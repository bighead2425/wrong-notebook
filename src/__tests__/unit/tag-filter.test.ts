/**
 * 【2026-11-05 空空】8 条标签筛选交互的规则钉。
 *
 * 他把需求讲成 8 条操作，本质是一句：**在筛就摘掉，不在筛就加进来**。
 * 这里按他的原话逐条对回去，免得以后有人"顺手优化"掉其中一条。
 */

import { describe, it, expect } from 'vitest';
import { toggleFilterTag, isTagActive } from '@/lib/tag-filter';

describe('toggleFilterTag —— 点一下标签', () => {
    /** ⑦ 全部显示时点标签 ⇒ 筛出同标签的题 */
    it('空集 + 点一个 ⇒ 只用它筛', () => {
        expect(toggleFilterTag([], 'a')).toEqual(['a']);
    });

    /** ⑥ 只剩一个时点它 ⇒ 退出筛选、全部显示 */
    it('只有一个 + 点它 ⇒ 空集（退出筛选）', () => {
        expect(toggleFilterTag(['a'], 'a')).toEqual([]);
    });

    /** ③ 点已筛中的标签 ⇒ 摘掉它 */
    it('多个里点其中一个 ⇒ 只摘掉它，其余不动', () => {
        expect(toggleFilterTag(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    });

    /** ⑧ 筛选中点另一个没参与的标签 ⇒ 加进来（题变多，并集） */
    it('申选中点一个没参与的 ⇒ 追加', () => {
        expect(toggleFilterTag(['a'], 'b')).toEqual(['a', 'b']);
    });

    /**
     * ④ 一道题因多个标签被选中，摘掉一个之后**其他仍然亮着** ——
     *    这条不是"单独的逻辑"，而是"只摘掉被点的那个"的必然结果。
     */
    it('摘掉一个不会连带清空其他（第 4 条）', () => {
        expect(toggleFilterTag(['a', 'b'], 'a')).toEqual(['b']);
    });

    /** React 靠引用变化触发更新 ⇒ 必须返回新数组 */
    it('返回新数组，不改入参', () => {
        const prev = ['a'];
        const next = toggleFilterTag(prev, 'b');
        expect(prev).toEqual(['a']);
        expect(next).not.toBe(prev);
    });
});

describe('isTagActive —— 这个标签算不算亮着', () => {
    it('在集合里 ⇒ 亮', () => {
        expect(isTagActive(['a', 'b'], 'a')).toBe(true);
    });
    it('不在集合里 ⇒ 不亮', () => {
        expect(isTagActive(['a'], 'b')).toBe(false);
    });
    /** 老数据没有 tag.id ⇒ 不能因为 "undefined 匹配" 就误亮 */
    it('没有 id ⇒ 一律不亮', () => {
        expect(isTagActive(['a'], undefined)).toBe(false);
        expect(isTagActive(['a'], null)).toBe(false);
    });
});
