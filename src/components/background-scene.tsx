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
            <div className="bg-tree">
                <svg className="tree tree-a" viewBox="0 0 300 400" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <g stroke="#6E6659" strokeLinecap="round">
                        <path d="M8 396 C 40 330 70 282 110 212 C 140 158 166 112 182 58" strokeWidth="4.4" />
                        <path d="M46 332 C 32 300 18 278 4 260" strokeWidth="1.9" />
                        <path d="M96 236 C 124 216 148 204 170 196" strokeWidth="1.9" />
                        <path d="M140 154 C 124 126 104 104 86 84" strokeWidth="1.5" />
                        <path d="M168 104 C 190 94 212 84 234 74" strokeWidth="1.3" />
                        <path d="M124 190 C 118 166 116 148 118 128" strokeWidth="1.1" />
                    </g>
                    <g fill="#6E6659">
                        <ellipse cx="4" cy="260" rx="7.5" ry="2.6" transform="rotate(-32 4 260)" />
                        <ellipse cx="16" cy="250" rx="6.5" ry="2.3" transform="rotate(-16 16 250)" />
                        <ellipse cx="170" cy="196" rx="7.5" ry="2.6" transform="rotate(-12 170 196)" />
                        <ellipse cx="183" cy="189" rx="6.5" ry="2.4" transform="rotate(8 183 189)" />
                        <ellipse cx="157" cy="204" rx="6" ry="2.2" transform="rotate(-36 157 204)" />
                        <ellipse cx="86" cy="84" rx="7.5" ry="2.6" transform="rotate(-46 86 84)" />
                        <ellipse cx="99" cy="77" rx="6.5" ry="2.4" transform="rotate(-28 99 77)" />
                        <ellipse cx="234" cy="74" rx="7" ry="2.5" transform="rotate(-8 234 74)" />
                        <ellipse cx="221" cy="82" rx="6" ry="2.2" transform="rotate(24 221 82)" />
                        <ellipse cx="182" cy="58" rx="7.5" ry="2.6" transform="rotate(-20 182 58)" />
                        <ellipse cx="197" cy="52" rx="6.5" ry="2.4" transform="rotate(6 197 52)" />
                        <ellipse cx="169" cy="64" rx="6" ry="2.2" transform="rotate(-42 169 64)" />
                        <ellipse cx="70" cy="286" rx="6.5" ry="2.4" transform="rotate(28 70 286)" />
                        <ellipse cx="60" cy="301" rx="6" ry="2.2" transform="rotate(12 60 301)" />
                        <ellipse cx="118" cy="128" rx="6.5" ry="2.4" transform="rotate(-64 118 128)" />
                    </g>
                </svg>

                <svg className="tree tree-b" viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <g stroke="#6E6659" strokeLinecap="round">
                        <path d="M6 296 C 42 250 78 212 118 172 C 148 142 174 116 196 90" strokeWidth="3.6" />
                        <path d="M52 252 C 30 236 12 220 2 206" strokeWidth="1.6" />
                        <path d="M104 186 C 130 172 152 164 176 158" strokeWidth="1.6" />
                        <path d="M150 140 C 140 116 128 98 114 80" strokeWidth="1.3" />
                    </g>
                    <g fill="#6E6659">
                        <ellipse cx="2" cy="206" rx="7" ry="2.5" transform="rotate(-40 2 206)" />
                        <ellipse cx="14" cy="198" rx="6" ry="2.2" transform="rotate(-22 14 198)" />
                        <ellipse cx="176" cy="158" rx="7" ry="2.5" transform="rotate(-8 176 158)" />
                        <ellipse cx="188" cy="152" rx="6" ry="2.2" transform="rotate(10 188 152)" />
                        <ellipse cx="164" cy="164" rx="5.8" ry="2.1" transform="rotate(-30 164 164)" />
                        <ellipse cx="114" cy="80" rx="7" ry="2.5" transform="rotate(-52 114 80)" />
                        <ellipse cx="126" cy="74" rx="6" ry="2.2" transform="rotate(-34 126 74)" />
                        <ellipse cx="196" cy="90" rx="7" ry="2.5" transform="rotate(-16 196 90)" />
                        <ellipse cx="208" cy="84" rx="6" ry="2.2" transform="rotate(4 208 84)" />
                        <ellipse cx="72" cy="224" rx="6" ry="2.2" transform="rotate(26 72 224)" />
                    </g>
                </svg>
            </div>

            <div className="bg-grain" />

            <div className="bg-stars-wrap">
                <div className="bg-stars bg-stars-a" />
                <div className="bg-stars bg-stars-b" />
            </div>

            {/* 弯月：缺口朝左（蛾眉月，傍晚可见的那种朝向） */}
            <div className="bg-moon" />
        </div>
    );
}
