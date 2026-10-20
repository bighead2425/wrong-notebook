/**
 * 【2026-09-30 建，2026-10-15 换内容】关注档 → **复习紧迫度**
 *
 * 字段仍是 `ErrorItem.attention`（1-5，**数值语义不变、库里不动**），
 * 这里只统一"怎么显示、怎么叫"—— 免得列表/详情/筛选各写一套说法。
 *
 * ⚠️ **2026-10-15 空空换的这一版**：1-5 = 🍜🥘🥐🥥🥗 / D C B A S / 稳了 还行 该练 抓紧 此刻。
 *    这套图标**本来就是花生 2026-10-03 提的那一版**（见下面那张表的注释）。
 *
 * ⚠️ **语义变了**（这是本次改造的核心）：以前 1-5 是"等级，越高越厉害"；
 *    现在 1-5 是"**紧迫度，越大越急**"。所以 5 = 🥗 S 此刻 = **今天就得练**，
 *    1 = 🍜 D 稳了 = 最不急（连对 ≥ 3 次，锁定）。
 *    ⇒ 完整规则见 `docs\14_等级语义改造v2_完整设计_20261015.md`。
 *
 * ⚠️ **等级由系统算，用户不再干涉**（2026-10-15 定）——
 *    卡片点奖牌升级、详情页下拉、扫码面板、分析页**四处人工入口全部收回**。
 *    `cycleAttentionLevel()` 保留但**已无人调用**（见它的注释）。
 */

export interface AttentionLevel {
    /** 1-5，与 `ErrorItem.attention` 同义 */
    value: number;
    medal: string;
    /** 【2026-10-15】字母档：D / C / B / A / S（越大越急）。显示时与 `zh` 拼成「B该练」。 */
    grade: string;
    zh: string;
    en: string;
}

/* ══════════════════════════════════════════════════════════════════════
 * 【2026-10-04 定规矩，2026-10-15 换内容】⚠️ 这张表 = **花生要自己改的地方**，改这里就够。
 *
 * 他的原话："将等级设为 1-5，在软件表现或者印刷或者需要人来看的时候，
 * 能够将数字映射到 emoji 上就行了，这样改映射比改代码容易得多。"
 * ⇒ 确实是这个结构：**库里只存 1-5 的数字**，显示全靠这张表。
 *
 * ✅ **2026-10-15 换成了花生 2026-10-03 自己提的那一版 🍜🥘🥐🥥🥗**
 *    （当时她提了这版，空空让她再想想 —— 现在定案就是它，等于她自己的选择回来了）。
 *    配的字母 D/C/B/A/S 和名字 稳了/还行/该练/抓紧/此刻 是空空 2026-10-15 定的。
 *
 * ⚠️ **改的时候四样一起改**：`medal`（图标）、`grade`（字母）、`zh`（中文名）、`en`（英文名）。
 *   只改图标会变成"🍜 稳了"配"D"这种怪组合 —— 四样是配对的。
 * ⚠️ **只许改内容，不许改顺序**：`value` 必须保持 1→5 递增（= 紧迫度递增），
 *   因为 `level-linkage.ts` 的 clampLevel 和 `cycleAttentionLevel` 都靠"数值越大 = 越靠后"。
 *   本次 1→5 = D→S = 不急→最急，**符合**。
 * ⚠️ 使用点：多选筛选 / 错题卡 / 列表筛选 / 详情页 / 内阁统计。
 *   （**详情页的"人工改档"下拉、卡片的"点一下升级"已于 2026-10-15 全部收回**）
 *   它们都只读这张表 ⇒ 改完自动全站生效，不用逐个改。
 * ══════════════════════════════════════════════════════════════════════ */

export const ATTENTION_LEVELS: readonly AttentionLevel[] = [
    { value: 1, medal: '🍜', grade: 'D', zh: '稳了', en: 'Steady' },
    { value: 2, medal: '🥘', grade: 'C', zh: '还行', en: 'Fair' },
    { value: 3, medal: '🥐', grade: 'B', zh: '该练', en: 'To practice' },
    { value: 4, medal: '🥥', grade: 'A', zh: '抓紧', en: 'Hurry' },
    { value: 5, medal: '🥗', grade: 'S', zh: '此刻', en: 'Now' },
];

