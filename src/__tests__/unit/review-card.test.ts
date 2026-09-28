// @vitest-environment node
// 纯逻辑测试：不碰 DOM，跑 node 环境快得多。
import { describe, expect, it } from 'vitest';
import {
    BUILD_DEFAULT_BLANK_LINES,
    REVIEW_BLOCK_SLACK_MM,
    REVIEW_DEFAULT_BLANK_LINES,
    REVIEW_FIGURE_BOX_RATIO,
    FIGURE_SCALE_MAX,
    FIGURE_SCALE_MIN,
    normalizeFigureScale,
    REVIEW_LAYOUT_MM,
    REVIEW_BLANK_LINE_PX,
    REVIEW_PAGE_HEIGHT_MM,
    REVIEW_USABLE_WIDTH_MM,
    VOLUME_COLUMN_MM,
    VOLUME_HEADER_MM,
    VOLUME_VARIANTS,
    applyGlobalBlankLines,
    countSheets,
    effectiveBlankLines,
    normalizeBlankLines,
    paginateMeasured,
    type MeasuredBlock,
} from '@/lib/review-card';

/**
 * 卷的版面常量与分栏分页（纯函数）。
 *
 * ⚠️ 【2026-09-28 第三次改版】这里**不再有"估算高度"的测试** ——
 *    估算那一步已经从代码里删掉了。高度是**外面量好传进来**的，
 *    本文件只验"拿到真实高度之后怎么分栏分页"。
 *    所以下面每个用例里的 `heightMM` 都是"假装量出来是这么多"。
 *
 * 防的还是那几件会印到纸上的错：
 *   · 一道题被拆到两栏/两页（她的写字区被撕成两半）；
 *   · 一栏里的块加起来超过栏高（会被 `overflow: hidden` 切掉下半截）；
 *   · 装不下的题被**静默丢掉**。
 */

const blk = (key: string, heightMM: number): MeasuredBlock => ({ key, heightMM });

describe('卷 · 留白行数', () => {
    it('缺省值：复练 5 行、积累 1 行（他定的）', () => {
        expect(REVIEW_DEFAULT_BLANK_LINES).toBe(5);
        expect(BUILD_DEFAULT_BLANK_LINES).toBe(1);
        expect(VOLUME_VARIANTS.review.defaultBlankLines).toBe(5);
        expect(VOLUME_VARIANTS.build.defaultBlankLines).toBe(1);
    });

    it('夹到合法区间：负数变 0、超大值封顶，非法值退回落点', () => {
        expect(normalizeBlankLines(-3, 5)).toBe(REVIEW_LAYOUT_MM.blankLinesMin);
        expect(normalizeBlankLines(9999, 5)).toBe(REVIEW_LAYOUT_MM.blankLinesMax);
        expect(normalizeBlankLines(null, 5)).toBe(5);
        expect(normalizeBlankLines(undefined, 1)).toBe(1);
        expect(normalizeBlankLines(Number.NaN, 7)).toBe(7);
    });

    it('没单独设过的题 ⇒ 跟着这张卷的缺省走', () => {
        expect(effectiveBlankLines({}, 'a', 'review')).toBe(5);
        expect(effectiveBlankLines({}, 'a', 'build')).toBe(1);
        expect(effectiveBlankLines({ a: 9 }, 'a', 'review')).toBe(9);
        expect(effectiveBlankLines({ a: 9 }, 'b', 'review')).toBe(5);
    });
});

describe('卷 · 整体调留白（他定的规则）', () => {
    it('等于旧缺省值的题跟着变；自己定过别的值的题原样保留', () => {
        const next = applyGlobalBlankLines({ a: null, b: 5, c: 8, d: undefined }, 5, 7);
        expect(next.a).toBe(7);
        expect(next.b).toBe(7);
        expect(next.c).toBe(8);
        expect(next.d).toBe(7);
    });

    it('返回的是**新对象**，不改原来的表', () => {
        const before = { a: 5 };
        const next = applyGlobalBlankLines(before, 5, 9);
        expect(before.a).toBe(5);
        expect(next).not.toBe(before);
    });

    it('连续两次整体调整：第二次跟着第一次走', () => {
        const s1 = applyGlobalBlankLines({ a: null, b: 8 }, 5, 7);
        const s2 = applyGlobalBlankLines(s1, 7, 9);
        expect(s2.a).toBe(9);
        expect(s2.b).toBe(8);
    });
});

