/**
 * 两段式评测（真图、真题，跟单段直接对比）
 *
 * 跑法：
 *   DATABASE_URL="file:E:/note_develop_share/repo/prisma/dev.db" TAG_EVAL=1 \
 *   ./node_modules/.bin/vitest run src/__tests__/eval/two-stage-eval.test.ts \
 *   --pool=threads --testTimeout=2400000
 *
 * 它做四件事：
 *   ① 第一段：图 → 转录 + 学科 + 3 个考点短语（不带清单）
 *   ② 本地：短语 → 候选节（当前册全册 + 命中的节）
 *   ③ 第二段：纯文字 + 编号候选 → 只输出"选第几个"
 *   ④ 判定：选中的节对不对（对照人工期望）
 *
 * 关心两个数：**节准确率** 和 **候选里有没有正确项**（召回）。
 * 后者若为 0，说明检索这一步就断了，跟第二段无关。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { prisma } from '@/lib/prisma';
import { buildCandidates, type ScoredSection } from '@/lib/tag-index';
import {
    buildStage1Prompt, parseStage1,
    buildStage2Prompt, parseStage2, composeCaseText,
} from '@/lib/ai/two-stage';
import { normalizeTagName } from '@/lib/ai/tag-ref';
import { bookKeyOf } from '@/lib/ai/tag-scope';
import { REAL_CASES } from './real-cases';

const CFG = 'C:/Users/user/.workbuddy/tmp-eval/app-config.json';
const EVAL = process.env.TAG_EVAL === '1';
const SUBJECT_KEY: Record<string, string> = {
    数学: 'math', 物理: 'physics', 化学: 'chemistry', 生物: 'biology',
    英语: 'english', 语文: 'chinese', 历史: 'history', 地理: 'geography', 政治: 'politics',
};

interface AiConf { base: string; model: string; key: string; template: string }

function loadAi(): AiConf {
    const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    const inst = c.openai.instances.find((i: { id: string }) => i.id === c.openai.activeInstanceId);
    return {
        base: inst.baseUrl.replace(/\/$/, ''),
        model: process.env.TAG_EVAL_MODEL || inst.model,
        key: inst.apiKey,
        template: c.prompts?.analyze,
    };
}

async function chat(ai: AiConf, system: string, userContent: unknown, maxTokens = 8192): Promise<{ text: string; usage: Record<string, number>; ms: number }> {
    const t0 = Date.now();
    const maxTry = Number(process.env.TAG_EVAL_TRY || 3);
    let lastErr = '';
    for (let attempt = 1; attempt <= maxTry; attempt++) {
        try {
            const res = await fetch(`${ai.base}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.key}` },
                body: JSON.stringify({
                    model: ai.model,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: userContent },
                    ],
                    max_tokens: maxTokens,
                }),
            });
            if (res.status === 429) {
                lastErr = `429 ${(await res.text()).slice(0, 120)}`;
                if (attempt < maxTry) { await new Promise((r) => setTimeout(r, 20000 * attempt)); continue; }
                throw new Error(lastErr);
            }
            if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
            const d = await res.json();
            const text = d.choices?.[0]?.message?.content ?? '';
            if (!text.trim()) throw new Error('空内容');
            return { text, usage: d.usage ?? {}, ms: Date.now() - t0 };
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
            if (attempt >= maxTry) break;
            await new Promise((r) => setTimeout(r, 20000 * attempt));
        }
    }
    throw new Error(lastErr);
}

function extractTag(text: string, tag: string): string | null {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
}

describe('两段式评测', () => {
    it.skipIf(!EVAL)('跑真实题：第一段→检索→第二段', async () => {
        const ai = loadAi();
        const stage1Sys = buildStage1Prompt({ template: ai.template, gradeSemester: '五年级上' });
        const rows: Record<string, unknown>[] = [];

        for (const c of REAL_CASES) {
            /* 支持 TAG_EVAL_ONLY 只跑几道：撞限流时不用从头再来 */
            const only = (process.env.TAG_EVAL_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (only.length > 0 && !only.includes(c.source)) continue;

            const item = await prisma.errorItem.findFirst({ where: { source: c.source } });
            if (!item?.originalImageUrl) { console.log(c.source, '无图跳过'); continue; }

            /* 单道失败不能让整轮评测挂掉 —— 限流是常态，记一行继续下一道 */
            try {

            /* ① 第一段 */
            const s1 = await chat(ai, stage1Sys, [
                { type: 'text', text: '请分析这道题目图片。' },
                { type: 'image_url', image_url: { url: item.originalImageUrl } },
            ]);
            const parsed = parseStage1(s1.text);
            const subjectCn = parsed.subject || c.subject;
            const subjectKey = SUBJECT_KEY[subjectCn] ?? 'math';

            /* ② 本地检索 */
            const currentBook = c.subject === '数学' ? '五年级上' : '小学';
            const cands: ScoredSection[] = buildCandidates(subjectKey, {
                currentBook,
                keywords: parsed.keywords,
                limit: 40,
            });

            /* 召回：期望的节在不在候选里（允许多解） */
            const accepted = [c.section, ...(c.altSections ?? [])]
                .filter(Boolean)
                .map((s) => normalizeTagName(s as string));
            const wantBook = bookKeyOf(c.book || '');
            const matchSection = (sec: string) => accepted.includes(normalizeTagName(sec));
            const recall = cands.some(
                (x) => matchSection(x.entry.section)
                    && (!wantBook || bookKeyOf(x.entry.book) === wantBook),
            );

            /* ③ 第二段 */
            const caseText = composeCaseText({
                questionText: extractTag(s1.text, 'question_text'),
                answerText: extractTag(s1.text, 'answer_text'),
                analysis: (extractTag(s1.text, 'analysis') || '').slice(0, 800),
            });
            const s2Sys = buildStage2Prompt({
                caseText,
                candidates: cands.map((x) => x.entry),
                currentBook,
                subjectCn,
            });
            const s2 = await chat(ai, s2Sys, '请按格式回答。', 800);
            const picked = parseStage2(s2.text);

            const chosen = picked.picks.map((n) => cands[n - 1]?.entry).filter(Boolean);
            const hit = chosen.some(
                (e) => matchSection(e!.section)
                    && (!wantBook || bookKeyOf(e!.book) === wantBook),
            );

            /**
             * 【2026-11-01】新增 `<kps>` 之后要盯两件事：
             *   ① 它给的考点名，**是不是真的在候选的考点列表里**（逐字照抄的要求守没守）；
             *   ② 它给的是不是"这题真正考的那几个点"（这个只能人看，评测只记下来）。
             * ① 是硬约束：编出来的名字在库里匹配不到，会静默退到节节点，粒度就丢了。
             *
             * ⚠️ 必须拿**所有选中的候选**去校验，不能只看第一个 ——
             *    一道题选了两处（如"数位"+"大小比较"），第二个节里的点会被误判成编造。
             */
            const allKpNames = chosen.flatMap((e) => e!.tags);
            const kpsValid = picked.kps.filter(
                (k) => allKpNames.some((t) => t === k || t.includes(k) || k.includes(t)),
            );
            const kpsFake = picked.kps.filter((k) => !kpsValid.includes(k));

            rows.push({
                source: c.source,
                subjectCn,
                keywords: parsed.keywords,
                candidateCount: cands.length,
                recall,
                picks: picked.picks,
                kps: picked.kps,
                kpsFake,
                confidence: picked.confidence,
                chosen: chosen.map((e) => `${e!.book} › ${e!.section}`),
                want: `${c.book} › ${c.section}`,
                hit,
                tokens: (s1.usage.prompt_tokens ?? 0) + (s2.usage.prompt_tokens ?? 0),
                ms: s1.ms + s2.ms,
            });

            const last = rows[rows.length - 1] as Record<string, unknown>;
            console.log(
                `${c.source} | 关键词=${(parsed.keywords || []).join('/')} | 候选${cands.length} | 召回${recall ? '✓' : '✗'} | 选中=${(last.chosen as string[]).join(' ; ') || '（空）'} | 点=${picked.kps.join('+') || '（空）'}${kpsFake.length ? ` ⚠️编造:${kpsFake.join(',')}` : ''} | 命中${hit ? '✓' : '✗'} | ${Math.round((last.ms as number) / 1000)}s`,
            );
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.log(`${c.source} | 失败：${msg.slice(0, 120)}`);
                rows.push({ source: c.source, error: msg, hit: false, recall: false });
            }
        }

        fs.writeFileSync('C:/Users/user/.workbuddy/tmp-eval/rows-two-stage.json', JSON.stringify(rows, null, 2), 'utf8');

        const n = rows.length;
        console.log(`\n召回 ${rows.filter((r) => r.recall).length}/${n} · 命中 ${rows.filter((r) => r.hit).length}/${n}`);
        expect(n).toBeGreaterThan(0);
    }, 2400000);
});
