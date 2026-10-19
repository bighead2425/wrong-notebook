/**
 * 日积月累 · **同词头归并**（2026-10-18）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 空空那句话是全篇的定盘星：
 *
 *   "对某种题型，比如语文阅读理解中的'中心思想'要怎么写，可能一条积累不够，
 *    那就两条积累、三条积累……这样不同时期的不同看法就从不同角度出来了。"
 *
 *   "就像错题本里一样，有一个主积累，还有一些附积累跟着。"
 *
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 关键判断：**主附关系不靠手动连线，靠词头** ─────────────────────
 *
 * 错题本的"主/附"必须手动挂 `parentId`，因为两道题本来没有关系，
 * 是**人**发现"它们是一回事"才连起来的。
 *
 * 词典不是这样。词典里"中心思想"这个词只有**一个词头**，不同时期的理解
 * 都排在这个词头下面 —— 没有"关联"这个动作，只有**同一个词**。
 *
 * 所以这里**不做任何模糊匹配**：
 *   · "中心思想怎么写" 和 "怎么写中心思想" **不并**（语序不同就是两个词头）；
 *   · "中心思想" 和 "主旨" **不并**（那是同义词，要并得她自己说了算）。
 *   宁可少并（她看见两条分开的，最多觉得有点散），
 *   不可错并（把两个不同的问题焊成一条，她会再也分不开）。
 *
 * ── 什么样的一条**没有**词头 ────────────────────────────────────────
 * 摘抄、一段感受、一封信 —— 本来就没有"词"。它们不进任何组，
 * 按时间散着放。**格式不逼它们**（逼了就不写了）。
 */

/** 参与归并的一条（只要这几个字段，不绑数据库模型） */
export interface HeadwordItem {
    id: string;
    /** md 正文 */
    content: string | null;
    /** 建这条的时间（用来定"谁是主"） */
    createdAt: Date | string;
}

export interface HeadwordGroup<T extends HeadwordItem = HeadwordItem> {
    /** 归一化后的钥匙（比较用，不显示） */
    key: string;
    /** 显示用的词头（取组里**最早**那条的写法 —— 那是她自己的说法） */
    headword: string;
    /** 组内的条目，**时间正序**（最早的在前） */
    items: T[];
    /**
     * 主积累 = 组里**最早**的那条。
     *
     * 为什么不是"最长/最全"的那条：主条的用处是"这是这个词的来历"，
     * 第一次记下它的那个时刻才是来历。后来的条目是补丁，补丁再多也不该顶掉来历。
     * ⚠️ 将来若允许她手动指定主条，**手动 > 这个默认**（与等级账本同一条规矩）。
     */
    mainId: string;
}

/** emoji（含变体选择符、零宽连接符）—— 归一化时整颗去掉 */
const EMOJI_RE =
    /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

