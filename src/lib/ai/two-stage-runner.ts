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
    buildStage2Prompt, parseStage2, composeCaseText, parseStage1Payload,
} from './two-stage';
import { normalizeTagName } from './tag-ref';
import { bookKeyOf } from './tag-scope';
import { normalizeGradeBook, bookFromNotebook } from '../grade-book';
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
    /** 单次请求的超时（毫秒）。不设的话网络卡住会**永久**挂着 */
    timeoutMs?: number;
}): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
    const ep = resolveEndpoint();
    if (!ep) throw new Error('没有可用的 AI 配置');

    /**
     * 【2026-11-01】**必须有超时。**
     *
     * 第二段现在跑在串行队列里（一次只有一道）。如果某次 fetch 因为网络抖动
     * 或服务端不响应而永远不返回，**整条队列就停摆** —— 后面的题全都卡在
     * "正在归位…"，而且不会有任何报错。这比单个请求失败严重得多。
     *
     * 取值：第一段带图，实测最慢约 130 秒（正常 30–70 秒），给 150 秒；
     * 第二段纯文字，正常 5–20 秒，给 90 秒。到点就 abort，走重试。
     */
    const { system, user, maxTokens = 8192, retries = 3, timeoutMs = 150000 } = params;
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
                signal: AbortSignal.timeout(timeoutMs),
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
            const aborted = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
            lastErr = aborted ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : (e instanceof Error ? e.message : String(e));
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
    /**
     * 【2026-11-08 空空】**单次请求超时，由调用方传设置页那个值。**
     *
     * 原来这里写死 150 秒，而前端 `apiClient` 等的是设置里的值（默认 180）——
     * 于是**后端 150 秒就断、开始重试，前端等到 180 秒也放弃**。
     * 用户把设置调到 300 秒完全没用：两头都用不上。
     *
     * 不传时才落回 150 秒（第一段带图，实测正常 30–70 秒，150 是兜底）。
     */
    timeoutMs?: number;
}): Promise<ReturnType<typeof parseStage1> & { promptTokens: number }> {
    const cfg = getAppConfig();
    const system = buildStage1Prompt({
        template: params.template || cfg.prompts?.analyze || DEFAULT_ANALYZE_TEMPLATE,
        gradeSemester: params.gradeSemester,
    });

    const user = [
        { type: 'text', text: '请分析这道题目图片。' },
        { type: 'image_url', image_url: { url: params.imageDataUrl } },
    ];

    const t = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 150000;
    let r = await chatCompletions({ system, user, retries: 2, timeoutMs: t });
    let parsed = parseStage1(r.text);

    /**
     * 【2026-11-01】**只在"输出里没有 `<keywords>` 这一段"时重试一次。**
     *
     * 两种情况要分开：
     *   · 明确写了 `<keywords>UNMATCHED</keywords>` → 接受，这是有效信息
     *     （这题确实没有现成的节名可挂），逼它编词只会往检索里灌噪音；
     *   · 压根没有这一段 → 模型偷懒或被截断，重试一次。
     *
     * 只重试一次：第二次还不给，说明它就是不打算给，再打下去只是浪费钱。
     * 没有关键词也能继续 —— 候选会退到"当前册全册"，第二段照样能选（实测过）。
     */
    if (!parsed.keywordsPresent) {
        logger.info('两段式：第一段没输出 keywords 段，重试一次');
        try {
            r = await chatCompletions({ system, user, retries: 2, timeoutMs: t });
            const retried = parseStage1(r.text);
            /* 重试用更好的结果，但原文仍以能解析出字段的那次为准 */
            if (retried.keywordsPresent || (!parsed.subject && retried.subject)) {
                parsed = retried;
            }
        } catch (e) {
            logger.warn({ err: String(e) }, '两段式：第一段重试失败，用第一次的结果继续');
        }
    }

    return { ...parsed, promptTokens: r.promptTokens };
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
    /** 该题具体考到的知识点（对应 picks[0] 那个节下的条目）；可能为空 */
    kps: string[];
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
        return { picks: [], kps: [], confidence: 'low', reason: '没有候选', candidates, promptTokens: 0 };
    }

    const system = buildStage2Prompt({
        caseText: params.caseText,
        candidates: candidates.map((c) => c.entry),
        currentBook: params.currentBook,
        subjectCn: params.subjectCn,
        template: params.template || cfg.prompts?.stage2,
    });

    /* 第二段是纯文字、输出短：90 秒没回就是出问题了，重试 2 次（外层还有一层重试） */
    const r = await chatCompletions({ system, user: '请按格式回答。', maxTokens: 800, timeoutMs: 90000, retries: 2 });
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
        /**
         * 第一段留下的中间数据。两种格式都要认：
         *   · 老：`["短语1","短语2"]`（纯数组）
         *   · 新：`{"keywords":[...],"subject":"数学"}`（多存了学科）
         */
        const stage1 = parseStage1Payload(item.stage1Keywords);
        const keywords = stage1.keywords;
        const stage1Subject = stage1.subject;

        /**
         * 学科：**本子优先，本子没有就用第一段认出来的**。
         *
         * 库里 20% 的题没挂本子（104 道里 20 道）。原来这里直接退成 'other'
         * ⇒ 词表查不到 ⇒ 候选为空 ⇒ 归位必然失败，那道题永远卡在"正在归位…"。
         * 而第一段本来就算出了学科，不该白算。
         */
        const subjectKey = item.notebook?.subject
            ?? (stage1Subject ? SUBJECT_KEY[stage1Subject] : undefined)
            ?? 'other';
        const subjectCn = Object.keys(SUBJECT_KEY).find((k) => SUBJECT_KEY[k] === subjectKey) ?? '';

        /**
         * 当前"位置"：
         *   · 理科（数理化生）→ 具体册，如「五年级上」
         *   · 文科五科 → 学段，如「小学 / 初中 / 高中」
         *
         * 【2026-11-01】**册名要先归一，而且本子比题目记录可靠。**
         *   线上库的 `gradeSemester` 有 7 种写法（'五年级/上学期'、'五年级'、
         *   'Grade 6, 1st Semester'…），词表只认 '五年级上' 这种；
         *   认不出 ⇒ 当前册全册一个都进不了候选，只能靠关键词撞运气。
         *   而本子是**按册建的**（"小五上数学"），比保存时按主页年级填的字段准。
         *   实例：大雁塔那道记的是"六年级上"，实际录在"五年级上"的本子里。
         */
        const stageOfGrade = (g: string | null | undefined): string | null => {
            if (!g) return null;
            if (/^[一二三四五六]年级/.test(g)) return '小学';
            if (/^[七八九]年级/.test(g)) return '初中';
            if (/^高/.test(g)) return '高中';
            return null;
        };
        const notebookBook = bookFromNotebook(item.notebook?.grade, item.notebook?.semester);
        const itemBook = normalizeGradeBook(item.gradeSemester);
        const currentBook = isStageScopeSubject(subjectKey)
            ? (stageOfGrade(item.gradeSemester) ?? stageOfGrade(item.notebook?.grade ?? null) ?? '小学')
            : (notebookBook ?? itemBook);

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
                    /**
                     * 【2026-11-01】没有候选 = 这道题**没有任何可选项**（比如没挂本子、
                     * 学科是 other、或该学科词表为空）。这不是"模型这次没选好"，
                     * 重试多少次都是同一个结果 —— 立刻放弃，别白等 5+10 秒。
                     */
                    if (r.candidates.length === 0) {
                        lastErr = new Error('没有候选可选项（学科未知或词表为空）');
                        break;
                    }
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

                /**
                 * 把「节」翻成库里的节点。
                 *
                 * 【2026-11-01 修】之前只落 `name === e.section` 那个节点，
                 * 也就是**节节点** —— 比单段式的知识点粗一级，而且
                 * 「节」和「同名知识点」都存在时，`find` 取到哪个取决于数据库顺序。
                 *
                 * 现在：先找节节点，再在**它的子节点**里按第二段给的 kps 挑知识点。
                 * 挑到就落叶子；挑不到（或模型没给）就落节节点 —— 不会比原来差。
                 */
                let kpIndex = 0;
                for (const e of chosen) {
                    /* 严格按坐标找"节"：名字 + 册 + 父节点是章 */
                    const sectionNode = allTags.find(
                        (t) => t.name === e.section
                            && rootOf(t.id) === e.book
                            && nameOf(t.parentId) === e.chapter,
                    );

                    if (!sectionNode) {
                        /**
                         * 没有同名的"节"节点。两种可能：
                         *   a) 词表里这个节只有叶节点、没有独立的节节点；
                         *   b) 坐标对不上（模型写错了章/册）。
                         * 前者能救：按名字 + 册找一个，落它自己。
                         */
                        const loose = allTags.find(
                            (t) => t.name === e.section && rootOf(t.id) === e.book,
                        );
                        if (loose) {
                            tagIds.push(loose.id);
                            resolution.push({
                                name: loose.name, book: e.book, section: e.chapter,
                                tagId: loose.id, granularity: 'point', matchedBy: 'nearby',
                            });
                        } else {
                            resolution.push({
                                name: e.section, book: e.book, chapter: e.chapter, section: e.section,
                                tagId: null, granularity: 'none', matchedBy: 'none',
                            });
                        }
                        kpIndex += 1;
                        continue;
                    }

                    /* kps 只对应第一个编号（模型的输出格式就是这么约定的） */
                    const wantKps = kpIndex === 0 ? r.kps : [];
                    kpIndex += 1;

                    const children = allTags.filter((t) => t.parentId === sectionNode.id);
                    const landed: { id: string; name: string }[] = [];
                    for (const k of wantKps) {
                        const kn = normalizeTagName(k);
                        const child = children.find(
                            (c) => c.name === k || normalizeTagName(c.name) === kn,
                        );
                        if (child && !landed.some((x) => x.id === child.id)) {
                            landed.push({ id: child.id, name: child.name });
                        }
                    }

                    if (landed.length > 0) {
                        for (const l of landed) {
                            tagIds.push(l.id);
                            resolution.push({
                                name: l.name, book: e.book, chapter: e.chapter, section: e.section,
                                tagId: l.id, granularity: 'point', matchedBy: 'path',
                            });
                        }
                    } else {
                        /* 没给点 / 给的点对不上 → 落节本身，并如实标出粒度 */
                        tagIds.push(sectionNode.id);
                        resolution.push({
                            name: sectionNode.name, book: e.book, chapter: e.chapter, section: e.section,
                            tagId: sectionNode.id, granularity: 'section', matchedBy: 'path',
                            ...(wantKps.length > 0 ? { unmatchedKps: wantKps } : {}),
                        });
                    }
                }

                /**
                 * 【2026-11-01】先**原子地抢状态**，再写标签。
                 *
                 * 为什么不能直接 update：第二段要跑几十秒，这期间用户完全可能在
                 * 详情页手选了标签（那条路会把 tagStatus 改成 'done'）。
                 * 直接 update 就会把人选的覆盖掉。
                 *
                 * `updateMany` 带 `tagStatus: 'pending'` 条件 ⇒ 只有状态还是 pending
                 * 才写得进去；count=0 说明人已经介入，这次结果作废。
                 * （Prisma 的 updateMany 不支持嵌套关系，所以标签要第二步单独写。）
                 */
                const claim = await prisma.errorItem.updateMany({
                    where: { id: itemId, tagStatus: 'pending' },
                    data: {
                        tagStatus: 'done',
                        tagResolution: JSON.stringify(resolution),
                        /* 中间数据用完即清：用户要求"完成后删去，不再积累" */
                        stage1Keywords: null,
                    },
                });

                if (claim.count === 0) {
                    logger.info({ itemId }, '两段式：人已介入，本次归位结果作废');
                    return;
                }

                if (tagIds.length > 0) {
                    await prisma.errorItem.update({
                        where: { id: itemId },
                        data: { tags: { set: tagIds.map((id) => ({ id })) } },
                    });
                }
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
