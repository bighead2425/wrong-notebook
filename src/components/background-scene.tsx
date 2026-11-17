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
 * ## 树影的叶子必须"长在枝条边上"
 *
 * 第一版把叶子坐标直接取在枝条曲线上 —— 于是每片叶子都**压在枝条中轴**上，
 * 看起来像"叶子串在竹签上"。真实的叶子是从枝条侧面抽出来的。
 *
 * 现在用几何算：沿三次贝塞尔采样取点 → 求切线 → 沿**法线**偏移 → 左右交替。
 * 叶子的旋转角 = 切线角 + ±46°，朝枝条外侧张开。
 *
 * ## 树影的柔边：三层叠色，不用 blur
 *
 * 逆向 openhanako 的结论：它的树影是**一段 40 秒的 MP4**（拍摄时就是虚焦的），
 * 代码里没有任何 filter。我们没有实拍素材，只能用矢量仿：
 * 同一组路径画三遍，越外圈越粗越淡（1.9×/32% → 1.35×/62% → 1×/100%）。
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

type Pt = [number, number];
/** [x, y, 旋转角度, 缩放] */
type Leaf = [number, number, number, number?];

interface Branch {
    d: string;
    w: number;
}

interface Twig {
    p0: Pt;
    p1: Pt;
    p2: Pt;
    p3: Pt;
    w: number;
    /** 这条枝上挂几片叶。0 = 光杆（主干） */
    leaves: number;
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
    const m = 1 - t;
    const a = m * m * m;
    const b = 3 * m * m * t;
    const c = 3 * m * t * t;
    const d = t * t * t;
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

function tangentAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
    const m = 1 - t;
    return [
        3 * m * m * (p1[0] - p0[0]) + 6 * m * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
        3 * m * m * (p1[1] - p0[1]) + 6 * m * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]),
    ];
}

/**
 * 把一堆枝条定义转成「路径 + 叶子」。
 *
 * 叶子的位置 = 曲线上的点 + 法线方向偏移；旋转 = 切线角 ± 张开角。
 * 偏移量 4.5 是"叶柄长度"，让叶根贴着枝条边缘而不是压在中轴上。
 */
function buildTree(twigs: Twig[]) {
    const paths: Branch[] = [];
    const leaves: Leaf[] = [];

    for (const tw of twigs) {
        paths.push({
            d: `M${tw.p0[0]} ${tw.p0[1]} C ${tw.p1[0]} ${tw.p1[1]} ${tw.p2[0]} ${tw.p2[1]} ${tw.p3[0]} ${tw.p3[1]}`,
            w: tw.w,
        });
        const n = tw.leaves;
        for (let i = 0; i < n; i++) {
            /* 从 0.1 一直长到 0.99：留 4% 空档枝梢会"秃"一截，很显眼 */
            const t = n === 1 ? 0.5 : 0.1 + 0.89 * (i / (n - 1));
            const [x, y] = cubicAt(tw.p0, tw.p1, tw.p2, tw.p3, t);
            const [dx, dy] = tangentAt(tw.p0, tw.p1, tw.p2, tw.p3, t);
            const len = Math.hypot(dx, dy) || 1;
            /* 左右交替，形成"交错着生"—— 同侧连续生长会看着像梳子 */
            const side = i % 2 === 0 ? 1 : -1;
            /* 叶柄长度：让叶根离枝条边缘还有一点空隙，不是"贴"上去 */
            const off = 5;
            const nx = (-dy / len) * side;
            const ny = (dx / len) * side;
            const raw = (Math.atan2(dy, dx) * 180) / Math.PI + side * 36;
            /**
             * **垂枝的叶子不会朝上长。**
             *
             * 角度是跟着切线走的，枝条一拐弯，叶子就翻到上半平面去了 ——
             * 预览里左上那几片就是朝上挑着的，很扎眼。
             * 落在上半平面时沿水平轴镜像一次，让它朝下。
             */
            const ang = Math.sin((raw * Math.PI) / 180) < 0.08 ? 180 - raw : raw;
            /* 尺寸轻微起伏，避免每片一样大 */
            const scale = 0.78 + ((i * 7) % 5) * 0.07;
            leaves.push([x + nx * off, y + ny * off, ang, scale]);
        }
    }

    return { paths, leaves };
}

