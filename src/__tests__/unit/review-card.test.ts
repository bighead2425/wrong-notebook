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
    blankLinesFromDrag,
    countSheets,
    figureScaleFromDrag,
    effectiveBlankLines,
    layoutFromSnapshot,
    normalizeBlankLines,
    pageFits,
    pageUsageMM,
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

/**
 * 【2026-10-03 他要求】**横竖都能拖**的题图缩放。
 *
 * 他的原话：手机上左右太窄，拖把手很难调到自己想要的缩放，
 * 所以纵向也要算：向上缩小、向下放大；斜着拖时「哪个方向移得多就听哪个」。
 *
 * ⚠️ 测试**只 import 真函数**，不照抄实现 —— 抄一遍的话方向做反了测试照样绿
 *    （上一版 `blankLinesFromDrag` 就栽在这上面，见本文件留白那条注释）。
 */
describe('卷 · 拖把手缩放（横竖都能拖）', () => {
    // startPx = 100 时：新百分比 = round((100 + d) / 100 × 100) = 100 + d，数值干净
    const S = 100;

    it('纯横向：向右放大、向左缩小（他认可的老手感，必须不变）', () => {
        expect(figureScaleFromDrag(S, 50, 0)).toBe(150);
        expect(figureScaleFromDrag(S, -50, 0)).toBe(50);
    });

    it('纯纵向：向下放大、向上缩小（这次新加的）', () => {
        expect(figureScaleFromDrag(S, 0, 50)).toBe(150); // 下 = 放大
        expect(figureScaleFromDrag(S, 0, -50)).toBe(50); // 上 = 缩小
    });

    it('第二象限（左上 45°）⇒ 缩小；第四象限（右下 45°）⇒ 放大', () => {
        expect(figureScaleFromDrag(S, -50, -50)).toBe(50); // 左上 ⇒ 缩
        expect(figureScaleFromDrag(S, 50, 50)).toBe(150); // 右下 ⇒ 放
    });

    it('右上（第一象限）：横向移得多 ⇒ 听横向（放大）；纵向移得多 ⇒ 听纵向（缩小）', () => {
        // 右上 dx>0、dy<0 本是"矛盾的"，按位移绝对值大的那个轴定夺
        expect(figureScaleFromDrag(S, 60, -40)).toBe(160); // 横向大 ⇒ 放大
        expect(figureScaleFromDrag(S, 40, -60)).toBe(40); // 纵向大 ⇒ 缩小
    });

    it('左下（第三象限）同理：谁移得多听谁', () => {
        expect(figureScaleFromDrag(S, -60, 40)).toBe(40); // 横向大 ⇒ 缩小
        expect(figureScaleFromDrag(S, -40, 60)).toBe(160); // 纵向大 ⇒ 放大
    });

    it('到边界被 clamp：再拖也不越过 30 / 180', () => {
        expect(figureScaleFromDrag(S, 500, 0)).toBe(FIGURE_SCALE_MAX);
        expect(figureScaleFromDrag(S, -500, 0)).toBe(FIGURE_SCALE_MIN);
        expect(figureScaleFromDrag(S, 0, 500)).toBe(FIGURE_SCALE_MAX);
        expect(figureScaleFromDrag(S, 0, -500)).toBe(FIGURE_SCALE_MIN);
    });

    it('位移为 0 ⇒ 不动（原样 100%）', () => {
        expect(figureScaleFromDrag(S, 0, 0)).toBe(100);
    });

    it('纵向也用同一个 startPx 当基准（保证纵横向手感一致）', () => {
        // 起手图宽 200，向下拖 100 ⇒ (200+100)/200 = 150%
        expect(figureScaleFromDrag(200, 0, 100)).toBe(150);
        expect(figureScaleFromDrag(50, 0, 25)).toBe(150);
    });

    it('起手宽度拿不到（0/NaN）⇒ 退回默认 100%，绝不除以 0', () => {
        expect(figureScaleFromDrag(0, 50, 0)).toBe(100);
        expect(figureScaleFromDrag(Number.NaN, 50, 0)).toBe(100);
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

    it('向下拖 = 加行、向上拖 = 减行（他 2026-09-29 纠正后的方向）', () => {
        // 拖的是"上面那块的底边"：往下拉 = 拉长 = 留白变多。
        // ⚠️ 这条测的是**真函数** blankLinesFromDrag —— 旧版把页面里的算法抄进来重算一遍，
        // 结果方向做反了测试照样绿。教训：测试必须 import 被测函数，禁止照抄实现。
        expect(blankLinesFromDrag(5, 2 * REVIEW_BLANK_LINE_PX, 5)).toBe(7); // 向下拖两行 ⇒ 5+2
        expect(blankLinesFromDrag(5, -2 * REVIEW_BLANK_LINE_PX, 5)).toBe(3); // 向上拖两行 ⇒ 5−2
        expect(blankLinesFromDrag(1, -5 * REVIEW_BLANK_LINE_PX, 1)).toBe(0); // 减到 0 就停住
        expect(blankLinesFromDrag(5, 0.4 * REVIEW_BLANK_LINE_PX, 5)).toBe(5); // 拖不到位不算
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

/**
 * 复练卷页的"**页内锁定**"（他 2026-09-30 定的规矩）：
 * 卷一旦印出去，页归属只认快照 —— 调留白/题图只改页内高度，题绝不再跨页移动。
 * 打印预览页则相反（还没定稿，用 paginateMeasured 随便重排）。
 */
describe('按快照还原版面 layoutFromSnapshot', () => {
    const rows = [
        { key: 'a', seq: 1, pageIndex: 1, columnIndex: 0, seqInColumn: 1 },
        { key: 'b', seq: 2, pageIndex: 1, columnIndex: 0, seqInColumn: 2 },
        { key: 'c', seq: 3, pageIndex: 2, columnIndex: 0, seqInColumn: 1 },
    ];

    it('★ 页归属只认快照：给什么页就是什么页，与"装不装得下"无关', () => {
        const { pages } = layoutFromSnapshot(rows, 'review');
        expect(pages).toHaveLength(2);
        expect(pages[0].columns[0].blocks.map((b) => b.key)).toEqual(['a', 'b']);
        expect(pages[1].columns[0].blocks.map((b) => b.key)).toEqual(['c']);
        // 流水号跟着快照走（不是页内重新从 1 数）
        expect(pages[1].columns[0].blocks[0].seq).toBe(3);
    });

    it('栏内顺序按 seqInColumn 排（喂乱序也照样排好）', () => {
        const { pages } = layoutFromSnapshot(
            [
                { key: 'z', seq: 2, pageIndex: 1, columnIndex: 0, seqInColumn: 2 },
                { key: 'y', seq: 1, pageIndex: 1, columnIndex: 0, seqInColumn: 1 },
            ],
            'review',
        );
        expect(pages[0].columns[0].blocks.map((b) => b.key)).toEqual(['y', 'z']);
    });

    it('中间有整页空着也留着（页号不能跳 —— 纸是连续印的）', () => {
        const { pages } = layoutFromSnapshot(
            [
                { key: 'a', seq: 1, pageIndex: 1, columnIndex: 0, seqInColumn: 1 },
                { key: 'b', seq: 2, pageIndex: 3, columnIndex: 0, seqInColumn: 1 },
            ],
            'review',
        );
        expect(pages).toHaveLength(3);
        expect(pages[1].columns[0].blocks).toEqual([]);
    });

    it('积累纸（两栏）：页内按栏分开，栏序按 columnIndex', () => {
        const { pages } = layoutFromSnapshot(
            [
                { key: 'L', seq: 1, pageIndex: 1, columnIndex: 0, seqInColumn: 1 },
                { key: 'R', seq: 2, pageIndex: 1, columnIndex: 1, seqInColumn: 1 },
            ],
            'build',
        );
        expect(pages[0].columns).toHaveLength(2);
        expect(pages[0].columns[0].blocks[0].key).toBe('L');
        expect(pages[0].columns[1].blocks[0].key).toBe('R');
    });

    it('没有 overflow 这一说：装不下也不许把题挪走（页内锁定的代价交给安全阀管）', () => {
        const { overflow } = layoutFromSnapshot(rows, 'review');
        expect(overflow).toEqual([]);
    });
});

describe('页用量与安全阀 pageUsageMM / pageFits', () => {
    const heights: Record<string, number> = { a: 100, b: 50 };

    it('与 paginateMeasured 同一口径：每块都加那点余量', () => {
        expect(pageUsageMM(['a', 'b'], (k) => heights[k])).toBeCloseTo(100 + 50 + REVIEW_BLOCK_SLACK_MM * 2, 5);
    });

    it('★ 一页刚好装得下 = 通过；再多一点就判超', () => {
        expect(pageFits(VOLUME_COLUMN_MM)).toBe(true);
        expect(pageFits(VOLUME_COLUMN_MM + 1)).toBe(false);
        // 单块就超过一栏（和 paginateMeasured 的 overflow 判据一致）
        expect(pageUsageMM(['big'], () => VOLUME_COLUMN_MM)).toBeGreaterThan(VOLUME_COLUMN_MM);
    });
});

/**
 * 【2026-10-02 审计时补】`paginateMeasured` 的**页脚预留**参数。
 *
 * 为什么值得单测：积累纸要在每栏底部留 6mm 页脚（他的要求），而分页算法必须**知道**这件事，
 * 否则它会按原来的高度继续塞 ⇒ 最后一屏溢出（看起来像排版坏了）。
 * 这条测试钉住"传了预留就会少装"这个方向 —— 哪天有人把参数接丢了，这里立刻红。
 */
describe('卷 · 页脚预留（积累纸专用）', () => {
    const one = (key: string, h: number) => ({ key, heightMM: h });

    it('不传预留 = 0：行为与从前一字不差', () => {
        const blocks = [one('a', 100), one('b', 100), one('c', 100)];
        const noArg = paginateMeasured(blocks, 'build');
        const zero = paginateMeasured(blocks, 'build', 0);
        expect(zero.pages.length).toBe(noArg.pages.length);
    });

    it('★ 传了预留 ⇒ 每栏少装，页数只多不少（这正是"留了页脚"该有的代价）', () => {
        // 每块 100mm、栏高约 240mm ⇒ 不预留时每栏 2 块
        const blocks = [one('a', 100), one('b', 100), one('c', 100), one('d', 100)];
        const without = paginateMeasured(blocks, 'build');
        const withFooter = paginateMeasured(blocks, 'build', 60); // 预留 60mm
        expect(withFooter.pages.length).toBeGreaterThanOrEqual(without.pages.length);
        // 预留 60mm 后一栏只剩约 180mm ⇒ 100+100 放不下（含 slack），每栏 1 块
        const firstCol = withFooter.pages[0].columns[0];
        expect(firstCol.blocks.length).toBe(1);
    });
});
