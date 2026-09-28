/**
 * T2 复练纸 —— 版面常量与**分页算法**（纯函数，可单测）。
 *
 * ── 这张纸是什么 ──────────────────────────────────────────────────
 * 「要重做但不必深挖」的题的载体：**一题半页、两题一页**（P 定义见二次设计
 * 《打印版面设计结论》§五）。与 T1 深挖纸的区别：
 *   · 没有十字象限、没有反面、没有遮挡线；
 *   · 题与题之间一条**灰色虚线**分隔；
 *   · 答题留白按"行"计（她写字的地方）；
 *   · 与深挖纸同一条铁律：**纸上零 AI 内容**（不印答案 / 解析 / 错因）。
 *
 * ── 两条硬规则（他定的）──────────────────────────────────────────
 *   ① **绝不跨页**：一道题要么整块在本页，要么整块推到下一页。
 *      跨页会把"题面"和"她写字的地方"切到两张纸上，写字时得翻来翻去。
 *   ② 一页放不下两题时，**宁可只放一题**（另一题顺延），也不挤压留白。
 *      那一题会独占整页 —— 多出来的空间全给它写字。
 *
 * ── 为什么做成纯函数 ────────────────────────────────────────────
 * "包不包得下"如果靠肉眼在屏幕上看，等于把验收推给打印纸；
 * 这里给出**算出来的**块高与分页，配单测钉死边界（正好放下 / 差一点点放不下）。
 *
 * 本模块不碰 DOM、不碰数据库。
 */

import { CONTENT_MM } from './deep-dive-card';

/* ============================ 版面常量 ============================ */

/**
 * 复练纸的**单页可用高度** = 版心高 − 2mm 松量。
 *
 * ⚠️ 为什么不是正好 227mm（与深挖纸同一条教训，别改回去）：
 *    把高度写成与页边距算出来的内容区一模一样时，浏览器排版取整只要多出一点点，
 *    就会判定"这一块装不下"而把它整体挪到下一页 —— 表现是**每张纸前面多一张白纸**。
 *    少 2mm 对这个风险免疫，代价只是纸尾多 2mm 留白（本来也该留白）。
 * 与 `deep-dive-card.ts` 的 `SIDE_HEIGHT_MM` 同一口径。
 */
export const REVIEW_PAGE_HEIGHT_MM = CONTENT_MM.h - 2;

/**
 * 题间分隔（灰虚线 + 它上下的留白）占的高度。
 * ⚠️ 它只在**同页两题之间**出现，不占页首/页尾。
 */
export const REVIEW_DIVIDER_MM = 3;

/** 打孔位：与深挖纸同一条物理边（左侧），她可以一并归入活页夹。 */
export const REVIEW_PUNCH_GUTTER_MM = 12;

/** 可排版宽度 = 版心宽 − 打孔位 */
export const REVIEW_USABLE_WIDTH_MM = CONTENT_MM.w - REVIEW_PUNCH_GUTTER_MM;

export const REVIEW_LAYOUT_MM = {
    /** 题目行（学科色标 + 题号 + 小二维码 + 角标）——比深挖纸的 9mm 略高，因为要塞二维码 */
    headerRow: 14,
    /** 题目行下面那条细线 */
    headerRule: 1,
    /** 题干文字：10pt、行高 4.2mm（与深挖纸反面同一口径） */
    textLineMM: 4.2,
    /**
     * 每行大约多少字。
     * 可排版宽 140mm、10pt 中文 ≈ 4.9mm/字 ⇒ 约 28 字/行；
     * 这里**故意取小一点（26）**：估多了会导致"算着放得下、印出来溢出一行"，
     * 那是不可接受的（宁可少算一行，留点余地）。
     */
    charsPerLine: 26,
    /**
     * 题干超过这么多行 ⇒ 这道题**本来就不该用复练纸**，UI 提示改用深挖纸。
     * ⚠️ 这**只是提示线，不是封顶**：行数照实算，
     *    否则"20 行的题按 10 行算"会算出放得下、印出来却溢出。
     */
    textAdvisoryLines: 10,
    /** 题图：宽高上限（半页里不能太大，否则留白被吃光） */
    figureMaxWidthMM: 90,
    figureMaxHeightMM: 45,
    /** 答题留白下限（一行按 7mm 算，3 行 = 21mm）。低于它这道题不适合复练纸 */
    blankMinLines: 3,
    /** 答题留白每行的高度 */
    blankLineMM: 7,
    /** 升降级小框那一行的高度（框 5mm + 上下余量） */
    promoteBox: 7,
    /** 块内各段之间的小间隙合计（题目行下、题面下、留白上下的呼吸） */
    blockGaps: 4,
} as const;

