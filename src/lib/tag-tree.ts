/**
 * 【2026-11-02 真真】标签树的**三态选中**计算 —— 从 `tag-picker-dialog.tsx` 抽出来的纯逻辑。
 *
 * 为什么要抽：这是"勾父节点 = 勾下面所有知识点"的**唯一判据**，
 * 算错了界面上看不出来，只会表现成"题目数量不对"。放在组件里既没法测、也没法复用。
 *
 * ── 核心规则（空空 2026-11-02 明确）──────────────────────────────────
 *   "如果我选中一个节下一些知识点（不是全部），则这个节一级上面的章（单元）
 *    前面的方框显示为选中但不是都选中状态（半选）。"
 *
 * ⚠️ **每个节点都独立算自己的子树**，不是只看直接子节点：
 *   "第一单元 → 小数乘法 → 3 个知识点，选了 2 个"
 *   ⇒ 小数乘法 = 半选，**第一单元也 = 半选**（因为它的叶子里有 2/更多 被选），
 *     再上面"人教版五年级上册"同样 = 半选。
 *   一路往上都是"部分"，直到某一层的叶子**全被选中**才变全选。
 */

export interface TagNodeLike {
    id: string;
    name: string;
    children: TagNodeLike[];
}

/** 一棵子树里所有**叶子**（题只挂在最末级知识点上，所以三态只数叶子） */
export function leavesOf<T extends TagNodeLike>(node: T): T[] {
    if (node.children.length === 0) return [node];
    return node.children.flatMap((c) => leavesOf(c as T));
}

/**
 * 这个节点当前的三态。
 *
 * @param node      要算的节点
 * @param pickedIds 已选中的**叶子 id** 集合
 * @returns `all` = 子树叶子全选中；`some` = 选中一部分（半选）；`none` = 一个都没选
 *
 * ⚠️ 传进来的 `pickedIds` 里如果混了**非叶子**的 id，对结果没有影响
 *   （只跟 `leavesOf(node)` 里的 id 比对）。
 */
export function tagSelectionState(node: TagNodeLike, pickedIds: ReadonlySet<string>): "all" | "some" | "none" {
    const leaves = leavesOf(node);
    if (leaves.length === 0) return "none";
    const hit = leaves.filter((l) => pickedIds.has(l.id)).length;
    if (hit === 0) return "none";
    return hit === leaves.length ? "all" : "some";
}

/* ==================== 【2026-11-02】检索：命中了要展开到哪一层 ==================== */

export interface TagSearchResult {
    /** 需要展开的节点 id（命中项 + 它们的**全部祖先**） */
    expandIds: string[];
    /** 命中的节点数（同一个词在章名、知识点名里各出现一次就算 2） */
    hits: number;
}

/**
 * 在标签树里找关键字，并算出"要把哪些节点展开"。
 *
 * ── 空空 2026-11-02 的原话 ──────────────────────────────────
 *   "如果检索到的，就展开到检索到的学科、年级（学段）、单元、章节、知识点，
 *    检索到哪一层级就展开那一层级，并将关键字突出显示出来。"
 *
 * ── 规则 ──────────────────────────────────────────────────
 *   · 命中项的**祖先全展开** —— 否则它在折叠的册里，根本看不见；
 *   · 命中项**自己有子节点时也展开** —— 否则只看到"小数乘法"这一行，
 *     看不到它下面具体是哪几个知识点，等于定位到了却停在门外；
 *   · 命中项的**子节点不展开**（除非子节点自己也命中）—— 这就是
 *     "检索到哪一层级就展开那一层级"，不硬撑开无关的下层。
 *
 * @param nodes   一个学科下的整棵树
 * @param keyword 关键字（空/纯空格 ⇒ 不搜，返回空结果）
 */
export function searchTagTree<T extends TagNodeLike>(nodes: T[], keyword: string): TagSearchResult {
    const needle = keyword.trim().toLowerCase();
    const expand = new Set<string>();
    let hits = 0;
    if (!needle) return { expandIds: [], hits: 0 };

    const walk = (list: T[], ancestors: string[]): boolean => {
        let anyHit = false;
        for (const node of list) {
            const selfHit = node.name.toLowerCase().includes(needle);
            const childHit = walk((node.children ?? []) as T[], [...ancestors, node.id]);
            if (selfHit) hits += 1;
            if (selfHit || childHit) {
                anyHit = true;
                for (const a of ancestors) expand.add(a);
                if ((node.children?.length ?? 0) > 0) expand.add(node.id);
            }
        }
        return anyHit;
    };

    walk(nodes, []);
    return { expandIds: [...expand], hits };
}
