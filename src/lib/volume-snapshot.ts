/**
 * 【2026-11-04 审计 C4】**卷行的内容快照怎么取** —— 唯一实现在这里。
 *
 * ── 原来的错 ────────────────────────────────────────────────────
 *   `review-volumes/page.tsx` 的保存逻辑写的是：
 *     `questionText: (item?.questionText || item?.ocrText || row?.questionText)`
 *   ——**题库现值优先**。于是她只调一下留白、点"更新组卷"，
 *   卷里的题干就被刷成"现在"的样子（后来可能被 OCR 修正过、被 AI 改过）。
 *   结果：**补印出来的纸，和已经发出去、她划过勾的那张对不上。**
 *
 * ── 为什么这是大问题 ────────────────────────────────────────────
 *   定盘星：**卷内必须存快照**；纸上那份才是"她做过题"的凭证。
 *   分数、等级小框都跟着这份凭证走 —— 凭证被改，等于历史被改写。
 *   `lib/level-linkage.ts` 里那条"**绝不回头改已印出去的纸**"就是这个意思。
 *
 * ── 现在的口径 ──────────────────────────────────────────────────
 *   **快照优先，现值只兜底**：
 *   · 这一行**已有快照** ⇒ 一个字都不动（哪怕题库后来改了）
 *   · 这一行还**没有快照**（新建行）⇒ 才从题里取
 */

/** 卷行上已存的快照（可能只有一部分字段） */
export interface RowSnapshot {
    itemNo?: string | null;
    questionText?: string | null;
    manageType?: string | null;
}

/** 题库里那道题的现值 */
export interface FreshItem {
    source?: string | null;
    questionText?: string | null;
    ocrText?: string | null;
    manageType?: string | null;
}

export interface ResolvedSnapshot {
    itemNo: string | null;
    questionText: string | null;
    manageType: string | null;
}

/** 空串也算"没有" —— 免得一个 `''` 把快照顶掉、或者把现值拦下来 */
const pick = (...vals: (string | null | undefined)[]): string | null => {
    for (const v of vals) {
        if (typeof v === "string" && v.trim().length > 0) return v;
    }
    return null;
};

/**
 * 算这一行要写回去的快照字段。
 *
 * @param row  卷行上**已有的**快照（新建行传 undefined）
 * @param item 题库里的题（题被删了传 undefined）
 */
export function resolveVolumeSnapshot(
    row: RowSnapshot | undefined | null,
    item: FreshItem | undefined | null,
): ResolvedSnapshot {
    return {
        /* 题号：纸上的号是凭证的一部分，别因为题后来改了 source 就变 */
        itemNo: pick(row?.itemNo, item?.source),
        /* 题干：OCR 文字优先于正文（正文可能被 AI 改写过，OCR 才是纸上的字） */
        questionText: pick(row?.questionText, item?.questionText, item?.ocrText),
        /* 等级小框（↑升级 / ↓降级）：印出去是什么就是什么 */
        manageType: pick(row?.manageType, item?.manageType),
    };
}
