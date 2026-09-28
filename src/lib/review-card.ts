/**
 * 卷（T2 复练纸 / T3 积累纸）—— 版面常量与**分页算法**（纯函数，可单测）。
 *
 * ── 这两张纸是什么（他 2026-09-28 全套重新定义过）─────────────────
 * 它们是**卷**，不是"一道题一张纸"：
 *   · 复练纸 = **单栏**，从上往下逐题排，每页排满为止；
 *   · 积累纸 = **左右两栏**，先排左栏、再排右栏、再翻页，两栏之间一条竖线。
 * 共同点：
 *   · 页眉是一条卷头（阳文圆角框「复练 / 积累」+ 卷号 + 年级·学期 + 第X/Y页 + 印于日期
 *     + 与二维码共享页宽的那条横线），**不写知识点**；
 *   · 每题 = 流水号 + 题干（OCR 文字）+（有题图则题干左下角放题图）+ 答题留白；
 *   · **答题留白按"行"算**（缺省复练 5 行、积累 1 行），可逐题微调；
 *   · 题与题之间一条**浅灰虚线**；
 *   · 与深挖纸同一条铁律：**纸上零 AI 内容**（不印答案 / 解析 / 错因 / 进度）。
 *
 * ── 三条硬规则（他定的）──────────────────────────────────────────
 *   ① **绝不跨页、绝不跨栏**：一道题要么整块在本栏，要么整块推到下一栏/下一页。
 *   ② 一页**能排几题就排几题**（不再有"每页最多两题"这条 —— 2026-09-28 已废）。
 *      所以"每道题占多高"完全由**题干行数 + 留白行数**决定，而不是平均分半页。
 *   ③ 同一页（栏）内题间用浅灰虚线隔开；**跨页/跨栏处不画线**
 *      （"前一页最后一道题和后一页第一道题可以不用虚线隔开"）。
 *
 * ── 为什么做成纯函数 ────────────────────────────────────────────
 * "包不包得下"如果靠肉眼在屏幕上看，等于把验收推给打印纸。
 * 这里给出**算出来的**块高与分栏分页，配单测钉死边界。
 *
 * 本模块不碰 DOM、不碰数据库。
 */

import { CONTENT_MM } from './deep-dive-card';
import type { VolumeKind } from './volume-code';

/* ============================ 版面常量 ============================ */

/**
 * 单页可用高度 = 版心高 − 2mm 松量。
 *
 * ⚠️ 为什么不是正好 227mm（与深挖纸同一条教训，别改回去）：
 *    高度写成与页边距算出来的内容区一模一样时，浏览器排版取整只要多出一点点，
 *    就会判定"这一块装不下"而整体挪到下一页 —— 表现是**每张纸前面多一张白纸**。
 */
export const REVIEW_PAGE_HEIGHT_MM = CONTENT_MM.h - 2;

/**
 * 卷头（页眉）占的高度。
 *
 * 它内部是**两排**（他定的）：
 *   ① 阳文框「复练/积累」+ 卷号 + 年级·学期 + 第X/Y页 + 印于 YYYY-MM-DD   → 9mm
 *   ② 一条横线（撑满左侧）+ 本页二维码（贴右）                            → 11mm
 * 再加 1mm 呼吸 ⇒ 21mm。
 *
 * ⚠️ 横线与二维码**共享页宽**（线占左边剩下的、码贴右边）——
 *    与深挖纸是同一种排法，只是深挖纸那条在页脚、这条在页头。
 * 内容区 = 页高 − 它。
 */
export const VOLUME_HEADER_MM = 21;

/** 内容区高度（分栏时**每栏**都是这个高度） */
export const VOLUME_COLUMN_MM = REVIEW_PAGE_HEIGHT_MM - VOLUME_HEADER_MM;

/** 打孔装订位宽度（与深挖纸同一条物理边，见 `deep-dive-card.ts` 的说明） */
export const REVIEW_PUNCH_GUTTER_MM = 12;

/** 两栏之间的间隙（竖线就画在这里面） */
export const COLUMN_GAP_MM = 4;

