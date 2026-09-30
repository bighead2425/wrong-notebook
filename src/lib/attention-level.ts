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

/* ============================ 列表页上的两个动作 ============================ */

/**
 * 卡片右上角那枚奖牌：**点一下升一级，👑 之后回到 🥉**（循环）。
 *
 * 出处：他 2026-09-30 的原话 ——
 *   *"点击错题卡上的等级图标，则图标自动升级并保存，顺序从🥉🥈🥇💎👑升级，
 *     已经是👑的跳回🥉，形成循环。"*
 *
 * ⚠️ 规则写在库里、不写在组件里：这条"循环"将来会被别处用到（扫码页也有等级加减），
 *    写两遍必然分叉。
 */
export function cycleAttentionLevel(value: unknown): number {
    const cur = attentionLevelOf(value).value;
    return cur >= 5 ? 1 : cur + 1;
}

/**
 * 「等级」多选下拉里点一下某一档。
 *
 * 他定的规矩：**至少留一个勾** ——
 *   *"如果剩下了唯一一个对号时，即使再点击这个无对号的选项，也不能使对号消失。"*
 * 所以：点已选中的 → 若它是最后一个，**原样返回**（不让勾变没）；否则去掉它。
 * 点没选的 → 加上去，并**按 1→5 排好序**（存出来的 URL 参数才是稳定的 `1,3,5`）。
 */
export function toggleAttentionLevel(selected: readonly number[], value: number): number[] {
    if (selected.includes(value)) {
        if (selected.length <= 1) return [...selected];
        return selected.filter((x) => x !== value);
    }
    return [...selected, value].sort((a, b) => a - b);
}

/** 5 档全选 = 没筛（判"已筛"时用；别处不许再写一遍 `length === 5`） */
export function isAttentionUnfiltered(selected: readonly number[]): boolean {
    return selected.length >= ATTENTION_LEVELS.length;
}