describe('卷 · 版面常量', () => {
    it('页高 = 版心 − 2mm；卷头 15mm；内容区 = 页高 − 卷头', () => {
        expect(REVIEW_PAGE_HEIGHT_MM).toBe(225);
        expect(VOLUME_HEADER_MM).toBe(15);
        expect(VOLUME_COLUMN_MM).toBe(210);
    });

    it('复练单栏用整幅（140mm）；积累两栏，每栏约为一半', () => {
        expect(VOLUME_VARIANTS.review.columns).toBe(1);
        expect(VOLUME_VARIANTS.review.columnWidthMM).toBe(REVIEW_USABLE_WIDTH_MM);
        expect(VOLUME_VARIANTS.build.columns).toBe(2);
        expect(VOLUME_VARIANTS.build.columnWidthMM).toBeLessThan(VOLUME_VARIANTS.review.columnWidthMM / 2 + 1);
    });

    it('题图比例在 (0,1) 之间（它是"图占答题区宽度的比例"）', () => {
        expect(REVIEW_FIGURE_BOX_RATIO).toBeGreaterThan(0);
        expect(REVIEW_FIGURE_BOX_RATIO).toBeLessThan(1);
    });

    it('答题区下限 ≥ 升降级小框那一行（7mm），否则小框会被裁掉', () => {
        expect(REVIEW_LAYOUT_MM.answerRowMinMM).toBeGreaterThanOrEqual(7);
    });
});

describe('卷 · 题图缩放（他在预览区拖右下角调的）', () => {
    it('缺省 100%，非法值退回 100%', () => {
        expect(normalizeFigureScale(null)).toBe(100);
        expect(normalizeFigureScale(undefined)).toBe(100);
        expect(normalizeFigureScale(Number.NaN)).toBe(100);
    });

    it('夹在 30–180：再小也留得下一条边，再大不吃掉写字的地方', () => {
        expect(normalizeFigureScale(1)).toBe(FIGURE_SCALE_MIN);
        expect(normalizeFigureScale(9999)).toBe(FIGURE_SCALE_MAX);
        expect(normalizeFigureScale(120)).toBe(120);
    });

    it('⚠️ 上限 180 的来由：55% × 1.8 = 99%，图列不会吃掉留白那半边', () => {
        expect(REVIEW_FIGURE_BOX_RATIO * FIGURE_SCALE_MAX).toBeLessThanOrEqual(100);
        // 再往上放就真的把写字的地方吃掉了（所以必须拦住）
        expect(REVIEW_FIGURE_BOX_RATIO * 200).toBeGreaterThan(100);
    });
});

describe('卷 · 拖虚线调留白（一行的像素）', () => {
    it('一行留白 = 7mm = 约 26.5 屏幕像素（96dpi）', () => {
        expect(REVIEW_BLANK_LINE_PX).toBeCloseTo((7 * 96) / 25.4, 4);
    });

    it('拖够一行的距离才换行；拖不到位不算数（就近取整）', () => {
        const moved = (lines: number) => Math.round((REVIEW_BLANK_LINE_PX * lines) / REVIEW_BLANK_LINE_PX);
        expect(moved(3)).toBe(3);
        expect(moved(0.4)).toBe(0);
        expect(moved(0.6)).toBe(1);
    });

    it('向上拖 = 减行、向下拖 = 加行（他定的方向）', () => {
        // 打印页里是 `startLines - deltaLines`，delta 为 y 位移换算出的行数
        const apply = (startLines: number, dyPx: number) =>
            normalizeBlankLines(startLines - Math.round(dyPx / REVIEW_BLANK_LINE_PX), startLines);
        expect(apply(5, -2 * REVIEW_BLANK_LINE_PX)).toBe(7); // 向下拖两行 ⇒ 5+2
        expect(apply(5, 2 * REVIEW_BLANK_LINE_PX)).toBe(3); // 向上拖两行 ⇒ 5−2
        expect(apply(1, 5 * REVIEW_BLANK_LINE_PX)).toBe(0); // 减到 0 就停住
    });
});

