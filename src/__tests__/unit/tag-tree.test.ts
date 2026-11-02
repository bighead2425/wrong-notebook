/**
 * 【2026-11-02 真真】标签树三态选中 —— 钉住"半选往上传染"这条。
 *
 * 空空当天指出我画图画错了：
 *   "小数乘法下面 3 个知识点，选了 2 个 ⇒ 上面『人教版五年级上册』是半选没问题，
 *    但下面『第一单元』也应该是半选、『小数乘法』也应该是半选才对啊。
 *    是你图画错了、是我说的不对、还是开发出问题了？"
 *
 * **答：我图画错了，代码是对的。** 这几条测试就是证明 ——
 * 每个节点都独立算**自己子树**的叶子，所以"部分选中"会一路往上都是半选，
 * 直到某一层叶子全被选中才变全选。
 */

import { describe, expect, it } from 'vitest';
import { leavesOf, searchTagTree, tagSelectionState, type TagNodeLike } from '@/lib/tag-tree';

/** 造一棵与截图同构的树：
 *  人教版五年级上册
 *    第一单元
 *      小数乘法
 *        小数乘整数 / 小数乘小数 / 积的近似数
 *      位置
 *        用数对表示位置
 */
function makeTree(): TagNodeLike {
    return {
        id: 'book',
        name: '人教版五年级上册',
        children: [
            {
                id: 'unit1',
                name: '第一单元',
                children: [
                    {
                        id: 'mul',
                        name: '小数乘法',
                        children: [
                            { id: 'a', name: '小数乘整数', children: [] },
                            { id: 'b', name: '小数乘小数', children: [] },
                            { id: 'c', name: '积的近似数', children: [] },
                        ],
                    },
                    {
                        id: 'pos',
                        name: '位置',
                        children: [{ id: 'd', name: '用数对表示位置', children: [] }],
                    },
                ],
            },
        ],
    };
}

const find = (node: TagNodeLike, id: string): TagNodeLike => {
    if (node.id === id) return node;
    for (const c of node.children) {
        const hit = find(c, id);
        if (hit.id === id) return hit;
    }
    return node;
};

describe('标签树 · 三态选中', () => {
    it('leavesOf：只收最末级，中间层不算', () => {
        const ids = leavesOf(makeTree()).map((l) => l.id);
        expect(ids).toEqual(['a', 'b', 'c', 'd']);
    });

    it('★ 3 个知识点选了 2 个 ⇒ 小数乘法是**半选**', () => {
        const tree = makeTree();
        const picked = new Set(['a', 'b']);
        expect(tagSelectionState(find(tree, 'mul'), picked)).toBe('some');
    });

    it('★★ 同一个场景 ⇒ **第一单元也是半选**（这是空空指出的那条）', () => {
        const tree = makeTree();
        const picked = new Set(['a', 'b']);
        expect(tagSelectionState(find(tree, 'unit1'), picked)).toBe('some');
    });

    it('★★ 再往上一级 ⇒ 人教版五年级上册同样是半选', () => {
        const tree = makeTree();
        const picked = new Set(['a', 'b']);
        expect(tagSelectionState(find(tree, 'book'), picked)).toBe('some');
    });

    it('★ 一条分支全选、另一条没选 ⇒ 中间层仍是半选', () => {
        const tree = makeTree();
        // 小数乘法 3 个全选，位置那个没选
        const picked = new Set(['a', 'b', 'c']);
        expect(tagSelectionState(find(tree, 'mul'), picked)).toBe('all'); // 它自己这条满了
        expect(tagSelectionState(find(tree, 'unit1'), picked)).toBe('some'); // 但单元里还有位置没选
        expect(tagSelectionState(find(tree, 'book'), picked)).toBe('some');
    });

    it('全部叶子都选中 ⇒ 一路上来都是 all', () => {
        const tree = makeTree();
        const picked = new Set(['a', 'b', 'c', 'd']);
        expect(tagSelectionState(find(tree, 'mul'), picked)).toBe('all');
        expect(tagSelectionState(find(tree, 'unit1'), picked)).toBe('all');
        expect(tagSelectionState(find(tree, 'book'), picked)).toBe('all');
    });

    it('一个都没选 ⇒ 全是 none', () => {
        const tree = makeTree();
        const picked = new Set<string>();
        expect(tagSelectionState(find(tree, 'mul'), picked)).toBe('none');
        expect(tagSelectionState(find(tree, 'book'), picked)).toBe('none');
    });

    it('叶子自己：选中 = all，没选 = none（叶子没有"半选"）', () => {
        const tree = makeTree();
        expect(tagSelectionState(find(tree, 'a'), new Set(['a']))).toBe('all');
        expect(tagSelectionState(find(tree, 'a'), new Set<string>())).toBe('none');
    });

    it('pickedIds 里混了非叶子 id 也不影响结果', () => {
        const tree = makeTree();
        // 混进 "mul"（非叶子）—— 不该让 mul 变成 all
        expect(tagSelectionState(find(tree, 'mul'), new Set(['mul']))).toBe('none');
    });
});

