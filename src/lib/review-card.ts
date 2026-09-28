/**
 * 卷（T2 复练纸 / T3 积累纸）—— 版面常量与**分栏分页**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 【2026-09-28 第三次改版：不再"估算高度"，改成**量真实高度**】
 *
 * 之前两版是：用"题干字符数 ÷ 每行字数 × 行高"**估算**每道题占多高，
 * 再按估出来的数字分页。这条路踩了三次坑，而且**每次都是同一个病**：
 *
 *   估算 ≠ 实际。题干里有表格、有选项列表、有内嵌图、有 LaTeX 时，
 *   实际高度就是和估出来的不一样。于是：
 *     · 块被撑破 ⇒ `overflow: hidden` 把下半截切掉（**升降级小框剩半个**就是这个）；
 *     · 分页以为排得下 ⇒ 内容压到下一页的块上。
 *   而且**不报错**：只有印出来才知道。
 *
 * 现在的做法（这也是能一次解决的办法）：
 *   ① 块**不设高度**，让浏览器按真实内容排（天然不裁切、不会挤）；
 *   ② 在一个**隐藏的量尺容器**里把全部题块先渲染一遍（宽度 = 真实栏宽），
 *      等图片就绪后读每个块的**真实高度**；
 *   ③ 拿真实高度做分栏分页（就是下面这个纯函数），再按结果正式渲染。
 *
 * 一句话：**布局交给浏览器，分页交给这个文件。** 估算这一步被彻底删掉了。
 * ══════════════════════════════════════════════════════════════════
 *
 * 三条硬规则（他定的）：
 *   ① **绝不跨页、绝不跨栏**：一道题要么整块在本栏，要么整块推到下一栏/下一页。
 *   ② 一页**能排几题就排几题**（没有"每页最多两题"这条）。
 *   ③ 同一栏内题间用浅灰虚线隔开；跨页/跨栏处不画。
 *
 * 本模块不碰 DOM：高度是**外面量好传进来**的，这里只做算术。
 */

import { CONTENT_MM } from './deep-dive-card';
import type { VolumeKind } from './volume-code';

/* ============================ 版面常量 ============================ */

/**
 * 单页可用高度 = 版心高 − 2mm 松量。
 * ⚠️ 少这 2mm 是为了防"浏览器取整把一整块挤到下一页、前面多一张白纸"。
 */
export const REVIEW_PAGE_HEIGHT_MM = CONTENT_MM.h - 2;

/**
 * 卷头（页眉）高度 = **15mm**（2026-09-28 第二次改版收成一排）。
 *   ① 一排装完：阳文框 + 卷号 + 年级·学期 …… 第X/Y页 + 印于日期 + 二维码 → 12mm
 *   ② 横线**整条贯通**                                                      → 2mm
 */
export const VOLUME_HEADER_MM = 15;

/** 内容区高度（分栏时**每栏**都是这个高度） */
export const VOLUME_COLUMN_MM = REVIEW_PAGE_HEIGHT_MM - VOLUME_HEADER_MM;

/** 打孔装订位宽度（与深挖纸同一条物理边） */
export const REVIEW_PUNCH_GUTTER_MM = 12;

/** 两栏之间的间隙（竖线画在这里面） */
export const COLUMN_GAP_MM = 4;

/** 扣掉打孔位后真正能排版的宽度 = 152 − 12 = 140mm */
export const REVIEW_USABLE_WIDTH_MM = CONTENT_MM.w - REVIEW_PUNCH_GUTTER_MM;

/** 有题图时，**图**占答题区宽度的比例（剩下留给她写字） */
export const REVIEW_FIGURE_BOX_RATIO = 0.55;

/**
 * 每块在分页时**多算这么一点高度**。
 *
 * 量尺容器与正式渲染是两次布局，理论上同样宽度、同样内容 ⇒ 同样高度；
 * 但两次之间可能有亚像素取整差。多算 0.4mm 就够吸收掉 ——
 * 代价只是页尾偶尔多 0.4mm 空白，而"块被挤到下一页"的代价是一整页排版变样。
 */
export const REVIEW_BLOCK_SLACK_MM = 0.4;

