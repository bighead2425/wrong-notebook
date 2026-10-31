/**
 * 节级索引与检索（两段式的「中间那一跳」）
 *
 * 【2026-11-01】用户定的两段式：
 *   第一段（看图）：出题干/答案/解析/错因 + **学科 + 3 个考点短语**
 *   第二段（读文字）：只在这几个候选节里选
 *
 * 这个文件负责中间那一跳：**把 3 个考点短语变成「几个候选节」**。
 *
 * 为什么按「节」而不是按「册」：
 *   用户举的例子很准 —— "重量/长度/单位"会命中所有带"单位"的节，
 *   如果按册收，就变成「五上整册 + 三下整册 + 二上整册」，比不筛还多。
 *   只有收到「节」，候选才真正变小（每节 1–5 个考点）。
 *
 * 这里全部是纯函数，不碰数据库 —— 可以用单测把每一条规则钉死。
 */

import {
    MATH_CURRICULUM, MATH_GRADE_ORDER,
    PHYSICS_CURRICULUM, PHYSICS_GRADE_ORDER,
    CHEMISTRY_CURRICULUM, CHEMISTRY_GRADE_ORDER,
    BIOLOGY_CURRICULUM, BIOLOGY_GRADE_ORDER,
    CHINESE_CURRICULUM, CHINESE_GRADE_ORDER,
    ENGLISH_CURRICULUM, ENGLISH_GRADE_ORDER,
    HISTORY_CURRICULUM, HISTORY_GRADE_ORDER,
    GEOGRAPHY_CURRICULUM, GEOGRAPHY_GRADE_ORDER,
    POLITICS_CURRICULUM, POLITICS_GRADE_ORDER,
} from './tag-data';

export interface SectionEntry {
    subject: string;
    /** 册（数理化生）或学段（语英政史地） */
    book: string;
    /** 册/学段的顺序号，用来算"离她当前册多远" */
    bookOrder: number;
    chapter: string;
    section: string;
    tags: string[];
}

type Curr = Record<string, Array<{ chapter: string; sections?: Array<{ section: string; tags: string[] }>; tags?: string[] }>>;

const SUBJECT_DATA: Record<string, { cur: Curr; order: Record<string, number> }> = {
    math: { cur: MATH_CURRICULUM as unknown as Curr, order: MATH_GRADE_ORDER },
    physics: { cur: PHYSICS_CURRICULUM as unknown as Curr, order: PHYSICS_GRADE_ORDER },
    chemistry: { cur: CHEMISTRY_CURRICULUM as unknown as Curr, order: CHEMISTRY_GRADE_ORDER },
    biology: { cur: BIOLOGY_CURRICULUM as unknown as Curr, order: BIOLOGY_GRADE_ORDER },
    chinese: { cur: CHINESE_CURRICULUM as unknown as Curr, order: CHINESE_GRADE_ORDER },
    english: { cur: ENGLISH_CURRICULUM as unknown as Curr, order: ENGLISH_GRADE_ORDER },
    history: { cur: HISTORY_CURRICULUM as unknown as Curr, order: HISTORY_GRADE_ORDER },
    geography: { cur: GEOGRAPHY_CURRICULUM as unknown as Curr, order: GEOGRAPHY_GRADE_ORDER },
    politics: { cur: POLITICS_CURRICULUM as unknown as Curr, order: POLITICS_GRADE_ORDER },
};

/** 把某学科的整棵树拍平成「节」列表 */
export function buildSectionIndex(subject: string): SectionEntry[] {
    const data = SUBJECT_DATA[subject];
    if (!data) return [];
    const out: SectionEntry[] = [];
    for (const [book, chapters] of Object.entries(data.cur)) {
        const bookOrder = data.order[book] ?? 999;
        for (const ch of chapters) {
            const sections = ch.sections ?? [{ section: ch.chapter, tags: ch.tags ?? [] }];
            for (const s of sections) {
                out.push({
                    subject,
                    book,
                    bookOrder,
                    chapter: ch.chapter,
                    section: s.section,
                    tags: s.tags,
                });
            }
        }
    }
    return out;
}

