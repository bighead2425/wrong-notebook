/**
 * 错因分类（受控枚举）—— 给 AI 打标用，**不印在纸上**（P16 定案）
 *
 * ── 【2026-09-30 换新】从 6 个自由分类 → **8 种、分 3 组、带优先级** ──────────
 * 他给的这一版不是"多几个选项"，而是**三条规矩**：
 *
 *  ① **分三组，组决定复习类型**（"以上三类分别初步判定分类"）：
 *       不掌握 → 深挖（要搞懂，不是练熟）
 *       没做对 → 复练（方法会，只是不熟）
 *       其他   → 未定（没有可靠依据，先不定）
 *
 *  ② **越排在前面的越优先，一题只留一个错因**。
 *     他的原话：既有知识盲区、又有计算失误的题，**记知识盲区**
 *     （知识盲区排第 2、计算失误排第 5）⇒ 优先级 = 本文件里的**声明顺序**。
 *     别处不许再编一套权重：顺序改一次、全系统跟着改。
 *
 *  ③ **人与 AI 可以来回改**：AI 先给初判，她/他不同意就手动改；
 *     孩子的深挖纸回录后，也可按她自己的分析再改一次。（写入侧不做"谁覆盖谁"的判断，
 *     最后一次改动生效；留痕走 StateChangeLog。）
 *
 * ── 为什么一个字段只装一个值 ──────────────────────────────────────────
 * 多错因合并成"一个"不是丢信息，是**排定责任**：一题摆两个错因，
 * 下一轮复习就不知道该补哪一块。顺序定了，合并就是确定性的，不需要人再判。
 *
 * ⚠️ 本模块的值存在 `ErrorItem.mistakeCategory` 这一列，**刻意与 errorType 分开**：
 * `errorType` 是外部导入透传的英文自由文本（api/import、openclaw/batch-upload 会写），
 * 语义不受控；只有本模块的值才是受控枚举。
 */

/* ============================ 8 种错因 ============================ */

export type MistakeCategory =
    /** 不掌握 · 对基本定义、公式理解不透彻，只知其然不知其所以然（知道用哪个知识点，但用错了） */
    | 'concept_vague'
    /** 不掌握 · 根本没学过或漏了关键考点，无法下手（干脆不知道该用什么知识点） */
    | 'knowledge_gap'
    /** 不掌握 · 学过但记混了，应该用 A、用着用着成了 B */
    | 'memory_weak'
    /** 没做对 · 没看清单位/限制条件/关键词（把"不正确"看成"正确"） */
    | 'misread'
    /** 没做对 · 符号写错、进位出错、步骤跳跃（"粗心"表象下的基本功问题） */
    | 'calc_slip'
    /** 没做对 · 习惯用老方法套新题，忽略条件变化，"想当然"出错 */
    | 'fixed_mindset'
    /** 其他 · 手写答案是对的，或这道题本来就没有手写答案，只是想记下来 */
    | 'just_record'
    /** 其他 · 前 7 个都无法归因 */
    | 'unknown_reason';

export type MistakeGroup = 'not_mastered' | 'not_right' | 'other';

const LABELS_ZH: Record<MistakeCategory, string> = {
    concept_vague: '概念模糊',
    knowledge_gap: '知识盲区',
    memory_weak: '记忆不牢',
    misread: '审题不清',
    calc_slip: '计算失误',
    fixed_mindset: '思维定式',
    just_record: '就想记录',
    unknown_reason: '未知错因',
};

const LABELS_EN: Record<MistakeCategory, string> = {
    concept_vague: 'Vague concept',
    knowledge_gap: 'Knowledge gap',
    memory_weak: 'Shaky memory',
    misread: 'Misread the question',
    calc_slip: 'Calculation slip',
    fixed_mindset: 'Fixed mindset',
    just_record: 'Just recording',
    unknown_reason: 'Unknown reason',
};

/**
 * **顺序即优先级**（1 最优先）。一题归多个错因时，取**数组里最靠前**的那个。
 * 改优先级 = 改这个数组的顺序，别处不用动。
 */
export const MISTAKE_CATEGORIES: readonly MistakeCategory[] = [
    'concept_vague',
    'knowledge_gap',
    'memory_weak',
    'misread',
    'calc_slip',
    'fixed_mindset',
    'just_record',
    'unknown_reason',
];

/** 三组（下拉菜单按组分段显示；组本身也决定复习类型，见 `deriveManageType`） */
export const MISTAKE_GROUPS: readonly {
    key: MistakeGroup;
    zh: string;
    en: string;
    items: readonly MistakeCategory[];
}[] = [
    {
        key: 'not_mastered',
        zh: '不掌握',
        en: 'Not yet understood',
        items: ['concept_vague', 'knowledge_gap', 'memory_weak'],
    },
    {
        key: 'not_right',
        zh: '没做对',
        en: 'Slipped up',
        items: ['misread', 'calc_slip', 'fixed_mindset'],
    },
    {
        key: 'other',
        zh: '其他',
        en: 'Other',
        items: ['just_record', 'unknown_reason'],
    },
];

