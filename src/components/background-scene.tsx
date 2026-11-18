"use client";

import { useEffect } from "react";

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
 *
 * 一句话：**真枝叶 + 自由姿态 + 簇生疏密 + 冷灰 + 重虚焦**。
 *
 * ## 为什么现在敢用 feGaussianBlur
 *
 * 旧注释说"三层叠色，不用 blur"，针对的是**逐帧重画的线条**（每帧重算模糊，费）。
 * 现在枝叶几何是静态的，每层各套一个模糊滤镜，浏览器缓存成位图，动画只整张轻轻旋转
 * （`transform`）—— 模糊只在首帧算一次。真正要躲的是"动画内容上挂 filter"，
 * 不是 filter 本身。
 *
 * ## 参考图特征，逐一对应
 *
 * | 参考图 | 本版实现 |
 * |---|---|
 * | 叶一簇簇、疏密随机、不成排 | 种子随机数抖动每片叶的间距/偏移/角度/大小/浓淡 |
 * | 叶姿态四面八方、不强制垂头 | 切线角 ±(18°~70°) 自由取角 |
 * | 冷调灰、不是暖褐 | 三层冷灰 #A2A4AB / #878B94 / #5F646E |
 * | 边缘完全融掉 | 每根枝一个 `feGaussianBlur`，远 6.1 → 近 3.9（还要留住叶形，别糊成团） |
 * | 画面底部一道横向柔影 | `.bg-horizon`（CSS 线性渐变 + 模糊） |
 *
 * ## 亮环境用暗元素，暗环境用亮元素
 * 浅色底上叠亮的东西对比度上不去。所以浅色放树影（比背景暗），深色放星点（比背景亮）。
 */

const BG_ATTR = "bg";
const PAUSE_ATTR = "bg-paused";

/** 树影三色：**冷调灰**（参考图是冷灰，旧版暖褐灰偏黄、违和的来源之一）。
 *  远层最浅、近层最深，色相一致只推明度 —— 叠起来才是同一片树的远近，不是三种树。 */
const TREE_INK_FAR = "#A2A4AB";
const TREE_INK = "#878B94";
const TREE_INK_NEAR = "#5F646E";
/** 星点色：单一暖白 —— 彩色菱形是"贴纸感"的来源，已去掉。 */
const STAR_INK = "#F2EDE2";

type Pt = [number, number];
/** [x, y, 旋转角, 缩放?, 自身浓淡?] —— 每片叶的浓淡独立，远近层次才自然 */
type Leaf = [number, number, number, number?, number?];

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

/**
 * 一根独立生长的枝（不是某根枝的复制品）。三根叠起来 = 一片有纵深的树：
 *   · 左枝：缓垂、冷浅灰、最虚最淡
 *   · 中枝：斜坠、中性暖灰、中等
 *   · 右枝：垂直下坠、深褐灰、最实最浓
 * 每根的 twigs / blur / ink / leafScale / color 全都不同。
 */
interface TreeLayer {
    twigs: Twig[];
    /** 高斯模糊半径，越大越虚 */
    blur: number;
    /** 浓淡倍率（0~1），乘在整棵树 opacity 之上 */
    ink: number;
    /** 叶片大小倍率，远小近大 */
    leafScale: number;
    /** 这一根枝自己的颜色 —— 三根不同色，不是同一色改透明度 */
    color: string;
}

