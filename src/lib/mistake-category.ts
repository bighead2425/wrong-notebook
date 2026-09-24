/**
 * 错因分类（受控枚举）—— 给 AI 打标用，**不印在纸上**（P16 定案）
 *
 * 背景：原设计是"她勾选固定 5 类"，2026-09-23 改成**她自由书写、AI 归类**。
 * 5 个类目没有被丢掉，只是**从纸面移到了 AI 的输出标签**：
 * 类目统一的责任从她转到 AI，跨题汇总的能力不变。
 *
 * 她那边改由"圈"与"写"承担（P16）：圈管"在哪一步"，字管"为什么"。
 *
 * ⚠️ 本模块的值存在 `ErrorItem.mistakeCategory` 这一列，**刻意与 errorType 分开**：
 * `errorType` 是外部导入透传的英文自由文本（api/import、openclaw/batch-upload 会写），
 * 语义不受控；只有本模块的值才是受控枚举。
 */

export type MistakeCategory =
    | 'missed_condition'
    | 'no_method'
    | 'computation'
    | 'concept'
    | 'blank'
    | 'other';

const LABELS_ZH: Record<MistakeCategory, string> = {
    missed_condition: '看漏条件',
    no_method: '方法没想到',
    computation: '算错写错',
    concept: '概念不清',
    blank: '完全不会',
    other: '其他',
};

const LABELS_EN: Record<MistakeCategory, string> = {
    missed_condition: 'Missed a condition',
    no_method: 'No method found',
    computation: 'Computation slip',
    concept: 'Concept unclear',
    blank: 'Stuck entirely',
    other: 'Other',
};

/** P16 原定的 5 类 + other。顺序即展示顺序。 */
export const MISTAKE_CATEGORIES: readonly MistakeCategory[] = [
    'missed_condition',
    'no_method',
    'computation',
    'concept',
    'blank',
    'other',
];

export function isMistakeCategory(value: unknown): value is MistakeCategory {
    return typeof value === 'string' && (MISTAKE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 容错归一化，三态语义分明：
 *   · 空（null / undefined / 空串） → **null**：表示"还没打标"，与"打了 other"不是一回事
 *   · 合法值                      → 原样返回
 *   · 有值但不认识                → 'other'（宁可落到"其他"，也不留一个非法值在库里）
 */
export function normalizeMistakeCategory(value: unknown): MistakeCategory | null {
    if (value === null || value === undefined) return null;
    const v = String(value).trim().toLowerCase();
    if (v === '') return null;
    return isMistakeCategory(v) ? v : 'other';
}

export function getMistakeCategoryLabel(
    value: unknown,
    language: 'zh' | 'en' = 'zh',
): string {
    const normalized = normalizeMistakeCategory(value);
    if (normalized === null) return '';
    return (language === 'en' ? LABELS_EN : LABELS_ZH)[normalized];
}
