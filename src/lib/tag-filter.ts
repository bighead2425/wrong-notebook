/**
 * 【2026-11-05 空空】标签筛选集合的"点一下"规则 —— **8 条交互需求全靠它**。
 *
 * 他把需求讲成一串操作，其实归结成一句：
 *   **点一个正在筛的标签 ⇒ 摘掉它；点一个没在筛的标签 ⇒ 加进来。**
 *
 * 把它抽出来单独放，是因为这 8 条里有 4 条是这句话的**推论**：
 *
 * | 他的说法 | 其实就是 |
 * |---|---|
 * | ①③ 点已筛中的标签 ⇒ 该题上这个标签恢复正常 | 从集合里摘掉 |
 * | ⑤ 这道题没有筛选标签了 ⇒ 整道题被剔除 | 后端按"标签交集非空"过滤，自然消失 |
 * | ⑥ 只剩一个标签时点它 ⇒ 退出筛选、全部显示 | 摘掉最后一个 = 空集 = 不筛 |
 * | ⑦ 全部显示时点标签 ⇒ 筛出同标签的题 | 空集加一个 |
 * | ⑧ 筛选中点另一个没参与筛选的标签 ⇒ 它加入筛选（题变多） | 往集合里追加（**并集**，不是交集） |
 *
 * ⚠️ 第 ⑧ 条那个"变多"是并集的必然结果，不是 bug：
 *    筛选语义是"凡是涉及这些标签的题都出来"，不是"同时满足所有标签"。
 */

/**
 * 点一下某个标签之后，新的筛选集合是什么。
 *
 * @param prev  当前的筛选标签 id 集合
 * @param tagId 被点的那个标签 id
 * @returns 新集合（**新数组**，不改入参 —— React 靠引用变化触发更新）
 */
export function toggleFilterTag(prev: readonly string[], tagId: string): string[] {
    return prev.includes(tagId) ? prev.filter((x) => x !== tagId) : [...prev, tagId];
}

/**
 * 这个标签在当前筛选里"算不算亮着"。
 * 单独抽出来是为了卡片和筛选条用**同一个判断**，以后不会一边亮一边不亮。
 */
export function isTagActive(activeTagIds: readonly string[], tagId: string | undefined | null): boolean {
    return !!tagId && activeTagIds.includes(tagId);
}