/** 错因 → 所属组 */
export function groupOf(category: MistakeCategory): MistakeGroup {
    const g = MISTAKE_GROUPS.find((x) => x.items.includes(category));
    return g ? g.key : 'other';
}

/**
 * 他给的**逐条解释**（2026-09-30 原话，一字未改语义）—— 当界面上的悬停说明用。
 *
 * 用途有二，都不是装饰：
 *  ① 界面上鼠标停一下就知道这一项到底指什么（"概念模糊"和"知识盲区"最容易混：
 *     前者是**知道用哪个知识点但用错了**，后者是**根本不知道该用哪个**）；
 *  ② 将来 AI 打标时，这份说明就是给模型的判据 —— **判据只有一份**，
 *     界面上写的和给 AI 看的必须是同一份，否则"人和 AI 说的不是一回事"。
 */
export const MISTAKE_CATEGORY_DESC_ZH: Record<MistakeCategory, string> = {
    concept_vague: '对基本定义、公式理解不透彻，只知其然不知其所以然（知道用哪个知识点，但实际使用中搞错了）',
    knowledge_gap: '根本没学过或遗漏了关键考点，导致无法下手（干脆不知道该用什么知识点）',
    memory_weak: '学过但记混了，比如把相似概念搞错，或考场上突然遗忘（应该用知识点 A，用着用着成了 B）',
    misread: '没看清单位、限制条件或关键词，如把"不正确"看成"正确"',
    calc_slip: '符号写错、进位出错或步骤跳跃，属于"粗心"表象下的基本功问题',
    fixed_mindset: '习惯用老方法套新题，忽略题目条件的变化，导致"想当然"出错',
    just_record: '适用于录入的一道题：手写做出的答案是对的，或者这道题没有手写答案',
    unknown_reason: '适用于前面 7 个原因都无法归因的情况',
};

/* ============================ 归一化与迁移 ============================ */

/**
 * **老值 → 新值**的映射（2026-09-30 换枚举时同步跑了一条 SQL 迁移，这里留一份兜底）。
 *
 * 旧枚举 6 个，语义对应关系（不是重新分类，是**同一件事换了个说法**）：
 *   concept（概念不清）         → concept_vague（概念模糊）
 *   blank（完全不会）           → knowledge_gap（知识盲区：根本不知道用哪个知识点）
 *   no_method（方法没想到）     → knowledge_gap（同上：想不出该走哪条路）
 *   missed_condition（看漏条件）→ misread（审题不清）
 *   computation（算错写错）     → calc_slip（计算失误）
 *   other（其他）               → unknown_reason（未知错因）
 */
const LEGACY_MAP: Record<string, MistakeCategory> = {
    concept: 'concept_vague',
    blank: 'knowledge_gap',
    no_method: 'knowledge_gap',
    missed_condition: 'misread',
    computation: 'calc_slip',
    other: 'unknown_reason',
};

export function isMistakeCategory(value: unknown): value is MistakeCategory {
    return typeof value === 'string' && (MISTAKE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 容错归一化，三态语义分明：
 *   · 空（null / undefined / 空串） → **null**：表示"还没打标"，与"打了未知错因"不是一回事
 *   · 合法值                      → 原样返回
 *   · 旧枚举值                    → 按 `LEGACY_MAP` 转成新值（老数据不至于变成"未知"）
 *   · 有值但完全不认识            → 'unknown_reason'（宁可落到"未知错因"，也不留非法值在库里）
 */
export function normalizeMistakeCategory(value: unknown): MistakeCategory | null {
    if (value === null || value === undefined) return null;
    const v = String(value).trim().toLowerCase();
    if (v === '') return null;
    if (isMistakeCategory(v)) return v;
    return LEGACY_MAP[v] ?? 'unknown_reason';
}

export function getMistakeCategoryLabel(
    value: unknown,
    language: 'zh' | 'en' = 'zh',
): string {
    const normalized = normalizeMistakeCategory(value);
    if (normalized === null) return '';
    return (language === 'en' ? LABELS_EN : LABELS_ZH)[normalized];
}

/* ============================ 一题只留一个 ============================ */

/**
 * 多个错因 → **一个**。取优先级最高的那个（`MISTAKE_CATEGORIES` 里最靠前）。
 *
 * 出处：他 2026-09-30 的原话 ——
 *   *"AI 分析发现存在多种错题原因时候，8 种错题原因按次序确定优先级，越排在前面的越优先……
 *     每道错题归集的错因保留一个即可。"*
 *
 * 空数组 / 全是非法值 → null（保持"没打标"，不硬塞一个）。
 */
export function pickPrimaryCategory(values: unknown): MistakeCategory | null {
    if (!Array.isArray(values)) return null;
    const hits = values
        .map((v) => normalizeMistakeCategory(v))
        .filter((v): v is MistakeCategory => v !== null);
    if (hits.length === 0) return null;
    // 按既有顺序排，取第一个 —— 顺序表是唯一依据
    return MISTAKE_CATEGORIES.find((c) => hits.includes(c)) ?? hits[0];
}

/** 优先级序号（1 最优先），给界面显示"为什么记了这一个" */
export function priorityOf(category: MistakeCategory): number {
    return MISTAKE_CATEGORIES.indexOf(category) + 1;
}