/* ==========================================================================
 * 【2026-11-02】检索：命中后要展开到哪一层
 *
 * 空空原话：
 *   "如果检索到的，就展开到检索到的学科、年级（学段）、单元、章节、知识点，
 *    检索到哪一层级就展开那一层级。"
 * ========================================================================== */

describe('searchTagTree', () => {
    /** 一棵 8 层深、跟真实词表同构的树：册 → 单元 → 节 → 知识点 */
    const book = (): TagNodeLike => ({
        id: 'book',
        name: '人教版五年级上册',
        children: [
            {
                id: 'unit1',
                name: '第一单元 小数的再认识和加减法',
                children: [
                    {
                        id: 'mul',
                        name: '小数乘法',
                        children: [
                            { id: 'a', name: '小数乘整数', children: [] },
                            { id: 'b', name: '小数乘小数', children: [] },
                        ],
                    },
                    {
                        id: 'sub',
                        name: '小数减法',
                        children: [{ id: 's1', name: '小数减法的竖式', children: [] }],
                    },
                ],
            },
            { id: 'unit2', name: '第二单元 位置', children: [] },
        ],
    });

    it('命中知识点 ⇒ 祖先一路展开到顶（否则它在折叠的册里看不见）', () => {
        const { expandIds, hits } = searchTagTree([book()], '小数乘整数');
        expect(hits).toBe(1);
        // 祖先一路到顶 —— 缺任何一层，那个知识点都还是藏在折叠里
        expect(expandIds).toContain('mul');
        expect(expandIds).toContain('unit1');
        expect(expandIds).toContain('book');
        /**
         * ⚠️ 命中的**叶子自己不进展开集合** —— 叶子没有可展开的东西，
         *    父节点（`mul`）展开了它自然就露出来了。加进去只是往
         *    `expandedNodes` 里塞一堆无意义的键。
         */
        expect(expandIds).not.toContain('a');
    });

    it('命中"节" ⇒ 展开到节为止，节下面的知识点不硬撑开', () => {
        const { expandIds, hits } = searchTagTree([book()], '小数减法');
        /**
         * 节名「小数减法」+ 子节点「小数减法的竖式」都含这个词 ⇒ 2 处。
         * 但**「小数乘法」不能出现在结果里** —— 它没命中。
         */
        expect(hits).toBe(2);                       // 节名 1 处 + 子节点名 1 处
        expect(expandIds).toContain('sub');          // 节自己被展开 ⇒ 下面露出来
        expect(expandIds).not.toContain('mul');      // 没命中的兄弟分支不许被撑开
        expect(expandIds).not.toContain('a');
        /**
         * 再钉一条边界：**没命中任何东西的分支，一个都不能进展开集合**。
         * 否则"搜一个词、整个词表全开" —— 那就不叫检索了。
         */
        expect(expandIds).not.toContain('unit2');
    });

    it('命中单元 ⇒ 只展开它和祖先，兄弟单元不动', () => {
        const { expandIds, hits } = searchTagTree([book()], '第二单元');
        expect(hits).toBe(1);
        // 「第二单元 位置」是叶子（没挂子节点）⇒ 只有它的祖先要展开
        expect(expandIds).toEqual(['book']);
        expect(expandIds).not.toContain('unit1');
    });

    it('大小写不敏感（英语学科的词表是英文）', () => {
        const tree: TagNodeLike[] = [
            { id: 'x', name: 'Present Simple', children: [{ id: 'y', name: 'be动词', children: [] }] },
        ];
        const { hits, expandIds } = searchTagTree(tree, 'present');
        expect(hits).toBe(1);
        expect(expandIds).toContain('x');
    });

    it('关键词两边的空格不算数', () => {
        const { hits } = searchTagTree([book()], '  位置  ');
        expect(hits).toBe(1);
    });

    it('一个都没命中 ⇒ 空结果（界面据此说"没找到"）', () => {
        const { expandIds, hits } = searchTagTree([book()], '微积分');
        expect(hits).toBe(0);
        expect(expandIds).toEqual([]);
    });

    it('空关键词 ⇒ 不搜（这是"点搜索但不填内容 = 全部收起"的依据）', () => {
        expect(searchTagTree([book()], '')).toEqual({ expandIds: [], hits: 0 });
        expect(searchTagTree([book()], '   ')).toEqual({ expandIds: [], hits: 0 });
    });

    it('多个学科分开算，各自只展开自己的分支', () => {
        const math = book();
        const chinese: TagNodeLike = {
            id: 'cn',
            name: '人教版五年级上册',
            children: [{ id: 'cn1', name: '阅读理解', children: [] }],
        };
        const r = searchTagTree([math], '小数');
        const r2 = searchTagTree([chinese], '小数');
        expect(r.hits).toBeGreaterThan(0);
        expect(r2.hits).toBe(0);
        expect(r2.expandIds).toEqual([]);
    });
});