/** 两个册之间差几册（同一个 key 为 0） */
export function bookDistance(a: number, b: number): number {
    return Math.abs(a - b);
}

export interface ScoredSection {
    entry: SectionEntry;
    /** 命中强度：命中的关键词个数 × 10 + 命中的考点数 */
    score: number;
    /** 离她当前册多远（0 = 就是当前册） */
    distance: number;
    /** 命中了哪些关键词，便于解释 */
    hits: string[];
}

/**
 * 用考点短语去找节。
 *
 * 匹配规则（宁可多召回，排序交给后面）：
 *   · 短语出现在**节名**里，或节名包含短语；
 *   · 短语出现在**该节任一考点名**里，或考点名包含短语。
 *
 * 强度：命中考点名比命中节名更具体，加权更高。
 */
export function searchByKeywords(keywords: string[], index: SectionEntry[]): ScoredSection[] {
    const kws = keywords.map((k) => k.trim()).filter(Boolean);
    if (kws.length === 0) return [];

    const out: ScoredSection[] = [];
    for (const entry of index) {
        const hits: string[] = [];
        let score = 0;

        for (const kw of kws) {
            const inSection = entry.section.includes(kw) || kw.includes(entry.section);
            const hitTags = entry.tags.filter((t) => t.includes(kw) || kw.includes(t)).length;

            if (inSection) {
                hits.push(kw);
                score += 10;
            }
            if (hitTags > 0) {
                if (!hits.includes(kw)) hits.push(kw);
                score += 10 + hitTags * 2;
            }
        }

        if (score > 0) {
            out.push({ entry, score, distance: 0, hits });
        }
    }
    return out.sort((a, b) => b.score - a.score);
}

/**
 * 【2026-11-01 用户定的规则】**语文/英语/政治/历史/地理：整学段全送，不做关键词筛选。**
 *
 * 理由（他说的，我认同）：
 *   · 这五科本来就没有"册"，只有学段，标签总量很小
 *     （英语小学整学段 21 个点、语文高中 32 个、政治高中 35 个）；
 *   · **第一段本来就在猜，第二段才有选项确认** —— 猜不准的时候把选项砍掉，
 *     等于让第一段的错误去惩罚第二段；
 *   · 实测：英语那道题的关键词是"阅读理解"，而小学词表叫"短文阅读"，
 *     检索直接召回 0，第二段连选的机会都没有。
 *
 * 所以关键词只为数理化生服务（那才是"册"多、候选大的地方）。
 */
export const STAGE_SCOPE_SUBJECTS = new Set([
    'chinese', 'english', 'politics', 'history', 'geography',
]);

/** 该学科是否按"整学段全送"处理（不筛关键词） */
export function isStageScopeSubject(subject: string): boolean {
    return STAGE_SCOPE_SUBJECTS.has(subject);
}

export interface BuildOptions {
    /** 她当前在读的册（数学 = 「五年级上」；语文/英语 = 「小学」） */
    currentBook?: string | null;
    /** 第一段给的 3 个考点短语 */
    keywords: string[];
    /** 候选项上限（含当前册全册） */
    limit?: number;
    /** 关键词命中的节最多带几册进来 */
    maxBooksFromKeywords?: number;
}

/**
 * 组装第二段的候选集。
 *
 * 规则（按用户定的）：
 *   1. **当前册的整册节**全部进来 —— 因为是"她现在在读"，命中概率最高；
 *   2. 再补**关键词命中的节**（来自其他册）；
 *   3. 按「离当前册的距离」排序，近的在前；
 *   4. 截断到 limit，避免又变成"几百个节点"。
 */
