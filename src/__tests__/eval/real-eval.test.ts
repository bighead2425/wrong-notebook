/**
 * 真实错题评测（**带图片**，走完整 analyze 链路）
 *
 * 与 tag-eval.test.ts 的区别：
 *   · 输入是**原图**（线上库里的 originalImageUrl），不是纯文本
 *   · 题来自她的真实错题，期望值是人工看图判定的
 *   · 参数完全照真实 analyze：subject 取本子的学科，grade/gradeSemester 取主页值
 *
 * 跑法：
 *   DATABASE_URL="file:E:/note_develop_share/repo/prisma/dev.db" TAG_EVAL=1 \
 *   ./node_modules/.bin/vitest run src/__tests__/eval/real-eval.test.ts --pool=threads --testTimeout=2400000
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { getTagTree } from '@/lib/ai/tag-service';
import { generateAnalyzePrompt } from '@/lib/ai/prompts';
import { parseTagRefs, normalizeTagName } from '@/lib/ai/tag-ref';
import { splitKnowledgePoints } from '@/lib/ai/knowledge-split';
import { buildResolverIndex, resolveTagRefs, type FlatTag, type ResolvedTag } from '@/lib/tag-resolve';
import { bookKeyOf } from '@/lib/ai/tag-scope';
import { prisma } from '@/lib/prisma';
import { REAL_CASES, type RealCase } from './real-cases';

const CONFIG_PATH = 'C:/Users/user/.workbuddy/tmp-eval/app-config.json';
const EVAL = process.env.TAG_EVAL === '1';

interface AiConf { base: string; model: string; key: string; template?: string }

function loadAi(): AiConf {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const list = c.openai?.instances ?? [];
    const inst = list.find((i: { id: string }) => i.id === c.openai?.activeInstanceId) ?? list[0];
    if (!inst?.apiKey) throw new Error('配置里没有可用的 apiKey');
    return {
        base: inst.baseUrl.replace(/\/$/, ''),
        model: process.env.TAG_EVAL_MODEL || inst.model,
        key: inst.apiKey,
        template: c.prompts?.analyze,
    };
}

async function callModel(ai: AiConf, system: string, imageDataUrl: string): Promise<string> {
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
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: '请分析这道题目图片。' },
                                { type: 'image_url', image_url: { url: imageDataUrl } },
                            ],
                        },
                    ],
                    /**
                     * ⚠️ max_tokens 必须跟线上一致（8192）。
                     * 线上 provider 的注释就写着："闭标签丢失绝大多数是被 max_tokens 截断"。
                     * 我一开始用 2500 ⇒ 推理模型（sensenova 会先写 reasoning）写完就到顶，
                     * content 直接是空的 —— 4/6 道"模型返回了空内容"，**是我的锅不是模型的**。
                     */
                    max_tokens: Number(process.env.TAG_EVAL_MAX_TOKENS || 8192),
                    /**
                     * temperature：**默认不传**，跟线上一致。
                     * 线上 provider 根本没设这个参数 ⇒ 走平台默认（≈1.0，比 temperature=0 随机得多）。
                     * 所以线上真实波动比我们评测里看到的**更大**。
                     */
                    ...(process.env.TAG_EVAL_TEMP
                        ? { temperature: Number(process.env.TAG_EVAL_TEMP) }
                        : {}),
                }),
            });
            if (res.status === 429) {
                lastErr = `429 ${(await res.text()).slice(0, 160)}`;
                if (attempt < maxTry) { await new Promise((r) => setTimeout(r, 20000 * attempt)); continue; }
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
    source: string;
    subjectOk: boolean;
    aiSubject: string;
    bookOk: boolean | null;
    actualBook: string;
    sectionOk: boolean | null;
    kpOk: boolean | null;
    matchedBy: string;
    kps: string;
    aiBook: string;
    aiSection: string;
    /** 库里原来存的标签（AI 之前标的） */
    oldTags: string;
    /** 新版转录的题干，用来和库里比 */
    newText: string;
    ms: number;
    err?: string;
}