/** 扣掉打孔位后真正能排版的宽度 = 152 − 12 = 140mm */
export const REVIEW_USABLE_WIDTH_MM = CONTENT_MM.w - REVIEW_PUNCH_GUTTER_MM;

/** 版面上跟"毫米"有关的共享数字 */
export const REVIEW_LAYOUT_MM = {
    /** 题干文字：10pt、行高 4.2mm（与深挖纸反面同一口径） */
    textLineMM: 4.2,
    /** 答题留白每行的高度 —— 也是"留白行数"这个单位本身 */
    blankLineMM: 7,
    /** 题块内各段之间的小间隙合计（题干下、答题区上下的呼吸） */
    blockGapsMM: 2.5,
    /**
     * 题干超过这么多行 ⇒ 这题**本来就不该进复练/积累卷**，UI 提示改用深挖纸。
     * ⚠️ 这**只是提示线，不是封顶**：行数照实算 ——
     *    封顶会让长题干被算短，"算着放得下、印出来溢出"正是最不能出的错。
     */
    textAdvisoryLines: 10,
    /** 题图高度上限（复练用） */
    figureMaxHeightMM: 45,
    /** 题图高度上限（积累用；栏窄，图不该太大） */
    figureMaxHeightMMBuild: 30,
    /** 留白行数的合法区间（微调时夹在这里面） */
    blankLinesMin: 0,
    blankLinesMax: 40,
} as const;

/** 复练纸缺省留白行数（他定的） */
export const REVIEW_DEFAULT_BLANK_LINES = 5;
/** 积累纸缺省留白行数（他定的） */
export const BUILD_DEFAULT_BLANK_LINES = 1;

/**
 * 两种卷的版面差异，一处集中。
 * ⚠️ 别在组件里再写一遍"两栏时宽度除以二"之类的判断 —— 算法与渲染必须同源。
 */
export interface VolumeVariantSpec {
    kind: VolumeKind;
    /** 分几栏 */
    columns: 1 | 2;
    /**
     * 每行大约多少字。**故意取小**：估多了会"算着放得下、印出来溢出一行"，
     * 那是不可接受的（宁可少算一行，纸尾留点余地）。
     * 140mm 单栏取 26；68mm 栏取 12。
     */
    charsPerLine: number;
    /** 缺省留白行数 */
    defaultBlankLines: number;
    /** 题图高度上限 */
    figureMaxHeightMM: number;
    /** 题图宽度上限 */
    figureMaxWidthMM: number;
    /** 单栏内容宽度 */
    columnWidthMM: number;
}

export const VOLUME_VARIANTS: Record<VolumeKind, VolumeVariantSpec> = {
    review: {
        kind: 'review',
        columns: 1,
        charsPerLine: 26,
        defaultBlankLines: REVIEW_DEFAULT_BLANK_LINES,
        figureMaxHeightMM: REVIEW_LAYOUT_MM.figureMaxHeightMM,
        figureMaxWidthMM: 70,
        columnWidthMM: REVIEW_USABLE_WIDTH_MM,
    },
    build: {
        kind: 'build',
        columns: 2,
        charsPerLine: 12,
        defaultBlankLines: BUILD_DEFAULT_BLANK_LINES,
        figureMaxHeightMM: REVIEW_LAYOUT_MM.figureMaxHeightMMBuild,
        figureMaxWidthMM: 40,
        columnWidthMM: (REVIEW_USABLE_WIDTH_MM - COLUMN_GAP_MM) / 2,
    },
};

/** 浮点比较容差（算高度必然带小数，别用严格相等去判"装不下"） */
const EPS = 0.01;

/* ============================ 输入输出 ============================ */

export interface ReviewQuestionSpec {
    /** 这道题的标识（题目 id），用来在结果里对回来 */
    key: string;
    /** 题干文字（用来估行数；空串 = 没有题干文字） */
    questionText?: string | null;
    /** 题图想要的高度（mm）；0 = 没有题图 */
    figureHeightMM?: number;
}

