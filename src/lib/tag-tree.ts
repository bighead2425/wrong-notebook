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
