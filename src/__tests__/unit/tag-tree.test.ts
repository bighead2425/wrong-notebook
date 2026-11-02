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
import { leavesOf, tagSelectionState, type TagNodeLike } from '@/lib/tag-tree';

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
