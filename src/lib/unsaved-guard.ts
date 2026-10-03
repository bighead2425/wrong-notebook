/**
 * 【2026-10-03 需求第 4 条】"未保存的版面改动"这套防护的**纯逻辑**。
 *
 * 为什么单独一个模块：这套判断（"该不该拦""拦下来说什么"）在两个页面各写一遍、
 * 再各自随手改，迟早出现"一个拦、一个不拦"的不一致。放这里一处实现，可单测。
 *
 * 本模块**不碰 DOM、不碰 React、不碰 window** —— 只做比较与拼文案，
 * 弹不弹 `confirm`、挂不挂 `beforeunload` 都留给调用方（页面）。
 */

import { normalizeFigureScale } from "./review-card";

/* ══════════════════════════════════════════════════════════════════
 * 一、复练卷页：版面改过没有
 *
 * 积累纸页原本就有一套 `dirty`（草稿 vs 卷快照），复练卷页没有 —— 这一条是补它的。
 * 判据刻意用**当前生效值 vs 已保存基线**逐项比（而不是"动过某个控件就置脏"）：
 * 用户拖大了又拖回原样、点 + 又点 −，都应当算"没改"，别拿【更新组卷】烦他。
 * ══════════════════════════════════════════════════════════════════ */

/** 已保存的版面（基线）：打开卷时按快照记下、保存成功后刷新成刚存的那版 */
export interface ReviewLayoutBaseline {
    /** 整卷默认留白行数 */
    defaultBlankLines: number;
    /** key（题 id / 快照行 key）→ 留白行数 */
    blankLines: Record<string, number>;
    /** key → 题图缩放百分比 */
    figureScale: Record<string, number>;
}

/** 屏幕上的草稿（可以与基线不同） */
export interface ReviewLayoutDraft {
    /** 整卷默认留白行数 */
    defaultBlankLines: number;
    /** key → 留白行数；`null/undefined` = 没单独设过 ⇒ 跟默认走 */
    blankOverrides: Record<string, number | null | undefined>;
    /** key → 题图缩放百分比 */
    figureScales: Record<string, number | null | undefined>;
}

/**
 * 复练卷页的"版面改过没有"。
 *
 * 逐项比当前**生效值**：
 *   · 留白：`override ?? draft.default` vs  `baseline.blankLines[key] ?? baseline.default`；
 *   · 题图：两边都用 `normalizeFigureScale` 归一（与渲染同口径，免得 100.0001 被判成改过）。
 * key 取两侧的并集，但**比的仍是生效值**：某一侧缺的 key 按其默认值兜底，
 * 所以"多出来一个 key 但值正好等于默认"不算改动（它本来也没让版面变样）。
 */
export function reviewLayoutDirty(baseline: ReviewLayoutBaseline, draft: ReviewLayoutDraft): boolean {
    if (baseline.defaultBlankLines !== draft.defaultBlankLines) return true;

    const blankKeys = new Set([...Object.keys(baseline.blankLines), ...Object.keys(draft.blankOverrides)]);
    for (const key of blankKeys) {
        const original = baseline.blankLines[key] ?? baseline.defaultBlankLines;
        const current = draft.blankOverrides[key] ?? draft.defaultBlankLines;
        if (original !== current) return true;
    }

    const figureKeys = new Set([...Object.keys(baseline.figureScale), ...Object.keys(draft.figureScales)]);
    for (const key of figureKeys) {
        const original = normalizeFigureScale(baseline.figureScale[key]);
        const current = normalizeFigureScale(draft.figureScales[key]);
        if (original !== current) return true;
    }

    return false;
}

/* ══════════════════════════════════════════════════════════════════
 * 二、该不该拦、拦下来说什么
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 这一步该不该先弹确认：**只有"改过还没保存"才拦**。
 * 没改就放行 —— 否则每次切卷/打印都弹一下，比不拦还烦。
 */
export function shouldWarnBeforeLeaving(dirty: boolean): boolean {
    return dirty;
}

/**
 * "会丢掉未保存改动"的确认文案（`window.confirm` 里那两句）。
 * 项目惯例是中文为主、英文一并给 —— 这里按 `zh` 选一版。
 *
 * @param actionZh 动作的中文说法（如 `切换卷` / `打印`）—— 直接嵌进句子
 * @param actionEn 动作的英文说法（如 `Switch volume` / `Print`）—— 直接嵌进句子
 */
export function unsavedLeaveMessage(zh: boolean, actionZh: string, actionEn: string): string {
    return zh
        ? `当前版面改过了但还没保存，继续会丢掉这些改动。确定${actionZh}吗？`
        : `You have unsaved layout changes — continuing will lose them. ${actionEn} anyway?`;
}