/** 半页（同页两题时每一题能用的高度） */
export const REVIEW_HALF_BLOCK_MM = (REVIEW_PAGE_HEIGHT_MM - REVIEW_DIVIDER_MM) / 2;

/** 答题留白下限（mm） */
export const REVIEW_BLANK_MIN_MM = REVIEW_LAYOUT_MM.blankMinLines * REVIEW_LAYOUT_MM.blankLineMM;

/* ============================ 输入输出 ============================ */

export interface ReviewQuestionSpec {
    /** 这道题的标识（题号或 id），只用来在结果里对回来 */
    key: string;
    /** 题干文字（用来估行数；空串 = 没有题干文字） */
    questionText?: string | null;
    /** 题图高度（mm）；0 = 没有题图 */
    figureHeightMM?: number;
}

export interface ReviewBlockLayout {
    key: string;
    /** 这道题**内容**需要的高度（题目行 + 题干 + 题图 + 小框 + 最小留白），不含弹性留白 */
    contentHeightMM: number;
    /** 题干文字估出来的行数（用于 UI 提示"这道题字多"） */
    textLines: number;
    /** **实际能印**的题图高度（已按"整页装得下"封顶）。组件照这个值渲染，别再自己夹一次 */
    figureHeightMM: number;
    /** 这块实际分到的高度（同页两题 = 半页；独占整页 = 整页） */
    blockHeightMM: number;
    /** 弹性留白高度 = 块高 − 内容高（永远 ≥ 0） */
    blankHeightMM: number;
    /**
     * ⚠️ **把题图缩到 0 都装不下一整页** ⇒ 这道题印不了复练纸（题干太长）。
     * 调用方据此提示"改用深挖纸"，**不静默丢题**。
     */
    overflow: boolean;
}

export interface ReviewPageLayout {
    /** 本页放几块（1 或 2） */
    blocks: ReviewBlockLayout[];
}

export interface ReviewSheetLayout {
    pages: ReviewPageLayout[];
    /** 印不下的那些题（key + 原因），调用方拿它提示用户 */
    overflow: { key: string; textLines: number }[];
}

/* ============================ 估算与分页 ============================ */

/**
 * 估题干占几行（按字符数粗略折算；中文按整字符算即可，英文标点混排也不至于差太多）。
 *
 * ⚠️ **不封顶**：行数照实算。封顶会让"很长的题干"被算短 ——
 *    算着放得下、印出来溢出，正是这张纸最不能出的错。
 *    长题该走深挖纸，那由 UI 按 `textAdvisoryLines` 提示，而不是在这里悄悄截断。
 */
export function estimateTextLines(text: string | null | undefined): number {
    const s = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return 0;
    return Math.ceil(s.length / REVIEW_LAYOUT_MM.charsPerLine);
}

/** 题干是不是"太长、不该用复练纸"（UI 拿它给提示） */
export function isTextTooLong(textLines: number): boolean {
    return textLines > REVIEW_LAYOUT_MM.textAdvisoryLines;
}

/**
 * 题干占这么多行时，题图**最多**还能印多高（再高就连一整页都装不下）。
 *
 * 为什么要它：题干长的题如果照 45mm 印题图，一块就超过整页 ⇒ 只能"改纸"。
 * 与其让用户去改纸，不如**先把题图缩到装得下**——题图缩一点不影响做题，
 * 而"这题印不了"要用户动手，代价更大。
 */
export function maxFigureHeightMMFor(textLines: number): number {
    const fixed =
        REVIEW_LAYOUT_MM.headerRow +
        REVIEW_LAYOUT_MM.headerRule +
        textLines * REVIEW_LAYOUT_MM.textLineMM +
        REVIEW_LAYOUT_MM.promoteBox +
        REVIEW_BLANK_MIN_MM +
        REVIEW_LAYOUT_MM.blockGaps;
    return Math.max(0, REVIEW_PAGE_HEIGHT_MM - fixed);
}

/**
 * 一道题**内容**需要多高（不含弹性留白），并给出**实际能印**的题图高度。
 *
 * 组成：题目行 + 题干文字 + 题图 + 升降级小框 + 最小留白 + 段间间隙。
 *
 * ⚠️ 题图在这里**统一夹一次**（取三个上限的最小值）：
 *    ① 调用方想要的高度；② 版面自身的 45mm 上限；③ "一整页装得下"的上限。
 *    夹取只在这一处，组件拿 `figureHeightMM` 直接渲染 ——
 *    两处各夹一次会出现"UI 按 45 显示、算法按 30 计算"的不一致。
 */