export interface ReviewBlockLayout {
    key: string;
    /** 流水号（1 起）—— **只是这份卷对题的排序号**，不是题号 */
    seq: number;
    /** 题干文字估出来的行数（UI 拿它提示"这道题字多"） */
    textLines: number;
    /** 实际生效的留白行数（已夹到合法区间） */
    blankLines: number;
    /** **实际能印**的题图高度（已按栏内放得下夹过）。组件照它渲染，别再自己夹一次 */
    figureHeightMM: number;
    /** 答题区高度 = max(题图, 留白行数 × 行高) */
    rowHeightMM: number;
    /** 整块高度（题干 + 答题区 + 间隙），已被夹到不超过一栏 */
    contentHeightMM: number;
    /**
     * ⚠️ **连留白都压不掉**也装不下一栏 ⇒ 这题印不了这张卷（题干太长）。
     * 调用方据此提示"改用深挖纸"，**不静默丢题**（仍然给它一栏，只是标出来）。
     */
    overflow: boolean;
}

export interface ReviewColumnLayout {
    blocks: ReviewBlockLayout[];
}

export interface ReviewPageLayout {
    /** 本页的栏（复练 1 栏、积累 2 栏） */
    columns: ReviewColumnLayout[];
}

export interface ReviewSheetLayout {
    pages: ReviewPageLayout[];
    /** 印不下的那些题（key + 行数），调用方拿它提示用户 */
    overflow: { key: string; textLines: number }[];
}

export type BlankLinesMap = Record<string, number | null | undefined>;

/* ============================ 估算 ============================ */

/**
 * 估题干占几行（按字符数粗略折算；中文按整字符算即可）。
 * ⚠️ **不封顶**：见 `textAdvisoryLines` 的说明。
 */
export function estimateTextLines(text: string | null | undefined, charsPerLine: number): number {
    const s = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return 0;
    const per = Math.max(1, Math.trunc(charsPerLine));
    return Math.ceil(s.length / per);
}

/** 题干是不是"太长、不该进这张卷"（UI 拿它给提示） */
export function isTextTooLong(textLines: number): boolean {
    return textLines > REVIEW_LAYOUT_MM.textAdvisoryLines;
}

/** 留白行数夹到合法区间；传空 ⇒ 用这张卷的缺省值 */
export function normalizeBlankLines(value: number | null | undefined, fallback: number): number {
    const base = value === null || value === undefined || !Number.isFinite(Number(value))
        ? fallback
        : Number(value);
    const n = Math.round(base);
    return Math.min(REVIEW_LAYOUT_MM.blankLinesMax, Math.max(REVIEW_LAYOUT_MM.blankLinesMin, n));
}

/** 某道题当前生效的留白行数（没单独设过 ⇒ 跟着这张卷的缺省走） */
export function effectiveBlankLines(
    overrides: BlankLinesMap,
    key: string,
    kind: VolumeKind,
): number {
    return normalizeBlankLines(overrides?.[key], VOLUME_VARIANTS[kind].defaultBlankLines);
}

/**
 * 整体调整留白行数时，**逐题**跟着变还是不动。
 *
 * 规则（他定的，照抄）：
 *   「每一题如果留白大小**等于**整体调整前留白行数，则随之调整；
 *     当某一题当前留白大小**不等于**调整前行数时，则不随之调整。」
 *
 * 所以判据是**数值相等**，不看"当初是不是显式设过"——
 * 一道题被手动调回 5 行、而缺省也正是 5 时，它就重新归队（这符合直觉）。
 *
 * 返回**新的覆盖表**（不改原对象）。
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
        // 跟着缺省走的题 → 一起变；自己定过别的值的题 → 原样保留
        next[key] = effective === before ? after : effective;
    }
    return next;
}

/* ============================ 度量 ============================ */

/**
 * 量一道题在某张卷上占多高。
 *
 * 组成：题干文字 + **答题区** + 间隙。
 * 答题区高度 = `max(题图高度, 留白行数 × 行高)`（他定的：谁大听谁的）。
 *
 * ⚠️ 题图在这里**统一夹一次**（取上限与"栏内放得下"的较小者）。
 *    夹取只在这一处，组件拿 `figureHeightMM` 直接渲染 ——
 *    两处各夹一次会出现"UI 按 45 显示、算法按 30 计算"的不一致。
 */
