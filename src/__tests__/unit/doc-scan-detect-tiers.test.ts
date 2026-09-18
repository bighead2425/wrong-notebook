/**
 * 四角检测降级链与置信分档的集成测试（custom-v21）。
 *
 * 特点：跑的是**真实 OpenCV + 真实 findPaperCorners**，但合成图是程序生成的，
 * 所以完全可复现、不需要开浏览器、也不需要外部素材，秒级反馈。
 *
 * 覆盖三档置信各自需要什么样的图；其中最值钱的一条是 B ——
 * 它把「同一张纸、同样条件，四角时而认得出时而认不出」这个老毛病钉成了回归测试：
 * 灰阶差落在 ~35–50 那一段时，严格档（Canny 50/150）认不出、宽松档（30/100）能接住。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { findPaperCorners, repairToQuad, quadSanity, type Corner } from '@/lib/doc-scan';

/**
 * 为什么不用应用的 loadOpenCV()：
 * 它内部走 `await import("@techstark/opencv-js")`，在 vitest 的模块转换下会报
 * `Method Promise.prototype.then called on incompatible receiver [object Module]`
 * —— 而同一个包在纯 Node 里用 require 加载完全正常（已实测）。
 * 所以这里用 createRequire 直接加载 CJS 入口，绕开转换层。
 */
let cvCache: any = null;
async function loadCvForTest(): Promise<any> {
    if (cvCache) return cvCache;
    const req = createRequire(import.meta.url);
    let cv: any = req('@techstark/opencv-js');
    if (cv && cv.default) cv = cv.default;
    if (typeof cv === 'function') cv = await cv();
    if (cv && typeof cv.then === 'function') cv = await cv;
    if (!cv || !cv.Mat) {
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('OpenCV 初始化超时')), 20000);
            cv.onRuntimeInitialized = () => {
                clearTimeout(t);
                resolve();
            };
        });
    }
    cvCache = cv;
    return cv;
}

const W = 1600;
const H = 1200;

/** 奇偶射线法判断点是否在多边形内（凸/凹都能用） */
function inPoly(x: number, y: number, poly: Corner[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** 造一张「灰底 + 浅色多边形纸张」的合成图（RGBA）。灰度图足够，颜色对检测无影响 */
function makeImage(poly: Corner[] | null, pageLum: number, bgLum: number) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const lum = poly && inPoly(x + 0.5, y + 0.5, poly) ? pageLum : bgLum;
            data[i] = lum;
            data[i + 1] = lum;
            data[i + 2] = lum;
            data[i + 3] = 255;
        }
    }
    return data;
}