export function contentHeightMM(spec: ReviewQuestionSpec): {
    height: number;
    textLines: number;
    figureHeightMM: number;
} {
    const textLines = estimateTextLines(spec.questionText);
    const want = Math.max(0, spec.figureHeightMM ?? 0);
    const figureHeightMM = Math.min(
        want,
        REVIEW_LAYOUT_MM.figureMaxHeightMM,
        maxFigureHeightMMFor(textLines),
    );
    const height =
        REVIEW_LAYOUT_MM.headerRow +
        REVIEW_LAYOUT_MM.headerRule +
        textLines * REVIEW_LAYOUT_MM.textLineMM +
        figureHeightMM +
        REVIEW_LAYOUT_MM.promoteBox +
        REVIEW_BLANK_MIN_MM +
        REVIEW_LAYOUT_MM.blockGaps;
    return { height, textLines, figureHeightMM };
}

/**
 * 分页：**一题半页、两题一页；包不下就顺延，绝不跨页**。
 *
 * 规则细节（都能被下面的单测验证）：
 *   1. 每题的"内容高"先算出来；
 *   2. 一页最多两块；第二块放不下就开新页（**宁可这页只放一块**）；
 *   3. 独占整页的那一块，块高 = 整页 ⇒ 多出来的全变成写字留白；
 *   4. 内容高 > 整页 ⇒ 判 overflow（这题不该用复练纸，提示改用深挖纸）。
 */
export function layoutReviewSheets(specs: readonly ReviewQuestionSpec[]): ReviewSheetLayout {
    const pages: ReviewPageLayout[] = [];
    const overflow: { key: string; textLines: number }[] = [];

    /** 当前这一页（还没定型：可能再进一题变成"两题一页"） */
    let current: ReviewBlockLayout[] = [];

    const flush = () => {
        if (current.length) {
            pages.push({ blocks: current });
            current = [];
        }
    };

    for (const spec of specs) {
        const { height, textLines, figureHeightMM } = contentHeightMM(spec);
        /**
         * 题图已经按"整页装得下"夹过 ⇒ 这里还超页，说明**连题图都不要也装不下**
         * （题干本身就太长）。这种题真的不该用复练纸，记下来给调用方提示。
         */
        const tooTall = height > REVIEW_PAGE_HEIGHT_MM;
        if (tooTall) overflow.push({ key: spec.key, textLines });

        /**
         * 先按"独占整页"给这块定高；若下一题能与它同页，下面会一起改成半页。
         * 这样默认是**最宽裕**的那一档：先给足，同页才缩。
         */
        const block: ReviewBlockLayout = {
            key: spec.key,
            contentHeightMM: height,
            textLines,
            figureHeightMM,
            blockHeightMM: REVIEW_PAGE_HEIGHT_MM,
            blankHeightMM: Math.max(0, REVIEW_PAGE_HEIGHT_MM - height),
            overflow: tooTall,
        };

        // 本页已有一题：试着把这一题也放进来（要求两题都 ≤ 半页）
        if (current.length === 1) {
            const first = current[0];
            const bothFit =
                !first.overflow &&
                !tooTall &&
                first.contentHeightMM <= REVIEW_HALF_BLOCK_MM &&
                height <= REVIEW_HALF_BLOCK_MM;

            if (bothFit) {
                first.blockHeightMM = REVIEW_HALF_BLOCK_MM;
                first.blankHeightMM = Math.max(0, REVIEW_HALF_BLOCK_MM - first.contentHeightMM);
                block.blockHeightMM = REVIEW_HALF_BLOCK_MM;
                block.blankHeightMM = Math.max(0, REVIEW_HALF_BLOCK_MM - height);
                current.push(block);
                flush();
                continue;
            }

            // 放不下 ⇒ 上一题**独占整页**（已按整页定高），收页，本题另开一页
            flush();
        }

        current.push(block);
        /**
         * 只有"还塞得下第二个半页"时才把这一页留着：
         * 内容已超半页（或溢出）的题到此为止，直接收页 —— 免得下一题
         * 被迫挤在半页里，也免得"看着还有一半空白其实放不下"。
         */
        if (tooTall || height > REVIEW_HALF_BLOCK_MM) flush();
    }

    flush();
    return { pages, overflow };
}

/** 一张纸能放几题（给 UI 显示"这批题会出 N 页"） */
export function countSheets(layout: ReviewSheetLayout): number {
    return layout.pages.length;
}
