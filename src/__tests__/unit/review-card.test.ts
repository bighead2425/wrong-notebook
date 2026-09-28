// @vitest-environment node
// 纯逻辑测试：不碰 DOM，跑 node 环境快得多。
import { describe, expect, it } from 'vitest';
import {
    BUILD_DEFAULT_BLANK_LINES,
    REVIEW_DEFAULT_BLANK_LINES,
    REVIEW_LAYOUT_MM,
    REVIEW_PAGE_HEIGHT_MM,
    VOLUME_COLUMN_MM,
    VOLUME_VARIANTS,
    applyGlobalBlankLines,
    effectiveBlankLines,
    estimateTextLines,
    layoutReviewSheets,
    measureBlock,
    normalizeBlankLines,
    type ReviewQuestionSpec,
} from '@/lib/review-card';

/**
 * 卷的版面与分页（纯函数）。
 *
 * 这些测试防的是**肉眼看不出来、却会被印到纸上**的错：
 *   · 一道题被拆到两页（她的写字区被撕成两半）；
 *   · 算着放得下、印出来溢出（估算与实际不一致）；
 *   · "整体调留白"把已经单独调过的题也一起改掉；
 *   · 积累纸该分两栏却没分（或者分了栏但宽度还算成整幅）。
 */

const spec = (over: Partial<ReviewQuestionSpec> & { key: string }): ReviewQuestionSpec => ({
    questionText: '一个长方形的长是 8 厘米，宽是 5 厘米，求它的周长。',
    figureHeightMM: 0,
    ...over,
});

const textOfLines = (lines: number, charsPerLine: number) => '字'.repeat(lines * charsPerLine);

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
        const before = { a: null, b: 5, c: 8, d: undefined };
        const next = applyGlobalBlankLines(before, 5, 7);
        // a（没设过 = 跟着缺省）、b（正好等于旧缺省）⇒ 一起变 7
        expect(next.a).toBe(7);
        expect(next.b).toBe(7);
        // c 自己定过 8 ≠ 5 ⇒ 不动；d 没设过也跟缺省
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
        expect(s2.a).toBe(9); // a 第一次变 7（= 当时的缺省），第二次继续跟
        expect(s2.b).toBe(8); // b 一直没动
    });
});

describe('卷 · 度量（答题区 = max(题图, 留白行数)）', () => {
    it('没有题图时，答题区高度就是留白行数 × 行高', () => {
        const b = measureBlock(spec({ key: 'a' }), 'review', 1);
        expect(b.blankLines).toBe(5);
        expect(b.rowHeightMM).toBeCloseTo(5 * REVIEW_LAYOUT_MM.blankLineMM, 3);
    });

    it('题图比留白高 ⇒ 听题图的', () => {
        const b = measureBlock(spec({ key: 'a', figureHeightMM: 45 }), 'review', 1);
        expect(b.rowHeightMM).toBeCloseTo(45, 3);
    });

    it('题图比留白矮 ⇒ 听留白的（图仍按自己高度印，不拉伸）', () => {
        const b = measureBlock(spec({ key: 'a', figureHeightMM: 12 }), 'review', 1);
        expect(b.figureHeightMM).toBeCloseTo(12, 3);
        expect(b.rowHeightMM).toBeCloseTo(5 * REVIEW_LAYOUT_MM.blankLineMM, 3);
    });

    it('题图过高时**先缩图**，缩得下就不算"印不了"', () => {
        const b = measureBlock(
            spec({
                key: 'a',
                questionText: textOfLines(20, VOLUME_VARIANTS.review.charsPerLine),
                figureHeightMM: 200,
            }),
            'review',
            1,
        );
        expect(b.figureHeightMM).toBeLessThan(200);
        expect(b.overflow).toBe(false);
        expect(b.contentHeightMM).toBeLessThanOrEqual(VOLUME_COLUMN_MM + 0.01);
    });

    it('题干本身就超过一整栏 ⇒ overflow（UI 据此提示改用深挖纸），不静默丢题', () => {
        const b = measureBlock(
            spec({
                key: 'a',
                questionText: textOfLines(80, VOLUME_VARIANTS.review.charsPerLine),
            }),
            'review',
            1,
        );
        expect(b.overflow).toBe(true);
        // 即便如此，块高也不会超过一栏（免得把后面全挤下去）
        expect(b.contentHeightMM).toBeLessThanOrEqual(VOLUME_COLUMN_MM + 0.01);
    });
});

