/**
 * 知识点坐标 → 库里节点的解析（纯函数，不碰数据库）。
 *
 * 【2026-10-31】为什么单独一层：
 *
 * 原来落库是「拿名字 `findFirst`」——而词表里 38 个知识点跨册重名，
 * 取第一条的结果是**五年级的题挂到二年级**。而且这个错误看起来完全正常：
 * 名字对、关联有、界面不报错，只有统计和出卷在悄悄偏。
 *
 * 现在按 册+节+名 → 册+名 → 唯一同名 三级降级，每级都记 `matchedBy`，
 * 让人能看出"这条到底是稳稳挂上的，还是蒙的"。
 *
 * **一条铁律**：定不了就不定。宁可不归类进待确认，也不许随便挂一个。
 */

import { bookKeyOf } from './ai/tag-scope';
import { normalizeTagName, type TagRef } from './ai/tag-ref';

export type MatchedBy = 'path' | 'book-name' | 'legacy' | 'none' | 'human' | 'nearby';

export interface FlatTag {
    id: string;
    name: string;
    parentId: string | null;
}

export interface ResolverIndex {
    byId: Map<string, FlatTag>;
    /** 节点 id → 顶层祖先的名字（册 / 学段） */
    rootNameOf: Map<string, string>;
    /** 节点 id → 直接父节点的名字（节 / 板块） */
    parentNameOf: Map<string, string | null>;
    /**
     * 【2026-10-31】有子节点的 id 集合。
     *
     * 用它区分「节」和「知识点」：**有子节点的是节，没有的才是知识点**。
     * 真实词表里「列方程解决问题」既是节名又是知识点名，不区分就会在两个节点间摇摆。
     */
    hasChild: Set<string>;
}

export interface ResolvedTag {
    name: string;
    book?: string;
    section?: string;
    tagId: string | null;
    matchedBy: MatchedBy;
}

/** 建索引：一次遍历把每个节点的「册名」和「父名」算好，避免每次都往上爬 */
export function buildResolverIndex(tags: FlatTag[]): ResolverIndex {
    const byId = new Map(tags.map((t) => [t.id, t]));
    const rootNameOf = new Map<string, string>();
    const parentNameOf = new Map<string, string | null>();

    for (const t of tags) {
        parentNameOf.set(t.id, t.parentId ? byId.get(t.parentId)?.name ?? null : null);

        let cur: FlatTag | undefined = t;
        const guard = new Set<string>();
        while (cur?.parentId && !guard.has(cur.id)) {
            guard.add(cur.id);
            const parent = byId.get(cur.parentId);
            if (!parent) break;
            cur = parent;
        }
        rootNameOf.set(t.id, cur?.name ?? t.name);
    }

    const hasChild = new Set<string>();
    for (const t of tags) {
        if (t.parentId) hasChild.add(t.parentId);
    }

    return { byId, rootNameOf, parentNameOf, hasChild };
}

/**
 * 解析一条坐标。
 *
 * 顺序不能换：
 *   1. `path`      册 + 节 + 名 全中 —— 最稳，可以直接信
 *   2. `book-name` 册 + 名 中   —— 册锁住了，至少不会挂错册；节错了影响统计但不影响归属
 *   3. `legacy`    **全库只有一个**同名节点才认 —— 没有歧义才叫"匹配"，有歧义就是猜
 *   4. `none`      其余一律不认
 */
export function resolveOne(ref: TagRef, index: ResolverIndex, tags: FlatTag[]): ResolvedTag {
    const base: ResolvedTag = {
        name: ref.name,
        book: ref.book,
        section: ref.section,
        tagId: null,
        matchedBy: 'none',
    };

    const wantName = normalizeTagName(ref.name);
    const sameNameAll = tags.filter(
        (t) => t.name === ref.name || normalizeTagName(t.name) === wantName,
    );
    if (sameNameAll.length === 0) return base;

    /**
     * 【2026-10-31】同名时**优先取知识点（叶子），不要取节**。
     *
     * 真实词表里「列方程解决问题」既是节名、又是这一节里一个知识点的名字，
     * 于是同名节点有两个（一个是节，一个是点）。不区分的话：
     *   · 回溯时"唯一"条件永远不成立（两个都在同一册）⇒ 整题 none；
     *   · 挂上去的可能是节而不是知识点。
     * 有子节点的是节，没有的才是知识点 —— 用它一刀切开。
     */
    const leaves = sameNameAll.filter((t) => !index.hasChild.has(t.id));
    const sameName = leaves.length > 0 ? leaves : sameNameAll;

    /* 高三上/下 与 高三 是同一册；其余学科原样 */
    const bookKey = ref.book ? bookKeyOf(ref.book) : null;

    if (bookKey) {
        const inBook = sameName.filter((t) => index.rootNameOf.get(t.id) === bookKey);

        if (ref.section) {
            const wantSection = normalizeTagName(ref.section);
            const exact = inBook.find(
                (t) => normalizeTagName(index.parentNameOf.get(t.id) ?? '') === wantSection,
            );
            if (exact) return { ...base, tagId: exact.id, matchedBy: 'path' };
        }

        if (inBook.length > 0) {
            return { ...base, tagId: inBook[0].id, matchedBy: 'book-name' };
        }

        /**
         * 【2026-10-31 真实题评测发现】**往前追溯**。
         *
         * 他最早的原话：
         *   "如果没有当前学年学期的，则往前追溯，离得越近的则越能命中。"
         *
         * 真实题 SX20260919001（长安塔·一元一次方程应用）就是这个情形：
         * AI 写 book="五年级下"，而「认识方程」在**四年级下**。
         * 原来的规则是"说了册、那册没有 ⇒ 直接放弃"⇒ 整题 none，
         * 于是这道**明显属于认识方程**的题连知识点都挂不上。
         *
         * 规矩（保守版）：
         *   · 在**其他册**里找同名节点；
         *   · **只有一个**才认（多个同名仍然是猜，不认）——保持"不猜"这条底线；
         *   · 命中时标记 `nearby`，界面上能看出"这是回溯挂的"，人可复核。
         */
        const elsewhere = sameName.filter((t) => index.rootNameOf.get(t.id) !== bookKey);
        if (elsewhere.length === 1) {
            return { ...base, tagId: elsewhere[0].id, matchedBy: 'nearby' };
        }

        /* 说了册但库里这册没有，且别处也不唯一 → 不跨册乱找，直接放弃 */
        return base;
    }

    /* 没有册信息：只有唯一同名才敢认（旧格式走这里） */
    if (sameName.length === 1) {
        return { ...base, tagId: sameName[0].id, matchedBy: 'legacy' };
    }

    return base;
}

export function resolveTagRefs(refs: TagRef[], index: ResolverIndex, tags: FlatTag[]): ResolvedTag[] {
    return refs.map((r) => resolveOne(r, index, tags));
}
