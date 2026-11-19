"use client";

import { useEffect, type CSSProperties } from "react";

/**
 * 【2026-11-17 空空】**背景效果层 · 虚焦枝叶版。**
 *
 * ## 五次尝试，错在哪、对在哪
 *
 * 1. **描线稿版**：三次贝塞尔求切线/法线，沿枝条一片片摆柳叶 + 三层叠色描边。
 *    叶子形状对了，但**太清晰**，像剪纸贴纸。
 * 2. **水墨团版**：改成几个模糊椭圆当树冠，想用"虚焦"救场。
 *    结果形状全丢，变成**几团污渍**——被当场否掉。
 * 3. **虚焦枝叶版**：形用第 1 版（真枝叶），柔用第 2 版（整体模糊）。对路了。
 * 4. **三根不同的枝**：空空指出"三层同一根枝改透明度 = 重影"。
 *    改成**三根互不模仿的枝**叠成一片，解决重影。
 * 5. **本版（自然簇生 + 冷灰自由叶）**：空空对照新参考图指出仍违和。逐条找差距：
 *      · 旧版叶子沿枝**等距排列**（像梳子）→ 改成**随机簇生**：种子随机数给每片叶
 *        的间距/角度/大小/浓淡各自抖动，一簇一簇、有疏有密；
 *      · 旧版叶子强制"朝下" → 改成**四面八方自由姿态**（参考图就是这样）；
 *      · 旧版暖褐灰偏黄 → 改成**冷调灰**（参考图是冷灰）；
 *      · 虚焦再加重一档，叶缘几乎融进枝里。
 * 6. **v172 部署后"什么都看不见"**：不是被遮挡，是**浓叶团画在了屏幕外**——
 *    `.tree-a` 右移出屏 14vw，1920 宽的屏上 viewBox x > 215 全被裁掉，
 *    而最浓的一层恰恰画在 x 216~302；屏内只剩最虚最淡的远枝，乘上 10% 浓淡 = 隐身。
 *    **教训：预览是完整画布，真机有裁切 —— 构图必须落在可视窗口内**（每棵树的
 *    可视窗口写在了 TREE_A / TREE_B 的注释里）。
 * 7. **v173 还是看不见 —— 真正的病根是"浓度天花板"**：
 *    旧浓淡刻度最大只有 20%，而 6~9 的高斯模糊会把一片叶子摊薄到约 27%，
 *    再乘每叶随机透明度（下限 0.35），单叶实际只剩约 2% 深度差 ⇒ **物理上不可见**。
 *    我之前的预览用的是 50% 不透明度（真实值的 5 倍），于是"预览好看、真机隐身"，
 *    连修两版都在错误的位置上打转。
 *    **教训：预览必须用真实参数。预览骗人，等于没预览。**
 *    修正：浓淡刻度重定为 0.24~0.8（默认 0.5）、每叶下限提到 0.55、虚焦收一档
 *    （5.2/6.4/7.8），旧存档按档位序号自动迁移（`normalizeTreeOpacity`）。
 *    参数是用数值模拟（几何+模糊按真实参数跑一遍，量灰度分位）对齐参考图定的，
 *    **不再靠肉眼估**。
 * 8. **2026-11-20 第 8 轮：不画了——照片素材分层摆动**：
 *    五轮手绘迭代后空空仍不满意（"像晾着的死蛇"），问"能不能完全复刻参考图"。
 *    答：不画了，**把参考图本身提取成影子素材**（亮度差→alpha，逐行背景估计
 *    自动剔除渐晕与桌面影）。这正是 openhanako 的路线（它用实拍视频）。
 *    空空再设计：一幅图按枝叶形状**切成三块**，各自摆动、频率错开——
 *    分层摆动让丛内也有相对运动。手绘几何全部退役（本文件只留星点与月亮）。
 *
 * 一句话：**照片素材 + 分层摆动 + 滑条语义照旧**。
 *
 * ## 摆动机制（空空设计的"分层摆"）
 *
 * 三块碎片各自绕顶部支点（枝出画处）小幅旋转（±1° 内），周期 20s/26s/32s 错开；
 * 切缝羽化互补（缝宽 70 ≈ 页面 300px，两块在缝里此消彼长、总量恒等于 1）⇒ 接缝不可见。
 * 只有 transform 在动，浏览器整层缓存（合成层铁律依旧成立）。
 *
 * ## 亮环境用暗元素，暗环境用亮元素
 * 浅色底上叠亮的东西对比度上不去。所以浅色放树影（比背景暗），深色放星点（比背景亮）。
 */