/** 低频平滑噪声（无任何直线边缘）—— 等价于「画面里根本没有纸张」 */
function makeSmoothNoise(): Uint8ClampedArray {
    const sw = 40;
    const sh = 53;
    let seed = 20260918;
    const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const grid = new Float64Array(sw * sh);
    for (let i = 0; i < grid.length; i++) grid[i] = 150 + rnd() * 60;

    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        const gy = (y / (H - 1)) * (sh - 1);
        const y0 = Math.floor(gy);
        const y1 = Math.min(sh - 1, y0 + 1);
        const fy = gy - y0;
        for (let x = 0; x < W; x++) {
            const gx = (x / (W - 1)) * (sw - 1);
            const x0 = Math.floor(gx);
            const x1 = Math.min(sw - 1, x0 + 1);
            const fx = gx - x0;
            const v =
                grid[y0 * sw + x0] * (1 - fx) * (1 - fy) +
                grid[y0 * sw + x1] * fx * (1 - fy) +
                grid[y1 * sw + x0] * (1 - fx) * fy +
                grid[y1 * sw + x1] * fx * fy;
            const i = (y * W + x) * 4;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}

/**
 * 横幅照片（1600×1200）里放一张竖版 A4 比例的纸 —— 与真机最常见的持机方向一致。
 *
 * 刻意让"整图宽高比 1.333"与"纸张宽高比 0.59"差得足够远：这样浏览器验收里
 * 「预览画布宽高比有没有发生变化」就能明确回答"到底有没有发生拉正"，
 * 而不必依赖肉眼看图。竖版纸放进横幅照片也让这个差异天然存在。
 */
const pageQuad: Corner[] = [
    { x: 500, y: 80 },
    { x: 1100, y: 50 },
    { x: 1120, y: 1130 },
    { x: 480, y: 1160 },
];

/** 整页旋转 35°：验证 sortCorners 在斜置四边形上不再出现"同点重复 / 顶点丢失" */
const rotatedQuad: Corner[] = [
    { x: 796.15, y: 169.85 },
    { x: 1205.65, y: 456.85 },
    { x: 803.85, y: 1030.15 },
    { x: 394.35, y: 743.15 },
];

/**
 * 右上角被"切掉一块"（卷边 / 破损）→ 轮廓近似成**五边形**，走 rank 4 点数补救。
 * 切角做得很大（沿上边切到 70%、沿右边切到 35%），保证 approxPolyDP 一定保留出第 5 个顶点：
 * 该顶点到弦线的距离约 165px 原始坐标（检测缩略图里约 82px），远大于 eps = 0.02×周长 ≈ 34px。
 */
const chamferedPentagon: Corner[] = [
    { x: 500, y: 80 },
    { x: 920, y: 59 },
    { x: 1107, y: 428 },
    { x: 1120, y: 1130 },
    { x: 480, y: 1160 },
];

/** 造 Mat 的便捷封装 */
function matOf(cv: any, poly: Corner[] | null, pageLum: number, bgLum: number) {
    return cv.matFromImageData({
        data: makeImage(poly, pageLum, bgLum),
        width: W,
        height: H,
    });
}

describe('findPaperCorners 置信分档（真实 OpenCV）', () => {
    it('高对比度清晰四边形 → 高置信，且命中严格档', async () => {
        const cv = await loadCvForTest();
        const mat = matOf(cv, pageQuad, 245, 40);
        const r = findPaperCorners(cv, mat);
        mat.delete();
        expect(r.confidence).toBe('high');
        expect(r.stage.startsWith('strict')).toBe(true);
        expect(r.corners).not.toBeNull();
    });

    it('旋转 35° 的页面 → 高置信，且四个角互不相同（sortCorners 回归）', async () => {
        const cv = await loadCvForTest();
        const mat = matOf(cv, rotatedQuad, 245, 40);
        const r = findPaperCorners(cv, mat);
        mat.delete();
        expect(r.confidence).toBe('high');
        const pts = r.corners
            ? [
                  r.corners.topLeftCorner,
                  r.corners.topRightCorner,
                  r.corners.bottomRightCorner,
                  r.corners.bottomLeftCorner,
              ]
            : [];
        expect(pts).toHaveLength(4);
        expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBe(4);
    });

    it('【核心】灰阶差 40（旧版必然失手的那一段）→ 低置信，由宽松档接住', async () => {
        const cv = await loadCvForTest();
        // 实测：灰阶差 ≥ 60 严格档就能认；40 这一档严格档认不出、宽松档能接住；
        // 30 及以下连宽松档也认不出。这条断言把"时好时坏"那批图钉住了。
        const mat = matOf(cv, pageQuad, 100, 60);
        const r = findPaperCorners(cv, mat);
        mat.delete();
        expect(r.confidence).toBe('low');
        expect(r.stage.startsWith('loose')).toBe(true);
        expect(r.corners).not.toBeNull();
    });

    it('灰阶差低到 30 时连宽松档都认不出 → 必须老实报 none，不许硬凑', async () => {
        const cv = await loadCvForTest();
        const mat = matOf(cv, pageQuad, 90, 60);
        const r = findPaperCorners(cv, mat);
        mat.delete();
        expect(r.confidence).toBe('none');
        expect(r.corners).toBeNull();
    });

    it('缺一个角的五边形 → 低置信，走点数补救', async () => {
        const cv = await loadCvForTest();
        const mat = matOf(cv, chamferedPentagon, 245, 40);
        const r = findPaperCorners(cv, mat);
        mat.delete();
        expect(r.confidence).toBe('low');
        expect(r.stage).toContain('repair');
        expect(r.corners).not.toBeNull();
    });

    it('画面里没有纸（平滑噪声）→ 无候选，不硬凑四边形', async () => {
        const cv = await loadCvForTest();
        const mat = cv.matFromImageData({
            data: makeSmoothNoise(),
            width: W,
            height: H,
        });
        const r = findPaperCorners(cv, mat);
        mat.delete();
        expect(r.confidence).toBe('none');
        expect(r.corners).toBeNull();
    });

    it('minAreaRect 兜底（rank 6）依赖的 opencv.js API 确实存在 —— 不是静默死代码', async () => {
        // 上面几条用例都走 rank 0~5，rank 6 一次都没被触发。
        // 若 cv.RotatedRect.points 不存在，它会被 try/catch 吞掉、只在控制台留一行 warn，
        // 表现为"兜底形同虚设"却看不出问题。这里直接把这条链路钉住。
        const cv = await loadCvForTest();
        expect(typeof cv.minAreaRect).toBe('function');
        expect(typeof cv.RotatedRect?.points).toBe('function');
        const contour = cv.matFromArray(4, 1, cv.CV_32SC2, [
            100, 100,
            900, 100,
            900, 700,
            100, 700,
        ]);
        const rect = cv.minAreaRect(contour);
        const pts = cv.RotatedRect.points(rect) as Corner[];
        contour.delete();
        expect(pts).toHaveLength(4);
        // 而且是可用的四点：800×600 的矩形，经修复与合理性校验后应当被接受
        const q = repairToQuad(pts.map((p) => ({ x: p.x, y: p.y })));
        expect(q).toHaveLength(4);
        expect(quadSanity(q!, 1600, 1200)).toBe(true);
    });
});
