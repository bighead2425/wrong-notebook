import { describe, it, expect } from 'vitest';
import {
    CORNER_KEYS,
    GUIDE_INSET,
    PAPER_RATIO,
    guideBox,
    maxCornerShift,
    meanCorners,
    settleCorners,
    toNormCorners,
} from '@/lib/doc-live-corners';
import type { Corners } from '@/lib/doc-scan';

/** 造一组角点：给一个"纸"的中心与半宽半高（归一化或像素都行，纯算术） */
function makeCorners(cx: number, cy: number, hw: number, hh: number): Corners {
    return {
        topLeftCorner: { x: cx - hw, y: cy - hh },
        topRightCorner: { x: cx + hw, y: cy - hh },
        bottomRightCorner: { x: cx + hw, y: cy + hh },
        bottomLeftCorner: { x: cx - hw, y: cy + hh },
    };
}

describe('toNormCorners —— 检测画布坐标 → 归一化 0..1', () => {
    it('按宽高分别归一化', () => {
        const c = makeCorners(400, 250, 300, 200);
        const n = toNormCorners(c, 800, 500);
        expect(n.topLeftCorner).toEqual({ x: 0.125, y: 0.1 });
        expect(n.bottomRightCorner).toEqual({ x: 0.875, y: 0.9 });
    });

    it('超出画布的角点被夹回 0..1（拖动过界 / 检测抽风都不该画出画面外）', () => {
        const c = makeCorners(400, 250, 900, 900);
        const n = toNormCorners(c, 800, 500);
        expect(n.topLeftCorner).toEqual({ x: 0, y: 0 });
        expect(n.bottomRightCorner).toEqual({ x: 1, y: 1 });
    });

    it('宽高为 0 时不产生 NaN（第一帧还没拿到流尺寸）', () => {
        const n = toNormCorners(makeCorners(10, 10, 5, 5), 0, 0);
        for (const k of CORNER_KEYS) {
            expect(Number.isFinite(n[k].x)).toBe(true);
            expect(Number.isFinite(n[k].y)).toBe(true);
        }
    });
});

describe('maxCornerShift —— 两组角点的最大位移', () => {
    it('同一组 → 0', () => {
        const a = makeCorners(0.5, 0.5, 0.3, 0.4);
        expect(maxCornerShift(a, a)).toBe(0);
    });

    it('取四个角里位移最大的那个（不是平均）', () => {
        const a = makeCorners(0.5, 0.5, 0.3, 0.4);
        const b: Corners = { ...a, topRightCorner: { x: 0.8, y: 0.1 } };
        expect(maxCornerShift(a, b)).toBeCloseTo(0, 5);
        expect(maxCornerShift(a, { ...b, topRightCorner: { x: 0.83, y: 0.1 } })).toBeCloseTo(0.03, 5);
    });
});

describe('settleCorners —— 判稳 + 平滑', () => {
    it('一帧都没有 → null', () => {
        expect(settleCorners([])).toBeNull();
    });

    it('有任意一帧没认出来 → null（宁可什么都不画）', () => {
        const a = makeCorners(0.5, 0.5, 0.3, 0.4);
        expect(settleCorners([a, null, a])).toBeNull();
    });

    it('三帧完全一致 → 返回该位置', () => {
        const a = makeCorners(0.5, 0.5, 0.3, 0.4);
        const got = settleCorners([a, a, a]);
        expect(got).not.toBeNull();
        // ⚠️ 不能 `toEqual(a)`：返回的是**平均值**（三个相同值相加再除 3），
        //    浮点上会带出 1e-17 的尾差（0.2 → 0.20000000000000004）。按近似比。
        for (const k of CORNER_KEYS) {
            expect(got![k].x).toBeCloseTo(a[k].x, 12);
            expect(got![k].y).toBeCloseTo(a[k].y, 12);
        }
    });

    it('抖动超过阈值 → null（这一档最容易"框乱跳"，必须拦住）', () => {
        const a = makeCorners(0.5, 0.5, 0.3, 0.4);
        const b = makeCorners(0.5 + 0.05, 0.5, 0.3, 0.4); // 偏 5% > 2%
        expect(settleCorners([a, b, a], 0.02)).toBeNull();
    });

    it('轻微抖动（阈值内）→ 返回平均值（画面更稳）', () => {
        const a = makeCorners(0.5, 0.5, 0.3, 0.4);
        const b = makeCorners(0.5 + 0.01, 0.5, 0.3, 0.4);
        const got = settleCorners([a, b, b], 0.02);
        expect(got).not.toBeNull();
        expect(got!.topLeftCorner.x).toBeCloseTo(0.2 + 0.01 * (2 / 3), 5);
    });

    it('缓慢漂移也要拦住：每帧只差一点点、但累计超阈值 → null', () => {
        const steps = [0, 0.015, 0.03].map((d) => makeCorners(0.5 + d, 0.5, 0.3, 0.4));
        // 相邻两两之差都 ≤ 0.015（比阈值小），但首尾差了 0.03
        expect(settleCorners(steps, 0.02)).toBeNull();
    });

    it('单帧也能用（第一次拿到结果时缓冲区只有一帧）', () => {
        const a = makeCorners(0.5, 0.5, 0.3, 0.4);
        expect(settleCorners([a])).toEqual(a);
    });
});

