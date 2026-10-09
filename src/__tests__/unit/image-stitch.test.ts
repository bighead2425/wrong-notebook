// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来（jsdom worker 会因内存超时）。
import { describe, expect, it } from 'vitest';
import {
    boxesOverlap,
    clampBoxToImage,
    findBoxConflicts,
    planConcat,
    planStitch,
    sortStitchBoxes,
    STITCH_MAX_EDGE,
    STITCH_MAX_HEIGHT,
    type StitchBox,
    type StitchImage,
} from '@/lib/image-stitch';

/** 造一个框 */
function box(p: Partial<StitchBox> = {}): StitchBox {
    return { imageIndex: 0, x: 0, y: 0, w: 100, h: 50, ...p };
}

const IMG: StitchImage = { width: 1000, height: 800 };
const TWO_IMGS: StitchImage[] = [
    { width: 1000, height: 800 },
    { width: 1000, height: 800 },
];

describe('clampBoxToImage · 框划到黑背景里，只取图内那部分', () => {
    it('正常在框内 ⇒ 原样', () => {
        expect(clampBoxToImage(box({ x: 10, y: 20, w: 100, h: 50 }), IMG)).toEqual({
            x: 10,
            y: 20,
            w: 100,
            h: 50,
        });
    });

    it('右下超出 ⇒ 截到图片边界（黑边不进成品）', () => {
        expect(clampBoxToImage(box({ x: 950, y: 780, w: 200, h: 100 }), IMG)).toEqual({
            x: 950,
            y: 780,
            w: 50,
            h: 20,
        });
    });

    it('左上超出 ⇒ 从 0 开始', () => {
        expect(clampBoxToImage(box({ x: -50, y: -30, w: 100, h: 60 }), IMG)).toEqual({
            x: 0,
            y: 0,
            w: 50,
            h: 30,
        });
    });

    it('整段都在图外 ⇒ null（丢弃，不产生空段）', () => {
        expect(clampBoxToImage(box({ x: 1200, y: 10, w: 100, h: 50 }), IMG)).toBeNull();
        expect(clampBoxToImage(box({ x: 10, y: 900, w: 100, h: 50 }), IMG)).toBeNull();
    });

    it('细过 1 像素（手抖点出来的小框）⇒ null', () => {
        expect(clampBoxToImage(box({ x: 999.5, y: 10, w: 10, h: 50 }), IMG)).toBeNull();
    });
});

