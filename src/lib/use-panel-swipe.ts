"use client";

import { useRef } from "react";

/**
 * 【2026-10-12 需求第 2 条】手机端"划一下就把左栏收起来 / 叫出来"。
 *
 * 他原话："在手机端，已有组卷页、日积月累页、积累纸·打印页，对左边栏进行**从右至左**划动，
 *          意为隐藏左边栏；对右边栏进行**从左到右**划动，意为显示左边栏。"
 *
 * ⇒ 左栏上「向左划」= 收起（它本来就在左边，往左退出去最顺）；
 *    右栏上「向右划」= 把左栏拉回来。
 *
 * ── 为什么用 touch 事件而不是 pointer 事件 ─────────────────────────
 * 这两个页面上**已经有** pointer 拖拽（纸上的题图缩放把手、留白虚线），
 * 再用 pointer 判手势会跟它们抢事件。触屏上"划一下"本来就是手指动作，
 * 用 `touchstart / touchend` 最省事，也不会影响鼠标。
 *
 * ── 三条判据（缺一条就会误触发）────────────────────────────────
 *   ① **够长**：横向位移 > 60px（手抖、点按都不会到这）；
 *   ② **够平**：纵向位移 < 40px（上下滑页面不能被当成划栏 —— 这条最关键）；
 *   ③ **够快**：从按下到抬起 < 400ms（**慢拖**不当手势：纸上的题图缩放把手
 *      正是"慢慢往右拖"，不加这条，手机上每次拖图都会把左栏叫出来）。
 * 三条同时满足才触发，触发后**不 preventDefault**（页面该怎么滚还怎么滚）。
 */
export interface PanelSwipeHandlers {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
}

export function usePanelSwipe(opts: {
    /** 向左划（横向位移为负）时干的事 —— 给"左栏"传"收起" */
    onSwipeLeft?: () => void;
    /** 向右划（横向位移为正）时干的事 —— 给"右栏"传"把左栏叫回来" */
    onSwipeRight?: () => void;
    /** 横向位移门槛（px），默认 60 */
    threshold?: number;
    /** 纵向位移上限（px），默认 40 */
    maxCross?: number;
    /** 最长时长（ms），默认 400 */
    maxDuration?: number;
}): PanelSwipeHandlers {
    const start = useRef<{ x: number; y: number; t: number } | null>(null);

    return {
        onTouchStart: (e: React.TouchEvent) => {
            /**
             * ⚠️ **从滑块 / 输入框 / 按钮上开始的这一下，不算划栏手势。**
             *
             * 这几个左栏里全是滑块（留白高度、题图宽度都是 `<input type="range">`），
             * 手机上"按住滑块往右拖"既够长、又够平、也够快 —— 三条判据全都满足，
             * 于是**每次调滑块都会把左栏收掉**。这条是专门堵它的：
             * 手指落在表单控件上，就不记起点（自然也不会触发）。
             */
            const el = e.target as HTMLElement | null;
            if (el?.closest?.("input, select, textarea, button, a, [role='slider']")) {
                start.current = null;
                return;
            }
            const t = e.touches[0];
            if (!t) return;
            start.current = { x: t.clientX, y: t.clientY, t: Date.now() };
        },
        onTouchEnd: (e: React.TouchEvent) => {
            const s = start.current;
            start.current = null;
            if (!s) return;
            const t = e.changedTouches[0];
            if (!t) return;

            const dx = t.clientX - s.x;
            const dy = Math.abs(t.clientY - s.y);
            const threshold = opts.threshold ?? 60;
            const maxCross = opts.maxCross ?? 40;
            const maxDuration = opts.maxDuration ?? 400;

            if (dy > maxCross) return; // ② 纵向太多 ⇒ 那是上下滑页面
            if (Date.now() - s.t > maxDuration) return; // ③ 太慢 ⇒ 那是拖着别的东西
            if (Math.abs(dx) < threshold) return; // ① 不够长

            if (dx < 0) opts.onSwipeLeft?.();
            else opts.onSwipeRight?.();
        },
    };
}