/** 第一组：垂枝形，根在右上 (296,6)，主干向左下，枝条一路垂下 */
const TREE_A_TWIGS: Twig[] = [
    /* 主干拆两段：一段到底的等粗在预览里像根棍子，分两段才有渐细 */
    { p0: [296, 6], p1: [284, 20], p2: [272, 34], p3: [258, 50], w: 6.2, leaves: 0 },
    { p0: [258, 50], p1: [246, 72], p2: [236, 96], p3: [222, 120], w: 4.6, leaves: 0 },
    { p0: [222, 120], p1: [196, 158], p2: [150, 212], p3: [128, 292], w: 3.2, leaves: 14 },
    { p0: [244, 72], p1: [198, 92], p2: [150, 122], p3: [116, 164], w: 2.6, leaves: 12 },
    { p0: [270, 36], p1: [254, 92], p2: [248, 152], p3: [252, 212], w: 2.4, leaves: 11 },
    { p0: [236, 94], p1: [256, 132], p2: [272, 176], p3: [276, 232], w: 2.2, leaves: 10 },
    { p0: [222, 120], p1: [216, 170], p2: [214, 230], p3: [218, 292], w: 2.5, leaves: 11 },
    { p0: [252, 58], p1: [234, 80], p2: [216, 104], p3: [204, 130], w: 1.5, leaves: 8 },
];

/** 第二组：更小更稀，错在第一棵的里侧，拉出层次 */
const TREE_B_TWIGS: Twig[] = [
    { p0: [292, 10], p1: [282, 22], p2: [272, 34], p3: [262, 48], w: 5, leaves: 0 },
    { p0: [262, 48], p1: [254, 68], p2: [250, 88], p3: [248, 104], w: 3.8, leaves: 0 },
    { p0: [248, 104], p1: [226, 140], p2: [198, 192], p3: [186, 252], w: 2.8, leaves: 12 },
    { p0: [272, 40], p1: [248, 66], p2: [216, 90], p3: [192, 124], w: 2.2, leaves: 10 },
    { p0: [258, 74], p1: [268, 110], p2: [274, 152], p3: [270, 198], w: 2, leaves: 9 },
    { p0: [248, 104], p1: [242, 150], p2: [240, 202], p3: [244, 248], w: 2.2, leaves: 10 },
];

const TREE_A = buildTree(TREE_A_TWIGS);
const TREE_B = buildTree(TREE_B_TWIGS);

/**
 * 主角星：十几颗"各有各的样子"的星。
 *
 * 背景那两层 `radial-gradient` 提供的是"星尘"（均匀、微小、看不出个体），
 * 真正让夜空有层次的是这十几颗 —— 大小不一、颜色四种、形状两种、
 * 而且**只有一半带光晕**（全都发光就成了萤火虫群）。
 *
 * 它们常亮，不参与呼吸：有的一直亮、有的明暗变化，才叫错落。
 */
interface HeroStar {
    x: number;
    y: number;
    s: number;
    c: string;
    /** 有没有光晕 */
    glow?: boolean;
    /** 菱形 */
    diamond?: boolean;
}

const SILVER = "#F2EDE2";
const ASH = "#BFBCB4";
const AMBER = "#E6D5A2";
const ICE = "#D2DBE6";