describe('boxesOverlap / findBoxConflicts · 框不能交叉', () => {
    it('相交 ⇒ 冲突；边贴边不算（那是挨着，不是交叉）', () => {
        const a = { x: 0, y: 0, w: 10, h: 10 };
        expect(boxesOverlap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
        expect(boxesOverlap(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
        expect(boxesOverlap(a, { x: 0, y: 10, w: 10, h: 10 })).toBe(false);
    });

    it('一个框套住另一个 ⇒ 也算冲突（包含也是一种交叉）', () => {
        const outer = { x: 0, y: 0, w: 100, h: 100 };
        const inner = { x: 10, y: 10, w: 20, h: 20 };
        expect(boxesOverlap(outer, inner)).toBe(true);
    });

    it('findBoxConflicts 只比同一张图里的；跨图不比较', () => {
        const boxes = [
            box({ imageIndex: 0, y: 0, w: 100, h: 100 }),
            box({ imageIndex: 0, x: 50, y: 50, w: 100, h: 100 }),
            box({ imageIndex: 1, x: 0, y: 0, w: 100, h: 100 }),
            box({ imageIndex: 0, x: 300, y: 300, w: 10, h: 10 }),
        ];
        expect(findBoxConflicts(boxes)).toEqual([{ a: 0, b: 1 }]);
    });

    it('全都不碰 ⇒ 空数组', () => {
        expect(findBoxConflicts([box({ y: 0 }), box({ y: 100 })])).toEqual([]);
    });
});

describe('sortStitchBoxes · 图序 → 上边 y → 左边 x', () => {
    it('先按图排，再按 y，y 相同看 x', () => {
        const boxes = [
            box({ imageIndex: 1, x: 0, y: 0 }),
            box({ imageIndex: 0, x: 500, y: 100 }),
            box({ imageIndex: 0, x: 50, y: 300 }),
            box({ imageIndex: 0, x: 10, y: 100 }),
        ];
        expect(sortStitchBoxes(boxes).map((t) => t.index)).toEqual([3, 1, 2, 0]);
    });

    it('不改入参（返回新数组）', () => {
        const boxes = [box({ y: 100 }), box({ y: 0 })];
        sortStitchBoxes(boxes);
        expect(boxes[0].y).toBe(100);
    });
});

describe('planStitch · 等宽 + 首尾相接', () => {
    it('两段宽度不同 ⇒ 等比放到「最宽那一段」的宽度（只放大不缩小）', () => {
        const plan = planStitch(
            [
                box({ imageIndex: 0, w: 400, h: 200 }),
                box({ imageIndex: 1, w: 200, h: 100 }),
            ],
            TWO_IMGS,
        );
        expect(plan.width).toBe(400);
        expect(plan.height).toBe(400);
        expect(plan.segments.map((s) => [s.dy, s.dh])).toEqual([
            [0, 200],
            [200, 200],
        ]);
        expect(plan.dropped).toBe(0);
    });

    it('首尾相接：上一段的 dy+dh = 下一段的 dy（没有缝）', () => {
        const plan = planStitch(
            [
                box({ imageIndex: 0, w: 300, h: 130 }),
                box({ imageIndex: 0, y: 300, w: 500, h: 90 }),
                box({ imageIndex: 1, w: 250, h: 210 }),
            ],
            TWO_IMGS,
        );
        for (let i = 1; i < plan.segments.length; i += 1) {
            expect(plan.segments[i].dy).toBe(
                plan.segments[i - 1].dy + plan.segments[i - 1].dh,
            );
        }
        expect(plan.height).toBe(plan.segments.reduce((s, x) => s + x.dh, 0));
    });

    it('顺序按「图序 → y」：第二张图的框排在最后', () => {
        const plan = planStitch(
            [
                box({ imageIndex: 1, y: 0, w: 100, h: 100 }),
                box({ imageIndex: 0, y: 400, w: 100, h: 100 }),
            ],
            TWO_IMGS,
        );
        expect(plan.segments.map((s) => s.imageIndex)).toEqual([0, 1]);
    });

    it('框超出图片边界 ⇒ 段里只留图内那部分', () => {
        const plan = planStitch([box({ imageIndex: 0, x: 900, y: 700, w: 300, h: 300 })], TWO_IMGS);
        expect(plan.segments).toHaveLength(1);
        expect(plan.segments[0]).toMatchObject({ sx: 900, sy: 700, sw: 100, sh: 100 });
        expect(plan.width).toBe(100);
    });

    it('整段都在图外 ⇒ 丢弃并计数，不占段', () => {
        const plan = planStitch(
            [
                box({ imageIndex: 0, x: 500, y: 100, w: 100, h: 100 }),
                box({ imageIndex: 0, x: 1500, y: 100, w: 100, h: 100 }),
            ],
            TWO_IMGS,
        );
        expect(plan.segments).toHaveLength(1);
        expect(plan.dropped).toBe(1);
    });

    it('所属图不存在 ⇒ 也算丢弃', () => {
        const plan = planStitch([box({ imageIndex: 9 })], TWO_IMGS);
        expect(plan.segments).toHaveLength(0);
        expect(plan.dropped).toBe(1);
        expect(plan.width).toBe(0);
    });

    it('总高超上限 ⇒ 整体等比缩（宽也跟着缩，比例不破）', () => {
        const tall: StitchImage[] = [{ width: 1000, height: 6000 }];
        const plan = planStitch([box({ imageIndex: 0, w: 400, h: 6000 })], tall, {
            maxHeight: 1200,
        });
        expect(plan.scale).toBeLessThan(1);
        expect(plan.height).toBeLessThanOrEqual(1201);
        expect(plan.width).toBeLessThan(400);
        expect(plan.width / plan.height).toBeCloseTo(400 / 6000, 1);
    });

    it('超出总高上限后，各段仍然首尾相接', () => {
        const tall: StitchImage[] = [{ width: 1000, height: 4000 }];
        const plan = planStitch(
            [
                box({ imageIndex: 0, w: 200, h: 2000 }),
                box({ imageIndex: 0, y: 2000, w: 200, h: 2000 }),
            ],
            tall,
            { maxHeight: 1000 },
        );
        expect(plan.segments).toHaveLength(2);
        expect(plan.segments[1].dy).toBe(plan.segments[0].dy + plan.segments[0].dh);
        expect(plan.height).toBeLessThanOrEqual(1001);
    });

    it('一个框都没有 ⇒ 空方案（宽高 0）', () => {
        expect(planStitch([], TWO_IMGS)).toMatchObject({
            width: 0,
            height: 0,
            segments: [],
            dropped: 0,
        });
    });

    it('默认总高上限就是 2560', () => {
        expect(STITCH_MAX_HEIGHT).toBe(2560);
    });
});

describe('planConcat · 页横拼 / 页竖拼（不画框，整页接）', () => {
    it('页竖拼：等宽 —— 以最宽那张为基准，其余等比缩到同宽，上下首尾相接', () => {
        // ① 1000×500（最宽）② 500×500（缩到同宽后应变成 1000 高）
        const plan = planConcat(
            [
                { width: 1000, height: 500 },
                { width: 500, height: 500 },
            ],
            "vertical",
        );
        expect(plan.width).toBe(1000);
        expect(plan.segments[0]).toMatchObject({ dx: 0, dy: 0, dw: 1000, dh: 500 });
        // 第二张：k = 1000/500 = 2 ⇒ 高 1000
        expect(plan.segments[1]).toMatchObject({ dx: 0, dy: 500, dw: 1000, dh: 1000 });
        expect(plan.height).toBe(1500);
        expect(plan.scale).toBe(1);
    });

    it('页横拼：等高 —— 以最高那张为基准，其余等比缩到同高，左右首尾相接', () => {
        const plan = planConcat(
            [
                { width: 500, height: 1000 },
                { width: 1000, height: 500 },
            ],
            "horizontal",
        );
        expect(plan.height).toBe(1000);
        // 基准高 1000：第一张本来就 1000 高 ⇒ 宽 500；第二张 k=2 ⇒ 宽 2000
        expect(plan.segments[0]).toMatchObject({ dx: 0, dy: 0, dw: 500, dh: 1000 });
        expect(plan.segments[1]).toMatchObject({ dx: 500, dy: 0, dw: 2000, dh: 1000 });
        expect(plan.width).toBe(2500);
    });

    it('顺序照传入顺序，不自己排序（页序由用户的上下移决定）', () => {
        const plan = planConcat(
            [
                { width: 300, height: 100 },
                { width: 900, height: 100 },
            ],
            "vertical",
        );
        // 若被按宽度排过序，第一大段就会是 imageIndex=1（900 那张在前）
        expect(plan.segments.map((s) => s.imageIndex)).toEqual([0, 1]);
        // 顺序对了，尺寸还得对：竖向拼是**等宽**，基准 = 最宽的 900
        // ⇒ 第一张 300 宽的那张要放大 3 倍，高 100 → 300（不是原样的 100）
        expect(plan.segments[0]).toMatchObject({ dw: 900, dh: 300, dy: 0 });
        expect(plan.segments[1]).toMatchObject({ dw: 900, dh: 100, dy: 300 });
        expect(plan.height).toBe(400);
    });

    it('长边超上限 ⇒ 整体等比缩，宽高一起缩（保形）', () => {
        const plan = planConcat(
            [
                { width: 1000, height: 2000 },
                { width: 1000, height: 2000 },
            ],
            "vertical",
            { maxEdge: 1000 },
        );
        expect(plan.scale).toBeCloseTo(0.25, 5);
        expect(plan.height).toBeLessThanOrEqual(1001);
        expect(plan.width).toBe(250);
    });

    it('横拼超上限 ⇒ 缩的是宽（长边）', () => {
        const plan = planConcat(
            [
                { width: 2000, height: 1000 },
                { width: 2000, height: 1000 },
            ],
            "horizontal",
            { maxEdge: 1000 },
        );
        expect(plan.scale).toBeCloseTo(0.25, 5);
        expect(plan.width).toBeLessThanOrEqual(1001);
        expect(plan.height).toBe(250);
    });

    it('单张 ⇒ 原尺寸（不放大也不缩）', () => {
        const plan = planConcat([{ width: 800, height: 600 }], "vertical");
        expect(plan).toMatchObject({ width: 800, height: 600, scale: 1 });
    });

    it('坏图（0 尺寸）跳过，不带出空段；全是坏图 ⇒ 空方案', () => {
        const plan = planConcat(
            [
                { width: 0, height: 0 },
                { width: 100, height: 50 },
            ],
            "vertical",
        );
        expect(plan.segments).toHaveLength(1);
        expect(plan.segments[0].imageIndex).toBe(1);

        expect(planConcat([{ width: 0, height: 0 }], "horizontal")).toMatchObject({
            width: 0,
            height: 0,
            scale: 1,
            segments: [],
        });
        expect(planConcat([], "horizontal").segments).toHaveLength(0);
    });

    it('默认长边上限就是 2560', () => {
        expect(STITCH_MAX_EDGE).toBe(2560);
    });
});
