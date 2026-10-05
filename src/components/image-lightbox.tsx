"use client";

/**
 * 通用「看图」窗口 —— 只负责"看清这张图"，不掺任何业务。
 *
 * 起因（2026-10-05 他的原话）：回录页里图片进了「待处理 / 预处理 / 已分析」之后
 * 都只有一小格，"有时候完全不知道是哪张图片"。收件箱那个预览窗口的手感他认可，
 * 所以把"看图"这一层单独抽出来，谁都能用 —— 而不是抄一份到别的页面去。
 *
 * ── 为什么抽出来而不是复制一份 ─────────────────────────────
 * 用户会拿两个窗口对比手感：缩放焦点、拖动阻尼、翻页阈值只要有一点不同，
 * 用起来就会觉得"这个飘"。所以这里的缩放/平移数学与 `image-cropper`、
 * 以及原来的收件箱预览**完全同一套**（applyView / zoomAt / computeFitZoom）。
 *
 * ── 它管什么、不管什么 ─────────────────────────────────────
 * 管：整屏看一张、滚轮/双指缩放、拖动平移、上一张/下一张、双击放大复位、
 *     手机横扫翻页、Esc/关闭按钮、窗口尺寸变化时自动适应。
 * 不管：旋转存哪儿、能不能删、选中状态 —— 那些是业务，由调用方通过
 *     `toolbarLeft` / `toolbarRight` 两个插槽把按钮塞进来（收件箱就是这么用的）。
 *
 * ── 文案 ──────────────────────────────────────────────────
 * 直接复用 `common.batch.inbox` 里那几条**通用**文案（上一张/下一张/关闭/
 * 第 i / n 张/手势提示）—— 中英都有、且本来就是同一批字。
 * 不另建一份：文案只写一处，两个窗口说的话才不会分叉。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { rotatedSize } from "@/lib/image-rotation";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";

export interface LightboxItem {
    /** 图片来源：object URL / data URL / 接口地址都行 */
    src: string;
    /** 底部显示的名字（可选） */
    label?: string;
    /** 显示用的旋转角（度），默认 0 —— **只影响显示**，不动图片本身 */
    rotation?: number;
}

export interface ImageLightboxProps {
    open: boolean;
    items: LightboxItem[];
    /** 当前看第几张。越界会自动按环形收敛，调用方不必精确修正 */
    index: number;
    onIndexChange: (i: number) => void;
    onClose: () => void;
    /** 忙碌时禁用导航与关闭（收件箱保存中会用到） */
    busy?: boolean;
    /** 导航按钮**左边**的业务按钮（收件箱放：选中 / 旋转 / 状态 / 下载 / 删除） */
    toolbarLeft?: React.ReactNode;
    /** 导航按钮**右边**的业务按钮 */
    toolbarRight?: React.ReactNode;
    /**
     * 关闭前钩子。给了就先把关闭按钮换成转圈、等它跑完再真关
     *（收件箱用它"等所有保存落地 → 重读一遍目录"）。
     */
    onBeforeClose?: () => Promise<void> | void;
    /** 无障碍标题（不显示，只给读屏） */
    title?: string;
}

/* 与 image-cropper 保持同一组数值 —— 三个窗口的手感必须一致 */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const FIT_PAD = 16;
const FIT_MAX = 2;

/** 手机端手势的三个阈值：横扫翻页的距离、双击允许的手指抖动、双击的时间窗 */
const SWIPE_PX = 70;
const TAP_SLOP = 24;
const DOUBLE_TAP_MS = 320;
/** 双击放大到"当前的多少倍" —— 按当前显示倍数放大，而不是写死绝对倍率：
 *  大图适应窗口后可能是 0.3 倍，写死 2 倍反而会缩小。 */
const DOUBLE_TAP_FACTOR = 2.5;

/** 工具栏图标按钮的统一长相 */
const iconBtn =
    "h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-background disabled:hover:text-muted-foreground";

