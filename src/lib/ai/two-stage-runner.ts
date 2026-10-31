/**
 * 两段式执行器（服务端）
 *
 * 【2026-11-01】
 *   第一段 = 看图转录 + 出 3 个考点短语（不带清单）
 *   中间   = 本地检索出候选「节」（`lib/tag-index.ts`）
 *   第二段 = 纯文字，只在候选编号里选
 *
 * 为什么**不走** `aiService.analyzeImage`：
 *   那条路只接受"按当前册给一份清单"这一种形态，强行加参数要动三个 provider；
 *   而两段式的两次调用形态都不一样（一次带图不带清单、一次不带图带候选），
 *   自己这里发请求反而更清楚，出问题也好定位。
 *
 * 容错：429 退避重试（限流是"等一下"，不是失败）、空内容重试、超时。
 */

import { getAppConfig } from '../config';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { buildCandidates, isStageScopeSubject } from '../tag-index';
import {
    buildStage1Prompt, parseStage1,
    buildStage2Prompt, parseStage2, composeCaseText,
} from './two-stage';
import { normalizeTagName } from './tag-ref';
import { bookKeyOf } from './tag-scope';
import { DEFAULT_ANALYZE_TEMPLATE } from './prompts';

interface EndpointConf {
    base: string;
    model: string;
    key: string;
}

function resolveEndpoint(): EndpointConf | null {
    const cfg = getAppConfig();
    const provider = cfg.aiProvider || 'openai';

    if (provider === 'openai') {
        const list = cfg.openai?.instances ?? [];
        const inst = list.find((i) => i.id === cfg.openai?.activeInstanceId) ?? list[0];
        if (!inst?.apiKey) return null;
        return { base: inst.baseUrl.replace(/\/$/, ''), model: inst.model, key: inst.apiKey };
    }
    if (provider === 'gemini') {
        const key = cfg.gemini?.apiKey;
        if (!key) return null;
        return {
            base: 'https://generativelanguage.googleapis.com/v1beta/openai',
            model: cfg.gemini?.model || 'gemini-2.5-flash',
            key,
        };
    }
    /* azure 的路径/鉴权与 OpenAI 不同，两段式暂不支持，回退单段 */
    return null;
}

