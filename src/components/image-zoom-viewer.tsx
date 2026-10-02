"use client";

/**
 * 【2026-10-03 他要求】图片**放大阅览**浮层 —— 给日积月累页右栏那张配图用。
 *
 * 原话："如果这个内容包含图片的话，现在点击这个图片则丝毫没有反应。
 * 我需要点击这个图片能够放大阅览：电脑端滚轮可以放大图片、拖动可以平移图片；
 * 手机端两指拉开放大缩小图片、两指平移可以移动图片位置。"
 *
 * ── 复用哪来的 ─────────────────────────────────────────────────────
 * 缩放/平移/捏合这套手感直接沿用**收件箱预览页**（`inbox-image-viewer.tsx`，
 * 也就是"图片录入/拍照"那条链路上的看图窗口）的坐标模型，纯数学已抽到
 * `src/lib/image-view.ts`，本组件只是把它接上指针事件。没有新写一套手势。
 *
 * ── 相对既有预览页**砍掉**了什么（他说"没必要的功能删减一下"）──
 *   · 左右翻页 / 环形切换（每个日积月累条目**最多一张图**）；
 *   · 旋转 90°（阅览不需要改方向）；
 *   · 下载 / 删除 / "新照片↔已录入"状态切换 / 勾选方框；
 *   · 顶部工具栏与文件名行 —— 只留一个关闭按钮。
 * 保留的只有：**缩放（滚轮 / 双指捏合）+ 平移（拖动 / 双指拖）+ 关闭（点空白 / Esc）**。
 *
 * ── 几条刻意的处理 ────────────────────────────────────────────────
 *   · **整屏浮层 + portal 到 body**：避免被编辑区的滚动/裁剪容器影响
 *     （`fixed inset-0` 一旦祖先有 transform/overflow 就会被带偏，portal 出去最省心）；
 *   · **no-print**：纸面永远不出现这层（打印时 `display:none`）；
 *   · **打开期间锁 body 滚动 + `touch-action:none`**：手机捏合时整页不许跟着缩放；
 *     卸载时把 body 的 overflow/overscroll 还原，关掉后页面滚动照常；
 *   · 图是 **dataURL**（存 `InsightPhoto` 表、接口给到前端），直接用 `<img src>`，
 *     不套 `next/image`。浮层与编辑区是**同一次 React 渲染**，开/关只动一个布尔量，
 *     草稿、光标、未保存的改动一概不受影响。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    computeFitZoom,
    resolveView,
    zoomAtPoint,
    type Offset,
    type ResolvedView,
    type Size,
} from "@/lib/image-view";

export interface ImageZoomViewerProps {
    open: boolean;
    /** 要看的图（dataURL / objectURL 均可） */
    src: string | null;
    alt?: string;
    onClose: () => void;
}

