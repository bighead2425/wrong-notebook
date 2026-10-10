import { VOLUME_COLUMN_MM, type MeasuredBlock } from '@/lib/review-card';
import { stripMarkdownImages } from '@/lib/markdown-utils';

/**
 * 【2026-10-10】T4 **模仿纸**的版面规则（纯函数，规则只写这一处）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这张纸跟另外三种**问的问题不一样**（他定的四种纸四种问法）：
 *   深挖纸 = 我为什么错 / 复练纸 = 我掌握没掌握 / 积累纸 = 开放笔记
 *   **模仿纸 = 我如何能对** —— 给自驱力弱的孩子：左栏把主题整个摊开
 *   （题干 → 图 → 遮挡线 → **参考答案 → 解析**），右栏放几道同类附题，让他**照着做**。
 *
 * ⚠️ 所以它是**唯一允许印 AI 内容**的纸型（答案与解析就印在左栏）。
 *    其余三种纸仍然守"纸上零 AI 内容"这条铁律。
 * ⚠️ **不印错因**（他 2026-10-10 明确："模仿纸不谈'错'这件事"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 分页：这张纸是**两条独立的流**，按同一批页输出
 *
 *   · **左栏（主题内容）**：一段一段往下填，一页放不下就**顺延到下一页**
 *     —— 这正是它跟另外三种纸最大的不同（那三种是"整块绝不跨页"，
 *     而左栏的题干/答案/解析本来就是长文，必须能接下去）。
 *   · **右栏（附题）**：与复练纸同一套规矩 —— **一道题绝不跨页**。
 *   · **总页数 = 两条流里大的那个**（某一侧先放完，那侧后面的页就是空的）。
 *
 * ⚠️ 段**不切开**：装不下就整段挪到下一页（他原话："如果一页放不下，就顺延到第二页"）。
 *    真的"切开一个字"需要文本级测量，而他要的效果是"接着往下印"，整段顺延就够了。
 */

/** 左栏里的一段（题干段落 / 题图 / 遮挡线 / 参考答案段落 / 解析段落，都是段） */
export interface ImitateSegment {
    /** 唯一键：渲染与"量尺"都靠它对齐 */
    key: string;
    /**
     * 画法（**分页算法不关心它**，只给渲染层看）：
     *   · `text`    —— 文字段（题干 / 答案 / 解析）
     *   · `figure`  —— 题图
     *   · `divider` —— 那条"遮挡线"（中间写"遮挡"二字）
     */
    kind: 'text' | 'figure' | 'divider';
    heightMM: number;
}

export interface ImitateSheet {
    /** 本页左栏的段（按顺序；空了就是这页左栏没内容了） */
    left: ImitateSegment[];
    /** 本页右栏的附题块（按顺序；已带**跨页连续**的流水号） */
    right: { key: string; heightMM: number; seq: number }[];
}

export interface ImitateLayout {
    sheets: ImitateSheet[];
    /**
     * 一栏都装不下的附题（key + 高度）—— 调用方拿它提示"这道题改用深挖纸"。
     * ⚠️ **左栏的段不会进这里**：段再高也独占一页（宁可溢一点，也不能把内容丢掉）。
     */
    overflowRight: { key: string; heightMM: number }[];
}

/**
 * 按**真实高度**给模仿纸分页（两条流）。
 *
 * @param leftSegments 左栏的段，**按主题内容的自然顺序**排好（题干 → 图 → 遮挡线 → 答案 → 解析）
 * @param rightBlocks  右栏的附题块，按卷内顺序排好（高度来自隐藏量尺的真实测量）
 * @param reservedMM   给页脚预留的高度（从每栏可用高度里扣掉；复练纸那边为同样的理由加过）
 */
export function paginateImitate(
    leftSegments: readonly ImitateSegment[],
    rightBlocks: readonly MeasuredBlock[],
    reservedMM = 0,
): ImitateLayout {
    /** 本栏**真正**可用的高度（扣掉页脚预留）；下限 10mm 兜住"配置写错" */
    const usableMM = Math.max(10, VOLUME_COLUMN_MM - reservedMM);

    /* ── 流①：左栏。段不切开，装不下就整段顺延下一页 ── */
    const leftPages: ImitateSegment[][] = [];
    let curLeft: ImitateSegment[] = [];
    let usedLeft = 0;
    for (const seg of leftSegments) {
        /**
         * 单段比整栏还高（极长的一段解析）⇒ 让它**独占一页**。
         * 宁可这一页溢出一点，也不把内容丢掉 —— 纸上看不到的东西等于没印。
         */
        if (seg.heightMM > usableMM) {
            if (curLeft.length) {
                leftPages.push(curLeft);
                curLeft = [];
                usedLeft = 0;
            }
            leftPages.push([seg]);
            continue;
        }
        if (usedLeft + seg.heightMM > usableMM) {
            leftPages.push(curLeft);
            curLeft = [];
            usedLeft = 0;
        }
        curLeft.push(seg);
        usedLeft += seg.heightMM;
    }
    if (curLeft.length) leftPages.push(curLeft);

    /* ── 流②：右栏。整块不跨页，装不下换页；一栏都装不下 ⇒ 记进 overflow ── */
    const rightPages: ImitateSheet['right'][] = [];
    const overflowRight: { key: string; heightMM: number }[] = [];
    let curRight: ImitateSheet['right'] = [];
    let usedRight = 0;
    let seq = 0;
    for (const block of rightBlocks) {
        seq += 1;
        if (block.heightMM > usableMM) {
            /** 流水号照样往前走：它是"卷里的第几道"，不该因为排不下就断号 */
            overflowRight.push({ key: block.key, heightMM: block.heightMM });
            continue;
        }
        if (usedRight + block.heightMM > usableMM) {
            rightPages.push(curRight);
            curRight = [];
            usedRight = 0;
        }
        curRight.push({ key: block.key, heightMM: block.heightMM, seq });
        usedRight += block.heightMM;
    }
    if (curRight.length) rightPages.push(curRight);

    /* ── 合页：页数取两条流里大的那个（至少 1 页，空卷也要有一张纸） ── */
    const pageCount = Math.max(leftPages.length, rightPages.length, 1);
    const sheets: ImitateSheet[] = [];
    for (let i = 0; i < pageCount; i += 1) {
        sheets.push({ left: leftPages[i] ?? [], right: rightPages[i] ?? [] });
    }

    return { sheets, overflowRight };
}

