/**
 * 标签判别 · 离线评测（不是常规单测，跑一次会真花钱）
 *
 * 跑法：
 *   DATABASE_URL="file:E:/note_develop_share/repo/prisma/dev.db" TAG_EVAL=1 \
 *   ./node_modules/.bin/vitest run src/__tests__/eval/tag-eval.test.ts --pool=threads --testTimeout=2400000
 *
 * 【它测什么】
 * 走**真实链路**：真实词表（线上 DB 副本）→ 真实提示词（线上配置副本）→ 真实模型
 * → 真实解析（parseTagRefs）→ 真实落点（resolveTagRefs）。
 *
 * 【它不测什么】
 * 输入是**纯文本题干**，跳过了 OCR。所以结果偏乐观 —— 真实录入还要多一层识图误差。
 *
 * 【判定口径】
 * "挂到哪一册"看的是**命中节点实际属于哪一册**（tagId → 顶层祖先），
 * 不是看 AI 自己写的 book。AI 说是五上、实际挂到四下，判错。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { getTagTree } from '@/lib/ai/tag-service';
import { generateAnalyzePrompt } from '@/lib/ai/prompts';
import { parseTagRefs, normalizeTagName } from '@/lib/ai/tag-ref';
import { splitKnowledgePoints } from '@/lib/ai/knowledge-split';
import {
    buildResolverIndex,
    resolveTagRefs,
    type FlatTag,
    type ResolvedTag,
} from '@/lib/tag-resolve';
import { bookKeyOf } from '@/lib/ai/tag-scope';
import { prisma } from '@/lib/prisma';
import { CASES, validateCases, type EvalCase } from './cases';

const CONFIG_PATH = 'C:/Users/user/.workbuddy/tmp-eval/app-config.json';
const EVAL = process.env.TAG_EVAL === '1';
const ONLY = process.env.TAG_EVAL_ONLY; // 调试用：只跑某几道，如 TAG_EVAL_ONLY=M01,M07

interface AiConf { base: string; model: string; key: string; template?: string }

function loadAi(): AiConf {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const list = c.openai?.instances ?? [];
    const inst = list.find((i: { id: string }) => i.id === c.openai?.activeInstanceId) ?? list[0];
    if (!inst?.apiKey) throw new Error('配置里没有可用的 apiKey');
    return {
        base: inst.baseUrl.replace(/\/$/, ''),
        /**
         * 可以用 TAG_EVAL_MODEL 临时换一个模型名**去试**，
         * 而不动线上配置（线上正在用哪个模型，是他的事）。
         */
        model: process.env.TAG_EVAL_MODEL || inst.model,
        key: inst.apiKey,
        template: c.prompts?.analyze,
    };
}

async function callModel(ai: AiConf, system: string, userText: string): Promise<string> {
    /**
     * 429 要退避重试，不能直接判失败 ——
     * 商汤的限流是"每分钟 N 次"，退 20 秒基本都能过。
     * （顺带这正是线上该做的事：限流不是错，是"等一下再来"。）
     */
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
                        { role: 'user', content: userText },
                    ],
                    temperature: 0,
                    max_tokens: 2500,
                }),
            });
            if (res.status === 429) {
                const body = (await res.text()).slice(0, 200);
                lastErr = `429 ${body}`;
                if (attempt < maxTry) {
                    await new Promise((r) => setTimeout(r, 20000 * attempt));
                    continue;
                }
                throw new Error(lastErr);
            }
            if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
            const data = await res.json();
            const content = data.choices?.[0]?.message?.content ?? '';
            if (!content.trim()) throw new Error('模型返回了空内容');
            return content;
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

interface Row {
    id: string;
    subjectOk: boolean;
    aiSubject: string;
    bookOk: boolean | null;
    actualBook: string;
    wantBook: string;
    sectionOk: boolean | null;
    kpOk: boolean | null;
    matchedBy: string;
    kps: string;
    /** 实际落点（命中节点所在的册 / 节） */
    actualSection: string;
    /** AI 自己写的坐标（判断是"它判错"还是"我们解析错"的关键） */
    aiBook: string;
    aiSection: string;
    aiReason: string;
    ms: number;
    err?: string;
    raw?: string;
}

