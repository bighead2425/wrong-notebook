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

/** 时长五档（秒）。20 秒最慢，4 秒最快 —— 再快就开始抓眼睛了。 */
export const BG_DURATIONS = [4, 8, 12, 16, 20] as const;

/**
 * 大小五档。
 *
 * 界面上的数字就是"相对当前"的倍数：1× / 1.5× / 2× / 3× / 4×。
 * 实际落成两个变量：
 *   · 星星按原倍率放大（点本来就小，4× 才 11px 的光斑）
 *   · 暖光压缩到 1~2.5×（它本来就占大半屏，真放 4 倍会糊成一片橙色）
 */
export const BG_SCALES = [1, 1.5, 2, 3, 4] as const;

/** 开/关背景效果，并写入两根滑条的值（供长按面板调用） */
export function applyBackgroundEffects(on?: boolean, duration?: number, scale?: number) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (on) {
        root.dataset[BG_ATTR] = "on";
        root.style.setProperty("--bg-dur", `${duration ?? 20}s`);
        root.style.setProperty("--bg-scale", String(scale ?? 1));
    } else {
        delete root.dataset[BG_ATTR];
    }
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