async function chatCompletions(params: {
    system: string;
    user: unknown;
    maxTokens?: number;
    retries?: number;
}): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
    const ep = resolveEndpoint();
    if (!ep) throw new Error('没有可用的 AI 配置');

    const { system, user, maxTokens = 8192, retries = 3 } = params;
    let lastErr = '';

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(`${ep.base}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
                body: JSON.stringify({
                    model: ep.model,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: user },
                    ],
                    max_tokens: maxTokens,
                }),
            });

            if (res.status === 429) {
                lastErr = `429 ${(await res.text()).slice(0, 120)}`;
                if (attempt < retries) {
                    await new Promise((r) => setTimeout(r, 20000 * attempt));
                    continue;
                }
                throw new Error(lastErr);
            }
            if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);

            const d = await res.json();
            const text = d.choices?.[0]?.message?.content ?? '';
            if (!text.trim()) throw new Error('模型返回了空内容');
            return {
                text,
                promptTokens: d.usage?.prompt_tokens ?? 0,
                completionTokens: d.usage?.completion_tokens ?? 0,
            };
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
            if (attempt >= retries) break;
            await new Promise((r) => setTimeout(r, 15000 * attempt));
        }
    }
    throw new Error(lastErr);
}

/** 第一段：看图 → 转录 + 学科 + 3 个考点短语 */
export async function runStage1(params: {
    imageDataUrl: string;
    gradeSemester?: string | null;
    template?: string | null;
}): Promise<ReturnType<typeof parseStage1> & { promptTokens: number }> {
    const cfg = getAppConfig();
    const system = buildStage1Prompt({
        template: params.template || cfg.prompts?.analyze || DEFAULT_ANALYZE_TEMPLATE,
        gradeSemester: params.gradeSemester,
    });

    const r = await chatCompletions({
        system,
        user: [
            { type: 'text', text: '请分析这道题目图片。' },
            { type: 'image_url', image_url: { url: params.imageDataUrl } },
        ],
    });

    return { ...parseStage1(r.text), promptTokens: r.promptTokens };
}

const SUBJECT_KEY: Record<string, string> = {
    数学: 'math', 物理: 'physics', 化学: 'chemistry', 生物: 'biology',
    英语: 'english', 语文: 'chinese', 历史: 'history', 地理: 'geography', 政治: 'politics',
};

/**
 * 第二段：拿这道题的文本 + 候选节，让模型挑编号。
 *
 * 这里**不写库**，只返回结果 —— 写库由调用方决定（保存后 / 重试按钮）。
 */
export async function runStage2(params: {
    subjectKey: string;
    subjectCn: string;
    currentBook?: string | null;
    keywords: string[];
    caseText: string;
    template?: string | null;
}): Promise<{
    picks: number[];
    confidence: 'high' | 'medium' | 'low';
    reason: string | null;
    candidates: ReturnType<typeof buildCandidates>;
    promptTokens: number;
}> {
    const cfg = getAppConfig();
    const candidates = buildCandidates(params.subjectKey, {
        currentBook: params.currentBook,
        keywords: params.keywords,
        limit: 40,
    });

    if (candidates.length === 0) {
        return { picks: [], confidence: 'low', reason: '没有候选', candidates, promptTokens: 0 };
    }

    const system = buildStage2Prompt({
        caseText: params.caseText,
        candidates: candidates.map((c) => c.entry),
        currentBook: params.currentBook,
        subjectCn: params.subjectCn,
        template: params.template || cfg.prompts?.stage2,
    });

    const r = await chatCompletions({ system, user: '请按格式回答。', maxTokens: 800 });
    return { ...parseStage2(r.text), candidates, promptTokens: r.promptTokens };
}

/**
 * 给某道已存在的题跑第二段，并把结果写回库。
 *
 * 状态机：
 *   pending → 跑 → 成功写 done / 失败写 failed（前端据此显示"重新归位"）
 *
 * ⚠️ 这个函数是**给后台任务**用的：调用方不要 await 它（fire-and-forget），
 *    否则保存接口会被拖慢几十秒。
 */
export async function relocateItem(itemId: string): Promise<void> {
    const item = await prisma.errorItem.findUnique({
        where: { id: itemId },
        include: { notebook: true, tags: true },
    });
    if (!item) return;

    const cfg = getAppConfig();
    const maxRetries = Math.max(1, cfg.twoStage?.maxRetries ?? 2);

    await prisma.errorItem.update({ where: { id: itemId }, data: { tagStatus: 'pending' } });

    try {
        const subjectKey = item.notebook?.subject ?? 'other';
        const subjectCn = Object.keys(SUBJECT_KEY).find((k) => SUBJECT_KEY[k] === subjectKey) ?? '';

        /**
         * 当前"位置"：
         *   · 理科（数理化生）→ 具体册，如「五年级上」
         *   · 文科五科 → 学段，如「小学 / 初中 / 高中」
         */
        const stageOfGrade = (g: string | null | undefined): string | null => {
            if (!g) return null;
            if (/^[一二三四五六]年级/.test(g)) return '小学';
            if (/^[七八九]年级/.test(g)) return '初中';
            if (/^高/.test(g)) return '高中';
            return null;
        };
        const currentBook = isStageScopeSubject(subjectKey)
            ? (stageOfGrade(item.gradeSemester) ?? stageOfGrade(item.notebook?.grade ?? null) ?? '小学')
            : (item.gradeSemester || null);

        /* 第一段的关键词：存在 stage1Keywords 里（中间数据），第二段用完即清 */
        let keywords: string[] = [];
        if (item.stage1Keywords) {
            try {
                const parsed = JSON.parse(item.stage1Keywords);
                if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === 'string');
            } catch {
                /* 解析不了就当没有关键词，候选退到当前册/学段全量 */
            }
        }

        const caseText = composeCaseText({
            questionText: item.questionText,
            answerText: item.answerText,
            analysis: item.analysis,
        });

        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const r = await runStage2({
                    subjectKey,
                    subjectCn,
                    currentBook,
                    keywords,
                    caseText,
                });

                if (r.picks.length === 0) {
                    lastErr = new Error('第二段没有选出任何位置');
                    continue;
                }

                const chosen = r.picks
                    .map((n) => r.candidates[n - 1]?.entry)
                    .filter(Boolean) as NonNullable<ReturnType<typeof buildCandidates>[number]>['entry'][];

                /* 把「节」翻成库里的知识点节点：节名匹配 + 册次对齐 */
                const tagIds: string[] = [];
                const resolution: Record<string, unknown>[] = [];
                const allTags = await prisma.knowledgeTag.findMany({
                    where: { subject: subjectKey, isSystem: true },
                    select: { id: true, name: true, parentId: true },
                });
                const byId = new Map(allTags.map((t) => [t.id, t]));
                const nameOf = (id: string | null) => (id ? byId.get(id)?.name ?? null : null);
                const rootOf = (id: string) => {
                    let cur = byId.get(id);
                    const guard = new Set<string>();
                    while (cur?.parentId && !guard.has(cur.id)) {
                        guard.add(cur.id);
                        cur = byId.get(cur.parentId);
                    }
                    return cur?.name ?? null;
                };

                for (const e of chosen) {
                    const hit = allTags.find(
                        (t) => t.name === e.section
                            && rootOf(t.id) === e.book
                            && nameOf(t.parentId) === e.chapter,
                    ) ?? allTags.find((t) => t.name === e.section && rootOf(t.id) === e.book);
                    if (hit) tagIds.push(hit.id);
                    resolution.push({
                        name: e.section,
                        book: e.book,
                        section: e.chapter,
                        tagId: hit?.id ?? null,
                        matchedBy: hit ? 'path' : 'none',
                    });
                }

                await prisma.errorItem.update({
                    where: { id: itemId },
                    data: {
                        tagStatus: 'done',
                        tagResolution: JSON.stringify(resolution),
                        /* 中间数据用完即清：用户要求"完成后删去，不再积累" */
                        stage1Keywords: null,
                        ...(tagIds.length > 0
                            ? { tags: { set: tagIds.map((id) => ({ id })) } }
                            : {}),
                    },
                });
                logger.info({ itemId, picks: r.picks, confidence: r.confidence }, '两段式：归位完成');
                return;
            } catch (e) {
                lastErr = e;
                await new Promise((res) => setTimeout(res, 5000 * attempt));
            }
        }

        await prisma.errorItem.update({ where: { id: itemId }, data: { tagStatus: 'failed' } });
        logger.warn({ itemId, err: String(lastErr) }, '两段式：归位失败');
    } catch (e) {
        logger.error({ itemId, err: String(e) }, '两段式：归位异常');
        await prisma.errorItem.update({ where: { id: itemId }, data: { tagStatus: 'failed' } }).catch(() => {});
    }
}

/** 判断某条标签记录是否与某册某节一致（给前端/测试用，逻辑与上面同一套） */
export function sameSection(book: string | null, chapter: string | null, entry: { book: string; chapter: string; section: string }): boolean {
    return (!book || bookKeyOf(book) === bookKeyOf(entry.book))
        && (!chapter || normalizeTagName(chapter) === normalizeTagName(entry.chapter));
}