/** 1-5 归一到合法档位（老数据/空值一律按 1 = 青铜） */
export function attentionLevelOf(value: unknown): AttentionLevel {
    const n = Number(value);
    const idx = Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) - 1 : 0;
    return ATTENTION_LEVELS[idx];
}

/** 图标 + 名称，如 `🥐 该练`（`zh=false` 给英文名） */
export function attentionLabel(value: unknown, zh = true): string {
    const lv = attentionLevelOf(value);
    return `${lv.medal} ${zh ? lv.zh : lv.en}`;
}

/**
 * 【2026-10-15 新】字母 + 名称，如 `B该练` —— **详情页顶栏第二行用的就是它**。
 *
 * ⚠️ 字母与名称之间**不加空格**（空空 2026-10-15 给的样式就是「B该练」）。
 * ⚠️ 为什么单开一个函数而不是拼字符串：字母和名称都来自那张表，
 *   散在各处拼会分叉（本项目的老教训）。
 */
export function attentionFullName(value: unknown, zh = true): string {
    const lv = attentionLevelOf(value);
    return `${lv.grade}${zh ? lv.zh : lv.en}`;
}

/* ============================ 列表页上的两个动作 ============================ */

/**
 * ⚠️⚠️【2026-10-15 **已停用**】卡片右上角那枚奖牌"点一下升一级"。
 *
 * 空空 2026-10-15 定：**等级完全交给系统，用户不再干涉** ⇒
 *   卡片 / 详情页下拉 / 扫码面板 / 分析页**四处人工入口全部收回**，本函数**已无人调用**。
 *
 * 📌 **函数体一个字没删** —— 理由与 `computeLevelLinkage` 同：
 *   那是他 2026-09-30 亲口定的规则的**唯一记录**，将来一起决定去留。
 *   留着也不会被误用（UI 已无入口），而且它的单测仍然钉着"1→5 递增、5 之后回 1"这条不变量。
 *
 * 出处（原文）：*"点击错题卡上的等级图标，则图标自动升级并保存，
 *   顺序从🥉🥈🥇💎👑升级，已经是👑的跳回🥉，形成循环。"*
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

/**
 * 【2026-10-15 新】**新录入的题的初始等级** = 5（🥗 S 此刻）。
 *
 * 按新规则：**没练过 ⇒ 最急 ⇒ 5**。
 * ⚠️ 语义与以前完全不同 —— 以前是"深挖 ⇒ 2 / 复练 ⇒ 1"（`initialLevelForManageType`），
 *    那是把等级当"等级"看；现在等级是"紧迫度"，**没练过当然最急**。
 *
 * 📌 **2026-10-15 起，等级与"用哪张纸"脱钩**（空空原话：
 *    *"复练、深挖是对一道题怎么练习、用什么纸的记录项……纸型和紧迫程度联系不是那么紧密。"*）
 *    ⇒ `initialLevelForManageType()` 不再被调用（函数体保留，是历史记录）。
 */
export const NEW_ITEM_ATTENTION = 5;

