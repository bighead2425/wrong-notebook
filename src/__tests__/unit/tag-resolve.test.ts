import { describe, expect, it } from 'vitest';
import { buildResolverIndex, resolveTagRefs, type FlatTag } from '@/lib/tag-resolve';
import type { TagRef } from '@/lib/ai/tag-ref';

/**
 * 三级降级的最小样本。
 *
 * 结构故意做成"同名跨册 + 同册跨节"，因为真实词表就是这样：
 * 数学 640 条里有 38 个名字在不同册重复出现。
 */
const TAGS: FlatTag[] = [
    { id: 'book5', name: '五年级上', parentId: null },
    { id: 'ch1', name: '第一单元', parentId: 'book5' },
    { id: 'sec1', name: '轴对称与旋转', parentId: 'ch1' },
    { id: 't1', name: '轴对称图形', parentId: 'sec1' },
    { id: 't2', name: '图形的旋转', parentId: 'sec1' },

    { id: 'book3', name: '三年级下', parentId: null },
    { id: 'ch2', name: '图形的运动', parentId: 'book3' },
    { id: 'sec2', name: '认识轴对称', parentId: 'ch2' },
    { id: 't3', name: '轴对称图形', parentId: 'sec2' },

    { id: 'bookG', name: '高三', parentId: null },
    { id: 'chG', name: '导数及其应用', parentId: 'bookG' },
    { id: 'secG', name: '导数的概念', parentId: 'chG' },
    { id: 'tG', name: '导数的几何意义', parentId: 'secG' },

    { id: 'tOnly', name: '独一份的知识点', parentId: 'sec1' },
];

const index = buildResolverIndex(TAGS);
const resolve = (ref: TagRef) => resolveTagRefs([ref], index, TAGS)[0];

describe('resolveOne · 第一级 path（册 + 节 + 名）', () => {
    it('三段全中 ⇒ 挂到那一节', () => {
        const r = resolve({ book: '五年级上', section: '轴对称与旋转', name: '轴对称图形' });
        expect(r.matchedBy).toBe('path');
        expect(r.tagId).toBe('t1');
    });

    it('同名跨册时，册说对了就不会挂错', () => {
        const r = resolve({ book: '三年级下', section: '认识轴对称', name: '轴对称图形' });
        expect(r.matchedBy).toBe('path');
        expect(r.tagId).toBe('t3');
    });
});

describe('resolveOne · 第二级 book-name（册 + 名）', () => {
    it('节抄错了，但册对 ⇒ 至少不挂错册', () => {
        const r = resolve({ book: '三年级下', section: '不存在的节', name: '轴对称图形' });
        expect(r.matchedBy).toBe('book-name');
        expect(r.tagId).toBe('t3');
    });
});

describe('resolveOne · 第三级 legacy（唯一同名）', () => {
    it('没有册信息但全库只有一条 ⇒ 认', () => {
        const r = resolve({ name: '独一份的知识点', legacy: true });
        expect(r.matchedBy).toBe('legacy');
        expect(r.tagId).toBe('tOnly');
    });

    it('没有册信息且同名多条 ⇒ **不猜**，交给待确认', () => {
        const r = resolve({ name: '轴对称图形', legacy: true });
        expect(r.matchedBy).toBe('none');
        expect(r.tagId).toBeNull();
    });
});

describe('resolveOne · 定不了就不定', () => {
    it('册说了但库里没这册 ⇒ 不跨册乱找', () => {
        const r = resolve({ book: '六年级上', name: '轴对称图形' });
        expect(r.matchedBy).toBe('none');
        expect(r.tagId).toBeNull();
    });

    it('名字完全不存在 ⇒ none', () => {
        const r = resolve({ book: '五年级上', name: '量子力学' });
        expect(r.matchedBy).toBe('none');
    });

    it('AI 加了括号补充，靠归一认出是同一个', () => {
        const r = resolve({
            book: '五年级上',
            section: '轴对称与旋转',
            name: '轴对称图形（沿一条直线对折）',
        });
        expect(r.matchedBy).toBe('path');
        expect(r.tagId).toBe('t1');
    });
});

describe('resolveOne · 高三只有一册', () => {
    it('「高三上」归一到「高三」，能挂上而不是整册找不到', () => {
        const r = resolve({ book: '高三上', section: '导数的概念', name: '导数的几何意义' });
        expect(r.matchedBy).toBe('path');
        expect(r.tagId).toBe('tG');
    });

    it('「高三下」同样归一', () => {
        const r = resolve({ book: '高三下', name: '导数的几何意义' });
        expect(r.matchedBy).toBe('book-name');
        expect(r.tagId).toBe('tG');
    });
});