describe('标签判别 · 离线评测', () => {
    it('题库自检', () => {
        expect(validateCases(CASES)).toEqual([]);
        expect(CASES.length).toBeGreaterThanOrEqual(30);
    });

    it.skipIf(!EVAL)('跑全部题目并出报告', async () => {
        const ai = loadAi();
        const all = await prisma.knowledgeTag.findMany({
            where: { subject: 'math', isSystem: true },
            select: { id: true, name: true, parentId: true },
        });
        const index = buildResolverIndex(all as FlatTag[]);
        const tree = await getTagTree('math', 5);

        const cases = ONLY ? CASES.filter((c) => ONLY.split(',').includes(c.id)) : CASES;
        const rows: Row[] = [];

        /**
         * 【2026-10-31】请求之间的间隔。
         *
         * 商汤的 deepseek-flash 配额很紧：连续请求会立刻 429
         * （"inference exceeds tpm/rpm limit"）。间隔给够，它才跑得动。
         */
        const gapMs = Number(process.env.TAG_EVAL_GAP || 0);
        if (gapMs > 0) {
            console.log(`每题间隔 ${gapMs}ms（应对限流）`);
        }

        for (const c of cases) {
            if (gapMs > 0 && rows.length > 0) {
                await new Promise((r) => setTimeout(r, gapMs));
            }
            const t0 = Date.now();
            try {
                /**
                 * 两个场景：
                 * - notebook：从「五上数学」本里录入 ⇒ 学科已知，给数学 4 册清单
                 * - nobody：首页拍照 ⇒ 学科未知，**不给任何清单**（这批改动的设计意图）
                 */
                const subjectArg = c.scenario === 'notebook' ? '数学' : null;
                /**
                 * ⚠️ 最后那个参数（gradeSemester）**不能漏**：
                 * 真实链路里 /api/analyze 会把主页填的「五年级上」传进来，
                 * 它决定提示词里的"她当前在读哪一册"。漏掉它，模型就只能按自己的
                 * 知识猜册次 —— 第一次试跑就是因为漏了，两道题全被判到四年级下。
                 */
                const system = generateAnalyzePrompt('zh', 5, subjectArg, {
                    tagTree: subjectArg ? tree : [],
                    customTemplate: ai.template,
                }, '五年级上');

                const raw = await callModel(ai, system, c.text);

                const aiSubject = (extractTag(raw, 'subject') || '').trim();
                const kpRaw = extractTag(raw, 'knowledge_points');
                let refs = parseTagRefs(kpRaw);
                if (refs.length === 0 && kpRaw) {
                    refs = splitKnowledgePoints(kpRaw).map((name) => ({ name, legacy: true }));
                }
                const resolved: ResolvedTag[] = resolveTagRefs(refs, index, all as FlatTag[]);

                const subjectOk = aiSubject === c.subject;

                /* 实际挂到哪一册：看命中节点的顶层祖先，不看 AI 自报的 book */
                const actualBooks = resolved
                    .filter((r) => r.tagId)
                    .map((r) => index.rootNameOf.get(r.tagId as string) || '');
                const actualBook = [...new Set(actualBooks)].join('/');

                /** 实际挂到哪一节：看命中节点的父节点，不看 AI 自报的 section */
                const actualSections = resolved
                    .filter((r) => r.tagId)
                    .map((r) => index.parentNameOf.get(r.tagId as string) || '');
                const actualSection = [...new Set(actualSections)].join('/');

                const bookOk = c.book
                    ? actualBooks.some((b) => bookKeyOf(b) === bookKeyOf(c.book))
                    : null;

                const sectionOk = c.section
                    ? actualSections.some((s) => normalizeTagName(s) === normalizeTagName(c.section as string))
                    : null;

                const kpOk = c.kps?.length
                    ? resolved.some((r) =>
                        c.kps!.some((k) => normalizeTagName(k) === normalizeTagName(r.name)),
                    )
                    : null;

                rows.push({
                    id: c.id,
                    subjectOk,
                    aiSubject,
                    bookOk,
                    actualBook,
                    wantBook: c.book || '-',
                    sectionOk,
                    kpOk,
                    matchedBy: [...new Set(resolved.map((r) => r.matchedBy))].join('/') || 'none',
                    kps: resolved.map((r) => r.name).join(', '),
                    actualSection,
                    aiBook: refs.map((r) => r.book || '（空）').join(' / '),
                    aiSection: refs.map((r) => r.section || '（空）').join(' / '),
                    aiReason: (extractTag(raw, 'book_reason') || '').trim(),
                    ms: Date.now() - t0,
                    raw: process.env.TAG_EVAL_RAW === '1' ? raw : undefined,
                });
            } catch (e) {
                rows.push({
                    id: c.id,
                    subjectOk: false,
                    aiSubject: '',
                    bookOk: null,
                    actualBook: '',
                    wantBook: c.book || '-',
                    sectionOk: null,
                    kpOk: null,
                    matchedBy: 'error',
                    kps: '',
                    actualSection: '',
                    aiBook: '',
                    aiSection: '',
                    aiReason: '',
                    ms: Date.now() - t0,
                    err: e instanceof Error ? e.message : String(e),
                });
            }
            const last = rows[rows.length - 1];
            console.log(
                `${last.id} | 学科${last.subjectOk ? '✓' : '✗'}(${last.aiSubject}) | 册${last.bookOk === null ? '-' : last.bookOk ? '✓' : '✗'}[${last.actualBook || '空'}] | 节${last.sectionOk === null ? '-' : last.sectionOk ? '✓' : '✗'}[${last.actualSection || '空'}] | 点${last.kpOk === null ? '-' : last.kpOk ? '✓' : '✗'} | ${last.matchedBy} | ${last.ms}ms`,
            );
        }

        const math = rows.filter((r) => r.bookOk !== null);
        const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

        console.log('\n===== 汇总 =====');
        console.log(`学科正确：${rows.filter((r) => r.subjectOk).length}/${rows.length}`);
        console.log(`册次正确：${math.filter((r) => r.bookOk).length}/${math.length}（${pct(math.filter((r) => r.bookOk).length, math.length)}）`);
        console.log(`节正确：  ${math.filter((r) => r.sectionOk).length}/${math.length}`);
        console.log(`知识点命中：${math.filter((r) => r.kpOk).length}/${math.length}`);
        console.log(`平均耗时：${Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length)}ms`);

        fs.writeFileSync(
            'C:/Users/user/.workbuddy/tmp-eval/rows.json',
            JSON.stringify(rows, null, 2),
            'utf8',
        );

        /* 只断言"跑完了"，具体好坏看报告；避免把评测变成长红灯 */
        expect(rows.length).toBe(cases.length);
    }, 2400000);
});
