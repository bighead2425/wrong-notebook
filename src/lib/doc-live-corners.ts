/**
 * 【2026-10-08】取景页"预览实时提示四角"的**纯逻辑**部分。
 *
 * 背景（他提的想法）：现在手机拍照是"先拍、后校对四角"；他想在**按快门之前**就看到
 * 软件认出来的纸边。我把它做成**取景页的一个勾选框**（默认关，记住上次选择）——
 * 不勾就完全还是老样子，勾上才多这一层。
 *
 * 为什么单独开一个文件：判稳、平滑、参考框几何都是**纯算术**，
 * 与相机/OpenCV/DOM 无关 ⇒ 可以完整单测（这个项目为"错误断言把 bug 焊死"吃过亏，
 * 纯逻辑一律配测试）。
 *
 * ⚠️ 三条边界（都是刻意的）：
 *   ① **只在置信档为 high 时才算数**（调用方负责过滤）——弱光/反光下 low 档给的框
 *      大多不准，宁可什么都不画，也别让框乱晃误导人；
 *   ② **必须连续几帧都对得上才显示**（见 settleCorners）——单帧抽风不许上屏；
 *   ③ 显示用的是**归一化坐标**（0..1，相对检测画布）⇒ 叠加层直接用百分比定位，
 *      不必知道预览到底显示成多少像素（那正是"框和纸错位"最常见的成因）。
 */

import type { Corner, Corners } from "./doc-scan";

/** 四个角的固定顺序（叠加层按它渲染角标，别处别自己排） */
export const CORNER_KEYS = [
    "topLeftCorner",
    "topRightCorner",
    "bottomRightCorner",
    "bottomLeftCorner",
] as const satisfies readonly (keyof Corners)[];

/** A/B 系列纸张的长宽比（A3 / A4 / B5 都是 √2 系列，B5 实际 1.42，取 1.414 足够） */
export const PAPER_RATIO = 1.414;

/** 参考框四周留边（占画面比例）—— 留一点边，别让角标贴到画面边缘外 */
export const GUIDE_INSET = 0.03;

/** 判稳阈值：每帧与"这几帧的平均值"相比，最大角点位移不得超过这个比例（归一化） */
export const LIVE_SETTLE_TOL = 0.02;

/** 一个归一化的矩形（0..1） */
export interface GuideBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 把"检测画布坐标"的四个角换成归一化坐标（0..1） */
export function toNormCorners(c: Corners, frameW: number, frameH: number): Corners {
    const f = (p: Corner): Corner => ({
        x: frameW > 0 ? clamp01(p.x / frameW) : 0,
        y: frameH > 0 ? clamp01(p.y / frameH) : 0,
    });
    return {
        topLeftCorner: f(c.topLeftCorner),
        topRightCorner: f(c.topRightCorner),
        bottomRightCorner: f(c.bottomRightCorner),
        bottomLeftCorner: f(c.bottomLeftCorner),
    };
}

/** 两组角点之间**最大**的那个对角点位移（归一化距离，用来判"是不是同一张纸的位置"） */
export function maxCornerShift(a: Corners, b: Corners): number {
    let worst = 0;
    for (const k of CORNER_KEYS) {
        const d = Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y);
        if (d > worst) worst = d;
    }
    return worst;
}

/** 多组角点的平均（抖动被平均掉 ⇒ 显示出来更稳） */
export function meanCorners(list: Corners[]): Corners {
    const out = {} as Corners;
    for (const k of CORNER_KEYS) {
        let sx = 0;
        let sy = 0;
        for (const c of list) {
            sx += c[k].x;
            sy += c[k].y;
        }
        out[k] = { x: sx / list.length, y: sy / list.length };
    }
    return out;
}

/**
 * 判稳：最近几帧**全部**都有结果、且**任意两帧**之间的最大角点位移都在 `tol` 内
 * ⇒ 返回平均值（抖动被平均掉）；否则返回 null（**不显示**）。
 *
 * 为什么是"任意两帧互比"而不是"只比相邻两帧"：
 * 相邻互比放得太松 —— 框在慢慢漂移时（手机微动、纸张被风吹），
 * 每一帧与上一帧的差都很小，但**累积**起来早就偏了，只比相邻就会一路放行。
 * 帧数只有 2~3 帧，两两比较是 O(n²) 也完全无所谓。
 */
export function settleCorners(
    frames: (Corners | null)[],
    tol: number = LIVE_SETTLE_TOL,
): Corners | null {
    if (frames.length === 0) return null;
    if (frames.some((f) => !f)) return null;
    const list = frames as Corners[];
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            if (maxCornerShift(list[i], list[j]) > tol) return null;
        }
    }
    return meanCorners(list);
}

/**
 * 参考框（引导框）在画面里的位置，归一化到 0..1。
 *
 * 规则（他 2026-10-08 确认）：**一次只拍一张纸，不在这里考虑跨页**，
 * 所以按 A/B 系列的 √2 比例画一个"纸的形状"当向导：
 *   · 纸的**长边跟着画面的长边**走（竖着拿手机就是竖框，横着拿就是横框）——
 *     这样无论手机怎么拿，框看着都像"一张纸"，不会变成奇怪的窄条；
 *   · 长边留 `inset` 的边；
 *   · 短边按 1:1.414 推；若推出来超出了画面（画面很长/很窄），反过来按短边顶满再推长边，
 *     保证框**始终完整在画面内**。
 *
 * ⚠️ 它只是**参考线**，不是裁剪框：软件照旧自己找纸的四条边（框外的内容不影响找角）。
 */