/** 中文/英文标点：比较词头时一律不看（"中心思想。"和"中心思想"是同一个词） */
const PUNCT_RE = /[\s，。、；：！？""''（）()《》〈〉【】\[\]…—\-·~～!?,.;:'"]/g;

/**
 * 从正文里取词头 —— **只认第一行是 `#### ` 的那种**。
 *
 * 为什么只认四级标题：那是 `normalizeInsightMarkdown` 统一出来的格式
 * （见 `lib/insight-note.ts`）。她手写的东西如果第一行不是标题，
 * 就**没有词头**，不猜、不拿第一句凑 —— 猜错的词头比没有词头更坏，
 * 因为它会把她两段不相干的话并到一起。
 */
export function extractHeadword(content: string | null | undefined): string | null {
    if (!content) return null;
    const firstLine = content.split('\n').find((l) => l.trim() !== '');
    if (!firstLine) return null;
    const m = firstLine.trim().match(/^####\s+(.+)$/);
    if (!m) return null;
    const text = m[1].replace(EMOJI_RE, '').trim();
    return text || null;
}

/** 归一化：去 emoji、去标点空白、全角转半角、小写 —— 只为了**比较**，不改显示 */
export function headwordKey(word: string): string {
    return word
        .replace(EMOJI_RE, '')
        .replace(PUNCT_RE, '')
        .toLowerCase();
}

/**
 * **落库用的**词头：从正文取词头 → 归一化 → 空就 null。
 *
 * 写入端（`POST /api/insights`、`PATCH /api/insights/[id]`）只调这一个。
 * 为什么要单独一个函数：取词头与归一化是两步，**任何一步漏了都会让分组错**
 * （漏归一化 ⇒ 只差一个空格就分成两组；漏取词头 ⇒ 整列空）。
 * 把它钉在一处，写入端就不会各写一遍。
 */
export function headwordOfContent(content: string | null | undefined): string | null {
    const word = extractHeadword(content);
    if (!word) return null;
    return headwordKey(word) || null;
}

function timeOf(t: Date | string): number {
    const v = t instanceof Date ? t.getTime() : new Date(t).getTime();
    return Number.isFinite(v) ? v : 0;
}

/**
 * 按词头归并。**没有词头的条目原样不进组**（调用方自己按时间散放）。
 *
 * @returns 组，按"组里最早那条"的时间**正序**（老的词在前，像词典的排列感 ——
 *          实际上词典按拼音排，这里按"她最早遇到它的时候"排）
 */
export function groupByHeadword<T extends HeadwordItem>(items: T[]): HeadwordGroup<T>[] {
    const buckets = new Map<string, T[]>();

    for (const item of items) {
        const word = extractHeadword(item.content);
        if (!word) continue;
        const key = headwordKey(word);
        if (!key) continue;
        const list = buckets.get(key);
        if (list) list.push(item);
        else buckets.set(key, [item]);
    }

    const groups: HeadwordGroup<T>[] = [];
    for (const [key, list] of buckets) {
        const sorted = [...list].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
        const first = sorted[0];
        groups.push({
            key,
            // 显示用最早那条的写法：她的原话，不是归一化后那串
            headword: extractHeadword(first.content) ?? key,
            items: sorted,
            mainId: first.id,
        });
    }

    groups.sort((a, b) => timeOf(a.items[0].createdAt) - timeOf(b.items[0].createdAt));
    return groups;
}

/**
 * 单条的"它是第几次记这个词"。
 *
 * 用在条目上显示 `第 2 次` 这种小标记 —— 她翻到一条时能立刻知道
 * "这不是我第一次想这个"，也就能顺着找回去看第一、第三次。
 *
 * @returns 1 起；没有词头或不在组里返回 null（摘抄不显示序号）
 */
export function occurrenceOf<T extends HeadwordItem>(
    item: T,
    groups: HeadwordGroup<T>[],
): { index: number; total: number; group: HeadwordGroup<T> } | null {
    for (const g of groups) {
        const i = g.items.findIndex((x) => x.id === item.id);
        if (i >= 0) return { index: i + 1, total: g.items.length, group: g };
    }
    return null;
}

/** 左栏那一列里的"一项"：要么是一条散的，要么是一组同词头的 */
export type HeadwordListEntry<T extends HeadwordItem> =
    | { kind: 'single'; row: T }
    | { kind: 'group'; key: string; headline: string; rows: T[] };

/**
 * **印积累纸时的顺序**（2026-10-18 空空拍板）：
 * "主积累在前面，附积累在后面，这样内容就串联并联系起来了。"
 *
 * 输入是她勾选条目的顺序（她心里的顺序），输出只在**同词头组内部**动：
 * 组内按时间正序（第一次的在前），组与组、散条之间的相对位置一个字都不动。
 *
 * ⚠️ 什么时候**不**该用它：打开一份**已经建好的卷**时，顺序以卷里存的快照为准
 *    （`seqInVolume`）—— 那张纸已经印出去了，不能因为后来补了一条就重排。
 */
export function orderForPrint<T extends HeadwordItem>(rows: T[]): T[] {
    const entries = buildHeadwordList(rows);
    return entries.flatMap((e) => (e.kind === 'single' ? [e.row] : e.rows));
}

/**
 * 把清单排成"同词头挨在一起"的样子（2026-10-19）。
 *
 * 规则（**位置算在谁头上，这一条最容易做错**）：
 *   · **组的位置 = 组里最早出现在清单里的那条的位置**。
 *     管理页的清单是时间倒序 ⇒ 等价于"这个词最近一次被记的时刻"。
 *     不这样算（比如按组里最早那条排），一个两年前的老词会把它整组拖到列表最底下，
 *     她刚写的新内容反而"消失了"。
 *   · **组内按时间正序**（最早的在上）—— 主积累（第一次）在最前，附积累跟着往下长，
 *     跟印在纸上的顺序一致。
 *   · 只有一条的"组"退化成散条（不做单条的分组框，那是白占地方）。
 *
 * @param rows 清单（管理页传时间**倒序**的；打印页传**勾选顺序**的，两者都对）
 */
export function buildHeadwordList<T extends HeadwordItem>(rows: T[]): HeadwordListEntry<T>[] {
    const groups = groupByHeadword(rows).filter((g) => g.items.length > 1);
    if (groups.length === 0) return rows.map((row) => ({ kind: 'single' as const, row }));

    const byKey = new Map(groups.map((g) => [g.key, g]));
    /** rowId → 它属于哪个词头 */
    const headingOf = new Map<string, string>();
    for (const g of groups) for (const it of g.items) headingOf.set(it.id, g.key);

    const out: HeadwordListEntry<T>[] = [];
    const emitted = new Set<string>();
    for (const row of rows) {
        const key = headingOf.get(row.id);
        if (!key) {
            out.push({ kind: 'single', row });
            continue;
        }
        if (emitted.has(key)) continue; // 这一组已经在该出现的位置放过了
        emitted.add(key);
        const g = byKey.get(key);
        if (g) out.push({ kind: 'group', key, headline: g.headword, rows: g.items });
    }
    return out;
}
