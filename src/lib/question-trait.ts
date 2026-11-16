/**
 * 【2026-11-16 空空】**"这道题 AI 的数字可信吗"——按题型判断。**
 *
 * ── 为什么不做成让 AI 自评 ────────────────────────────────────────
 * 实测过：一张方格纸数格子的题，三个模型（glm / deepseek / mimo）
 * 都给出「40 整格 + 24 半格 = 52 cm²」，还附一句"答案在 45~55 之间均合理"。
 * 像素级统计的真实答案是**约 100 cm²**（88 整格 + 27 不完整格），**差了近一倍**。
 *
 * 它们不知道自己错了 —— 让一个自信的错误答案自评，只会得到"我认为可靠"。
 *
 * ── 为什么用关键词而不是别的 ──────────────────────────────────────
 * 计数类题目的**题面有固定说法**（数一数 / 估算 / 方格纸 / 覆盖区域）。
 * 正则匹配零成本、可解释、改一条规则就生效，还不用动数据库。
 *
 * ── 原则：宁可漏判，不要误判 ──────────────────────────────────────
 * 漏了只是没提示；误了会让正常题也标黄，用户就不信这个标记了。
 * 所以**不匹配宽泛词**（"几个""多少""共有"）—— 那些应用题也常用。
 */

const COUNTING_PATTERNS: RegExp[] = [
    /数一数/,
    /估算/,
    /方格纸/,
    /每个小方格/,
    /图中有几[个条块]/,
    /覆盖区域/,
    /小正方体.*(数|几个)/,
];

/**
 * 这道题是不是"要数数"的类型。
 *
 * @param questionText 题干（没做过 AI 分析的题可能为空，返回 false）
 */
export function isCountingQuestion(questionText?: string | null): boolean {
    if (!questionText) return false;
    return COUNTING_PATTERNS.some((p) => p.test(questionText));
}

/** 命中后给用户看的那句话（详情页与审核页共用，避免两处文案走散） */
export const COUNTING_HINT_ZH =
    "这是计数类题目：AI 给的数字未经验证，请自己数一遍再核对。";
export const COUNTING_HINT_EN =
    "This is a counting task — the AI's numbers are unverified. Please count it yourself.";