/** 这份模仿纸一共几张（他界面上"第 X / Y 页"的 Y） */
export function imitatePageCount(layout: ImitateLayout): number {
    return layout.sheets.length;
}

/* ------------------------------------------------------------------ */
/* 左栏的内容：把主题拆成"段"                                            */
/* ------------------------------------------------------------------ */

/**
 * 左栏里一段的**内容**（不含高度 —— 高度要靠隐藏量尺按真实渲染量出来）。
 *
 * ⚠️ 顺序就是他定的那个：**题干 → 图 → 遮挡线 → 参考答案 → 解析**。
 *    两张"小标题"（`heading`）是给下面那段定名的，他自己那版设计稿里就写着
 *    "依次挂上，这道主题详情页的解析、参考答案"。
 * ⚠️ **没有"错因"**：他 2026-10-10 明确更正过 —— 模仿纸问的是"我如何能对"，
 *    **不谈"错"这件事**（原稿里写的"错因分析"作废）。
 */
export interface ImitateSegmentSpec {
    key: string;
    kind: 'text' | 'figure' | 'divider';
    /**
     * 这一段是什么：
     *   · `stem`    题干的正文
     *   · `heading` 小标题（"参考答案" / "解析"）
     *   · `answer`  参考答案正文
     *   · `analysis` 解析正文
     * （`figure` / `divider` 两段的 role 用 `stem` 占位，渲染层按 kind 画）
     */
    role: 'stem' | 'heading' | 'answer' | 'analysis';
    /** 文字内容（`figure` / `divider` 为空） */
    text: string;
}

/** 只取"这几种字段"——不要把整条 `ErrorItem` 拖进纯逻辑里 */
export interface ImitateSource {
    id: string;
    questionText?: string | null;
    ocrText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
}

/**
 * 把**主题**拆成左栏的段序列。
 *
 * ⚠️ 题干优先用 `questionText`、退回 `ocrText`（与复练纸题块同一口径）；
 *    并且**去掉文中的 markdown 图片** —— 题图是单独一段（`figure`），
 *    不然同一张图会印两遍（复练纸那边也踩过这个：`stripMarkdownImages`）。
 * ⚠️ 空内容不占段：没有答案就**不画**"参考答案"那个小标题，
 *    免得纸上出现一个孤零零的标题、下面一片空白。
 * ⚠️ 图要不要那一段由**调用方**决定（`opts.hasFigure`）—— 判断"有没有题图"
 *    要先解 `cropRegions`，那是另一层的事，不拉进这个纯函数里。
 */
export function buildImitateSegments(
    item: ImitateSource,
    opts: { hasFigure: boolean } = { hasFigure: false },
): ImitateSegmentSpec[] {
    const out: ImitateSegmentSpec[] = [];
    const stem = stripMarkdownImages((item.questionText || item.ocrText || '').trim());
    if (stem) {
        out.push({ key: `${item.id}:stem`, kind: 'text', role: 'stem', text: stem });
    }
    if (opts.hasFigure) {
        out.push({ key: `${item.id}:figure`, kind: 'figure', role: 'stem', text: '' });
    }
    /** 遮挡线：把"题目"和"答案"分开的那条线（与深挖纸背面同一个东西） */
    out.push({ key: `${item.id}:divider`, kind: 'divider', role: 'stem', text: '' });

    const answer = (item.answerText || '').trim();
    if (answer) {
        out.push({ key: `${item.id}:answer-h`, kind: 'text', role: 'heading', text: '参考答案' });
        out.push({ key: `${item.id}:answer`, kind: 'text', role: 'answer', text: answer });
    }
    const analysis = (item.analysis || '').trim();
    if (analysis) {
        out.push({ key: `${item.id}:analysis-h`, kind: 'text', role: 'heading', text: '解析' });
        out.push({ key: `${item.id}:analysis`, kind: 'text', role: 'analysis', text: analysis });
    }
    return out;
}

/** 段的内容 → 分页要的 `ImitateSegment`（把量出来的高度配上去） */
export function withHeights(
    specs: readonly ImitateSegmentSpec[],
    heightOf: (key: string) => number,
): ImitateSegment[] {
    return specs.map((s) => ({
        key: s.key,
        kind: s.kind,
        heightMM: heightOf(s.key),
    }));
}