export function guideBox(
    frameW: number,
    frameH: number,
    ratio: number = PAPER_RATIO,
    inset: number = GUIDE_INSET,
): GuideBox {
    const availW = clamp01(1 - inset * 2);
    const availH = clamp01(1 - inset * 2);
    let nw: number;
    let nh: number;

    if (frameH >= frameW) {
        // 竖画面：长边是高度 —— 先按高度顶满，宽按 1.414 推
        nh = availH;
        nw = (nh * (frameH / frameW)) / ratio;
        if (nw > availW) {
            nw = availW;
            nh = (nw * ratio) / (frameH / frameW);
        }
    } else {
        // 横画面：长边是宽度
        nw = availW;
        nh = (nw * (frameW / frameH)) / ratio;
        if (nh > availH) {
            nh = availH;
            nw = (nh * ratio) / (frameW / frameH);
        }
    }

    const x0 = (1 - nw) / 2;
    const y0 = (1 - nh) / 2;
    return { x0, y0, x1: x0 + nw, y1: y0 + nh };
}

/**
 * 参考框的四个角（画面像素坐标），顺序 左上/右上/右下/左下。
 * 这是"纸应该在哪"的先验，用于下面的 frameAffinity（他 2026-10-08 第 2 条）。
 */
export function expectedQuad(frameW: number, frameH: number): Corner[] {
    const b = guideBox(frameW, frameH);
    return [
        { x: b.x0 * frameW, y: b.y0 * frameH },
        { x: b.x1 * frameW, y: b.y0 * frameH },
        { x: b.x1 * frameW, y: b.y1 * frameH },
        { x: b.x0 * frameW, y: b.y1 * frameH },
    ];
}

/**
 * 【2026-10-08 他第 2 条】"纸基本是 A4/B5/A3，拍的时候人都会尽量让纸充满取景框，
 * 所以纸的四个角应该离**参考框的四个角**不远 —— 找角应该优先在框的四周（尤其框内附近）找。"
 *
 * 这个观察是对的，但**不能做成硬性"只在框附近找"**，原因是结构性的：
 * 轮廓法要的是"纸的四条边连成**一条闭合轮廓**"——把搜索限制在框四周的窄带里，
 * 这条轮廓在带内根本闭不上，反而整条候选都没了（这就是为什么不做 ROI 裁剪）。
 * 所以这里只把它做成一个 **0..1 的"像不像纸就在框里"的打分**，
 * 由调用方**在同档次候选之间**用它排序（见 doc-scan.ts 里 pick 的 useFramePrior）。
 *
 * 实现要点：
 *   · 每个角取"**离它最近的那个参考角**"的距离 —— 不要求点序一致（候选点序不同不该判错）；
 *   · 取四个角里最差的那个（一个角跑偏就说明不像），以画面短边的 25% 作为"完全不像"的尺度。
 */
export function frameAffinity(pts: Corner[], frameW: number, frameH: number): number {
    if (pts.length < 4 || !(frameW > 0) || !(frameH > 0)) return 0;
    const exp = expectedQuad(frameW, frameH);
    const scale = Math.max(1, 0.25 * Math.min(frameW, frameH));
    let worst = 0;
    for (const p of pts) {
        let nearest = Infinity;
        for (const e of exp) {
            const d = Math.hypot(p.x - e.x, p.y - e.y);
            if (d < nearest) nearest = d;
        }
        if (nearest > worst) worst = nearest;
    }
    return clamp01(1 - worst / scale);
}

/**
 * 【2026-10-08 他提的第 1 条】"预览里四个角已经准了（青色），一拍完却又重新找一遍、反而找歪了。"
 *
 * 解法：拍下来的这张**如果与预览是同一画幅**，就直接沿用预览定的四个角，**不再重找**。
 *
 * ⚠️ 为什么不能无条件沿用：`ImageCapture.takePhoto()` 拿到的静帧可能来自**另一个传感器模式**
 * （常见是 4:3，而预览流是 16:9）—— 画幅一变，纸在照片里的位置整体都不同，
 * 照搬预览的角会**错得更离谱**。所以拿"宽高比是否一致"当判据：
 *   · 比例一致（相对差 ≤ `aspectTol`）⇒ 同一视野、只是分辨率不同 ⇒ 缩放到照片像素后直接用；
 *   · 比例不同 ⇒ 老老实实重找（这时"重找"才是对的）。
 *
 * ⚠️ 入参 `live` 必须是**归一化**角点（0..1，相对预览画面）；
 *    返回值是**照片像素**坐标（与审核页 corners 的坐标基准一致）。
 */
export function presetFromLive(opts: {
    live: Corners | null;
    stillW: number;
    stillH: number;
    frameW: number;
    frameH: number;
    aspectTol?: number;
}): Corners | null {
    const { live, stillW, stillH, frameW, frameH, aspectTol = 0.02 } = opts;
    if (!live) return null;
    if (!(stillW > 0) || !(stillH > 0) || !(frameW > 0) || !(frameH > 0)) return null;

    const rel = Math.abs(stillW / stillH - frameW / frameH) / (frameW / frameH);
    if (!Number.isFinite(rel) || rel > aspectTol) return null;

    const out = {} as Corners;
    for (const k of CORNER_KEYS) {
        out[k] = {
            x: clamp01(live[k].x) * stillW,
            y: clamp01(live[k].y) * stillH,
        };
    }
    return out;
}
