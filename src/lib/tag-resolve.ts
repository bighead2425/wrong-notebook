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

export type MatchedBy = 'path' | 'book-name' | 'legacy' | 'none' | 'human';

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

    return { byId, rootNameOf, parentNameOf };
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
    const sameName = tags.filter(
        (t) => t.name === ref.name || normalizeTagName(t.name) === wantName,
    );
    if (sameName.length === 0) return base;

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

        /* 说了册但库里这册没有 → 不跨册乱找，直接放弃 */
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
