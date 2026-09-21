/**
 * 【custom-v33】逆时针 90° 旋转的坐标与尺寸换算。
 *
 * 为什么要单独抽一个纯函数模块：这套换算同时被两处用到 ——
 *   ① 收件箱预览页（旋转只影响「怎么显示」，不碰文件本身）；
 *   ② 裁剪窗口的「🔄转」按钮（旋转会真的改写画布，框选/擦除痕迹的坐标都要跟着搬）。
 * 两边都对"转完之后某个矩形跑到哪儿去了"有依赖，算错了就是框线错位 —— 这种事
 * 必须能被单测钉住，而不是靠肉眼看一遍。
 *
 * ── 屏幕坐标系下的换算（注意 y 轴向下） ──────────────────────────────
 *
 * 视觉上的「逆时针转 90°」= 画面的右边转到上边、上边转到左边。于是：
 *     原图右上角 (W, 0) → 新图左上角 (0, 0)
 *     原图左上角 (0, 0) → 新图左下角 (0, W)
 * 满足这两点的映射只有：
 *
 *     (x, y) → (y, W - x)          W = 旋转前的图宽
 *
 * 新画布尺寸随之变成 (原高, 原宽) —— 长宽对调。
 */

/**
 * 把任意输入收敛成 0 / 90 / 180 / 270 四个值之一（顺时针为正）。
 *
 * 为什么允许 270：逆时针转一次就是 270；把它直接存成 270 比存 -90 省事，
 * CSS 的 `rotate(270deg)` 也正是这个意思，不用再翻译一次。
 */
export function normalizeRotation(deg: unknown): number {
    const n = typeof deg === "number" && Number.isFinite(deg) ? deg : 0;
    return (((Math.round(n / 90) * 90) % 360) + 360) % 360;
}

/** 逆时针转 90°：0 → 270 → 180 → 90 → 0 */
export function rotateCCW(deg: number): number {
    return normalizeRotation(normalizeRotation(deg) - 90);
}

/** 旋转之后整张图的外框尺寸（90 / 270 时长宽对调） */
export function rotatedSize(w: number, h: number, deg: number): { w: number; h: number } {
    const r = normalizeRotation(deg);
    return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** 单步逆时针 90°：一个点的落点 */
export function rotatePointCCW(p: { x: number; y: number }, srcW: number): { x: number; y: number } {
    return { x: p.y, y: srcW - p.x };
}

/**
 * 单步逆时针 90°：一个矩形的落点（用两个对角点转完再取包围盒）。
 *
 * @param srcW **旋转前**那张图的宽度 —— 传错了整个框就会偏出去，
 *             所以调用方一律用"变换前"的尺寸，不要用变换后的。
 */
export function rotateRectCCW(rect: Rect, srcW: number): Rect {
    const a = rotatePointCCW({ x: rect.x, y: rect.y }, srcW);
    const b = rotatePointCCW({ x: rect.x + rect.w, y: rect.y + rect.h }, srcW);
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
    };
}

/**
 * 连续旋转 deg（逆时针累计）后，一个矩形的落点。
 *
 * 做成"逐步转、每步换一次宽度"而不是一次性套公式：因为每转一步参照系就变了，
 * 一次性公式在 180° / 270° 时容易把宽度搞混，逐步转反而不会错。
 */
export function rotateRect(rect: Rect, srcW: number, srcH: number, deg: number): Rect {
    let cur = { ...rect };
    let w = srcW;
    let h = srcH;
    const steps = normalizeRotation(deg) / 90;
    for (let i = 0; i < steps; i++) {
        cur = rotateRectCCW(cur, w);
        const next = rotatedSize(w, h, 90);
        w = next.w;
        h = next.h;
    }
    return cur;
}