describe('卷 · 分栏分页（吃真实高度）', () => {
    it('短题一页能排不止两道（没有"每页最多两题"这条）', () => {
        const { pages } = paginateMeasured(
            [blk('a', 30), blk('b', 30), blk('c', 30), blk('d', 30), blk('e', 30)],
            'review',
        );
        expect(pages[0].columns[0].blocks.length).toBeGreaterThan(2);
    });

    it('流水号按整卷顺序连续编号（1..n），不跨页重置', () => {
        const { pages } = paginateMeasured([blk('a', 30), blk('b', 30), blk('c', 30)], 'review');
        const seqs = pages.flatMap((p) => p.columns.flatMap((c) => c.blocks.map((b) => b.seq)));
        expect(seqs).toEqual([1, 2, 3]);
    });

    it('装不下 ⇒ **整块推到下一栏**：顺序不变、一个不丢', () => {
        // 每块 80mm，栏高 210mm ⇒ 每栏只能放 2 块
        const { pages } = paginateMeasured([blk('a', 80), blk('b', 80), blk('c', 80), blk('d', 80)], 'review');
        const keys = pages.flatMap((p) => p.columns.flatMap((c) => c.blocks.map((b) => b.key)));
        expect(keys).toEqual(['a', 'b', 'c', 'd']);
        expect(pages.length).toBe(2);
        expect(pages[0].columns[0].blocks.map((b) => b.key)).toEqual(['a', 'b']);
    });

    it('三条不可退让的性质（对任意组合都成立）', () => {
        const combos: MeasuredBlock[][] = [
            [],
            [blk('a', 30)],
            [blk('a', 30), blk('b', 100), blk('c', 20)],
            [blk('x', VOLUME_COLUMN_MM + 40), blk('y', 30)],
            [blk('a', 105), blk('b', 105), blk('c', 105), blk('d', 105)],
        ];
        for (const kind of ['review', 'build'] as const) {
            const variant = VOLUME_VARIANTS[kind];
            for (const blocks of combos) {
                const { pages } = paginateMeasured(blocks, kind);
                for (const page of pages) {
                    // ② 栏数不超过版式规定
                    expect(page.columns.length).toBeLessThanOrEqual(variant.columns);
                    for (const col of page.columns) {
                        // ① 一栏之内装得下（含余量）
                        const sum = col.blocks.reduce((n, b) => n + b.heightMM + REVIEW_BLOCK_SLACK_MM, 0);
                        // 单块就比栏还高的那种，自己独占一栏 ⇒ 允许它"超"，但它必须进 overflow
                        if (sum > VOLUME_COLUMN_MM + 0.01) expect(col.blocks.length).toBe(1);
                    }
                }
                // ③ 每块都出现过（不静默丢题）
                const keys = pages.flatMap((p) => p.columns.flatMap((c) => c.blocks.map((b) => b.key)));
                expect(keys.length).toBe(blocks.length);
            }
        }
    });

    it('积累纸分**两栏**：先排左栏再排右栏', () => {
        const many = Array.from({ length: 8 }, (_, i) => blk(`q${i}`, 60));
        const { pages } = paginateMeasured(many, 'build');
        const first = pages[0];
        expect(first.columns.length).toBe(2);
        expect(first.columns[0].blocks.length).toBeGreaterThan(0);
        expect(first.columns[1].blocks.length).toBeGreaterThan(0);
    });

    it('⚠️ 一栏都装不下的题 ⇒ 记进 overflow（提示改用深挖纸），但**仍然留在纸上**', () => {
        const { pages, overflow } = paginateMeasured([blk('big', VOLUME_COLUMN_MM + 60), blk('a', 30)], 'review');
        expect(overflow.map((o) => o.key)).toEqual(['big']);
        const keys = pages.flatMap((p) => p.columns.flatMap((c) => c.blocks.map((b) => b.key)));
        expect(keys).toContain('big');
    });

    it('空输入 ⇒ 零页（UI 自己去显示"没有选中任何题目"）', () => {
        const { pages, overflow } = paginateMeasured([], 'review');
        expect(pages).toEqual([]);
        expect(overflow).toEqual([]);
        expect(countSheets({ pages, overflow })).toBe(0);
    });

    it('⚠️ 余量只加在**分页判断**上：块高度本身原样返回（渲染按它来）', () => {
        const { pages } = paginateMeasured([blk('a', 33.3)], 'review');
        expect(pages[0].columns[0].blocks[0].heightMM).toBe(33.3);
    });
});