const BG_ATTR = "bg";
const PAUSE_ATTR = "bg-paused";

/** 星点色：单一暖白 —— 彩色菱形是"贴纸感"的来源，已去掉。 */
const STAR_INK = "#F2EDE2";

/**
 * 【2026-11-20 第 8 轮】树影素材：空空参考图 → 亮度差提取 → 透明 PNG（608×975），
 * 按**枝叶形状切成三块**——羽化互补切缝（第 9 轮羽化加宽到 110 素材单位
 * ≈ 页面 430px，配合摆幅放大：相邻块最大瞬时错位 ≤4°，位移 ~90px，仍在
 * 羽化带内 ⇒ 接缝不可见；两块在缝里此消彼长、总量恒等于 1）。
 *
 * 每块独立摆动：绕自己的顶部支点（"枝出画的地方"），周期 3s/3.45s/4.2s 错开
 * —— 空空设计的**分层摆动**：丛内也有相对运动，比"两丛整体摇"更活。
 *
 * left/width 是相对整幅树宽的百分比（切割脚本量出）；dur 是 --tree-dur 的倍率；
 * from/to 是各自的摆幅（deg），经内联 CSS 变量传给 keyframes。
 */
const TREE_PIECES = [
    { src: "/tree/shadow-left.png", left: 0, width: 100, dur: 1.35, from: -2.0, to: 2.2 },
    { src: "/tree/shadow-mid.png", left: 0, width: 100, dur: 1.15, from: 1.6, to: -1.8 },
    { src: "/tree/shadow-right.png", left: 0, width: 100, dur: 1, from: -2.4, to: 2.6 },
] as const;

/**
 * 主角星：十几颗大小不一的暖白小点。
 *
 * 试过菱形 + 彩色 + 圆形光晕（像萤火虫群），也试过 SVG 十字衍射芒（不自然，
 * SVG 画不出天文照片里那种自然的星芒）。最后回到最朴素的做法：**纯小圆点**，
 * 靠大小与明暗的参差撑出层次，密度交给背景的星尘层去铺。
 */
interface HeroStar {
    x: number;
    y: number;
    /** 半径（px），基准值；实际尺寸再乘 `--star-scale` */
    s: number;
    o?: number;
}

const HERO_STARS: HeroStar[] = [
    { x: 12, y: 18, s: 2, o: 0.9 },
    { x: 26, y: 34, s: 1.4 },
    { x: 8, y: 52, s: 1.6 },
    { x: 33, y: 66, s: 2.1, o: 0.95 },
    { x: 19, y: 82, s: 1.5 },
    { x: 44, y: 20, s: 1.2 },
    { x: 38, y: 88, s: 1.8 },
    { x: 56, y: 44, s: 1.4 },
    { x: 62, y: 72, s: 2.2, o: 0.95 },
    { x: 48, y: 58, s: 1.2 },
    { x: 72, y: 88, s: 1.6 },
    { x: 10, y: 70, s: 1.1 },
    { x: 30, y: 8, s: 1.7 },
    { x: 66, y: 24, s: 1.2 },
    { x: 52, y: 34, s: 1.5 },
    { x: 86, y: 62, s: 1.9, o: 0.9 },
    { x: 78, y: 40, s: 1.1 },
    { x: 4, y: 36, s: 1.3 },
];