export function buildCandidates(subject: string, opts: BuildOptions): ScoredSection[] {
    const { currentBook, keywords, limit = 40, maxBooksFromKeywords = 4 } = opts;
    const index = buildSectionIndex(subject);
    if (index.length === 0) return [];

    const currentOrder = currentBook
        ? (SUBJECT_DATA[subject]?.order[currentBook] ?? null)
        : null;

    /**
     * ★ 五科：**整学段全送**。
     *   不看关键词、不筛节 —— 这五科标签本来就少，筛一遍只会把正确答案筛掉。
     *   排序仍然按"离当前学段多远"，但学段就三个，实际几乎全在同一条线上。
     */
    if (isStageScopeSubject(subject)) {
        return index
            .map<ScoredSection>((entry) => ({
                entry,
                score: 0,
                distance: currentOrder === null ? 0 : bookDistance(entry.bookOrder, currentOrder),
                hits: [],
            }))
            .sort((a, b) => a.distance - b.distance || a.entry.bookOrder - b.entry.bookOrder);
    }

    /* 1. 当前册全册 */
    const chosen: ScoredSection[] = [];
    const seen = new Set<string>();
    const keyOf = (e: SectionEntry) => `${e.book}|${e.chapter}|${e.section}`;

    if (currentBook) {
        for (const entry of index) {
            if (entry.book !== currentBook) continue;
            chosen.push({ entry, score: 0, distance: 0, hits: [] });
            seen.add(keyOf(entry));
        }
    }

    /* 2. 关键词命中的节，只带最近的几册 */
    const found = searchByKeywords(keywords, index).filter((s) => !seen.has(keyOf(s.entry)));

    /**
     * 【2026-11-01】**命中了某一节 ⇒ 把它同章的其他节也带上。**
     *
     * 理由是实测过的：关键词说的是"列方程解决问题"，而题目实际考的是
     * 同一单元里的"解方程"或"等式的性质"。只带命中的那一节，同章的正确项
     * 就根本没进候选 —— 第二段再聪明也选不出来（它不允许发明）。
     *
     * 为什么扩到「章」而不是「整册」：
     *   · 整册是用户最初的设计（"三下整册也送过去"），但那样候选会翻倍；
     *   · 一道题落点几乎总在同一单元内，扩到章就够，每章也就 2–5 节。
     *
     * 扩展进来的节 score=0，排序在命中节之后 —— 候选超上限时先被截掉的是它们。
     */
    const hitChapters = new Set(found.map((s) => `${s.entry.book}|${s.entry.chapter}`));
    const expanded: ScoredSection[] = [...found];
    if (hitChapters.size > 0) {
        const taken = new Set(expanded.map((s) => keyOf(s.entry)));
        for (const entry of index) {
            if (!hitChapters.has(`${entry.book}|${entry.chapter}`)) continue;
            const k = keyOf(entry);
            if (seen.has(k) || taken.has(k)) continue;
            taken.add(k);
            expanded.push({ entry, score: 0, distance: 0, hits: [] });
        }
    }

    const byBook = new Map<string, ScoredSection[]>();
    for (const s of expanded) {
        const list = byBook.get(s.entry.book) ?? [];
        list.push(s);
        byBook.set(s.entry.book, list);
    }
    const bookRank = [...byBook.entries()]
        .map(([book, list]) => ({
            book,
            order: SUBJECT_DATA[subject]?.order[book] ?? 999,
            list,
        }))
        .sort((a, b) => (currentOrder === null ? a.order - b.order : bookDistance(a.order, currentOrder) - bookDistance(b.order, currentOrder)));

    for (const { list } of bookRank.slice(0, maxBooksFromKeywords)) {
        for (const s of list.slice(0, 12)) {
            s.distance = currentOrder === null ? 0 : bookDistance(s.entry.bookOrder, currentOrder);
            chosen.push(s);
            seen.add(keyOf(s.entry));
        }
    }

    /* 3. 排序：当前册在前（distance=0），其余按距离；同距离按命中强度 */
    chosen.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return b.score - a.score;
    });

    return chosen.slice(0, limit);
}

/** 把候选渲染成第二段用的编号清单 */
export function renderCandidates(cands: ScoredSection[], currentBook?: string | null): string {
    return cands
        .map((c, i) => {
            const head = [c.entry.book, c.entry.chapter, c.entry.section].filter(Boolean).join(' · ');
            const mark = currentBook && c.entry.book === currentBook ? '〔当前册〕' : '';
            return `[${i + 1}] ${head}${mark}\n    ${c.entry.tags.join(' / ')}`;
        })
        .join('\n');
}
