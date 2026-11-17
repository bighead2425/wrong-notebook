"use client";

import { useEffect } from "react";

/**
 * 【2026-11-17 空空】**背景效果层。**
 *
 * ## 亮环境用暗元素，暗环境用亮元素
 *
 * 浅色底上再叠亮的东西，对比度上不去，等于白做。所以：
 *
 * | | 浅色 | 深色 |
 * |---|---|---|
 * | 主元素 | **树影**（比背景暗） | **星点**（比背景亮） |
 * | 辅元素 | 纸纹 | 弯月 |
 *
 * ## 为什么树影只在左边
 *
 * 左右各一棵对称着摆，看起来像装饰边框，不像"窗外"。真实的光影总是偏一侧的。
 * 所以两组都从左边伸进来，一上一下，允许重叠。
 *
 * ## 性能
 *
 * 树影摆动只动 `transform: rotate()`，星点只动 `opacity` ——
 * 两者都是合成层动画，不触发逐帧重算。
 * **树影的柔边不用 `filter: blur()`**（那才会逐帧算），靠形状细 + 整体透明度低。
 */

const BG_ATTR = "bg";
const PAUSE_ATTR = "bg-paused";

/** 树影大小五档 */
export const TREE_SCALES = [0.7, 0.9, 1.2, 1.5, 1.85] as const;
/** 树影浓淡五档 */
export const TREE_OPACITIES = [0.05, 0.08, 0.11, 0.15, 0.2] as const;
/** 摆动周期（秒），索引 0 最快 */
export const TREE_SPEEDS = [8, 14, 20, 26, 32] as const;
/** 纸纹深浅五档 */
export const GRAIN_OPACITIES = [0.03, 0.05, 0.07, 0.1, 0.13] as const;

/** 星星大小五档（每颗星半径的倍数，**不影响数量**） */
export const STAR_SCALES = [1, 1.4, 1.9, 2.6, 3.5] as const;
/** 星光亮度五档 */
export const STAR_BRIGHTS = [0.5, 0.7, 0.9, 1.1, 1.35] as const;
/** 呼吸周期（秒），索引 0 最快 */
export const STAR_SPEEDS = [4, 8, 12, 16, 20] as const;

/**
 * 月亮颜色五档：皎白 → 血月。
 *
 * 血月不只是换色相，**明度一路压下去**（0.97 → 0.62）：
 * 真正的血月是"暗下来的红"，如果只改色相不降明度，会变成一盏橙色小灯，
 * 比白月亮还抢眼。
 */
export const MOON_COLORS = [
    { zh: "皎白", value: "oklch(0.97 0.012 95)" },
    { zh: "淡黄", value: "oklch(0.95 0.05 92)" },
    { zh: "暖金", value: "oklch(0.9 0.1 80)" },
    { zh: "浅橙", value: "oklch(0.82 0.13 55)" },
    { zh: "血月", value: "oklch(0.62 0.16 30)" },
] as const;

export interface EffectSettings {
    on: boolean;
    treeScale: number;
    treeOpacity: number;
    treeSpeed: number;
    grainOpacity: number;
    starScale: number;
    starBright: number;
    starSpeed: number;
    /** 月亮档位（0..4）：皎白 → 血月。存档位不存色值 —— 浏览器会把
     *  oklch 归一化成 rgb，字符串比不回来，刷新后滑条就对不上了。 */
    moonTint: number;
}

export const EFFECT_DEFAULTS: EffectSettings = {
    on: false,
    treeScale: 1,
    treeOpacity: 0.1,
    treeSpeed: 20,
    grainOpacity: 0.06,
    starScale: 1,
    starBright: 1,
    starSpeed: 20,
    moonTint: 0,
};