export const REVIEW_LAYOUT_MM = {
    /** 答题留白每行的高度 —— 也是"留白行数"这个单位本身 */
    blankLineMM: 7,
    /**
     * 答题区的**最小高度**：右下角那个升降级小框（6mm）+ 一点余量。
     * 留白行数被调到 0、又没有题图时，答题区会缩到 0 —— 小框就会被吃掉。
     */
    answerRowMinMM: 7,
    /**
     * 题图高度上限。
     * ⚠️ 图是 `width:100%` 按原始长宽比缩放的，所以这里限的是**高度**：
     *    竖长的几何图如果不限，一张就能吃掉大半页。
     */
    figureMaxHeightMM: 60,
    /** 留白行数的合法区间（微调时夹在这里面） */
    blankLinesMin: 0,
    blankLinesMax: 40,
} as const;

/** 复练纸缺省留白行数（他定的） */
export const REVIEW_DEFAULT_BLANK_LINES = 5;
/** 积累纸缺省留白行数（他定的） */
export const BUILD_DEFAULT_BLANK_LINES = 1;

export interface VolumeVariantSpec {
    kind: VolumeKind;
    /** 分几栏 */
    columns: 1 | 2;
    /** 缺省留白行数 */
    defaultBlankLines: number;
    /** 单栏内容宽度（量尺容器与正式渲染都按它，**必须同源**） */
    columnWidthMM: number;
}

export const VOLUME_VARIANTS: Record<VolumeKind, VolumeVariantSpec> = {
    review: {
        kind: 'review',
        columns: 1,
        defaultBlankLines: REVIEW_DEFAULT_BLANK_LINES,
        columnWidthMM: REVIEW_USABLE_WIDTH_MM,
    },
    build: {
        kind: 'build',
        columns: 2,
        defaultBlankLines: BUILD_DEFAULT_BLANK_LINES,
        columnWidthMM: (REVIEW_USABLE_WIDTH_MM - COLUMN_GAP_MM) / 2,
    },
};

/** 浮点比较容差 */
const EPS = 0.01;

/* ============================ 留白行数 ============================ */

export type BlankLinesMap = Record<string, number | null | undefined>;

/** 留白行数夹到合法区间；传空 ⇒ 用这张卷的缺省值 */
export function normalizeBlankLines(value: number | null | undefined, fallback: number): number {
    const base =
        value === null || value === undefined || !Number.isFinite(Number(value)) ? fallback : Number(value);
    const n = Math.round(base);
    return Math.min(REVIEW_LAYOUT_MM.blankLinesMax, Math.max(REVIEW_LAYOUT_MM.blankLinesMin, n));
}

/** 某道题当前生效的留白行数（没单独设过 ⇒ 跟着这张卷的缺省走） */
export function effectiveBlankLines(overrides: BlankLinesMap, key: string, kind: VolumeKind): number {
    return normalizeBlankLines(overrides?.[key], VOLUME_VARIANTS[kind].defaultBlankLines);
}

/**
 * 整体调整留白行数时，**逐题**跟着变还是不动。
 *
 * 规则（他定的，照抄）：
 *   「每一题如果留白大小**等于**整体调整前留白行数，则随之调整；
 *     当某一题当前留白大小**不等于**调整前行数时，则不随之调整。」
 *
 * 所以判据是**数值相等**，不看"当初是不是显式设过"。返回**新的覆盖表**。
 */
export function applyGlobalBlankLines(
    overrides: BlankLinesMap,
    prevDefault: number,
    nextDefault: number,
): BlankLinesMap {
    const next: BlankLinesMap = {};
    const before = Math.round(prevDefault);
    const after = Math.round(nextDefault);
    for (const [key, value] of Object.entries(overrides ?? {})) {
        const effective = value === null || value === undefined ? before : Math.round(Number(value));
        next[key] = effective === before ? after : effective;
    }
    return next;
}

/* ============================ 题图缩放 ============================ */

/** 题图缩放的合法区间（百分比，100 = 版面默认的 55% 宽） */
export const FIGURE_SCALE_MIN = 30;
export const FIGURE_SCALE_MAX = 180;
export const FIGURE_SCALE_DEFAULT = 100;

/**
 * 夹到合法区间；非法值退回默认。
 * ⚠️ 上限 180 不是随便定的：图列默认占答题区宽的 55%，
 *    55% × 1.8 = 99% —— 再大就会把"她写字的地方"整个吃掉。
 */
export function normalizeFigureScale(value: number | null | undefined): number {
    const base =
        value === null || value === undefined || !Number.isFinite(Number(value))
            ? FIGURE_SCALE_DEFAULT
            : Number(value);
    return Math.min(FIGURE_SCALE_MAX, Math.max(FIGURE_SCALE_MIN, Math.round(base)));
}

