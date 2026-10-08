import { describe, it, expect } from 'vitest';
import {
    CORNER_KEYS,
    GUIDE_INSET,
    PAPER_RATIO,
    expectedQuad,
    frameAffinity,
    guideBox,
    maxCornerShift,
    meanCorners,
    presetFromLive,
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

describe('presetFromLive —— 把"预览定的角"换算到照片上（他第 1 条）', () => {
    const live = makeCorners(0.5, 0.5, 0.25, 0.35); // 归一化：0.25..0.75 / 0.15..0.85

    it('没认到角 → null（这种时候就该老老实实重找）', () => {
        expect(
            presetFromLive({ live: null, stillW: 3840, stillH: 2160, frameW: 3840, frameH: 2160 }),
        ).toBeNull();
    });

    it('尺寸缺失（流还没起来）→ null，不产生 NaN', () => {
        expect(presetFromLive({ live, stillW: 0, stillH: 0, frameW: 3840, frameH: 2160 })).toBeNull();
        expect(presetFromLive({ live, stillW: 3840, stillH: 2160, frameW: 0, frameH: 0 })).toBeNull();
    });

    it('同一画幅（16:9 拍出 16:9）→ 按比例缩放到照片像素', () => {
        const got = presetFromLive({
            live,
            stillW: 1920,
            stillH: 1080,
            frameW: 3840,
            frameH: 2160,
        });
        expect(got).not.toBeNull();
        expect(got!.topLeftCorner.x).toBeCloseTo(0.25 * 1920, 6);
        expect(got!.topLeftCorner.y).toBeCloseTo(0.15 * 1080, 6);
        expect(got!.bottomRightCorner.x).toBeCloseTo(0.75 * 1920, 6);
        expect(got!.bottomRightCorner.y).toBeCloseTo(0.85 * 1080, 6);
    });

    it('画幅不同（静帧 4:3、预览 16:9）→ null（不能照搬，画幅一变位置全变）', () => {
        expect(
            presetFromLive({ live, stillW: 4000, stillH: 3000, frameW: 3840, frameH: 2160 }),
        ).toBeNull();
    });

    it('画幅只差一点点（同款比例的不同分辨率）→ 仍算同一画幅', () => {
        // 3840×2160 = 1.7778；3840×2176 相对差 0.0074 < 0.02
        expect(
            presetFromLive({ live, stillW: 3840, stillH: 2176, frameW: 3840, frameH: 2160 }),
        ).not.toBeNull();
    });

    it('阈值可调（差 0.7% 时给 0.005 的容差就不认）', () => {
        expect(
            presetFromLive({
                live,
                stillW: 3840,
                stillH: 2176,
                frameW: 3840,
                frameH: 2160,
                aspectTol: 0.005,
            }),
        ).toBeNull();
    });

    it('归一化值越界会被夹到照片范围内', () => {
        const wild: Corners = makeCorners(0.5, 0.5, 0.9, 0.9); // 0..-0.4 / -0.4..1.4
        const got = presetFromLive({ live: wild, stillW: 1000, stillH: 1000, frameW: 1000, frameH: 1000 });
        expect(got!.topLeftCorner).toEqual({ x: 0, y: 0 });
        expect(got!.bottomRightCorner).toEqual({ x: 1000, y: 1000 });
    });
});

describe('expectedQuad / frameAffinity —— "纸大概在框里"的先验（他第 2 条）', () => {
    const FW = 800;
    const FH = 1067;

    it('expectedQuad 就是参考框的四个角（画面像素坐标）', () => {
        const g = guideBox(FW, FH);
        const q = expectedQuad(FW, FH);
        expect(q).toHaveLength(4);
        expect(q[0].x).toBeCloseTo(g.x0 * FW, 6); // 左上
        expect(q[0].y).toBeCloseTo(g.y0 * FH, 6);
        expect(q[2].x).toBeCloseTo(g.x1 * FW, 6); // 右下
        expect(q[2].y).toBeCloseTo(g.y1 * FH, 6);
    });

    it('四个角正好落在参考框上 → 满分 1', () => {
        expect(frameAffinity(expectedQuad(FW, FH), FW, FH)).toBeCloseTo(1, 6);
    });

    it('顺序被打乱也算 1（不该因为点序不同判错）', () => {
        const q = expectedQuad(FW, FH);
        expect(frameAffinity([q[2], q[0], q[3], q[1]], FW, FH)).toBeCloseTo(1, 6);
    });

    it('整体偏出画面短边的 25% ⇒ 0 分（"完全不像"的尺度）', () => {
        const q = expectedQuad(FW, FH);
        const far = q.map((p) => ({ x: p.x + 25, y: p.y + 200 })); // 短边 800 的 25% = 200
        expect(frameAffinity(far, FW, FH)).toBe(0);
    });

    it('偏一半的距离 ⇒ 大约一半分（线性）', () => {
        const q = expectedQuad(FW, FH);
        const half = q.map((p) => ({ x: p.x + 100, y: p.y })); // 100 / 200 = 一半
        expect(frameAffinity(half, FW, FH)).toBeCloseTo(0.5, 6);
    });

    it('**只跑偏一个角**也按最差的那个算（一个角不对就说明不像纸）', () => {
        const q = expectedQuad(FW, FH);
        const one = q.map((p, i) => (i === 2 ? { x: p.x + 200, y: p.y } : p));
        expect(frameAffinity(one, FW, FH)).toBe(0);
    });

    it('纸缩在画面中间（没充满）→ 0 分：先验帮不上忙，但也**不添乱**', () => {
        const small = makeCorners(FW / 2, FH / 2, FW * 0.25, FH * 0.25);
        expect(frameAffinity(
            [small.topLeftCorner, small.topRightCorner, small.bottomRightCorner, small.bottomLeftCorner],
            FW,
            FH,
        )).toBe(0);
    });

    it('角点不够 4 个 / 尺寸非法 → 0（不炸）', () => {
        expect(frameAffinity([], FW, FH)).toBe(0);
        expect(frameAffinity(expectedQuad(FW, FH).slice(0, 3), FW, FH)).toBe(0);
        expect(frameAffinity(expectedQuad(FW, FH), 0, 0)).toBe(0);
    });
});