describe('meanCorners —— 四角分别取平均', () => {
    it('平均到各角，不是整体平移', () => {
        const a = makeCorners(0.5, 0.5, 0.3, 0.4);
        const b = makeCorners(0.5, 0.5, 0.2, 0.4);
        const m = meanCorners([a, b]);
        expect(m.topLeftCorner.x).toBeCloseTo(0.5 - 0.25, 5);
        expect(m.topRightCorner.x).toBeCloseTo(0.5 + 0.25, 5);
    });
});

describe('guideBox —— 1.414 参考框', () => {
    const pxRatio = (b: ReturnType<typeof guideBox>, fw: number, fh: number) => {
        const w = (b.x1 - b.x0) * fw;
        const h = (b.y1 - b.y0) * fh;
        const long = Math.max(w, h);
        const short = Math.min(w, h);
        return long / short;
    };

    it('竖画面（手机竖着拿）→ 长边是高度，比例正好 1.414', () => {
        const b = guideBox(800, 1067);
        expect(pxRatio(b, 800, 1067)).toBeCloseTo(PAPER_RATIO, 3);
        expect(b.y1 - b.y0).toBeGreaterThan(b.x1 - b.x0); // 竖框
    });

    it('横画面 → 长边是宽度', () => {
        const b = guideBox(1067, 800);
        expect(pxRatio(b, 1067, 800)).toBeCloseTo(PAPER_RATIO, 3);
        expect(b.x1 - b.x0).toBeGreaterThan(b.y1 - b.y0); // 横框
        expect(b.y1 - b.y0).toBeLessThan(1);
    });

    it('始终居中', () => {
        const b = guideBox(800, 1067);
        expect(b.x0).toBeCloseTo(1 - b.x1, 6);
        expect(b.y0).toBeCloseTo(1 - b.y1, 6);
    });

    it('长边按 inset 留边', () => {
        const b = guideBox(800, 1067);
        expect(b.y0).toBeCloseTo(GUIDE_INSET, 6);
    });

    it('极端画面比例也不能越界（很长的画面 / 很宽的画面）', () => {
        for (const [w, h] of [
            [300, 1000],
            [1000, 300],
            [400, 4000],
            [4000, 400],
            [800, 800],
        ] as const) {
            const b = guideBox(w, h);
            expect(b.x0).toBeGreaterThanOrEqual(0);
            expect(b.y0).toBeGreaterThanOrEqual(0);
            expect(b.x1).toBeLessThanOrEqual(1);
            expect(b.y1).toBeLessThanOrEqual(1);
            expect(b.x1).toBeGreaterThan(b.x0);
            expect(b.y1).toBeGreaterThan(b.y0);
            // 被夹过之后仍保持 1.414（两个分支都是"按短边反推长边"）
            expect(pxRatio(b, w, h)).toBeCloseTo(PAPER_RATIO, 3);
        }
    });

    it('可传别的比例 / 留边（跨页那种宽纸将来也能用）', () => {
        const b = guideBox(800, 1067, 2.0, 0.05);
        expect(b.y0).toBeCloseTo(0.05, 6);
        const w = (b.x1 - b.x0) * 800;
        const h = (b.y1 - b.y0) * 1067;
        expect(Math.max(w, h) / Math.min(w, h)).toBeCloseTo(2.0, 3);
    });
});
