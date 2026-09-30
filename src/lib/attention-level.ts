/**
 * 【2026-09-30】关注档 → **等级**（他要的：1-5 档换成 🥉🥈🥇💎👑）。
 *
 * 字段仍是 `ErrorItem.attention`（1-5，数值语义不变，库里不动），
 * 这里只统一"怎么显示、怎么叫"—— 免得列表/详情/筛选各写一套说法。
 *
 * ⚠️ 他的原话："这个先改起来，改完以后我再考虑如何分级的问题。"
 *    ⇒ 本轮**只改显示**，不改分级规则、不动数据。
 */

export interface AttentionLevel {
    /** 1-5，与 `ErrorItem.attention` 同义 */
    value: number;
    medal: string;
    zh: string;
    en: string;
}

export const ATTENTION_LEVELS: readonly AttentionLevel[] = [
    { value: 1, medal: '🥉', zh: '青铜', en: 'Bronze' },
    { value: 2, medal: '🥈', zh: '白银', en: 'Silver' },
    { value: 3, medal: '🥇', zh: '黄金', en: 'Gold' },
    { value: 4, medal: '💎', zh: '钻石', en: 'Diamond' },
    { value: 5, medal: '👑', zh: '王者', en: 'King' },
];

/** 1-5 归一到合法档位（老数据/空值一律按 1 = 青铜） */
export function attentionLevelOf(value: unknown): AttentionLevel {
    const n = Number(value);
    const idx = Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) - 1 : 0;
    return ATTENTION_LEVELS[idx];
}

/** 徽章 + 名称，如 `🥇 黄金`（`zh=false` 给英文名） */
export function attentionLabel(value: unknown, zh = true): string {
    const lv = attentionLevelOf(value);
    return `${lv.medal} ${zh ? lv.zh : lv.en}`;
}