/** 树影大小五档 */
export const TREE_SCALES = [0.7, 0.9, 1.2, 1.5, 1.85] as const;
/**
 * 树影浓淡五档。
 *
 * ⚠️ **这套数值是按"模糊之后的实际观感"定的，不是纸上算的。**
 * 旧刻度 [0.05…0.2] 配 6~9 的高斯模糊，一片叶子在屏幕上只剩约 2% 的深度差，
 * 整簇叠起来 5% —— v171~v173 三版"部署后看不见树影"的真正原因：
 * 不是被遮挡，是**浓度天花板本身在可见阈值以下**。
 *
 * 现在的账（用数值模拟对齐了参考图的灰度分位，p5≈0.75 / p10≈0.81，参考图 0.75 / 0.81）：
 * 0.55 × 叶片自身 0.55~1.0 × 层浓淡 0.6~1.0，再乘模糊摊薄 ⇒ 单叶约 12%、叶团叠加 20%
 * —— 淡淡的影子，但**看得见**，而且叶子分得开（每枝只留 8~14 片，不再叠成一片糊）。
 */
export const TREE_OPACITIES = [0.28, 0.4, 0.55, 0.7, 0.85] as const;
/** 旧刻度（≤0.2）。仅用于把老存档的值迁到新刻度，见 `normalizeTreeOpacity`。 */
const LEGACY_TREE_OPACITIES = [0.05, 0.08, 0.11, 0.15, 0.2] as const;
/** 摆动周期（秒），索引 0 最快。
 *  【2026-11-20 第 9 轮】旧档 8~32s 配 ±1° 摆幅，角速度小到肉眼不可见（空空：
 *  "最快也看不出来"）。重定：最快 3s + 摆幅放大到 ±2~2.6°（枝梢横移约 80px），
 *  快档明确可见；慢档仍有"微风"的安静感。摆幅放大后羽化带同步加宽
 *  （70→110）重切素材，接缝错位仍藏在羽化带里。 */
export const TREE_SPEEDS = [3, 5, 8, 13, 20] as const;
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
 * 血月不只是换色相，**明度一路压下去**（0.97 → 0.62）：
 * 真正的血月是"暗下来的红"，只改色相不降明度会变成一盏橙色小灯。
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
    treeOpacity: 0.55,
    treeSpeed: 8,
    grainOpacity: 0.06,
    starScale: 1,
    starBright: 1,
    starSpeed: 20,
    moonTint: 0,
};

/**
 * 老存档迁移：v173 及以前的滑条存的是 0.05~0.2（旧刻度，配现在的模糊等于隐身）。
 * 按**档位序号**映射到新刻度 —— 他原来选"第 3 档"，迁移后还是第 3 档，只是这档
 * 现在真的看得见。新刻度的最小值 0.24 > 0.2，所以不会误判：>0.2 一律当成新值。
 */
function normalizeTreeOpacity(v?: number): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return EFFECT_DEFAULTS.treeOpacity;
    if (v > 0.2 + 1e-6) return v;
    let best = 0;
    let diff = Infinity;
    LEGACY_TREE_OPACITIES.forEach((o, i) => {
        const d = Math.abs(o - v);
        if (d < diff) {
            diff = d;
            best = i;
        }
    });
    return TREE_OPACITIES[best];
}

