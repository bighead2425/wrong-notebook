// @vitest-environment node
// 纯逻辑测试：不碰 DOM、不碰数据库。
import { describe, expect, it } from 'vitest';
import { paginateImitate, imitatePageCount, type ImitateSegment } from '@/lib/imitate-card';
import { VOLUME_COLUMN_MM } from '@/lib/review-card';

/**
 * 模仿纸的分页 —— 他 2026-10-10 定的规矩。
 *
 * 这张纸跟另外三种**最不一样**的地方就在分页：
 *   左栏（主题的题干/图/答案/解析）**可以顺延到下一页**，
 *   右栏（附题）却**一道题都不许跨页**。
 * 两套规矩并存，还要合成同一批页 —— 这类"两条流"的算法最容易悄悄错
 * （错法是"某一侧少印了一段"或"流水号断了"），所以逐条钉住。
 *
 * ⚠️ 所有高度都按 `VOLUME_COLUMN_MM` 的**比例**算，**不写死 mm 数字** ——
 *    哪天版面常量改了，这些用例照样成立（写死数字就得改一堆测试，且改的人容易改错）。
 */

const USABLE = VOLUME_COLUMN_MM;

/** 造一段（kind 对分页没影响，这里统一用 text） */
const seg = (n: number | string, ratio: number): ImitateSegment => ({
    key: `s${n}`,
    kind: 'text',
    heightMM: USABLE * ratio,
});

describe('模仿纸分页：左栏（主题内容）能顺延，右栏（附题）不跨页', () => {
    it('左栏装不下就顺延到下一页（段不切开、不丢内容）', () => {
        // 每段占 60% 栏高 ⇒ 一段之后就装不下第二段
        const layout = paginateImitate([seg(1, 0.6), seg(2, 0.6), seg(3, 0.6)], []);
        expect(layout.sheets.length).toBe(3);
        expect(layout.sheets[0].left.map((s) => s.key)).toEqual(['s1']);
        expect(layout.sheets[1].left.map((s) => s.key)).toEqual(['s2']);
        expect(layout.sheets[2].left.map((s) => s.key)).toEqual(['s3']);
    });

    it('右栏一道题绝不跨页（放不下就整道换页）', () => {
        const layout = paginateImitate(
            [],
            [
                { key: 'a', heightMM: USABLE * 0.6 },
                { key: 'b', heightMM: USABLE * 0.6 },
            ],
        );
        expect(layout.sheets.length).toBe(2);
        expect(layout.sheets[0].right.map((b) => b.key)).toEqual(['a']);
        expect(layout.sheets[1].right.map((b) => b.key)).toEqual(['b']);
    });

    it('★ 页数 = 两条流里大的那个；先放完的那一侧，后面几页就是空的', () => {
        const layout = paginateImitate(
            [seg(1, 0.6), seg(2, 0.6), seg(3, 0.6)],
            [{ key: 'a', heightMM: USABLE * 0.6 }],
        );
        expect(layout.sheets.length).toBe(3);
        expect(layout.sheets[0].right.map((b) => b.key)).toEqual(['a']);
        // 第 2、3 页右栏是空的（不是"没生成页"，而是那侧先放完了）
        expect(layout.sheets[1].right).toEqual([]);
        expect(layout.sheets[2].right).toEqual([]);
        // 左栏三段一段不缺
        expect(layout.sheets.flatMap((s) => s.left.map((x) => x.key))).toEqual(['s1', 's2', 's3']);
    });

    it('单段比整栏还高 ⇒ 让它独占一页（宁可溢一点，也不能把内容从纸上弄丢）', () => {
        const layout = paginateImitate([{ key: 'long', kind: 'text', heightMM: USABLE * 1.4 }], []);
        expect(layout.sheets.length).toBe(1);
        expect(layout.sheets[0].left.map((s) => s.key)).toEqual(['long']);
        // 左栏的段**不会**进 overflow —— 那是右栏附题才有的概念
        expect(layout.overflowRight).toEqual([]);
    });

    it('附题一栏都装不下 ⇒ 进 overflowRight（界面据此提示"改用深挖纸"），且流水号照样往前走', () => {
        const layout = paginateImitate(
            [],
            [
                { key: 'a', heightMM: USABLE * 0.6 },
                { key: 'huge', heightMM: USABLE * 2 },
                { key: 'b', heightMM: USABLE * 0.6 },
            ],
        );
        expect(layout.overflowRight.map((o) => o.key)).toEqual(['huge']);
        // a 在第 1 页（流水号 1）；huge 排不下但不占位；b 排到第 2 页，流水号仍是 3（不断号）
        expect(layout.sheets[0].right.map((x) => [x.key, x.seq])).toEqual([['a', 1]]);
        expect(layout.sheets[1].right.map((x) => [x.key, x.seq])).toEqual([['b', 3]]);
    });

    it('预留页脚高度会真的从可用高度里扣掉（否则"最后一屏"会溢出纸面）', () => {
        const two = [seg(1, 0.5), seg(2, 0.5)];
        // 不预留：两段正好凑满一页
        expect(paginateImitate(two, []).sheets.length).toBe(1);
        // 预留 30%：第二段就装不下了
        expect(paginateImitate(two, [], USABLE * 0.3).sheets.length).toBe(2);
    });

    it('空卷也要有一张纸（界面上是"第 1 / 1 页"，不是 0 页）', () => {
        const layout = paginateImitate([], []);
        expect(layout.sheets.length).toBe(1);
        expect(layout.sheets[0]).toEqual({ left: [], right: [] });
        expect(imitatePageCount(layout)).toBe(1);
    });

    it('段的顺序一个都不能乱（题干 → 图 → 遮挡线 → 答案 → 解析 就是这个顺序）', () => {
        const segs: ImitateSegment[] = [1, 2, 3, 4, 5].map((n) => seg(n, 0.2));
        const layout = paginateImitate(segs, []);
        expect(layout.sheets.flatMap((s) => s.left.map((x) => x.key))).toEqual([
            's1',
            's2',
            's3',
            's4',
            's5',
        ]);
    });
});