/** 开/关背景效果，并写入全部可调项（供长按面板调用） */
export function applyBackgroundEffects(s?: Partial<EffectSettings>) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const v = { ...EFFECT_DEFAULTS, ...s };

    if (!v.on) {
        delete root.dataset[BG_ATTR];
        return;
    }
    root.dataset[BG_ATTR] = "on";
    const set = (k: string, val: string) => root.style.setProperty(k, val);
    set("--tree-scale", String(v.treeScale));
    set("--tree-opacity", String(v.treeOpacity));
    set("--tree-dur", `${v.treeSpeed}s`);
    set("--grain-opacity", String(v.grainOpacity));
    set("--star-scale", String(v.starScale));
    set("--star-bright", String(v.starBright));
    set("--star-dur", `${v.starSpeed}s`);
    set("--moon-color", MOON_COLORS[v.moonTint]?.value ?? MOON_COLORS[0].value);
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
            {/*
             * 树影：两组，都在左边，一上一下，允许重叠。
             * SVG 的根画在左下角，配合 CSS 的 `transform-origin: 0% 100%`
             * 就是"以树根为轴摆动"。
             */}
            {/*
             * 树影：两组，根部都在**右上角**，枝叶向左下伸展。
             * 两组一上一下、允许重叠，周期差 45%（同步摆动看着像机器）。
             * SVG 的根画在右上，配合 CSS 的 `transform-origin: 100% 0%`，
             * 摆动起来就是"从枝头挂下来"的感觉。
             */}
            <div className="bg-tree">
                <svg className="tree tree-a" viewBox="0 0 300 400" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <g stroke="#6E6659" strokeLinecap="round">
                        {/* 主干：右上 → 左下 */}
                        <path d="M296 6 C 258 56 218 108 184 162 C 150 216 116 280 90 344" strokeWidth="4.6" />
                        <path d="M246 66 C 214 54 188 38 166 16" strokeWidth="2.1" />
                        <path d="M208 124 C 168 114 138 96 110 72" strokeWidth="2" />
                        <path d="M168 190 C 132 200 104 218 80 246" strokeWidth="1.7" />
                        <path d="M130 264 C 158 282 180 302 198 330" strokeWidth="1.5" />
                        <path d="M90 344 C 58 356 34 372 14 390" strokeWidth="1.3" />
                    </g>
                    <g fill="#6E6659">
                        <ellipse cx="166" cy="16" rx="7.6" ry="2.7" transform="rotate(-34 166 16)" />
                        <ellipse cx="178" cy="24" rx="6.6" ry="2.4" transform="rotate(-16 178 24)" />
                        <ellipse cx="152" cy="26" rx="6" ry="2.2" transform="rotate(-48 152 26)" />
                        <ellipse cx="110" cy="72" rx="7.6" ry="2.7" transform="rotate(-24 110 72)" />
                        <ellipse cx="122" cy="64" rx="6.6" ry="2.4" transform="rotate(-6 122 64)" />
                        <ellipse cx="96" cy="82" rx="6" ry="2.2" transform="rotate(-42 96 82)" />
                        <ellipse cx="80" cy="246" rx="7.4" ry="2.6" transform="rotate(28 80 246)" />
                        <ellipse cx="92" cy="238" rx="6.4" ry="2.3" transform="rotate(10 92 238)" />
                        <ellipse cx="198" cy="330" rx="7" ry="2.5" transform="rotate(34 198 330)" />
                        <ellipse cx="186" cy="338" rx="6" ry="2.2" transform="rotate(16 186 338)" />
                        <ellipse cx="14" cy="390" rx="7.2" ry="2.6" transform="rotate(30 14 390)" />
                        <ellipse cx="28" cy="380" rx="6.2" ry="2.3" transform="rotate(12 28 380)" />
                        <ellipse cx="184" cy="162" rx="6.8" ry="2.5" transform="rotate(-58 184 162)" />
                        <ellipse cx="196" cy="150" rx="5.8" ry="2.1" transform="rotate(-70 196 150)" />
                        <ellipse cx="230" cy="92" rx="6.4" ry="2.3" transform="rotate(-38 230 92)" />
                        <ellipse cx="152" cy="212" rx="6" ry="2.2" transform="rotate(-72 152 212)" />
                    </g>
                </svg>

                <svg className="tree tree-b" viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <g stroke="#6E6659" strokeLinecap="round">
                        <path d="M292 8 C 252 48 212 92 178 138 C 146 182 116 232 92 284" strokeWidth="3.6" />
                        <path d="M236 66 C 204 56 178 42 156 22" strokeWidth="1.8" />
                        <path d="M188 124 C 152 132 126 148 104 172" strokeWidth="1.7" />
                        <path d="M142 196 C 168 214 188 232 204 254" strokeWidth="1.5" />
                        <path d="M92 284 C 62 296 40 310 20 326" strokeWidth="1.3" />
                    </g>
                    <g fill="#6E6659">
                        <ellipse cx="156" cy="22" rx="7" ry="2.5" transform="rotate(-32 156 22)" />
                        <ellipse cx="168" cy="30" rx="6" ry="2.2" transform="rotate(-14 168 30)" />
                        <ellipse cx="104" cy="172" rx="7" ry="2.5" transform="rotate(18 104 172)" />
                        <ellipse cx="116" cy="164" rx="6" ry="2.2" transform="rotate(2 116 164)" />
                        <ellipse cx="204" cy="254" rx="6.8" ry="2.4" transform="rotate(28 204 254)" />
                        <ellipse cx="192" cy="262" rx="5.8" ry="2.1" transform="rotate(12 192 262)" />
                        <ellipse cx="20" cy="326" rx="7" ry="2.5" transform="rotate(26 20 326)" />
                        <ellipse cx="34" cy="316" rx="6" ry="2.2" transform="rotate(10 34 316)" />
                        <ellipse cx="152" cy="168" rx="6.2" ry="2.2" transform="rotate(-64 152 168)" />
                        <ellipse cx="214" cy="96" rx="6.4" ry="2.3" transform="rotate(-40 214 96)" />
                    </g>
                </svg>
            </div>

            <div className="bg-grain" />

            <div className="bg-stars-wrap">
                <div className="bg-stars bg-stars-a" />
                <div className="bg-stars bg-stars-b" />
            </div>

            {/*
             * 弯月：**缺口朝左**（蛾眉月，傍晚可见的那种朝向）。
             *
             * 为什么用 SVG 而不是 CSS 的 inset box-shadow：
             * box-shadow 只能给一个纯色月牙，没有明暗过渡、没有光晕，
             * 看起来就像一张纸片贴在屏幕上。
             *
             * 这里三层叠起来：
             *   ① 月晕：径向渐变，从 30% 透明度柔到全透明
             *   ② 月牙本体：`--moon-color` 填充，用 mask 从整圆里挖掉偏左的圆
             *   ③ 球面明暗：线性渐变叠在月牙上（左上亮、右下暗），让它看起来是"球"不是"片"
             *
             * 全是静态渐变，绘制一次即缓存，不参与逐帧计算。
             */}
            <div className="bg-moon">
                <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <defs>
                        <radialGradient id="bg-moon-halo">
                            <stop offset="0%" stopColor="var(--moon-color)" stopOpacity="0.3" />
                            <stop offset="34%" stopColor="var(--moon-color)" stopOpacity="0.13" />
                            <stop offset="62%" stopColor="var(--moon-color)" stopOpacity="0.045" />
                            <stop offset="100%" stopColor="var(--moon-color)" stopOpacity="0" />
                        </radialGradient>
                        <linearGradient id="bg-moon-sheen" x1="0.15" y1="0.08" x2="0.9" y2="0.95">
                            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
                            <stop offset="42%" stopColor="#ffffff" stopOpacity="0.1" />
                            <stop offset="100%" stopColor="#000000" stopOpacity="0.24" />
                        </linearGradient>
                        <mask id="bg-moon-crescent">
                            <circle cx="50" cy="50" r="30" fill="#ffffff" />
                            <circle cx="34" cy="50" r="29.4" fill="#000000" />
                        </mask>
                    </defs>
                    <circle cx="50" cy="50" r="50" fill="url(#bg-moon-halo)" />
                    <circle cx="50" cy="50" r="30" fill="var(--moon-color)" mask="url(#bg-moon-crescent)" />
                    <circle cx="50" cy="50" r="30" fill="url(#bg-moon-sheen)" mask="url(#bg-moon-crescent)" />
                </svg>
            </div>
        </div>
    );
}
