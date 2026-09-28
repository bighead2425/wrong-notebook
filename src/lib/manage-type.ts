/**
 * 错题等级（manageType）——「这道题怎么处置」。
 *
 * ── 两个值，不是三个（2026-09-26 审计定为"必改"，2026-09-28 他确认）──────────
 *     deep   深挖 —— 要搞懂，不是练熟
 *     review 复练 —— 会了但不熟，练几遍
 *
 * ⚠️ **「积累」不在这一层**：积累点可以「自己录入」，一句话背后**没有错题行**，
 *    所以「等级 = 积累」无处可存。积累是**另一种内容**，将来自立一张表（Insight）。
 *    出处：二次设计《阅读入口》§6.2（标为死结·必改）、他 2026-09-28 的确认。
 *
 * ── 三条配套规矩（都落在这个文件里，别处不许再写一份）─────────────────
 *  ① **默认 = 复练**（不是深挖）。"全默认深挖 = 平均用力"，正是他反对的。
 *  ② **从错因派生**：她只做一件事（打错因），等级自动跟着走；改标准只改本文件的映射表，
 *     不用重新分类历史数据。
 *  ③ **派生 + 落定快照**：错因以后变了，**只允许自动改写 source 为 default/derived 的行**；
 *     人手动定过（manual）、采纳过 AI 建议（ai）、被行为升过级（upgrade）的一律不动 ——
 *     否则就是"静默重分历史数据"。
 *
 * 本模块是纯函数：不碰 DOM、不碰数据库。
 */

import {
    normalizeMistakeCategory,
    type MistakeCategory,
} from './mistake-category';

/* ============================ 错题等级 ============================ */

export type ManageType = 'deep' | 'review';

/** 顺序即展示顺序（深挖在前 —— 它是要"往上走"的那一档） */
export const MANAGE_TYPES: readonly ManageType[] = ['deep', 'review'];

export const MANAGE_TYPE_LABEL: Record<ManageType, string> = {
    deep: '深挖',
    review: '复练',
};

/** 一句话人话，给界面做副标题用（别处不要再编一套说法） */
export const MANAGE_TYPE_DESC: Record<ManageType, string> = {
    deep: '要搞懂，不是练熟',
    review: '会了但不熟，练几遍',
};

/** 未定时的显示文案 —— 老数据与"还没定过"的题都走这里，不猜 */
export const MANAGE_TYPE_UNDECIDED = '未定';

/**
 * 录入时的默认等级。
 * ⚠️ 是 **review（复练）** 而不是 deep —— 见文件头 ①。
 */
export const MANAGE_TYPE_DEFAULT: ManageType = 'review';

export function isManageType(value: unknown): value is ManageType {
    return typeof value === 'string' && (MANAGE_TYPES as readonly string[]).includes(value);
}

/**
 * 容错归一化：
 *   · 空（null/undefined/空串）→ null = **未定**（与"定了复练"不是一回事）
 *   · 合法值 → 原样
 *   · 有值但不认识 → null（宁可当未定，也不猜一个等级压到数据上）
 *
 * ⚠️ 与 `normalizeMistakeCategory` 的取舍不同：那个把不认识的落到 `other`，
 *    因为错因有"其他"这个合法出口；等级**没有**"其他"这一档，猜错的代价是
 *    "这道题以后按错误的规格对待"，所以退回未定、等人定。
 */
export function normalizeManageType(value: unknown): ManageType | null {
    if (value === null || value === undefined) return null;
    const v = String(value).trim().toLowerCase();
    if (v === '') return null;
    return isManageType(v) ? v : null;
}

/** 界面显示用（未定 → 「未定」） */
export function getManageTypeLabel(value: unknown): string {
    const t = normalizeManageType(value);
    return t ? MANAGE_TYPE_LABEL[t] : MANAGE_TYPE_UNDECIDED;
}

/* ============================ 来源（落定快照） ============================ */

export type ManageTypeSource = 'default' | 'derived' | 'ai' | 'manual' | 'upgrade';

export const MANAGE_TYPE_SOURCES: readonly ManageTypeSource[] = [
    'default',
    'derived',
    'ai',
    'manual',
    'upgrade',
];

export const MANAGE_TYPE_SOURCE_LABEL: Record<ManageTypeSource, string> = {
    default: '录入默认',
    derived: '按错因自动定',
    ai: 'AI 建议（已采纳）',
    manual: '手动定',
    upgrade: '练习结果自动升',
};

export function isManageTypeSource(value: unknown): value is ManageTypeSource {
    return typeof value === 'string' && (MANAGE_TYPE_SOURCES as readonly string[]).includes(value);
}

export function normalizeManageTypeSource(value: unknown): ManageTypeSource | null {
    if (value === null || value === undefined) return null;
    const v = String(value).trim().toLowerCase();
    if (v === '') return null;
    return isManageTypeSource(v) ? v : null;
}