const HERO_STARS: HeroStar[] = [
    { x: 12, y: 18, s: 7, c: SILVER, glow: true },
    { x: 26, y: 34, s: 4, c: AMBER },
    { x: 8, y: 52, s: 6, c: ASH, diamond: true },
    { x: 33, y: 66, s: 8, c: SILVER, glow: true },
    { x: 19, y: 82, s: 5, c: ICE },
    { x: 44, y: 20, s: 3, c: ASH },
    { x: 38, y: 88, s: 7, c: SILVER, diamond: true, glow: true },
    { x: 56, y: 44, s: 5, c: AMBER },
    { x: 62, y: 72, s: 9, c: SILVER, glow: true },
    { x: 48, y: 58, s: 3, c: ASH },
    { x: 72, y: 88, s: 6, c: SILVER, diamond: true },
    { x: 10, y: 70, s: 3, c: AMBER },
    { x: 30, y: 8, s: 6, c: SILVER, glow: true },
    { x: 66, y: 24, s: 3, c: ASH },
    { x: 52, y: 34, s: 5, c: ICE, diamond: true },
    { x: 86, y: 62, s: 7, c: SILVER, glow: true },
    { x: 78, y: 40, s: 3, c: AMBER },
    { x: 4, y: 36, s: 4, c: ASH },
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
 * 叶子不也做三层：它只有 14×3，再往外加粗只会糊成一团，
 * 而且节点数会从 ~80 涨到 ~200。柔边的收益主要在**枝条**上。
 */
function TreeSilhouette({
    className,
    viewBox,
    paths,
    leaves,
    leafId,
}: {
    className: string;
    viewBox: string;
    paths: Branch[];
    leaves: Leaf[];
    leafId: string;
}) {
    return (
        <svg className={className} viewBox={viewBox} fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
                {/* 柳叶形：22×5，两端收尖。第一版只有 14 长，
                    相对 200 长的枝条只占 7% —— 看起来像枝上长了毛刺。 */}
                <path id={leafId} d="M-11 0 C-6 -2.5 5 -2.5 11 0 C5 2.5 -6 2.5 -11 0 Z" />
            </defs>

            {SOFT_LAYERS.map((layer) => (
                <g key={layer.mul} stroke={TREE_INK} strokeLinecap="round" opacity={layer.opacity}>
                    {paths.map((b, i) => (
                        <path key={i} d={b.d} strokeWidth={b.w * layer.mul} />
                    ))}
                </g>
            ))}

            <g fill={TREE_INK}>
                {leaves.map(([x, y, a, s], i) => (
                    <use
                        key={i}
                        href={`#${leafId}`}
                        transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(1)}) scale(${s ?? 1})`}
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
                    paths={TREE_A.paths}
                    leaves={TREE_A.leaves}
                    leafId="tree-a-leaf"
                />
                <TreeSilhouette
                    className="tree tree-b"
                    viewBox="0 0 300 300"
                    paths={TREE_B.paths}
                    leaves={TREE_B.leaves}
                    leafId="tree-b-leaf"
                />
            </div>

            <div className="bg-grain" />

            <div className="bg-stars-wrap">
                <div className="bg-stars bg-stars-a" />
                <div className="bg-stars bg-stars-b" />
            </div>

            {/* 主角星：大小、颜色、形状、光晕各不相同 —— 夜空才有层次 */}
            <div className="bg-hero-stars">
                {HERO_STARS.map((st, i) => (
                    <span
                        key={i}
                        className="hero-star"
                        style={{
                            left: `${st.x}%`,
                            top: `${st.y}%`,
                            width: st.s,
                            height: st.s,
                            background: st.c,
                            opacity: 0.9,
                            borderRadius: st.diamond ? 0 : "50%",
                            transform: st.diamond ? "rotate(45deg)" : undefined,
                            boxShadow: st.glow ? `0 0 ${st.s * 1.6}px ${st.s * 0.5}px ${st.c}` : undefined,
                        }}
                    />
                ))}
            </div>

            {/*
             * 弯月：**缺口朝左**（蛾眉月，傍晚可见的那种朝向）。
             *
             * 三层：月晕（径向渐变）→ 月牙本体（遮罩挖出）→ 球面明暗（线性渐变）。
             * 第三层是关键 —— 没有它，月亮就是一个纯色形状，像纸片贴在屏幕上。
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