export function ImageLightbox({
    open,
    items,
    index,
    onIndexChange,
    onClose,
    busy = false,
    toolbarLeft,
    toolbarRight,
    onBeforeClose,
    title,
}: ImageLightboxProps) {
    const { t } = useLanguage();
    // 文案与收件箱预览共用同一批 key（见文件头说明）
    const s = t.common.batch?.inbox || {};

    /* ===== 当前这张是谁 ===== */
    const count = items.length;
    // 环形收敛：删掉最后一张后 index 会短暂越界，取模一步到位，不必让调用方算
    const idx = count > 0 ? ((index % count) + count) % count : 0;
    const cur = count > 0 ? items[idx] : null;
    const src = cur?.src ?? "";
    const label = cur?.label ?? "";
    const rot = cur?.rotation ?? 0;

    /* ===== 视图状态（缩放 / 平移）===== */
    const viewportRef = useRef<HTMLDivElement | null>(null);
    /** 当前这张图的自然像素尺寸（onLoad 读到）。换图期间保持不动 —— 清成 0 会让 fit 算不出来、画面空一帧 */
    const [nat, setNat] = useState({ w: 0, h: 0 });
    const [zoom, setZoom] = useState(1);
    const [view, setView] = useState({ x: 0, y: 0 });
    const zoomRef = useRef(1);
    const viewRef = useRef({ x: 0, y: 0 });
    const panRef = useRef({ x: 0, y: 0 });
    /** 旋转后的外框尺寸 —— 所有 fit/钳制都按它算，而不是原图自然尺寸 */
    const dispRef = useRef({ w: 0, h: 0 });
    const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
    const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);
    const panDragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

    /* 手机端手势：单指横扫切图、双击放大/复位。
     * 两者都只在 `pointerType === "touch"` 时生效 —— 电脑端有左右按钮和滚轮，
     * 不该让鼠标拖动变成"翻页"，也不该让双击和滚轮抢。 */
    const swipeRef = useRef<{ sx: number; sy: number } | null>(null);
    const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
    /** 触摸设备（没有 hover 能力）上不显示左右那两个半透明圆圈 —— 手机用滑动翻页 */
    const [touchOnly, setTouchOnly] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined" || !window.matchMedia) return;
        setTouchOnly(window.matchMedia("(hover: none)").matches);
    }, []);

    /**
     * 是否仍处于「自动适应」。用户一旦自己缩放/平移就退出 —— 否则手机收个地址栏、
     * 窗口高度变一下，画面就被拽回整图，用户刚放大的那个细节白找了。
     */
    const autoFitRef = useRef(true);
    const [working, setWorking] = useState(false);

    /* ===== 缩放 / 平移（与 image-cropper 同一套）===== */
    const applyView = useCallback((zRaw: number, p: { x: number; y: number }) => {
        const vp = viewportRef.current;
        const { w: nw, h: nh } = dispRef.current;
        if (!vp || !nw || !nh) return;
        if (!Number.isFinite(zRaw)) return;
        const vw = vp.clientWidth;
        const vh = vp.clientHeight;
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zRaw));
        const sw = nw * z;
        const sh = nh * z;
        // 图比视口小的时候不允许拖动，否则能把图拖出屏幕外找不回来
        const mx = Math.max(0, (sw - vw) / 2);
        const my = Math.max(0, (sh - vh) / 2);
        const px = Number.isFinite(p.x) ? Math.min(mx, Math.max(-mx, p.x)) : 0;
        const py = Number.isFinite(p.y) ? Math.min(my, Math.max(-my, p.y)) : 0;
        zoomRef.current = z;
        panRef.current = { x: px, y: py };
        viewRef.current = { x: (vw - sw) / 2 + px, y: (vh - sh) / 2 + py };
        setZoom(z);
        setView({ x: (vw - sw) / 2 + px, y: (vh - sh) / 2 + py });
    }, []);

    /** 以屏幕上某点为中心缩放：该点下的内容保持不动（滚轮 / 双指用） */
    const zoomAt = useCallback(
        (zRaw: number, cx: number, cy: number) => {
            const vp = viewportRef.current;
            const { w: nw, h: nh } = dispRef.current;
            if (!vp || !nw || !nh) return;
            const r = vp.getBoundingClientRect();
            const sx = cx - r.left;
            const sy = cy - r.top;
            const z = zoomRef.current;
            const nx = (sx - viewRef.current.x) / z;
            const ny = (sy - viewRef.current.y) / z;
            const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zRaw));
            const sw = nw * nz;
            const sh = nh * nz;
            autoFitRef.current = false; // 用户手动缩放，退出「自动适应」
            applyView(nz, {
                x: sx - (vp.clientWidth - sw) / 2 - nx * nz,
                y: sy - (vp.clientHeight - sh) / 2 - ny * nz,
            });
        },
        [applyView],
    );

    const computeFitZoom = useCallback(() => {
        const vp = viewportRef.current;
        const { w: nw, h: nh } = dispRef.current;
        if (!vp || !nw || !nh) return 1;
        const z = Math.min(
            (vp.clientWidth - FIT_PAD * 2) / nw,
            (vp.clientHeight - FIT_PAD * 2) / nh,
        );
        return Math.min(FIT_MAX, Math.max(MIN_ZOOM, z));
    }, []);

    /** 「适应大小」：整图居中铺满 —— 换图、旋转之后一律回到这个状态 */
    const fitView = useCallback(() => {
        autoFitRef.current = true;
        applyView(computeFitZoom(), { x: 0, y: 0 });
    }, [applyView, computeFitZoom]);

    /** 同步"旋转后的外框尺寸"，它是 fit/钳制的唯一基准 */
    useEffect(() => {
        dispRef.current = rotatedSize(nat.w, nat.h, rot);
    }, [nat.w, nat.h, rot]);

    /**
     * 换图 / 图加载完 / 旋转了 → 一律回到适应大小。
     *
     * 为什么用两个 rAF：对话框是 Radix 的 Portal + 有入场动画，第一帧里
     * viewport 的 clientWidth 还是 0，直接算 fit 会得到一个荒谬的比例。
     * 等两帧，布局稳定了再算。
     */
    useEffect(() => {
        if (!open) return;
        const id = requestAnimationFrame(() => {
            requestAnimationFrame(() => fitView());
        });
        return () => cancelAnimationFrame(id);
    }, [open, src, rot, nat.w, nat.h, fitView]);

    // 窗口尺寸变化（手机横竖屏 / 拖大窗口）：没手动缩放过就重新适应，否则只把画面钳回边界内
    useEffect(() => {
        const vp = viewportRef.current;
        if (!open || !vp) return;
        const ro = new ResizeObserver(() => {
            if (autoFitRef.current) fitView();
            else applyView(zoomRef.current, panRef.current);
        });
        ro.observe(vp);
        return () => ro.disconnect();
    }, [open, fitView, applyView]);

    // 电脑端滚轮缩放：以鼠标位置为中心
    useEffect(() => {
        if (!open) return;
        const onWheel = (e: WheelEvent) => {
            const vp = viewportRef.current;
            if (!vp) return;
            if (!vp.contains(e.target as Node)) return;
            e.preventDefault();
            // 归一化：有些鼠标/触控板按"行"或"页"上报
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 16;
            else if (e.deltaMode === 2) dy *= 100;
            zoomAt(zoomRef.current * Math.exp(-dy * 0.002), e.clientX, e.clientY);
        };
        // 挂到 window 的捕获阶段：先于 Radix Dialog 的滚动锁定拿到事件，
        // 否则滚轮会被 Dialog 吞掉（裁剪窗口踩过同一个坑）
        window.addEventListener("wheel", onWheel, { passive: false, capture: true });
        return () => window.removeEventListener("wheel", onWheel, { capture: true });
    }, [open, zoomAt]);

    /* ===== 动作 ===== */
    const goStep = useCallback(
        (d: number) => {
            if (count < 2) return;
            // 环形：第一张再往前 = 最后一张；最后一张再往后 = 第一张
            onIndexChange(((idx + d) % count + count) % count);
        },
        [count, idx, onIndexChange],
    );

    // 指针交互：双指捏合+平移 / 右键或中键拖动平移 / 单指拖动平移
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dispRef.current.w) return;
        e.preventDefault();
        try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
            /* 某些浏览器在极端情况下会抛，忽略即可 —— 拿不到捕获只是拖动可能中断 */
        }
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointersRef.current.size >= 2) {
            const pts = [...pointersRef.current.values()];
            pinchRef.current = {
                dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
                midX: (pts[0].x + pts[1].x) / 2,
                midY: (pts[0].y + pts[1].y) / 2,
            };
            panDragRef.current = null;
            return;
        }

        // 右键 / 中键 / 左键都是平移 —— 这里没有绘制功能，不需要区分工具
        if (e.button === 0 || e.button === 1 || e.button === 2) {
            // 这里**不**立刻把 autoFitRef 关掉：单纯点一下（尤其手机上双击放大的第一下）
            // 不该被当成"用户自己调过视角"。改成"真的发生位移时才关"（见 onPointerMove）。
            swipeRef.current = e.pointerType === "touch"
                ? { sx: e.clientX, sy: e.clientY }
                : null;
            panDragRef.current = {
                sx: e.clientX,
                sy: e.clientY,
                px: panRef.current.x,
                py: panRef.current.y,
            };
        }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (pointersRef.current.has(e.pointerId)) {
            pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }

        const pts = [...pointersRef.current.values()];
        if (pts.length >= 2 && pinchRef.current) {
            const g = pinchRef.current;
            const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const mx = (pts[0].x + pts[1].x) / 2;
            const my = (pts[0].y + pts[1].y) / 2;
            if (g.dist > 0) zoomAt(zoomRef.current * (d / g.dist), g.midX, g.midY);
            applyView(zoomRef.current, {
                x: panRef.current.x + (mx - g.midX),
                y: panRef.current.y + (my - g.midY),
            });
            g.dist = d;
            g.midX = mx;
            g.midY = my;
            return;
        }

        if (panDragRef.current) {
            const pd = panDragRef.current;
            const wantX = pd.px + (e.clientX - pd.sx);
            const wantY = pd.py + (e.clientY - pd.sy);
            autoFitRef.current = false; // 真的拖动过了，退出「自动适应」
            applyView(zoomRef.current, { x: wantX, y: wantY });

            /**
             * 手机端单指横扫切换图片。
             *
             * 判据不是"划了多少"，而是"有多少被边界吃掉了"（overshoot）——
             * applyView 会把平移量夹在边界内，所以「想要的位移 − 实际得到的位移」
             * 正好是"顶到边还在继续推"的那部分。这一条规则同时覆盖两种情况：
             *   · 图处于适应大小（比屏幕小、根本推不动）：横向拖动被全额吃掉，
             *     划够 SWIPE_PX 即翻页；
             *   · 图被放大过、已经推到最右/最左：再同方向继续推才翻页 ——
             *     这正是看大图时"划到头接着划就翻页"的习惯动作，
             *     而中间区域照常是平移，不会误翻。
             * 另要求横向明显大于纵向（1.5 倍），免得斜着拖被误判成翻页。
             */
            if (e.pointerType === "touch" && swipeRef.current) {
                const sw = swipeRef.current;
                const overshoot = wantX - panRef.current.x;
                const dx = e.clientX - sw.sx;
                const dy = e.clientY - sw.sy;
                if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(overshoot) > SWIPE_PX) {
                    swipeRef.current = null; // 一次手势只翻一张，免得一划到底连翻好几张
                    lastTapRef.current = null;
                    panDragRef.current = null;
                    // overshoot < 0 = 手指向左划 = 看下一张
                    goStep(overshoot < 0 ? 1 : -1);
                    return;
                }
            }
        }
    };

    const onPointerUp = (e?: React.PointerEvent<HTMLDivElement>) => {
        if (e) {
            pointersRef.current.delete(e.pointerId);
            /**
             * 手机端双击 = 放大 / 复位。
             *
             * 为什么要自己判双击：视口上有 `touch-action: none` 且 pointerdown 里
             * preventDefault，浏览器合成的 dblclick 在触屏上基本不触发；就算触发，
             * 也带不出准确定位。所以用"两次间隔够短 + 两次落点够近 + 两下都没怎么移动"来判。
             * 划动过的手势走不进这里（moved 超过容差就直接清掉计时）。
             */
            if (e.pointerType === "touch") {
                const sw = swipeRef.current;
                const moved = sw ? Math.hypot(e.clientX - sw.sx, e.clientY - sw.sy) : 999;
                swipeRef.current = null;
                const last = lastTapRef.current;
                if (
                    moved < TAP_SLOP && last &&
                    Date.now() - last.t < DOUBLE_TAP_MS &&
                    Math.abs(e.clientX - last.x) < TAP_SLOP &&
                    Math.abs(e.clientY - last.y) < TAP_SLOP
                ) {
                    lastTapRef.current = null;
                    const fitZ = computeFitZoom();
                    // 本来就在适应大小 → 按当前倍数放大；否则一律回到适应大小
                    if (Math.abs(zoomRef.current - fitZ) < 0.02 * Math.max(1, fitZ)) {
                        zoomAt(fitZ * DOUBLE_TAP_FACTOR, e.clientX, e.clientY);
                    } else {
                        fitView();
                    }
                } else if (moved < TAP_SLOP) {
                    lastTapRef.current = { t: Date.now(), x: e.clientX, y: e.clientY };
                } else {
                    lastTapRef.current = null;
                }
            }
        }
        if (pointersRef.current.size < 2) pinchRef.current = null;
        if (pointersRef.current.size === 0) panDragRef.current = null;
    };

    /** 关闭：给了 onBeforeClose 就先等它（收件箱要等保存落地），期间关闭按钮转圈 */
    const close = async () => {
        if (working) return;
        if (!onBeforeClose) {
            onClose();
            return;
        }
        setWorking(true);
        try {
            await onBeforeClose();
        } finally {
            setWorking(false);
            onClose();
        }
    };

    // 图被清空了（可能是在别处删的）→ 自动收起，别留一个空窗口
    useEffect(() => {
        if (open && count === 0) onClose();
    }, [open, count, onClose]);

    if (!cur) return null;

    const disp = rotatedSize(nat.w, nat.h, rot);

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) void close(); }}>
            <DialogContent
                className="max-w-none w-full h-[100dvh] sm:rounded-none p-0 gap-0 flex flex-col overflow-hidden [&>button]:hidden"
                aria-describedby={undefined}
            >
                <DialogTitle className="sr-only">{title || s.viewerTitle || "照片预览"}</DialogTitle>
                <DialogDescription className="sr-only">
                    {s.viewerDesc || "缩放、平移、上一张下一张"}
                </DialogDescription>

                {/* ===== 工具栏 ===== */}
                <div className="flex items-center gap-2 px-3 py-2 border-b bg-background shrink-0 flex-wrap">
                    {toolbarLeft}

                    {toolbarLeft && <span className="w-px h-5 bg-border mx-1" />}

                    {/* 左右切换：第一张再往前 = 最后一张，反之亦然 */}
                    <button
                        type="button" className={iconBtn}
                        onClick={() => goStep(-1)}
                        disabled={count < 2 || busy}
                        title={s.viewerPrev || "上一张"}
                    >
                        <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                        type="button" className={iconBtn}
                        onClick={() => goStep(1)}
                        disabled={count < 2 || busy}
                        title={s.viewerNext || "下一张"}
                    >
                        <ChevronRight className="h-5 w-5" />
                    </button>

                    {toolbarRight}

                    <div className="ml-auto flex items-center gap-2">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {(s.viewerIndex || "第 {i} / {n} 张")
                                .replace("{i}", String(idx + 1))
                                .replace("{n}", String(count))}
                        </span>
                        <button
                            type="button" className={iconBtn}
                            onClick={() => void close()}
                            disabled={busy || working}
                            title={s.viewerClose || "关闭"}
                        >
                            {working ? <Loader2 className="h-5 w-5 animate-spin" /> : <X className="h-5 w-5" />}
                        </button>
                    </div>
                </div>

                {/* ===== 图片区 ===== */}
                <div
                    ref={viewportRef}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onContextMenu={(e) => e.preventDefault()}
                    className="group flex-1 min-h-0 bg-black w-full"
                    style={{ position: "relative", overflow: "hidden", touchAction: "none", cursor: "grab" }}
                >
                    <div
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            // 显式定尺，且是**旋转之后**的尺寸：fit/钳制都以它为基准
                            width: disp.w || undefined,
                            height: disp.h || undefined,
                            lineHeight: 0,
                            transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})`,
                            transformOrigin: "0 0",
                        }}
                    >
                        {/*
                          图片本身保持原始像素尺寸，旋转只作用在它自己身上；
                          因为外层盒子的尺寸是「旋转后的尺寸」，居中之后正好铺满，
                          转 90° 时也不会多出一圈空白或者被裁掉一条。
                        */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            key={src}
                            src={src}
                            alt={label}
                            draggable={false}
                            onLoad={(e) => {
                                const el = e.currentTarget;
                                setNat({ w: el.naturalWidth, h: el.naturalHeight });
                            }}
                            style={{
                                position: "absolute",
                                left: "50%",
                                top: "50%",
                                // 宽高刻意不设 —— 让浏览器按自然尺寸渲染，
                                // translate(-50%,-50%) 的百分比才会正好等于"半个自己"
                                transform: `translate(-50%, -50%) rotate(${rot}deg)`,
                                userSelect: "none",
                                pointerEvents: "none",
                            }}
                        />
                    </div>

                    {/* 电脑端左右两侧的"翻页圆圈"：鼠标移进图片区才淡入（`group-hover`），
                        不抢画面。手机端**不渲染** —— 那边用左右滑动翻页，多两个圆圈只会挡图。
                        指针事件在这里 stopPropagation：不让点击圆圈顺带起一次平移。 */}
                    {!touchOnly && count > 1 && (
                        <>
                            {([
                                { d: -1, Icon: ChevronLeft, label: s.viewerPrev || "上一张", pos: "left-3" },
                                { d: 1, Icon: ChevronRight, label: s.viewerNext || "下一张", pos: "right-3" },
                            ] as const).map(({ d, Icon, label: lb, pos }) => (
                                <button
                                    key={d}
                                    type="button"
                                    disabled={busy}
                                    title={lb}
                                    aria-label={lb}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={() => goStep(d)}
                                    className={`absolute ${pos} top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-black/40 hover:bg-black/70 text-white/90 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-0`}
                                >
                                    <Icon className="h-6 w-6" />
                                </button>
                            ))}
                        </>
                    )}
                </div>

                {/* ===== 底部：名字与操作提示 ===== */}
                <div className="flex items-center gap-3 px-3 py-2 border-t bg-background shrink-0 text-xs text-muted-foreground">
                    <span className="truncate" title={label}>{label}</span>
                    <span className="ml-auto whitespace-nowrap hidden sm:inline">
                        {s.viewerFitHint || "滚轮缩放 · 右键拖动平移 · 手机：双指缩放、双击放大、左右滑动翻页"}
                    </span>
                </div>
            </DialogContent>
        </Dialog>
    );
}