/**
 * **能不能被"自动派生"改写**？—— 「派生 + 落定快照」的唯一判据。
 *
 * 可改写：source 为空（从没定过）/ default（只是录入默认，还没依据）
 * 不可改：**derived（已经派过一次 = 已落定）** / ai / manual / upgrade
 *
 * ⚠️ `derived` 为什么也算"已定"：定稿的原话是
 *    「**派生 + 落定快照**：错因以后变了，**已定类型不变**；变更写 StateChangeLog」
 *    —— 也就是**派生只发生一次**，派完就快照住。
 *    否则她/他把错因从"算错"改成"概念不清"时，等级会在背后悄悄跟着变，
 *    而纸已经按旧等级印出去、放进活页夹了。要改就走手动（source=manual）并留日志。
 *
 * 一处实现，别处不许再写一遍条件 —— 这类"谁能改谁不能改"的规则散开写，
 * 迟早出现"两处判据不一致、静默改掉人工结论"。
 */
export function canAutoRewrite(source: unknown): boolean {
    const s = normalizeManageTypeSource(source);
    return s === null || s === 'default';
}

/* ============================ 从错因派生 ============================ */

export interface ManageTypeSuggestion {
    /** 建议的等级；null = 不建议定（保持未定） */
    type: ManageType | null;
    /** 一句大白话理由，直接显示在按钮下面（他要求"给依据"） */
    reason: string;
    /** 这条建议是从哪个错因来的（null = 错因没打或为空） */
    from: MistakeCategory | null;
}

/**
 * 错因 → 等级的映射表（**改标准只改这一张表**）。
 *
 * 出处：二次设计《T2复练纸_T3积累纸_设计讨论》§二③ 的那张表。
 *
 * | 错因（设计原文的说法） | 等级 |
 * |---|---|
 * | 概念没懂 / 不会做 / 思路错 | **深挖** |
 * | 计算错 / 抄错 / 漏条件 / 粗心 / 时间不够 | **复练** |
 * | 字词 / 单词 / 公式 / 结论记错 | 提炼成**积累点**（不是"题"的等级）|
 *
 * ⚠️ 照实说明一处**对不齐**：当前受控枚举（`lib/mistake-category.ts`）只有 6 个值
 *   （看漏条件 / 方法没想到 / 算错写错 / 概念不清 / 完全不会 / 其他），
 *   **没有"记错"这一类**。所以设计表里的第三行现在没有对应值可映射 ——
 *   这里**不硬凑**（不把 other 猜成积累点），等积累建表时再加一个类目。
 */
const DERIVE_TABLE: Record<MistakeCategory, { type: ManageType | null; reason: string }> = {
    concept: {
        type: 'deep',
        reason: '错因是"概念不清"——要搞懂，不是练熟就能会的，建议深挖',
    },
    blank: {
        type: 'deep',
        reason: '错因是"完全不会"——里面一定有没搞懂的东西，建议深挖',
    },
    no_method: {
        type: 'deep',
        reason: '错因是"方法没想到"——要想通路子，建议深挖',
    },
    computation: {
        type: 'review',
        reason: '错因是"算错写错"——方法会，只是不熟，练几遍就行，建议复练',
    },
    missed_condition: {
        type: 'review',
        reason: '错因是"看漏条件"——习惯问题，多练几遍就稳，建议复练',
    },
    other: {
        type: null,
        reason: '错因是"其他"，没有可靠依据，先不定',
    },
};

/**
 * 按错因给出等级建议。**只建议，不落定** —— 沿用已拍板的 TBD-9：
 * 「以她的为准，AI 并存不覆盖」。
 */
export function suggestManageType(mistakeCategory: unknown): ManageTypeSuggestion {
    const from = normalizeMistakeCategory(mistakeCategory);
    if (from === null) {
        return {
            type: null,
            reason: '还没打错因标签，先不定（打了错因会自动给建议）',
            from: null,
        };
    }
    const hit = DERIVE_TABLE[from];
    return { type: hit.type, reason: hit.reason, from };
}

/* ============================ 纸面上的升降级小框 ============================ */

export type PromoteDirection = 'upgrade' | 'demote';

/**
 * 这道题该印哪个方向的升降级小框。
 *
 * ⚠️ **按「题的类型」印，不按「纸」印**（定稿第 3 条）：
 *    深挖题进了复练纸也只印"降级"；复练题进了深挖纸也只印"升级"。
 *    没定等级（未定）→ 不印（没有方向可指）。
 *
 * 出处：`二次设计/流程图连接笔记/18_升降级小框.md`
 */
export function promoteDirectionFor(type: unknown): PromoteDirection | null {
    const t = normalizeManageType(type);
    if (t === 'review') return 'upgrade';
    if (t === 'deep') return 'demote';
    return null;
}

/**
 * 小框的形态：**必须带文字，不能只靠颜色** ——
 * 打印/复印会把颜色吃掉一层，黑白出来红和灰蓝都是灰的。
 *   升级 = 红 `#c0392b`（红 = 加重、要更用力）
 *   降级 = 灰蓝 `#7f8c9b`（**不用绿**：复习三格里的绿 = 向上长，会打架）
 */
export const PROMOTE_BOX: Record<
    PromoteDirection,
    { arrow: string; label: string; labelEn: string; color: string }
> = {
    upgrade: { arrow: '↑', label: '升级', labelEn: 'Upgrade', color: '#c0392b' },
    demote: { arrow: '↓', label: '降级', labelEn: 'Downgrade', color: '#7f8c9b' },
};