/* ══════════════════════════════════════════════════════════════════════
 * 【2026-10-15 新】「掌握 / 等级」**合并筛选**的键
 *
 * 空空 2026-10-15 定（`docs\14` §7.5）：把原来的两个下拉合成一个 ——
 *   ① 原【筛选】里的「掌握状态」整组挪出来；
 *   ② 与原【等级】下拉合并，选项与顺序为：
 *      **已掌握 / 🍜D稳了 / 🥘C还行 / 🥐B该练 / 🥥A抓紧 / 🥗S此刻**
 *
 * 📌 为什么**没有"预掌握"这一项**：他这一版把模型说死了 ——
 *    *"题按照掌握与否的分类分为'已掌握'和'未掌握'，其中'未掌握'下分为 5 个等级。"*
 *    ⇒ 二分的"掌握" + 未掌握里的 5 档 = **6 个选项**。
 *    "预掌握"是**等级 1（稳了）之下的一个显示状态**（等级1 + 倒数0），
 *    筛 🍜D稳了 时它自然被包含进去，不必单列。
 *
 * ⚠️ **"已掌握优先于等级"**（他明确要求）：一道题即使等级是 🥗S此刻，
 *    只要它已掌握，就**不出现在 🥗S此刻 的筛选结果里** —— 由服务端把这几项
 *    拼成 `OR` 且给等级分支加上 `masteryLevel < 2` 实现（见 `api/error-items/list`）。
 * ══════════════════════════════════════════════════════════════════════ */

/** 合并筛选里"已掌握"那一项的键 */
export const MASTERED_FILTER_KEY = 'mastered';

/**
 * 【2026-10-20 空空】**"预掌握"单独列一项**（放在"已掌握"下面）。
 *
 * 他原话："这个等级下拉菜单中，在『已掌握』下面还是应该增加一个『预掌握』选项，
 *          有了这个预掌握，才更方便实用。"
 *
 * ⚠️ 它**不是新的一档等级**，也不占 `masteryLevel` 的值 ——
 *    判据就是 `lib/level-settle.ts` 里那个 `isPreMastered()`：
 *    **等级 1（连对 ≥3 锁定）+ 倒数走到 0**。
 *    原来只有"显示状态"、筛选时被 🍜D稳了 顺带包含；现在单独给一个键，
 *    她可以直接把这一批"再确认一次就该掌握"的题挑出来。
 *
 * 📌 本文件头那段"为什么没有预掌握"的说明**已作废**（他改主意了），
 *    保留原文只为记录来龙去脉。
 */
export const PRE_MASTERED_FILTER_KEY = 'preMastered';

/** 合并筛选的全部合法键（顺序 = 下拉里的显示顺序） */
export const FILTER_KEYS: readonly string[] = [
    MASTERED_FILTER_KEY,
    PRE_MASTERED_FILTER_KEY,
    ...ATTENTION_LEVELS.map((l) => String(l.value)),
];

/** 键 ⇒ 等级数字（"已掌握"不是等级，返回 null） */
export function filterKeyToLevel(key: string): number | null {
    /** "已掌握"和"预掌握"都不是某一档等级，走各自的分支 */
    if (key === MASTERED_FILTER_KEY || key === PRE_MASTERED_FILTER_KEY) return null;
    const n = Number(key);
    return Number.isFinite(n) && n >= 1 && n <= ATTENTION_LEVELS.length ? n : null;
}

/**
 * 点一下某个键：选中 ⇄ 取消。**至少留一个**（空 ⇒ 原样返回，不让勾全没）。
 * ⚠️ 与 `toggleAttentionLevel` 是同一条规矩，只是键从数字换成了字符串。
 */
export function toggleFilterKey(selected: readonly string[], key: string): string[] {
    if (selected.includes(key)) {
        if (selected.length <= 1) return [...selected];
        return selected.filter((k) => k !== key);
    }
    // 按 `FILTER_KEYS` 的固定顺序排 —— 存出来的 URL 参数才是稳定的
    return FILTER_KEYS.filter((k) => k === key || selected.includes(k));
}

/** 全部选中 = 没筛（判"已筛"、决定要不要传参数都用它） */
export function isFilterUnfiltered(selected: readonly string[]): boolean {
    return selected.length >= FILTER_KEYS.length;
}

/** 把 URL 里那串 `mastered,1,3` 解成合法的键数组（脏值直接丢掉） */
export function parseFilterKeys(raw: string | null): string[] {
    if (!raw) return [];
    const keys = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => FILTER_KEYS.includes(s));
    return FILTER_KEYS.filter((k) => keys.includes(k)); // 去重 + 固定顺序
}
