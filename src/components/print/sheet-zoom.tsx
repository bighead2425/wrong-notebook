"use client";

/**
 * 【2026-09-30 新增】**纸面的两档大小**：实际大小 ⇄ 适应宽度。
 *
 * 他实测报的：电脑上看得清，一到手机上纸太宽，得左右拉着才看得全一行。
 * 要的是"双击纸面空白处"在两档之间切：手机上双击、电脑上鼠标双击，同一个动作。
 *
 * ── 为什么用 CSS `zoom` 而不是 `transform: scale()` ──────────────
 *   `transform` **不改变布局**：缩了之后外层还按原尺寸占位 ⇒ 右栏照样能横向滚，
 *   而且整页高度也算错（这就是"缩了但滚动条还在"的常见坑）。
 *   `zoom` 是**参与布局**的缩放：纸变小、占位也变小 ⇒ 不用横滑、高度也对。
 *
 * ⚠️ 量尺容器（`print-review-measure`）**必须放在这个组件外面**：
 *    `getBoundingClientRect()` 拿到的是**缩放后**的像素，装进来的话量出的 mm 会整体偏小，
 *    分页就会以为"一页能装更多" —— 那是会直接印错版面的。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** B5 整纸宽（内容 152mm + 左右各 15mm 纸边）= 182mm，换算成 CSS px（CSS 规定 1in = 96px） */
export const SHEET_FULL_WIDTH_PX = (182 * 96) / 25.4;

/** 最小缩放 —— 再小字就糊了，不如让他横滑 */
export const SHEET_ZOOM_MIN = 0.3;

/**
 * 算出"适应宽度"该缩多少：可用宽度 / 整纸宽，夹在 [MIN, 1]。
 * 不用 `height` 参与 —— 手机横屏时宽度才是瓶颈，按宽度缩就一定不用横滑。
 */
export function fitZoomFor(availablePx: number, fullWidthPx: number = SHEET_FULL_WIDTH_PX): number {
    if (!Number.isFinite(availablePx) || availablePx <= 0) return 1;
    return Math.max(SHEET_ZOOM_MIN, Math.min(1, availablePx / fullWidthPx));
}

export function SheetZoom({
    children,
    className = "",
    L,
}: {
    children: ReactNode;
    className?: string;
    L: (zh: string, en: string) => string;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [fit, setFit] = useState(false);
    /**
     * 可用宽度（px）。**只存宽度、不存缩放值** ——
     * 缩放由渲染时算（`fit ? fitZoomFor(avail) : 1`）。
     * 这样"关掉适应"不需要在 effect 里 setState（那会踩 `react-hooks/set-state-in-effect`，
     * 而且多一轮渲染）：关掉时直接按宽度分支算出 1。
     */
    const [avail, setAvail] = useState<number | null>(null);

    const measure = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        // 减掉左右内边距（用算出来的真实值，别写死 16px —— 窄屏/宽屏的 padding 不一样）
        const cs = getComputedStyle(el);
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        setAvail(el.clientWidth - pad);
    }, []);

    useEffect(() => {
        if (!fit) return;
        measure();
        // 转屏 / 拖窗口 / 左右栏变宽窄，都要重算
        window.addEventListener("resize", measure);
        const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
        if (ro && ref.current) ro.observe(ref.current);
        return () => {
            window.removeEventListener("resize", measure);
            ro?.disconnect();
        };
    }, [fit, measure]);

    /** 实际大小 = 1；适应宽度 = 按可用宽度算（宽度还没量到时 `fitZoomFor` 会给 1，量到就纠正） */
    const zoom = fit ? fitZoomFor(avail ?? 0) : 1;

    /**
     * 双击切换两档。
     * ⚠️ **只认"空白处"**：点在题目块 / 按钮 / 输入框 / 各种把手上一律不理 ——
     *    否则"双击选中一句话"或"双击那个留白数字"会莫名其妙把整页缩放掉。
     */
    const onDoubleClick = (e: React.MouseEvent) => {
        const t = e.target as HTMLElement | null;
        if (
            t?.closest(
                "[data-review-block], button, a, input, select, textarea, label, .print-review-tweak, .print-fig-handle",
            )
        ) {
            return;
        }
        setFit((v) => !v);
    };

    return (
        <div ref={ref} className={className} onDoubleClick={onDoubleClick}>
            <p className="mb-2 text-[11px] text-muted-foreground no-print">
                {fit
                    ? L(
                          "当前：适应宽度（双击纸面空白处回到实际大小）",
                          "Fit to width (double-click blank area for actual size)",
                      )
                    : L(
                          "当前：实际大小（双击纸面空白处改为适应宽度，手机上不用左右拉）",
                          "Actual size (double-click blank area to fit width)",
                      )}
            </p>
            <div data-sheet-zoom style={{ zoom }}>
                {children}
            </div>
        </div>
    );
}
