// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来。
import { describe, expect, it } from 'vitest';
import {
    contentHeightMM,
    countSheets,
    estimateTextLines,
    isTextTooLong,
    layoutReviewSheets,
    REVIEW_HALF_BLOCK_MM,
    REVIEW_LAYOUT_MM,
    REVIEW_PAGE_HEIGHT_MM,
    type ReviewQuestionSpec,
} from '@/lib/review-card';

/**
 * T2 复练纸的分页（**一题半页、两题一页；包不下就顺延，绝不跨页**）。
 *
 * 为什么值得单测：这张纸的验收本来是"打出来看"，
 * 但"包不包得下"这件事**可以算**，算错了就是印出来溢出/切到两张纸。
 * 这里钉住的是三条不可退让的性质：
 *   ① 一块的内容高 ≤ 它的块高（块内一定装得下，不会被裁）
 *   ② 一页最多两块；两块高度之和 + 分隔 ≤ 整页
 *   ③ 装不下的记进 overflow，供 UI 提示"改用深挖纸"（不静默丢题）
 */
describe('review-card · 版面高度', () => {
    it('没有题图、题干很短的题：内容高远小于半页（能把半页让给下一题）', () => {
        const { height } = contentHeightMM({ key: 'a', questionText: '求周长和面积。' });
        expect(height).toBeLessThan(REVIEW_HALF_BLOCK_MM);
    });

    it('题图越高，内容越高（题图按调用方给的高度原样计入，不二次夹取）', () => {
        const noFig = contentHeightMM({ key: 'a', questionText: '看' }).height;
        const withFig = contentHeightMM({ key: 'a', questionText: '看', figureHeightMM: 40 }).height;
        expect(withFig - noFig).toBeCloseTo(40, 6);
    });

    it('估行数：空 = 0 行；正好一行不折；多一个字就折行', () => {
        const perLine = REVIEW_LAYOUT_MM.charsPerLine;
        expect(estimateTextLines('')).toBe(0);
        expect(estimateTextLines(null)).toBe(0);
        expect(estimateTextLines('字'.repeat(perLine))).toBe(1);
        expect(estimateTextLines('字'.repeat(perLine + 1))).toBe(2);
    });

    it('⚠️ 行数**不封顶** —— 长题干照实算，宁可疑它放不下，不能算短了印溢出', () => {
        const long = '字'.repeat(REVIEW_LAYOUT_MM.charsPerLine * 30);
        expect(estimateTextLines(long)).toBe(30);
        expect(isTextTooLong(30)).toBe(true);
        expect(isTextTooLong(3)).toBe(false);
    });
});