describe('卷 · 分页（尽量多排、绝不跨页）', () => {
    const short = (key: string): ReviewQuestionSpec => spec({ key, questionText: '口算：12 + 7 =' });

    it('取消"每页最多两题"：短题一页能排不止两道', () => {
        const { pages } = layoutReviewSheets([short('a'), short('b'), short('c'), short('d')], 'review');
        expect(pages.length).toBeGreaterThanOrEqual(1);
        expect(pages[0].columns[0].blocks.length).toBeGreaterThan(2);
    });

    it('流水号按整卷顺序连续编号（1..n），不跨页重置', () => {
        const { pages } = layoutReviewSheets([short('a'), short('b'), short('c')], 'review');
        const seqs = pages.flatMap((p) => p.columns.flatMap((c) => c.blocks.map((b) => b.seq)));
        expect(seqs).toEqual([1, 2, 3]);
    });

    it('三条不可退让的性质（对任意组合都成立）', () => {
        const combos: ReviewQuestionSpec[][] = [
            [],
            [short('a')],
            [short('a'), spec({ key: 'b', figureHeightMM: 45 }), short('c')],
            [
                spec({ key: 'x', questionText: textOfLines(30, 26), figureHeightMM: 40 }),
                short('y'),
                spec({ key: 'z', questionText: textOfLines(60, 26) }),
            ],
        ];
        for (const kind of ['review', 'build'] as const) {
            const variant = VOLUME_VARIANTS[kind];
            for (const specs of combos) {
                const { pages } = layoutReviewSheets(specs, kind);
                for (const page of pages) {
                    // ② 栏数不超过版式规定（复练 1、积累 2）
                    expect(page.columns.length).toBeLessThanOrEqual(variant.columns);
                    for (const col of page.columns) {
                        const sum = col.blocks.reduce((n, b) => n + b.contentHeightMM, 0);
                        // ① 一栏之内装得下：加起来不许超过栏高
                        expect(sum).toBeLessThanOrEqual(VOLUME_COLUMN_MM + 0.01);
                        for (const b of col.blocks) {
                            expect(b.contentHeightMM).toBeLessThanOrEqual(VOLUME_COLUMN_MM + 0.01);
                        }
                    }
                }
            }
        }
    });

    it('装不下的题**整块顺延**，绝不拆开（顺序不变、一个不丢）', () => {
        const specs = [short('a'), short('b'), spec({ key: 'big', questionText: textOfLines(40, 26) }), short('d')];
        const { pages } = layoutReviewSheets(specs, 'review');
        const keys = pages.flatMap((p) => p.columns.flatMap((c) => c.blocks.map((b) => b.key)));
        expect(keys).toEqual(['a', 'b', 'big', 'd']);
    });

    it('积累纸分**两栏**：先排左栏再排右栏', () => {
        const specs = Array.from({ length: 8 }, (_, i) => short(`q${i}`));
        const { pages } = layoutReviewSheets(specs, 'build');
        const first = pages[0];
        expect(first.columns.length).toBeLessThanOrEqual(2);
        if (first.columns.length === 2) {
            expect(first.columns[0].blocks.length).toBeGreaterThan(0);
            expect(first.columns[1].blocks.length).toBeGreaterThan(0);
        }
    });

    it('页高 = 版心 − 2mm（防"前面多一张白纸"的老教训）', () => {
        expect(REVIEW_PAGE_HEIGHT_MM).toBe(225);
        expect(VOLUME_COLUMN_MM).toBeLessThan(REVIEW_PAGE_HEIGHT_MM);
    });
});

describe('卷 · 行数估算', () => {
    it('短题一行、空题零行、长题不封顶（封顶会导致"算着放得下、印出来溢出"）', () => {
        expect(estimateTextLines('口算：12 + 7 =', 26)).toBe(1);
        expect(estimateTextLines('   ', 26)).toBe(0);
        expect(estimateTextLines(null, 26)).toBe(0);
        expect(estimateTextLines(textOfLines(40, 26), 26)).toBe(40);
    });
});
