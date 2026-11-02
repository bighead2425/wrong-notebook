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

    /**
     * 【2026-10-31】模拟真实题 SX20260919001：
     * 「列方程解决问题」只存在于**四年级下**，而 AI 写的是"五年级下" ⇒ 该走回溯。
     */
    { id: 'book4D', name: '四年级下', parentId: null },
    { id: 'chEQ', name: '第五单元 认识方程', parentId: 'book4D' },
    { id: 'secEQ', name: '列方程解决问题', parentId: 'chEQ' },
    { id: 'tEQ', name: '列方程解决问题', parentId: 'secEQ' },
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

describe('resolveOne · 往前追溯（nearby）', () => {
    it('AI 说的册里没有，但别处**唯一**同名 ⇒ 回溯挂上去', () => {
        /* 模拟真实题：AI 写"五年级下"，而这个知识点只在"四年级下" */
        const r = resolve({ book: '五年级下', section: '列方程解决问题', name: '列方程解决问题' });
        expect(r.matchedBy).toBe('nearby');
        expect(r.tagId).toBe('tEQ');
    });

    it('别处有多个同名 ⇒ 仍然是猜，不认（保持"不猜"底线）', () => {
        const r = resolve({ book: '六年级上', name: '轴对称图形' });
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

/* ==========================================================================
 * 【2026-11-02 真真】人点选的节点 —— 带 id 就直接认
 *
 * 空空的现场：
 *   详情页只有「小数的大小比较」→ 点编辑 → 从标签库选「小数减法」→ 确定
 *   → 框里两个标签都在 → 点保存 → **还是只有「小数的大小比较」**。
 *
 * 真因：保存只送名字。`legacy` 分支的规矩是"全库唯一同名才认"，
 *      而「小数减法」在四年级下、五年级上各有一个 ⇒ 两个都不认 ⇒ 一个都没挂上。
 *      顺带 `tagStatus` 也没置 done ⇒ 这道题还掉进了「待归类」队列。
 * ========================================================================== */
describe('resolveOne · human（人点选，带 tagId）', () => {
    /** 「轴对称图形」在五年级上、三年级下各一个 —— 典型的跨册重名 */
    it('同名两个 + 不带 id ⇒ 认不出来（这就是旧行为，必须能复现）', () => {
        const r = resolve({ name: '轴对称图形' });
        expect(r.tagId).toBeNull();
        expect(r.matchedBy).toBe('none');
    });

    it('同名两个 + 带 id ⇒ 直接认，不多问', () => {
        const r = resolve({ name: '轴对称图形', tagId: 't3' });
        expect(r.tagId).toBe('t3');           // 三年级下那个，不是默认的第一个
        expect(r.matchedBy).toBe('human');
    });

    it('带 id 时不看名字 —— 人点的是哪个就是哪个', () => {
        // 名字写得不一样（比如带了括号注），id 对就认
        const r = resolve({ name: '轴对称图形（三下）', tagId: 't3' });
        expect(r.tagId).toBe('t3');
        // 返回的 name 用**库里的真名**，这样落库的 knowledgePoints 是干净的
        expect(r.name).toBe('轴对称图形');
    });

    it('id 在库里查不到 ⇒ 不硬认，继续按名字尽力而为', () => {
        const r = resolve({ name: '独一份的知识点', tagId: 'deleted-node-id' });
        expect(r.tagId).toBe('tOnly');        // 名字唯一 ⇒ legacy 兜住
        expect(r.matchedBy).toBe('legacy');
    });

    it('id 查不到且名字也对不上 ⇒ none（宁可不归类，也不乱挂）', () => {
        const r = resolve({ name: '库里没有这个词', tagId: 'deleted-node-id' });
        expect(r.tagId).toBeNull();
        expect(r.matchedBy).toBe('none');
    });

    it('★ 一次两条（一道题原来的 + 新加的），各按各的 id 挂上', () => {
        const rs = resolveTagRefs(
            [
                { name: '轴对称图形', tagId: 't1' },   // 五年级上（原有）
                { name: '轴对称图形', tagId: 't3' },   // 三年级下（新加，重名）
            ],
            index,
            TAGS,
        );
        expect(rs.map((r) => r.tagId)).toEqual(['t1', 't3']);
        expect(rs.every((r) => r.matchedBy === 'human')).toBe(true);
    });
});