/* ============================ 分栏分页 ============================ */

/** 量好高度的一道题（`heightMM` 来自隐藏量尺容器的真实测量） */
export interface MeasuredBlock {
    key: string;
    heightMM: number;
}

export interface MeasuredBlockLayout extends MeasuredBlock {
    /** 流水号（1 起）—— 只是这份卷的排序号，不是题号 */
    seq: number;
}

export interface MeasuredColumnLayout {
    blocks: MeasuredBlockLayout[];
}

export interface MeasuredPageLayout {
    /** 本页的栏（复练 1 栏、积累 2 栏） */
    columns: MeasuredColumnLayout[];
}

export interface MeasuredSheetLayout {
    pages: MeasuredPageLayout[];
    /** 一栏都装不下的题（key + 高度），调用方拿它提示"改用深挖纸" */
    overflow: { key: string; heightMM: number }[];
}

/**
 * 按**真实高度**分栏分页：逐题贪心填栏，填满换栏、栏满换页，绝不跨栏/跨页。
 *
 * @param blocks 按**卷内顺序**排好、且已量过高度的题块
 * @param kind   复练（1 栏）/ 积累（2 栏）
 */
export function paginateMeasured(
    blocks: readonly MeasuredBlock[],
    kind: VolumeKind = 'review',
): MeasuredSheetLayout {
    const variant = VOLUME_VARIANTS[kind];
    const pages: MeasuredPageLayout[] = [];
    const overflow: { key: string; heightMM: number }[] = [];

    let pageColumns: MeasuredColumnLayout[] = [];
    let current: MeasuredBlockLayout[] = [];
    let used = 0;

    const closeColumn = () => {
        if (!current.length) return;
        pageColumns.push({ blocks: current });
        current = [];
        used = 0;
        if (pageColumns.length >= variant.columns) {
            pages.push({ columns: pageColumns });
            pageColumns = [];
        }
    };
    const closeAll = () => {
        closeColumn();
        if (pageColumns.length) {
            pages.push({ columns: pageColumns });
            pageColumns = [];
        }
    };

    blocks.forEach((b, i) => {
        // 量出来的高度 + 一点余量（吸收"量完再渲染"的取整差，见 REVIEW_BLOCK_SLACK_MM）
        const h = b.heightMM + REVIEW_BLOCK_SLACK_MM;
        // 一栏都装不下 —— 记下来提示换纸，但仍给它单独一栏（**不静默丢题**）
        if (h > VOLUME_COLUMN_MM + EPS) overflow.push({ key: b.key, heightMM: b.heightMM });

        // 本栏排不下 ⇒ 整块推到下一栏（**不拆题**）
        if (current.length > 0 && used + h > VOLUME_COLUMN_MM + EPS) closeColumn();

        current.push({ key: b.key, heightMM: b.heightMM, seq: i + 1 });
        used += h;
    });

    closeAll();
    return { pages, overflow };
}

/** 这份卷一共几页 */
export function countSheets(layout: MeasuredSheetLayout): number {
    return layout.pages.length;
}

/* ===================== 拖虚线调留白（2026-09-28） ===================== */

/**
 * 一行留白 = 多少**屏幕像素**（拖虚线时用）。
 * CSS 规定 1in = 96px、1in = 25.4mm ⇒ 1mm = 96/25.4 px。
 * ⚠️ 别在两个地方各写一遍换算 —— 量高度（px→mm）和这里（mm→px）是同一件事的两面。
 */
export const REVIEW_BLANK_LINE_PX = (REVIEW_LAYOUT_MM.blankLineMM * 96) / 25.4;

/**
 * 拖两题之间那条**虚线** ⇒ 算出"上面那道题"的新留白行数。
 *
 * ⚠️ 方向（他 2026-09-29 定的，之前做反了）：
 *    **往下拖 = 上面的题留白变大；往上拖 = 变小。**
 *    道理：拖的是"上面那块的底边"—— 把底边往下拉，那块就被拉长（留白变多）。
 *
 * @param startLines 起手时那道题的留白行数
 * @param deltaPx    鼠标/手指从起点起的**垂直位移**（向下为正）
 * @param fallback   归一化用的兜底值（= 起手时的行数最自然）
 */
export function blankLinesFromDrag(startLines: number, deltaPx: number, fallback: number): number {
    const deltaLines = Math.trunc(deltaPx / REVIEW_BLANK_LINE_PX);
    return normalizeBlankLines(startLines + deltaLines, fallback);
}
