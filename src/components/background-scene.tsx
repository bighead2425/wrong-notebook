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
 * ## 树影的柔边：三层叠色，不用 blur
 *
 * 逆向 openhanako 的结论很有意思：它的"树影"**是一段 40 秒的 MP4 视频**
 * （`mix-blend-mode: multiply` + `opacity .28`），柔度来自拍摄时的光学失焦 ——
 * 也就是说它不是画出来的，是拍出来的。
 *
 * 我们没有实拍素材，只能用矢量仿。仿的关键在边缘：
 * **同一组路径画三遍，越外圈越粗越淡**（1.9 倍宽 / 32% 不透明 → 1 倍宽 / 100%）。
 * 三层叠起来，远处看是一条柔边，近看是三层 —— 但不用 `filter: blur()`，
 * 那才是真正的逐帧计算。
 *
 * ## 参数来自逆向
 *
 * 叶片 24×8 纺锤形（单侧 3 条贝塞尔，两端收尖）、分叉 3 级、
 * 粗细按 0.55 等比递减、叶子沿枝两侧交错 ≈ 成簇。
 */

const BG_ATTR = "bg";
const PAUSE_ATTR = "bg-paused";

/** 树影颜色。暖褐，不是黑 —— 影子用纯黑在米色纸上会显脏。 */
const TREE_INK = "#57473A";

/** 三层柔边的参数：外层最粗最淡，内层原样最实 */
const SOFT_LAYERS = [
    { mul: 1.9, opacity: 0.32 },
    { mul: 1.35, opacity: 0.62 },
    { mul: 1, opacity: 1 },
] as const;

interface Branch {
    d: string;
    w: number;
}
/** [x, y, 旋转角度, 缩放] */
type Leaf = [number, number, number, number?];

/**
 * 第一组树的形状（viewBox 300×400）。
 *
 * 根在**右上角** (292,6)，主干一路向左下伸到 (96,356)。
 * 三级分叉：主干 → 一级枝（A~E）→ 二级枝（A1/B1/C1/D1）。
 */
const TREE_A_BRANCHES: Branch[] = [
    { d: "M292 6 C 258 58 224 110 194 168", w: 5.6 },
    { d: "M194 168 C 164 226 128 294 96 356", w: 4.4 },
    { d: "M250 52 C 220 40 194 24 170 6", w: 2.4 },
    { d: "M194 24 C 182 14 172 8 158 2", w: 1.2 },
    { d: "M220 96 C 186 96 158 108 134 126", w: 2.3 },
    { d: "M158 108 C 146 122 136 136 128 152", w: 1.3 },
    { d: "M194 168 C 158 172 130 184 104 204", w: 2.2 },
    { d: "M130 184 C 112 176 96 170 80 166", w: 1.2 },
    { d: "M162 232 C 190 244 212 260 230 280", w: 2 },
    { d: "M212 260 C 228 268 244 280 256 294", w: 1.2 },
    { d: "M126 306 C 100 312 74 320 50 332", w: 1.8 },
    { d: "M96 356 C 84 362 74 368 64 376", w: 1.2 },
];

const TREE_A_LEAVES: Leaf[] = [
    [240, 44, -52, 1],
    [226, 36, -38, 0.9],
    [210, 26, -58, 1.1],
    [196, 16, -34, 0.85],
    [186, 20, -48, 0.9],
    [172, 10, -30, 0.8],
    [206, 98, -12, 1],
    [190, 102, -28, 0.9],
    [174, 108, -6, 1.05],
    [158, 116, -22, 0.85],
    [150, 124, 44, 0.85],
    [140, 136, 52, 0.8],
    [132, 148, 38, 0.75],
    [180, 170, 18, 1],
    [164, 176, 6, 0.95],
    [148, 182, 26, 0.9],
    [132, 190, 10, 0.85],
    [116, 180, -24, 0.8],
    [100, 172, -38, 0.75],
    [86, 168, -16, 0.7],
    [180, 240, 32, 0.95],
    [196, 250, 22, 1],
    [212, 262, 38, 0.9],
    [226, 272, 28, 0.85],
    [240, 282, 40, 0.75],
    [252, 290, 30, 0.7],
    [112, 308, 16, 0.9],
    [96, 314, 28, 0.85],
    [80, 320, 12, 0.8],
    [66, 326, 24, 0.75],
    [88, 358, 36, 0.8],
    [72, 368, 20, 0.75],
    [258, 72, -20, 0.9],
    [238, 124, -8, 0.85],
    [206, 144, 14, 0.8],
    [176, 204, 28, 0.85],
];