export function ImageZoomViewer({ open, src, alt = "", onClose }: ImageZoomViewerProps) {
    const { language } = useLanguage();
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);

    /**
     * portal 只能在本机做（服务端没有 document）。
     * 直接判 `typeof document`，**不在 effect 里 setState**：`open` 初始必为 false、
     * 只有用户点击才会变 true，服务端与客户端首帧都渲染 null，不存在水合不一致。
     */
    const canPortal = typeof document !== "undefined";

    const viewportRef = useRef<HTMLDivElement | null>(null);
    /** 图片自然像素尺寸（onLoad 读到）。作为缩放/钳制的唯一基准 */
    const [nat, setNat] = useState<Size>({ w: 0, h: 0 });
    const natRef = useRef<Size>({ w: 0, h: 0 });
    const [view, setView] = useState<ResolvedView>({
        zoom: 1,
        pan: { x: 0, y: 0 },
        tx: 0,
        ty: 0,
    });
    const viewRef = useRef(view);
    useEffect(() => {
        viewRef.current = view;
    }, [view]);

    const pointersRef = useRef<Map<number, Offset>>(new Map());
    const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);
    const panDragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
    /** 这一轮手势有没有真的移动过 —— 用来把"拖动"和"点击空白关闭"分开 */
    const movedRef = useRef(false);
    /**
     * 是否仍处于「自动适应」。用户一旦自己缩放/平移就退出，免得手机收个地址栏、
     * 窗口高度一变，画面被拽回整图、刚找的细节白找（与既有预览页同一套判断）。
     */
    const autoFitRef = useRef(true);

    /** 所有缩放/平移的收口：解算并写回 state + ref */
    const apply = useCallback((zoomRaw: number, pan: Offset) => {
        const vp = viewportRef.current;
        const img = natRef.current;
        if (!vp || !img.w || !img.h) return;
        const next = resolveView({ w: vp.clientWidth, h: vp.clientHeight }, img, zoomRaw, pan);
        viewRef.current = next;
        setView(next);
    }, []);

    /** 「适应大小」：整图居中铺满 */
    const fit = useCallback(() => {
        autoFitRef.current = true;
        const vp = viewportRef.current;
        const img = natRef.current;
        if (!vp || !img.w || !img.h) return;
        apply(computeFitZoom({ w: vp.clientWidth, h: vp.clientHeight }, img), { x: 0, y: 0 });
    }, [apply]);

    /**
     * 打开 / 换图 / 图加载完 → 回到适应大小。
     * 用两层 rAF 等布局稳定：浮层刚挂上来的第一帧视口尺寸可能还是 0。
     */
    useEffect(() => {
        if (!open) return;
        const id = requestAnimationFrame(() => {
            requestAnimationFrame(() => fit());
        });
        return () => cancelAnimationFrame(id);
    }, [open, src, nat.w, nat.h, fit]);

    // 窗口尺寸变化：没手动缩放过就重新适应，否则只把画面钳回边界内
    useEffect(() => {
        const vp = viewportRef.current;
        if (!open || !vp) return;
        const ro = new ResizeObserver(() => {
            if (autoFitRef.current) fit();
            else apply(viewRef.current.zoom, viewRef.current.pan);
        });
        ro.observe(vp);
        return () => ro.disconnect();
    }, [open, fit, apply]);

    // 电脑端滚轮缩放：以鼠标位置为中心。原生非 passive 监听，才能 preventDefault 掉页面滚动
    useEffect(() => {
        const vp = viewportRef.current;
        if (!open || !vp) return;
        const onWheel = (e: WheelEvent) => {
            if (!vp.contains(e.target as Node)) return;
            e.preventDefault();
            // 归一化：有些鼠标/触控板按"行"或"页"上报
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 16;
            else if (e.deltaMode === 2) dy *= 100;
            const r = vp.getBoundingClientRect();
            const cur = viewRef.current;
            const next = zoomAtPoint(
                { w: vp.clientWidth, h: vp.clientHeight },
                natRef.current,
                cur,
                { x: e.clientX - r.left, y: e.clientY - r.top },
                cur.zoom * Math.exp(-dy * 0.002),
            );
            autoFitRef.current = false;
            viewRef.current = next;
            setView(next);
        };
        vp.addEventListener("wheel", onWheel, { passive: false });
        return () => vp.removeEventListener("wheel", onWheel);
    }, [open]);

    // Esc 关闭
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    // 打开期间锁 body 滚动；关掉后原样还原（别留下后遗症）
    useEffect(() => {
        if (!open) return;
        const body = document.body;
        const prevOverflow = body.style.overflow;
        const prevOverscroll = body.style.overscrollBehavior;
        body.style.overflow = "hidden";
        body.style.overscrollBehavior = "none";
        return () => {
            body.style.overflow = prevOverflow;
            body.style.overscrollBehavior = prevOverscroll;
        };
    }, [open]);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!natRef.current.w) return;
        e.preventDefault();
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            /* 个别浏览器极端情况会抛，忽略 —— 拿不到捕获只是拖动可能中断 */
        }
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        movedRef.current = false;

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

        panDragRef.current = {
            sx: e.clientX,
            sy: e.clientY,
            px: viewRef.current.pan.x,
            py: viewRef.current.pan.y,
        };
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (pointersRef.current.has(e.pointerId)) {
            pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }
        const vp = viewportRef.current;
        if (!vp) return;
        const vpSize = { w: vp.clientWidth, h: vp.clientHeight };
        const pts = [...pointersRef.current.values()];

        // 双指：捏合缩放 + 双指平移
        if (pts.length >= 2 && pinchRef.current) {
            const g = pinchRef.current;
            const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const mx = (pts[0].x + pts[1].x) / 2;
            const my = (pts[0].y + pts[1].y) / 2;
            const r = vp.getBoundingClientRect();
            if (g.dist > 0) {
                const zoomed = zoomAtPoint(
                    vpSize,
                    natRef.current,
                    viewRef.current,
                    { x: g.midX - r.left, y: g.midY - r.top },
                    viewRef.current.zoom * (d / g.dist),
                );
                // 双指中心移动量 = 平移量（捏合的同时可以拖着走）
                const next = resolveView(vpSize, natRef.current, zoomed.zoom, {
                    x: zoomed.pan.x + (mx - g.midX),
                    y: zoomed.pan.y + (my - g.midY),
                });
                autoFitRef.current = false;
                viewRef.current = next;
                setView(next);
            }
            g.dist = d;
            g.midX = mx;
            g.midY = my;
            movedRef.current = true;
            return;
        }

        // 单指 / 鼠标：平移
        if (panDragRef.current) {
            const pd = panDragRef.current;
            const dx = e.clientX - pd.sx;
            const dy = e.clientY - pd.sy;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
            autoFitRef.current = false;
            apply(viewRef.current.zoom, { x: pd.px + dx, y: pd.py + dy });
        }
    };

    const onPointerUp = (e?: React.PointerEvent<HTMLDivElement>) => {
        if (e) pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size < 2) pinchRef.current = null;
        if (pointersRef.current.size === 0) panDragRef.current = null;
    };

    /**
     * 关闭：只认"点在空白处"。点在图上（target 是图片外框）不关 ——
     * 移动端 `pointerEvents:none` 的 img 会让事件落到外框上，正好能区分。
     */
    const onViewportClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (movedRef.current) return;
        if (e.target !== viewportRef.current) return;
        onClose();
    };

    if (!open || !src || !canPortal) return null;

    return createPortal(
        <div
            className="no-print"
            style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.92)" }}
        >
            <div
                ref={viewportRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onClick={onViewportClick}
                onContextMenu={(e) => e.preventDefault()}
                style={{
                    position: "absolute",
                    inset: 0,
                    overflow: "hidden",
                    touchAction: "none",
                    overscrollBehavior: "none",
                    cursor: "grab",
                }}
            >
                <div
                    style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: nat.w || undefined,
                        height: nat.h || undefined,
                        lineHeight: 0,
                        transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`,
                        transformOrigin: "0 0",
                    }}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element -- 存的是 dataURL，next/image 用不上 */}
                    <img
                        src={src}
                        alt={alt}
                        draggable={false}
                        onLoad={(e) => {
                            const el = e.currentTarget;
                            natRef.current = { w: el.naturalWidth, h: el.naturalHeight };
                            setNat({ w: el.naturalWidth, h: el.naturalHeight });
                        }}
                        style={{
                            position: "absolute",
                            left: "50%",
                            top: "50%",
                            transform: "translate(-50%, -50%)",
                            userSelect: "none",
                            pointerEvents: "none",
                        }}
                    />
                </div>
            </div>

            <button
                type="button"
                onClick={onClose}
                aria-label={L("关闭", "Close")}
                title={L("关闭", "Close")}
                style={{
                    position: "absolute",
                    top: 12,
                    right: 12,
                    zIndex: 1,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 40,
                    width: 40,
                    borderRadius: 8,
                    background: "rgba(255,255,255,0.12)",
                    color: "#fff",
                }}
            >
                <X className="h-5 w-5" />
            </button>

            <p
                style={{
                    position: "absolute",
                    bottom: 12,
                    left: 0,
                    right: 0,
                    zIndex: 1,
                    textAlign: "center",
                    fontSize: 12,
                    color: "rgba(255,255,255,0.6)",
                    pointerEvents: "none",
                }}
            >
                {L(
                    "滚轮 / 双指缩放 · 拖动平移 · 点空白处或 Esc 关闭",
                    "Wheel / pinch to zoom · drag to pan · tap the background or Esc to close",
                )}
            </p>
        </div>,
        document.body,
    );
}