/** 开/关背景效果，并写入全部可调项（供长按面板调用） */
export function applyBackgroundEffects(s?: Partial<EffectSettings>) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    /**
     * 逐项兜底，**不要写 `{ ...EFFECT_DEFAULTS, ...s }`** ——
     * 展开会把 `undefined` 也盖进默认值里，于是 CSS 变量被写成字符串 "undefined"，
     * `calc(... * var(--tree-scale))` 整条失效，树连宽度都没有（静默消失）。
     * 老存档 / 缺字段的配置都会踩到这个坑。
     */
    const v: EffectSettings = {
        on: s?.on ?? EFFECT_DEFAULTS.on,
        treeScale: s?.treeScale ?? EFFECT_DEFAULTS.treeScale,
        treeOpacity: s?.treeOpacity ?? EFFECT_DEFAULTS.treeOpacity,
        treeSpeed: s?.treeSpeed ?? EFFECT_DEFAULTS.treeSpeed,
        grainOpacity: s?.grainOpacity ?? EFFECT_DEFAULTS.grainOpacity,
        starScale: s?.starScale ?? EFFECT_DEFAULTS.starScale,
        starBright: s?.starBright ?? EFFECT_DEFAULTS.starBright,
        starSpeed: s?.starSpeed ?? EFFECT_DEFAULTS.starSpeed,
        moonTint: s?.moonTint ?? EFFECT_DEFAULTS.moonTint,
    };

    if (!v.on) {
        delete root.dataset[BG_ATTR];
        return;
    }
    root.dataset[BG_ATTR] = "on";
    const set = (k: string, val: string) => root.style.setProperty(k, val);
    set("--tree-scale", String(v.treeScale));
    set("--tree-opacity", String(normalizeTreeOpacity(v.treeOpacity)));
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
            <div className="bg-tree">
                {/* 三块碎片各自摆动（空空的分层摆动设计）；left/width/摆幅/时长见 TREE_PIECES */}
                <div className="tree-photo">
                    {TREE_PIECES.map((p) => (
                        <img
                            key={p.src}
                            src={p.src}
                            alt=""
                            draggable={false}
                            className="tree-piece"
                            style={
                                {
                                    left: `${p.left}%`,
                                    width: `${p.width}%`,
                                    animationDuration: `calc(var(--tree-dur) * ${p.dur})`,
                                    "--from": `${p.from}deg`,
                                    "--to": `${p.to}deg`,
                                } as CSSProperties
                            }
                        />
                    ))}
                </div>
                {/* 参考图底部那道横向柔影：像虚焦的桌面边缘 */}
                <div className="bg-horizon" />
            </div>

            <div className="bg-grain" />

            <div className="bg-stars-wrap">
                <div className="bg-stars bg-stars-a" />
                <div className="bg-stars bg-stars-b" />
            </div>

            {/* 主角星：暖白小点，靠大小与明暗出层次，常亮不闪烁 */}
            <div className="bg-hero-stars">
                {HERO_STARS.map((st, i) => (
                    <span
                        key={i}
                        className="hero-star"
                        style={{
                            left: `${st.x}%`,
                            top: `${st.y}%`,
                            /* 每颗星的半径直接乘滑条档位 */
                            width: `calc(${st.s * 2}px * var(--star-scale))`,
                            height: `calc(${st.s * 2}px * var(--star-scale))`,
                            background: STAR_INK,
                            borderRadius: "50%",
                            opacity: st.o ?? 0.82,
                        }}
                    />
                ))}
            </div>

            {/*
             * 弯月：**缺口朝左**（蛾眉月，傍晚西方天空真实可见的朝向）。
             * 三层：月晕 → 月牙本体（遮罩挖出）→ 球面明暗。挖空圆 cx=37 让月牙更细。
             */}
            <div className="bg-moon">
                <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <defs>
                        <radialGradient id="bg-moon-halo">
                            <stop offset="0%" stopColor="var(--moon-color)" stopOpacity="0.26" />
                            <stop offset="34%" stopColor="var(--moon-color)" stopOpacity="0.1" />
                            <stop offset="62%" stopColor="var(--moon-color)" stopOpacity="0.035" />
                            <stop offset="100%" stopColor="var(--moon-color)" stopOpacity="0" />
                        </radialGradient>
                        <linearGradient id="bg-moon-sheen" x1="0.15" y1="0.08" x2="0.9" y2="0.95">
                            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
                            <stop offset="42%" stopColor="#ffffff" stopOpacity="0.1" />
                            <stop offset="100%" stopColor="#000000" stopOpacity="0.24" />
                        </linearGradient>
                        <mask id="bg-moon-crescent">
                            <circle cx="50" cy="50" r="30" fill="#ffffff" />
                            <circle cx="37" cy="50" r="29" fill="#000000" />
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