/** 构建结果：路径 + 叶子，再加这一层的渲染参数 */
interface BuiltLayer {
    paths: Branch[];
    leaves: Leaf[];
    blur: number;
    ink: number;
    color: string;
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
 * 种子随机数（mulberry32）：同一种子永远吐出同一串数。
 * 必须用它而不是 Math.random() —— SSR 和客户端要画出**同一棵树**，
 * 否则每次水合叶子都跳一次位置。
 */
function rng(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 枝条定义 → 「路径 + 叶子」。
 *
 * 这一版的叶子是**自然簇生**的（对照参考图改的三处）：
 *   · 位置：沿枝取点后加随机抖动 —— 一簇一簇、有疏有密，不再像梳子等距排列；
 *   · 角度：切线角 ±(18°~70°) **自由取角**，不再强制"朝下"——
 *     参考图里的叶子四面八方都有，强制垂头反而假；
 *   · 浓淡：每片叶带 0.35~0.95 的独立透明度，叠出"有的叶子离镜头近、有的远"。
 */
function buildTree(twigs: Twig[], leafScale = 1): { paths: Branch[]; leaves: Leaf[] } {
    const paths: Branch[] = [];
    const leaves: Leaf[] = [];
    /* 种子从首根枝的坐标派生：几何不变则画不变，几何一改整棵树自然重排 */
    const rand = rng((twigs[0]?.p0[0] ?? 7) * 1013 + twigs.length * 137 + leafScale * 1000);

    for (const tw of twigs) {
        paths.push({
            d: `M${tw.p0[0]} ${tw.p0[1]} C ${tw.p1[0]} ${tw.p1[1]} ${tw.p2[0]} ${tw.p2[1]} ${tw.p3[0]} ${tw.p3[1]}`,
            w: tw.w,
        });
        const n = tw.leaves;
        for (let i = 0; i < n; i++) {
            /* 均匀底 + 随机抖动：底保证覆盖全枝，抖动让间距忽大忽小（簇生感） */
            const t = n === 1 ? 0.5 : Math.min(0.99, 0.05 + 0.94 * (i / (n - 1)) + (rand() - 0.5) * (0.9 / n));
            const [x, y] = cubicAt(tw.p0, tw.p1, tw.p2, tw.p3, t);
            const [dx, dy] = tangentAt(tw.p0, tw.p1, tw.p2, tw.p3, t);
            const len = Math.hypot(dx, dy) || 1;
            /* 左右与离枝距离都随机：有的叶贴枝、有的离得远，虚焦后更像一团叶 */
            const side = rand() < 0.5 ? 1 : -1;
            const off = 2 + rand() * 5.5;
            const nx = (-dy / len) * side;
            const ny = (dx / len) * side;
            /* 自由姿态：切线角 ±(18°~70°)，不再强制朝下 */
            const ang = (Math.atan2(dy, dx) * 180) / Math.PI + side * (18 + rand() * 52);
            /* 大小与浓淡都随机：远处叶小而淡、近处大而浓的错觉就是从这来的。
               浓淡下限不能太低：0.35 那版乘上整体浓淡 + 模糊后等于看不见，
               0.55~1.0 既保留层次，又保证每片叶都真的"有墨"。 */
            const scale = (0.55 + rand() * 0.75) * leafScale;
            const o = 0.55 + rand() * 0.45;
            leaves.push([x + nx * off, y + ny * off, ang, scale, o]);
        }
    }

    return { paths, leaves };
}

/** 把一组层定义构建成可直接渲染的层（几何 + 参数） */
function buildLayers(layers: TreeLayer[]): BuiltLayer[] {
    return layers.map((l) => ({
        ...buildTree(l.twigs, l.leafScale),
        blur: l.blur,
        ink: l.ink,
        color: l.color,
    }));
}

/**
 * 一棵树 = 三根**不同的枝**叠在一起，不是一根枝复制三遍改颜色（那是重影）。
 *
 * 构图照参考图摆：**浓密叶团挂在可视区右半，一根稀疏长枝斜伸向左下**，
 * 越往左下越虚越淡、叶越小 —— 虚焦加浓淡，共同造出"镜头离叶团近、离长枝远"。
 *
 * ⚠️ 坐标必须落在 **可视窗口** 内：.tree-a 右移出屏 14vw，树宽约 min(78vw,88vh)，
 * 1920 宽的屏上只有 viewBox x < 215 在屏内 —— 浓叶团敢画在 x > 215 就整块悬在
 * 屏幕外，部署后"什么都看不见"（v172 踩过：预览完整、真机被裁）。
 *   · 近枝（冷深灰）：叶团核心 x≈160~240，枝粗叶密，虚得最少
 *   · 中枝（冷中灰）：从上方进入、向左下斜坠，中等
 *   · 远枝（冷浅灰）：细长一根，一直伸到画面左缘（x≈5~60），叶稀疏微小，虚得最狠
 */
const TREE_A: BuiltLayer[] = buildLayers([
    /* —— 近枝：浓密叶团（可视区右半，核心 x≈160~240）—— */
    {
        color: TREE_INK_NEAR,
        blur: 3.9,
        ink: 1,
        leafScale: 1.15,
        twigs: [
            { p0: [238, -8], p1: [228, 42], p2: [210, 92], p3: [192, 150], w: 4.6, leaves: 0 },
            { p0: [192, 150], p1: [180, 200], p2: [168, 250], p3: [162, 300], w: 2.8, leaves: 0 },
            { p0: [226, 44], p1: [220, 98], p2: [214, 152], p3: [210, 208], w: 2.2, leaves: 13 },
            { p0: [204, 122], p1: [194, 172], p2: [186, 226], p3: [182, 278], w: 2.4, leaves: 14 },
            { p0: [244, 10], p1: [242, 60], p2: [240, 110], p3: [240, 160], w: 2, leaves: 12 },
            { p0: [178, 190], p1: [166, 238], p2: [158, 288], p3: [154, 336], w: 1.9, leaves: 12 },
        ],
    },
    /* —— 中枝：向左下斜坠 —— */
    {
        color: TREE_INK,
        blur: 4.9,
        ink: 0.9,
        leafScale: 0.9,
        twigs: [
            { p0: [196, -6], p1: [178, 36], p2: [150, 80], p3: [120, 128], w: 3.4, leaves: 0 },
            { p0: [120, 128], p1: [98, 164], p2: [78, 204], p3: [64, 246], w: 2, leaves: 0 },
            { p0: [154, 70], p1: [134, 116], p2: [116, 166], p3: [106, 216], w: 2, leaves: 10 },
            { p0: [124, 140], p1: [104, 182], p2: [88, 228], p3: [80, 272], w: 1.7, leaves: 9 },
            { p0: [184, 20], p1: [174, 64], p2: [168, 112], p3: [168, 158], w: 1.8, leaves: 8 },
        ],
    },
    /* —— 远枝：稀疏长枝伸向画面左缘，最虚最淡 —— */
    {
        color: TREE_INK_FAR,
        blur: 6.1,
        ink: 0.6,
        leafScale: 0.7,
        twigs: [
            { p0: [136, -8], p1: [116, 30], p2: [88, 72], p3: [58, 116], w: 2.4, leaves: 0 },
            { p0: [58, 116], p1: [36, 158], p2: [18, 204], p3: [4, 248], w: 1.5, leaves: 0 },
            { p0: [64, 120], p1: [44, 158], p2: [28, 200], p3: [16, 244], w: 1.3, leaves: 7 },
            { p0: [100, 70], p1: [78, 108], p2: [58, 150], p3: [42, 192], w: 1.2, leaves: 6 },
            { p0: [28, 180], p1: [14, 218], p2: [6, 258], p3: [2, 296], w: 1.1, leaves: 5 },
        ],
    },
]);

/**
 * 第二棵树：错在第一棵左下，更稀更小。
 * ⚠️ 同样的可视窗口问题：.tree-b 宽约 56vw、右移出屏 26vw，1920 屏上
 * 只有 viewBox x < 160 在屏内 —— 枝叶必须画在 x 10~180 这一带。
 */
const TREE_B: BuiltLayer[] = buildLayers([
    {
        color: TREE_INK_NEAR,
        blur: 4.1,
        ink: 0.95,
        leafScale: 1.1,
        twigs: [
            { p0: [178, -6], p1: [168, 36], p2: [154, 80], p3: [138, 126], w: 3.6, leaves: 0 },
            { p0: [138, 126], p1: [124, 172], p2: [112, 218], p3: [104, 262], w: 2.2, leaves: 0 },
            { p0: [162, 60], p1: [152, 108], p2: [144, 158], p3: [140, 206], w: 2, leaves: 11 },
            { p0: [130, 150], p1: [118, 196], p2: [108, 242], p3: [102, 286], w: 1.7, leaves: 10 },
        ],
    },
    {
        color: TREE_INK,
        blur: 5.1,
        ink: 0.9,
        leafScale: 0.88,
        twigs: [
            { p0: [140, -4], p1: [122, 32], p2: [96, 72], p3: [68, 114], w: 2.6, leaves: 0 },
            { p0: [68, 114], p1: [44, 152], p2: [24, 192], p3: [10, 228], w: 1.5, leaves: 7 },
            { p0: [96, 80], p1: [76, 120], p2: [60, 162], p3: [50, 200], w: 1.4, leaves: 7 },
        ],
    },
    {
        color: TREE_INK_FAR,
        blur: 6.3,
        ink: 0.6,
        leafScale: 0.68,
        twigs: [
            { p0: [90, 0], p1: [72, 34], p2: [48, 70], p3: [26, 106], w: 1.8, leaves: 0 },
            { p0: [26, 106], p1: [8, 142], p2: [2, 170], p3: [10, 198], w: 1.2, leaves: 0 },
            { p0: [30, 104], p1: [14, 138], p2: [2, 168], p3: [2, 196], w: 1.1, leaves: 5 },
            { p0: [52, 86], p1: [36, 116], p2: [22, 144], p3: [14, 170], w: 1, leaves: 4 },
        ],
    },
]);

/**
 * 一片"由三根不同的枝叠成的树影"：每根本来就长得不一样，各有自己的滤镜、浓淡和颜色。
 *
 * 关键：模糊放在**包裹每根枝叶的父 group** 上，枝条和叶子一起虚 ——
 * 如果只虚叶子、枝条还清晰，就会退回"清晰枝条上挂模糊团"的怪样子。
 * 构图照参考图：近枝聚在右上、远枝伸向左下，虚焦 + 浓淡 + 叶片自身透明度
 * 三层叠加，共同造出"离镜头越远越虚越淡"的景深。
 */
const LEAF_PATH = "M-9.6 0 C-4.2 -2.7 3 -2.4 9.6 0 C3 2.4 -4.2 2.7 -9.6 0 Z";

function TreeSilhouette({
    className,
    viewBox,
    layers,
    leafId,
    uid,
}: {
    className: string;
    viewBox: string;
    layers: BuiltLayer[];
    leafId: string;
    uid: string;
}) {
    return (
        <svg className={className} viewBox={viewBox} fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
                {/* 叶片：狭长小叶，长 19、宽约 5，两端收尖 —— 参考图是这种小叶，不是大桐叶 */}
                <path id={leafId} d={LEAF_PATH} />
                {/* 每层一个滤镜，半径随景深变化；filter 区域放大，否则模糊会被裁掉一圈 */}
                {layers.map((layer, li) => (
                    <filter key={li} id={`${uid}-blur-${li}`} x="-40%" y="-40%" width="180%" height="180%">
                        <feGaussianBlur stdDeviation={layer.blur} />
                    </filter>
                ))}
            </defs>
            {layers.map((layer, li) => (
                <g key={li} filter={`url(#${uid}-blur-${li})`} opacity={layer.ink}>
                    <g stroke={layer.color} strokeLinecap="round" fill="none">
                        {layer.paths.map((b, i) => (
                            <path key={i} d={b.d} strokeWidth={b.w} />
                        ))}
                    </g>
                    <g fill={layer.color}>
                        {layer.leaves.map(([x, y, a, s, o], i) => (
                            <use
                                key={i}
                                href={`#${leafId}`}
                                opacity={o ?? 0.8}
                                transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(1)}) scale(${s ?? 1})`}
                            />
                        ))}
                    </g>
                </g>
            ))}
        </svg>
    );
}

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
    treeSpeed: 20,
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
                <TreeSilhouette
                    className="tree tree-a"
                    viewBox="0 0 300 400"
                    layers={TREE_A}
                    leafId="tree-a-leaf"
                    uid="tree-a"
                />
                <TreeSilhouette
                    className="tree tree-b"
                    viewBox="0 0 300 300"
                    layers={TREE_B}
                    leafId="tree-b-leaf"
                    uid="tree-b"
                />
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
