/**
 * 【2026-10-03】图片阅览的**纯坐标数学**（缩放 / 平移的钳制）。
 *
 * 为什么要单独抽一个纯函数模块：这套换算原本长在收件箱预览页
 * （`src/components/inbox-image-viewer.tsx`）里，日积月累页要点开右栏那张配图放大，
 * 手感必须和那个窗口一致 —— 两套算法只要差一点（比如滚轮焦点、边界钳制），
 * 用起来就会觉得"这个飘"。算错的效果又恰恰是"不报错、只是图跑出屏幕找不回来"，
 * 这种必须能被单测钉住，所以把纯数学搬出来共用。
 *
 * ── 坐标模型（与裁剪窗口 / 收件箱预览页同一套）────────────────────
 *
 *  · 视口（viewport）：盖住整屏的那层，`clientWidth/Height` 是它的尺寸；
 *  · 这个模块用**视口内的相对坐标**（左上角为原点），不碰 `clientX` 这类页面坐标；
 *  · 图片以自然像素尺寸 `img.w × img.h` 为基准，整体 `translate(tx,ty) scale(zoom)`，
 *    变换原点在左上角（`transform-origin: 0 0`）；
 *  · `pan` 是"图中心相对视口中心的偏移量"，`tx/ty` 由它和 zoom 算出来。
 *    之所以存 pan 而不直接存 tx/ty：钳制边界（`±(图宽·zoom − 视口宽)/2`）只跟 pan 有关，
 *    算起来干净。
 */

export interface Size {
    w: number;
    h: number;
}

export interface Offset {
    x: number;
    y: number;
}

/** 缩放下限 / 上限 —— 与收件箱预览页、裁剪窗保持同一组数值（手感一致） */
export const IMAGE_VIEW_MIN_ZOOM = 0.05;
export const IMAGE_VIEW_MAX_ZOOM = 8;

export interface ZoomBounds {
    min?: number;
    max?: number;
}

export interface FitOptions extends ZoomBounds {
    /** 适应大小时四周留的空白像素 */
    pad?: number;
    /** "适应大小"的放大上限 —— 小图别被硬拉成马赛克 */
    fitMax?: number;
}

/**
 * 把任意输入收敛到 [min, max] 区间内。
 * `NaN`（常来自退化手势里的 0/0）退回下限；`±Infinity` 按普通 clamp 收敛到上/下限；
 * 任何情况下都不会把 `NaN` 写进 transform。
 */
export function clampZoom(zRaw: number, bounds: ZoomBounds = {}): number {
    const min = bounds.min ?? IMAGE_VIEW_MIN_ZOOM;
    const max = bounds.max ?? IMAGE_VIEW_MAX_ZOOM;
    if (Number.isNaN(zRaw)) return min;
    return Math.min(max, Math.max(min, zRaw));
}

/**
 * 「适应大小」的比例：整图等比缩到视口内（四周各留 pad）。
 * 拿不到有效尺寸（视口/图还没量出来）返回 1，避免算出一个荒谬的比例。
 */
export function computeFitZoom(vp: Size, img: Size, opts: FitOptions = {}): number {
    const pad = opts.pad ?? 16;
    const fitMax = opts.fitMax ?? 2;
    if (!vp.w || !vp.h || !img.w || !img.h) return 1;
    const z = Math.min((vp.w - pad * 2) / img.w, (vp.h - pad * 2) / img.h);
    return clampZoom(Math.min(fitMax, z), opts);
}

/**
 * 平移量的边界：图比视口小的那一边**不允许拖动**（否则能把图拖出屏幕外找不回来）。
 * 返回的是半径，pan 落在 `[-limit, limit]` 内。
 */
export function panLimit(vp: Size, img: Size, zoom: number): Offset {
    return {
        x: Math.max(0, (img.w * zoom - vp.w) / 2),
        y: Math.max(0, (img.h * zoom - vp.h) / 2),
    };
}

/** 把 pan 钳进边界；非法值退回 0。顺便把 `-0` 归一成 `0`，别让它漏进 transform 字符串 */
export function clampPan(pan: Offset, vp: Size, img: Size, zoom: number): Offset {
    const lim = panLimit(vp, img, zoom);
    const cx = Number.isFinite(pan.x) ? Math.min(lim.x, Math.max(-lim.x, pan.x)) : 0;
    const cy = Number.isFinite(pan.y) ? Math.min(lim.y, Math.max(-lim.y, pan.y)) : 0;
    return { x: cx === 0 ? 0 : cx, y: cy === 0 ? 0 : cy };
}

/** 解算出来的可直接写进样式的视图状态 */
export interface ResolvedView {
    zoom: number;
    pan: Offset;
    /** transform: translate(tx, ty) */
    tx: number;
    ty: number;
}

/**
 * 由「zoom + 期望的 pan」解算出最终视图（钳制后的 zoom 与 pan，以及 tx/ty）。
 * 这是所有缩放/平移动作的收口点 —— 别处不要再手算 tx/ty。
 */
export function resolveView(
    vp: Size,
    img: Size,
    zoomRaw: number,
    pan: Offset,
    opts: ZoomBounds = {},
): ResolvedView {
    const zoom = clampZoom(zoomRaw, opts);
    const p = clampPan(pan, vp, img, zoom);
    return {
        zoom,
        pan: p,
        tx: (vp.w - img.w * zoom) / 2 + p.x,
        ty: (vp.h - img.h * zoom) / 2 + p.y,
    };
}

/**
 * 以屏幕上某一点为中心缩放：**该点下的内容保持不动**（滚轮 / 双指捏合用）。
 *
 * @param screen 缩放焦点，**视口内相对坐标**（调用方用 `clientX - rect.left` 换算好再传）
 */
export function zoomAtPoint(
    vp: Size,
    img: Size,
    current: ResolvedView,
    screen: Offset,
    nextZoomRaw: number,
    opts: ZoomBounds = {},
): ResolvedView {
    const nx = (screen.x - current.tx) / current.zoom;
    const ny = (screen.y - current.ty) / current.zoom;
    const nz = clampZoom(nextZoomRaw, opts);
    return resolveView(
        vp,
        img,
        nz,
        {
            x: screen.x - (vp.w - img.w * nz) / 2 - nx * nz,
            y: screen.y - (vp.h - img.h * nz) / 2 - ny * nz,
        },
        opts,
    );
}