export function measureBlock(
    spec: ReviewQuestionSpec,
    kind: VolumeKind,
    seq: number,
    blankOverride?: number | null,
): ReviewBlockLayout {
    const variant = VOLUME_VARIANTS[kind];
    const textLines = estimateTextLines(spec.questionText, variant.charsPerLine);
    const textMM = textLines * REVIEW_LAYOUT_MM.textLineMM;
    const blankLines = normalizeBlankLines(blankOverride, variant.defaultBlankLines);
    const blankMM = blankLines * REVIEW_LAYOUT_MM.blankLineMM;
    const gaps = REVIEW_LAYOUT_MM.blockGapsMM;

    /** 留给"答题区"那一行的高度（题图与留白在这里争地方） */
    const available = Math.max(0, VOLUME_COLUMN_MM - textMM - gaps);
    const want = Math.max(0, spec.figureHeightMM ?? 0);
    const wantCapped = Math.min(want, variant.figureMaxHeightMM);

    // 判"装不下"看的是**想要的**高度（题图可以缩，留白压不了）
    const desiredRow = Math.max(wantCapped, blankMM);
    const overflow = textMM + desiredRow + gaps > VOLUME_COLUMN_MM + EPS;

    const figureHeightMM = Math.min(wantCapped, available);
    const rowHeightMM = Math.min(Math.max(figureHeightMM, blankMM), available);
    /**
     * ⚠️ **块高必须封顶在一栏以内**。
     * 有些极端的题（题干单独就超过一栏）连"把答题区压到 0"都放不下 ——
     * 这时块高**夹到一栏**，只由 `overflow: true` 报出去（UI 提示改用深挖纸）。
     * 不夹的后果：这一块把整栏撑破，后面所有题被顶到看不见的地方，
     * 而且"分页"这一层会以为它排得下 —— 那是**静默错**，比报错糟得多。
     */
    const contentHeightMM = Math.min(textMM + rowHeightMM + gaps, VOLUME_COLUMN_MM);

    return {
        key: spec.key,
        seq,
        textLines,
        blankLines,
        figureHeightMM,
        rowHeightMM,
        contentHeightMM,
        overflow,
    };
}

/* ============================ 分栏分页 ============================ */

/**
 * 排一整份卷：**逐题贪心填栏，填满换栏、栏满换页，绝不跨栏/跨页**。
 *
 * 与旧版最大的差别：不再"一页最多两题"。
 * 现在"一页几题"完全由每题的（题干行数 + 留白行数）算出来 ——
 * 短题一页能排五六道，长题可能一页就一道。
 */
export function layoutReviewSheets(
    specs: readonly ReviewQuestionSpec[],
    kind: VolumeKind = 'review',
    blankOverrides: BlankLinesMap = {},
): ReviewSheetLayout {
    const variant = VOLUME_VARIANTS[kind];
    const pages: ReviewPageLayout[] = [];
    const overflow: { key: string; textLines: number }[] = [];

    /** 当前这一页已排好的栏 */
    let pageColumns: ReviewColumnLayout[] = [];
    /** 当前这一栏已排的块 */
    let current: ReviewBlockLayout[] = [];
    /** 当前这一栏已用掉的高度 */
    let used = 0;

    /** 收当前栏；这一页的栏数够了就把页也收掉 */
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

    /** 收掉"没排满一页"的尾巴 */
    const closeAll = () => {
        closeColumn();
        if (pageColumns.length) {
            pages.push({ columns: pageColumns });
            pageColumns = [];
        }
    };

    specs.forEach((spec, index) => {
        const block = measureBlock(spec, kind, index + 1, blankOverrides[spec.key]);
        if (block.overflow) overflow.push({ key: spec.key, textLines: block.textLines });

        // 本栏排不下 ⇒ 整块推到下一栏（**不拆题**）
        if (current.length > 0 && used + block.contentHeightMM > VOLUME_COLUMN_MM + EPS) {
            closeColumn();
        }
        current.push(block);
        used += block.contentHeightMM;
    });

    closeAll();
    return { pages, overflow };
}

/** 这份卷一共几页（UI 显示"共 N 页"） */
export function countSheets(layout: ReviewSheetLayout): number {
    return layout.pages.length;
}
