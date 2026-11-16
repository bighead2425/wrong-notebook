"use client";

import { useEffect } from "react";

/**
 * 【2026-11-17 空空】**背景效果层。**
 *
 * 三层叠在一起，全部 `pointer-events: none`、`z-index: -1`：
 *
 * | 层 | 浅色 | 深色 |
 * |---|---|---|
 * | 纸纹 `bg-grain` | ✅ 静态噪点 | ❌ 看不见，不加 |
 * | 阳光 `bg-sun` | ✅ 28 秒呼吸 | ❌ |
 * | 星点 `bg-stars-*` | ❌ | ✅ 两层 29s / 37s 错开 |
 *
 * ## 为什么 DOM 里永远渲染，只靠 `data-bg="on"` 控制显隐
 *
 * 关掉时用 `display: none` —— 浏览器会连动画一起停，不是"还在跑但看不见"。
 * 这样桌面和手机都不必为重渲染操心，切换也只是一次属性变化。
 *
 * ## 这里只做两件事
 *
 * 1. 渲染那几层 div（内容固定，永远不变）
 * 2. 页面切到后台时挂 `data-bg-paused`，把动画真正暂停 ——
 *    浏览器会节流但**不等于停止**，手机锁屏后仍在耗电。
 */
const BG_ATTR = "bg";
const PAUSE_ATTR = "bg-paused";

/** 开/关背景效果（供长按面板调用） */
export function applyBackgroundEffects(on?: boolean) {
    if (typeof document === "undefined") return;
    if (on) document.documentElement.dataset[BG_ATTR] = "on";
    else delete document.documentElement.dataset[BG_ATTR];
}

export function BackgroundScene() {
    useEffect(() => {
        const sync = () => {
            if (document.hidden) document.documentElement.dataset[PAUSE_ATTR] = "1";
            else delete document.documentElement.dataset[PAUSE_ATTR];
        };
        sync();
        document.addEventListener("visibilitychange", sync);
        return () => document.removeEventListener("visibilitychange", sync);
    }, []);

    return (
        /* aria-hidden：纯装饰，读屏软件不该念它 */
        <div className="bg-scene" aria-hidden="true">
            <div className="bg-sun" />
            <div className="bg-grain" />
            <div className="bg-stars bg-stars-a" />
            <div className="bg-stars bg-stars-b" />
        </div>
    );
}