describe('真实错题评测 · 带图片', () => {
    it.skipIf(!EVAL)('跑真实题并出报告', async () => {
        const ai = loadAi();

        const rows: Row[] = [];

        for (const c of REAL_CASES) {
            const t0 = Date.now();
            try {
                const item = await prisma.errorItem.findFirst({
                    where: { source: c.source },
                    include: { notebook: true },
                });
                if (!item) throw new Error('库里找不到这道题');
                if (!item.originalImageUrl) throw new Error('这道题没有原图');

                /* 学科取本子的（真实链路就是这样）；年级/学期取主页值 */
                const subjectKey = item.notebook?.subject ?? 'other';
                const subjectCn: Record<string, string> = {
                    math: '数学', physics: '物理', chemistry: '化学', biology: '生物',
                    english: '英语', chinese: '语文', history: '历史', geography: '地理', politics: '政治',
                };
                const subjectArg = subjectCn[subjectKey] ?? null;

                const tree = await getTagTree(subjectKey, 5);
                const system = generateAnalyzePrompt('zh', 5, subjectArg, {
                    tagTree: tree,
                    customTemplate: ai.template,
                }, '五年级上');

                const raw = await callModel(ai, system, item.originalImageUrl);

                const aiSubject = (extractTag(raw, 'subject') || '').trim();
                const kpRaw = extractTag(raw, 'knowledge_points');
                let refs = parseTagRefs(kpRaw);
                if (refs.length === 0 && kpRaw) {
                    refs = splitKnowledgePoints(kpRaw).map((name) => ({ name, legacy: true }));
                }

                const all = await prisma.knowledgeTag.findMany({
                    where: { subject: subjectKey, isSystem: true },
                    select: { id: true, name: true, parentId: true },
                });
                const index = buildResolverIndex(all as FlatTag[]);
                const resolved: ResolvedTag[] = resolveTagRefs(refs, index, all as FlatTag[]);
                if (process.env.TAG_EVAL_DEBUG === '1') {
                    console.log('  [debug] refs =', JSON.stringify(refs));
                    console.log('  [debug] all 条数 =', all.length, '| 命中的节点 =',
                        resolved.map((r) => (r.tagId
                            ? `${index.rootNameOf.get(r.tagId)} > ${index.parentNameOf.get(r.tagId)} > ${all.find((t) => t.id === r.tagId)?.name}`
                            : '(无)')));
                }

                const actualBooks = resolved.filter((r) => r.tagId)
                    .map((r) => index.rootNameOf.get(r.tagId as string) || '');
                const actualSections = resolved.filter((r) => r.tagId)
                    .map((r) => index.parentNameOf.get(r.tagId as string) || '');

                const bookOk = c.book
                    ? actualBooks.some((b) => bookKeyOf(b) === bookKeyOf(c.book))
                    : null;
                const sectionOk = c.section
                    ? actualSections.some((s) => normalizeTagName(s) === normalizeTagName(c.section as string))
                    : null;
                const kpOk = c.kps?.length
                    ? resolved.some((r) => c.kps!.some((k) => normalizeTagName(k) === normalizeTagName(r.name)))
                    : null;

                rows.push({
                    source: c.source,
                    subjectOk: aiSubject === c.subject,
                    aiSubject,
                    bookOk,
                    actualBook: [...new Set(actualBooks)].join('/'),
                    sectionOk,
                    kpOk,
                    matchedBy: [...new Set(resolved.map((r) => r.matchedBy))].join('/') || 'none',
                    kps: resolved.map((r) => r.name).join(', '),
                    aiBook: refs.map((r) => r.book || '（空）').join(' / '),
                    aiSection: refs.map((r) => r.section || '（空）').join(' / '),
                    oldTags: item.knowledgePoints || '',
                    newText: (item.questionText || '').slice(0, 60),
                    ms: Date.now() - t0,
                });
            } catch (e) {
                rows.push({
                    source: c.source,
                    subjectOk: false, aiSubject: '',
                    bookOk: null, actualBook: '', sectionOk: null, kpOk: null,
                    matchedBy: 'error', kps: '', aiBook: '', aiSection: '',
                    oldTags: '', newText: '', ms: Date.now() - t0,
                    err: e instanceof Error ? e.message : String(e),
                });
            }

            const last = rows[rows.length - 1];
            console.log(
                `${last.source} | 学科${last.subjectOk ? '✓' : '✗'}(${last.aiSubject}) | 册${last.bookOk === null ? '-' : last.bookOk ? '✓' : '✗'}[${last.actualBook || '空'}] | 节${last.sectionOk === null ? '-' : last.sectionOk ? '✓' : '✗'} | 点${last.kpOk === null ? '-' : last.kpOk ? '✓' : '✗'} | ${last.matchedBy} | ${last.ms}ms`,
            );
        }

        fs.writeFileSync(
            'C:/Users/user/.workbuddy/tmp-eval/rows-real.json',
            JSON.stringify(rows, null, 2),
            'utf8',
        );

        const ok = rows.filter((r) => !r.err).length;
        console.log(`\n跑通 ${ok}/${rows.length}`);
        expect(rows.length).toBe(REAL_CASES.length);
    }, 2400000);
});