describe('review-card · 分页', () => {
    const short = (key: string): ReviewQuestionSpec => ({ key, questionText: '很短的题。' });
    const medium = (key: string): ReviewQuestionSpec => ({
        key,
        questionText: '字'.repeat(REVIEW_LAYOUT_MM.charsPerLine * 8),
        figureHeightMM: 40,
    });
    const huge = (key: string): ReviewQuestionSpec => ({
        // 50 行 ⇒ 连题图都不要也超过一整页 ⇒ 真的印不了复练纸
        key,
        questionText: '字'.repeat(REVIEW_LAYOUT_MM.charsPerLine * 50),
        figureHeightMM: 45,
    });

    it('⚠️ 题干偏长时**先把题图缩到装得下**，而不是判"印不了"', () => {
        // 35 行 + 想要的 45mm 题图：一整页放不下的那部分由题图让出来（缩到约 33mm）
        const spec: ReviewQuestionSpec = {
            key: 'x',
            questionText: '字'.repeat(REVIEW_LAYOUT_MM.charsPerLine * 35),
            figureHeightMM: 45,
        };
        const { height, figureHeightMM } = contentHeightMM(spec);
        expect(figureHeightMM).toBeLessThan(45); // 被缩了
        expect(figureHeightMM).toBeGreaterThan(0); // 还没缩到没有
        expect(height).toBeLessThanOrEqual(REVIEW_PAGE_HEIGHT_MM); // 一整页装得下
        const { overflow } = layoutReviewSheets([spec]);
        expect(overflow).toHaveLength(0);
    });

    it('两道短题 ⇒ 一页两题，各占半页', () => {
        const { pages } = layoutReviewSheets([short('a'), short('b')]);
        expect(pages).toHaveLength(1);
        expect(pages[0].blocks).toHaveLength(2);
        for (const b of pages[0].blocks) {
            expect(b.blockHeightMM).toBeCloseTo(REVIEW_HALF_BLOCK_MM, 6);
        }
    });

    it('一短一中等 ⇒ **绝不挤压**：中等那道独占整页，短的留在原页', () => {
        const { pages } = layoutReviewSheets([short('a'), medium('b')]);
        expect(pages).toHaveLength(2);
        expect(pages[0].blocks.map((b) => b.key)).toEqual(['a']);
        expect(pages[1].blocks.map((b) => b.key)).toEqual(['b']);
        // 独占整页的那道把多出来的空间全给写字
        expect(pages[1].blocks[0].blockHeightMM).toBeCloseTo(REVIEW_PAGE_HEIGHT_MM, 6);
        expect(pages[1].blocks[0].blankHeightMM).toBeGreaterThan(REVIEW_LAYOUT_MM.blankMinLines * REVIEW_LAYOUT_MM.blankLineMM);
    });

    it('四道短题 ⇒ 两页、每页两题', () => {
        const { pages } = layoutReviewSheets([short('a'), short('b'), short('c'), short('d')]);
        expect(pages).toHaveLength(2);
        expect(pages.map((p) => p.blocks.length)).toEqual([2, 2]);
        expect(countSheets({ pages, overflow: [] })).toBe(2);
    });

    it('⚠️ 连题图都不要也装不下的题：记进 overflow（提示改用深挖纸），**不静默丢题**', () => {
        const { pages, overflow } = layoutReviewSheets([huge('big'), short('a')]);
        expect(overflow.map((o) => o.key)).toEqual(['big']);
        // 题还在纸上（给它一整页），只是标记为溢出
        const all = pages.flatMap((p) => p.blocks);
        expect(all.map((b) => b.key)).toContain('big');
    });

    it('三条不可退让的性质（对任意组合都成立）', () => {
        const combos: ReviewQuestionSpec[][] = [
            [short('a')],
            [short('a'), short('b')],
            [short('a'), medium('b'), short('c'), medium('d')],
            [huge('x'), short('a'), short('b'), medium('c')],
            [],
        ];
        for (const specs of combos) {
            const { pages, overflow } = layoutReviewSheets(specs);
            const overflowKeys = new Set(overflow.map((o) => o.key));
            for (const page of pages) {
                // ② 一页最多两块，且两块高度 + 分隔不超过整页
                expect(page.blocks.length).toBeLessThanOrEqual(2);
                const sum = page.blocks.reduce((n, b) => n + b.blockHeightMM, 0);
                const divider = page.blocks.length === 2 ? 3 : 0;
                expect(sum + divider).toBeLessThanOrEqual(REVIEW_PAGE_HEIGHT_MM + 0.001);
                for (const b of page.blocks) {
                    // ① **非溢出**的块一定装得下：留白不为负、内容 ≤ 块高
                    expect(b.blankHeightMM).toBeGreaterThanOrEqual(-0.001);
                    if (!b.overflow) {
                        expect(b.blockHeightMM + 0.001).toBeGreaterThanOrEqual(b.contentHeightMM);
                    } else {
                        // 溢出必须**如实登记**，不能悄悄算成装得下
                        expect(overflowKeys.has(b.key)).toBe(true);
                    }
                }
            }
        }
    });

    it('顺序不被打乱：出来的 key 顺序与输入一致（乱序由调用方决定，不在这里偷偷重排）', () => {
        const { pages } = layoutReviewSheets([short('a'), medium('b'), short('c')]);
        const keys = pages.flatMap((p) => p.blocks).map((b) => b.key);
        expect(keys).toEqual(['a', 'b', 'c']);
    });
});