/** 第二组（viewBox 300×300）：更小、更稀，拉出层次 */
const TREE_B_BRANCHES: Branch[] = [
    { d: "M292 8 C 254 52 216 96 184 140", w: 4.6 },
    { d: "M184 140 C 152 184 122 234 98 286", w: 3.6 },
    { d: "M252 50 C 224 38 200 22 178 4", w: 2 },
    { d: "M214 90 C 180 92 152 104 128 122", w: 1.9 },
    { d: "M184 140 C 150 146 124 158 100 178", w: 1.8 },
    { d: "M152 196 C 178 208 198 222 214 240", w: 1.6 },
    { d: "M98 286 C 74 292 52 300 32 310", w: 1.4 },
];

const TREE_B_LEAVES: Leaf[] = [
    [240, 44, -48, 0.85],
    [222, 32, -34, 0.8],
    [204, 22, -56, 0.75],
    [196, 96, -14, 0.8],
    [178, 102, -30, 0.75],
    [160, 112, -6, 0.8],
    [148, 126, 42, 0.7],
    [138, 140, 50, 0.65],
    [168, 148, 16, 0.8],
    [148, 158, 26, 0.75],
    [128, 168, 10, 0.7],
    [110, 174, -22, 0.65],
    [172, 208, 30, 0.75],
    [190, 220, 22, 0.7],
    [206, 232, 36, 0.65],
    [118, 272, 18, 0.7],
    [98, 282, 26, 0.65],
    [78, 290, 12, 0.6],
    [60, 300, 24, 0.55],
    [230, 70, -22, 0.7],
];

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
 * 真正的血月是"暗下来的红"，只改色相不降明度会变成一盏橙色小灯，比白月亮还抢眼。
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

/**
 * 一棵树的轮廓：枝条画三层（伪柔边），叶子画一层。
 *
 * 叶子为什么不也三层：叶子本身只有 24×8，再往外加粗只会糊成一团，
 * 而且数量翻三倍会让 DOM 节点从 ~80 涨到 ~200。柔边的收益主要在**枝条**上。
 */
function TreeSilhouette({
    className,
    viewBox,
    branches,
    leaves,
    leafId,
}: {
    className: string;
    viewBox: string;
    branches: Branch[];
    leaves: Leaf[];
    leafId: string;
}) {
    return (
        <svg className={className} viewBox={viewBox} fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
                {/* 纺锤形叶片：24×8，两端收尖，单侧 3 条贝塞尔 */}
                <path id={leafId} d="M-12 0 C-6 -4 6 -4 12 0 C6 4 -6 4 -12 0 Z" />
            </defs>

            {SOFT_LAYERS.map((layer) => (
                <g
                    key={layer.mul}
                    stroke={TREE_INK}
                    strokeLinecap="round"
                    opacity={layer.opacity}
                >
                    {branches.map((b, i) => (
                        <path key={i} d={b.d} strokeWidth={b.w * layer.mul} />
                    ))}
                </g>
            ))}

            <g fill={TREE_INK}>
                {leaves.map(([x, y, a, s], i) => (
                    <use
                        key={i}
                        href={`#${leafId}`}
                        transform={`translate(${x} ${y}) rotate(${a}) scale(${s ?? 1})`}
                    />
                ))}
            </g>
        </svg>
    );
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
            <div className="bg-tree">
                <TreeSilhouette
                    className="tree tree-a"
                    viewBox="0 0 300 400"
                    branches={TREE_A_BRANCHES}
                    leaves={TREE_A_LEAVES}
                    leafId="tree-a-leaf"
                />
                <TreeSilhouette
                    className="tree tree-b"
                    viewBox="0 0 300 300"
                    branches={TREE_B_BRANCHES}
                    leaves={TREE_B_LEAVES}
                    leafId="tree-b-leaf"
                />
            </div>

            <div className="bg-grain" />

            <div className="bg-stars-wrap">
                <div className="bg-stars bg-stars-a" />
                <div className="bg-stars bg-stars-b" />
            </div>

            {/*
             * 弯月：**缺口朝左**（蛾眉月，傍晚可见的那种朝向）。
             *
             * 三层：月晕（径向渐变）→ 月牙本体（遮罩挖出）→ 球面明暗（线性渐变）。
             * 第三层是关键 —— 没有它，月亮就是一个纯色形状，像纸片贴在屏幕上。
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
                    <circle
                        cx="50"
                        cy="50"
                        r="30"
                        fill="var(--moon-color)"
                        mask="url(#bg-moon-crescent)"
                    />
                    <circle
                        cx="50"
                        cy="50"
                        r="30"
                        fill="url(#bg-moon-sheen)"
                        mask="url(#bg-moon-crescent)"
                    />
                </svg>
            </div>
        </div>
    );
}
