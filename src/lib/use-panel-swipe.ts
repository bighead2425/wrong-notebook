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
 * 三条同时满足才触发。触发后 `preventDefault()` **只吃掉这一次的 click**（别让它顺手
 * 点开一条卷 / 一条积累），**不影响滚动** —— 滚动早在 touchmove 阶段就走完了。
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
             * ⚠️ **只排除"按一下就要生效、而且真的需要拖"的表单控件。**
             *
             * 原来这里还写着 `button, a` —— 那是错的，也正是他 2026-10-19 报的那个毛病：
             *
             *   "在『复练』『模仿』『年级』『学科』左右这个位置能够划动成功，
             *    在下面的卷名卷号的位置上面，如果我也从右向左划动，是无法隐藏左边框的。
             *    日积月累·管理页，左边框也是这个问题，在积累条目上面从右向左划动无法隐藏。"
             *
             * 原因：**左栏里每一张卷、每一条积累，整块就是一个 `<button>`**
             * （点它 = 打开这一条）。判据把 button 排除了 ⇒ 在最该划的地方（卷名、条目正文）
             * 开始的那一下**根本没记起点**，自然永远不会触发；
             * 而筛选栏的缝隙里 target 是 `div`，反而能划 —— 于是就成了"时灵时不灵"。
             *
             * 按钮/链接的误触不用担心：手势要求横向 > 60px，
             * 移动端浏览器在手指划出十几像素后就会**取消这次 click**；
             * 真判定成功时下面还会 `preventDefault()` 兜一道。
             */
            const el = e.target as HTMLElement | null;
            if (el?.closest?.("input, select, textarea, [role='slider']")) {
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

            if (dx < 0) {
                // 判定成功 ⇒ 吃掉这次触摸的收尾，别让它再派发成一次点击
                e.preventDefault();
                opts.onSwipeLeft?.();
            } else {
                e.preventDefault();
                opts.onSwipeRight?.();
            }
        },
    };
}
