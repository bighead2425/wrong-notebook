/**
 * 【2026-09-30】复习结果 —— 错题卡底部那**几个圆圈**的数据与规则。
 *
 * ══════════════════════════════════════════════════════════════════
 * 【2026-10-14 改造】三个计划格 ⇒ **四个计划格**
 *
 *   空空 2026-10-14 拍板：纸上加第 4 格（偏移 `+49`），配套把 `RETIRE_STREAK`
 *   从 3 改回 4（原来想要 4，但受限于"只有三个格"只能取 3）。
 *   ⇒ 本模块从 3 格扩到 4 格，`reviewDots` 随之从 4 个点变 **5 个点**
 *     （4 个计划格 + 1 个"最近一次"）。
 *
 *   ⚠️ 日期偏移**不再自己写一遍** —— 统一引用 `deep-dive-card.ts` 的
 *      `REVIEW_OFFSETS_DAYS`（那份注释原本写着"全项目只此一处定义"，
 *      但这里曾经又写了一遍，本次收口）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 他要的东西（原话拆解）
 *  前几个圆圈 = **计划复习**（打印后第 1 / 7 / 21 / 49 天）各自的结果；
 *  最后一个圆圈 = **到目前为止最近一次复习的结果** —— 不论那一次是不是计划内的。
 *
 *  三种状态：
 *    灰圈            = 还没有结果
 *    浅绿底 + 白勾   = 那一次做对了
 *    浅粉底 + 灰叉   = 那一次做错了
 *
 * ── 两条容易搞混的规矩（他就此专门解释过）────────────────────────────
 *  ① **计划内的一次做完 ⇒ 最后一个圈同步成同一个结果**（因为"最近一次"就是它）。
 *     他说："如果只复习了一次做对了，则第一个圆圈是绿色对号，而第四个圆圈也为绿色对号。"
 *  ② **计划外的复习只动最后一个圈**：前面的计划圈纹丝不动（那是计划内的账），
 *     最后一个圈改成这一次的结果。
 *
 * ⚠️ 规则只在这一处实现，免得"计划内同步 last"这条规矩在几处各写一遍、迟早分叉。
 *
 * 值存在 `ErrorItem.reviewOutcomes`（TEXT，JSON）。形状：
 *   {"planned":["right",null,null,null],"last":"wrong"}
 */

import { addDays, dayKey } from './calendar-grid';
// 日期偏移**只此一处**（deep-dive-card.ts 是它的家）—— 本模块不再自己写一遍
import { REVIEW_OFFSETS_DAYS } from './deep-dive-card';

export type ReviewOutcome = 'right' | 'wrong';

export interface ReviewOutcomes {
    /** 计划复习各次的结果，`null` = 还没结果；长度 = `PLANNED_REVIEW_ROUNDS` */
    planned: (ReviewOutcome | null)[];
    /** 最近一次复习的结果 —— 计划内、计划外都算 */
    last: ReviewOutcome | null;
}

/** 计划复习的次数（界面上直接用它，别处不要再写死"3"或"4"） */
export const PLANNED_REVIEW_ROUNDS = REVIEW_OFFSETS_DAYS.length;

/** 计划节点的下标类型（加格子时只改这一个联合类型） */
export type PlannedIndex = 0 | 1 | 2 | 3;

export const PLANNED_REVIEW_LABELS_ZH = [
    '第 1 天复习',
    '第 7 天复习',
    '第 21 天复习',
    '第 49 天复习',
] as const;
export const PLANNED_REVIEW_LABELS_EN = [
    'Day 1 review',
    'Day 7 review',
    'Day 21 review',
    'Day 49 review',
] as const;

export function isReviewOutcome(value: unknown): value is ReviewOutcome {
    return value === 'right' || value === 'wrong';
}

/**
 * 计划复习的节点偏移（天）—— **转发** `deep-dive-card.ts` 那一份。
 * 详情页那几行要**写出具体日期**（`YYYY-MM-DD`），所以偏移量必须只有一份。
 */
export const PLANNED_REVIEW_OFFSET_DAYS = REVIEW_OFFSETS_DAYS;

export function emptyReviewOutcomes(): ReviewOutcomes {
    return { planned: REVIEW_OFFSETS_DAYS.map(() => null), last: null };
}

/**
 * 容错归一化：接受 JSON 字符串（库里存的样子）或已经是对象的样子。
 * 任何一处不合法就按"还没有结果"处理 —— **宁可显示灰圈，也不猜一个结果**。
 *
 * ⚠️ 老的 3 格数据（`planned` 长度 3）读进来会被**补成 4 格**（多的补 `null`）——
 *    这样"扩格"不需要写迁移脚本。本项目目前还没有真实数据，这里只是保险。
 */
export function normalizeReviewOutcomes(value: unknown): ReviewOutcomes {
    let raw: unknown = value;
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return emptyReviewOutcomes();
        try {
            raw = JSON.parse(s);
        } catch {
            return emptyReviewOutcomes();
        }
    }
    if (!raw || typeof raw !== 'object') return emptyReviewOutcomes();

    const obj = raw as Record<string, unknown>;
    const plannedRaw = Array.isArray(obj.planned) ? obj.planned : [];
    const planned: (ReviewOutcome | null)[] = [];
    for (let i = 0; i < PLANNED_REVIEW_ROUNDS; i += 1) {
        const v = plannedRaw[i];
        planned.push(isReviewOutcome(v) ? v : null);
    }
    return { planned, last: isReviewOutcome(obj.last) ? obj.last : null };
}

/** 解析 → 存库字符串（写入侧统一走它，别处不许自己拼 JSON） */
export function serializeReviewOutcomes(outcomes: ReviewOutcomes): string {
    return JSON.stringify(outcomes);
}

/**
 * 记一次复习结果。
 *
 * @param plannedIndex 计划内第几次（0 起）；**不传**表示计划外的复习
 *                     （计划外只动 `last`，计划圈不动 —— 规矩 ②）
 */
export function recordReviewResult(
    current: unknown,
    result: ReviewOutcome,
    plannedIndex?: PlannedIndex,
): ReviewOutcomes {
    const base = normalizeReviewOutcomes(current);
    const planned = [...base.planned];
    if (plannedIndex !== undefined && plannedIndex >= 0 && plannedIndex < PLANNED_REVIEW_ROUNDS) {
        planned[plannedIndex] = result;
    }
    // 不论计划内外，"最近一次"都跟着更新（规矩 ①）
    return { planned, last: result };
}

/** 界面上一个圆圈要画成什么样 */
export interface ReviewDot {
    key: 'p1' | 'p2' | 'p3' | 'p4' | 'last';
    state: 'none' | 'right' | 'wrong';
    /** 悬停提示（中文） */
    zh: string;
    /** 悬停提示（英文） */
    en: string;
}

/**
 * 计划节点各自的**日期**（`YYYY-MM-DD`，本地时区）。
 * 打印日 +1 / +7 / +21 / +49 天 —— 出处见 `deep-dive-card.ts` 的 `REVIEW_OFFSETS_DAYS`。
 * 日期算不出来（没录入时间）就返回空串，界面上那格留空而不是显示瞎编的日期。
 */
export function plannedReviewDates(createdAt: unknown): string[] {
    const d = createdAt instanceof Date ? createdAt : new Date(String(createdAt ?? ''));
    if (Number.isNaN(d.getTime())) return PLANNED_REVIEW_OFFSET_DAYS.map(() => '');
    return PLANNED_REVIEW_OFFSET_DAYS.map((delta) => addDays(dayKey(d), delta));
}

/* ============================ 写入：两条入口，别搞混 ============================ */

/**
 * 【入口 A】界面上**直接改计划格里的某一格**（人工更正）—— 他要的规则：
 *
 *   出处：他 2026-09-30 的原话（很啰嗦但意思清楚）——
 *     · "三行过后的下面一行写最近一次情况……如果前三个有改动的情况下，
 *        照前三个中**最后一个已选**亮绿色对号或粉色错号的结果作为自己的结果"；
 *     · "如果前三个改动后，**没有任何一个**绿色对号或粉色错号，则**保持当前状态不变**"；
 *     · "如果前三次的调整是来自于 AI 提供的信息，且……与更新前的结果是**一样的**，
 *        那么最近一次情况应**保持不变**"。
 *
 *   落成三条：
 *     ① 改完与改前**完全一样** ⇒ 原样返回（`last` 不动）；
 *     ② 改完计划格**全空** ⇒ `last` 不动（他说"保持当前状态不变"）；
 *     ③ 否则 ⇒ `last` = **计划格里最后一个非空**的值（倒着找）。
 *
 *   ⚠️ 为什么 ③ 能同时满足他"先改第 2 次、再补改第 1 次就别跟着动"：
 *     补改第 1 次之后，"最后一个非空"仍然是第 2 次那颗 ⇒ `last` 算出来跟原来一样。
 *     规则本身不需要知道"谁先谁后"，只看"最后一个有结果的计划节点"。
 */
export function setPlannedOutcome(
    current: unknown,
    index: PlannedIndex,
    value: ReviewOutcome | null,
): ReviewOutcomes {
    const base = normalizeReviewOutcomes(current);
    const planned = [...base.planned];
    planned[index] = value;

    // ① 没变化 ⇒ 什么都不动（AI 重复回传同一批结果就走这条路）
    if (planned.every((v, i) => v === base.planned[i])) return base;

    // ③ 倒着找最后一个有结果的计划节点
    const lastFilled = [...planned].reverse().find((v) => v !== null) ?? null;

    // ② 全空 ⇒ last 不动；否则同步
    return { planned, last: lastFilled === null ? base.last : lastFilled };
}

/**
 * 【入口 B】只改**最近一次情况**那一行（计划外的复习、或人工直接指定）。
 *
 * 他说得最直白的一句："如果前三次记录中第三次（即 21 天后）记录已经存在，
 * 并记录为绿色对号或粉色错号，则再提供来这道题的复习情况，无论是对号还是错，
 * **就只在"最近一次情况"中予以记录更新**。"
 * —— 也就是"计划位满了以后，新结果只落在这里，计划格不再动"。
 */
export function setLastOutcome(current: unknown, value: ReviewOutcome | null): ReviewOutcomes {
    const base = normalizeReviewOutcomes(current);
    return { planned: base.planned, last: value };
}

/**
 * 全部圆圈（计划格 + 最后一个是"最近一次"）。
 * 顺序即显示顺序；最后一个与前面用 `|` 隔开（布局在组件里，不在这里）。
 */
export function reviewDots(outcomes: unknown): ReviewDot[] {
    const o = normalizeReviewOutcomes(outcomes);
    const dots: ReviewDot[] = o.planned.map((state, i) => ({
        key: (['p1', 'p2', 'p3', 'p4'] as const)[i],
        state: state ?? 'none',
        zh: `${PLANNED_REVIEW_LABELS_ZH[i]}：${stateLabel(state, 'zh')}`,
        en: `${PLANNED_REVIEW_LABELS_EN[i]}: ${stateLabel(state, 'en')}`,
    }));
    dots.push({
        key: 'last',
        state: o.last ?? 'none',
        zh: `最近一次复习：${stateLabel(o.last, 'zh')}`,
        en: `Latest review: ${stateLabel(o.last, 'en')}`,
    });
    return dots;
}

function stateLabel(state: ReviewOutcome | null | undefined, lang: 'zh' | 'en'): string {
    if (state === 'right') return lang === 'zh' ? '做对了' : 'correct';
    if (state === 'wrong') return lang === 'zh' ? '做错了' : 'wrong';
    return lang === 'zh' ? '还没有结果' : 'no result yet';
}

/* ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-16 如如】新形状：`{"recent": ["wrong","right","right","right"]}`
 *
 * ⭐ 出处：`docs\18` §〇 / §2.2 —— **复习结果的唯一真相从"4 个计划格 + 最近一次"
 *    换成"一条一条的流水"**（`ReviewEvent`），这个字段降级成**派生缓存**
 *    （每次写流水之后从最近的流水算出来写回）。
 *
 *   约定（规格 §2.2）：
 *     · `recent` **按时间正序** —— **末尾那个 = 最近一次**
 *     · 最多 **`RECENT_REVIEW_LIMIT`（=4）** 条（与错题卡那 4 个圈一致）；
 *       ⚠️ **流水里才是全部**，这里只是"显示用的最近 4 条"
 *     · 空数组 `[]` = 没录过
 *
 *   ⚠️ **字段名不变**（还叫 `ErrorItem.reviewOutcomes`）⇒
 *      `lib/constants/error-item-list-fields.ts` 与那条"字段同步"看门测试都不用动。
 *   ⚠️ **老形状（`{planned,last}`）必须继续能读** —— 过渡期两套并存，
 *      下面 `normalizeRecentOutcomes()` 新旧都认；迁移只做一件事：
 *      把老形状**展开**成 `recent`（见 `legacyOutcomesToRecent`）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 错题卡上显示几条（= 新形状最多存几条） */
export const RECENT_REVIEW_LIMIT = 4;

/** 库里存的新形状 */
export interface ReviewRecentOutcomes {
    /** 最近几次的结果，**正序**（末尾 = 最近一次），长度 0..`RECENT_REVIEW_LIMIT` */
    recent: ReviewOutcome[];
}

/** 内部：把 JSON 串 / 对象 / 垃圾值统一成"对象或 null" */
function asObject(value: unknown): Record<string, unknown> | null {
    let raw: unknown = value;
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return null;
        try {
            raw = JSON.parse(s);
        } catch {
            return null;
        }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
}

/**
 * 是不是**老形状**（`{planned,last}`）。
 * 判据：有 `planned` 或 `last` 这两个键之一，且**没有** `recent`（`recent` 优先）。
 */
export function isLegacyReviewOutcomes(value: unknown): boolean {
    const obj = asObject(value);
    if (!obj) return false;
    if ('recent' in obj) return false;
    return 'planned' in obj || 'last' in obj;
}

/**
 * 老形状 ⇒ 最近结果序列。
 *
 * ⚠️⚠️ **展开规则必须与 `lib/review-status.ts` 的 `reviewEventSequence()` 逐字一致** ——
 *    这是"迁移后读出来跟迁移前一样"的**验收点**（`docs\18` §2.3）。
 *    规则就两条：① `planned` 里的非空值按序留下；② `last` 若与"最后一条"不同，追加到末尾。
 *
 * 例：`{"planned":["right","wrong",null,null],"last":"right"}` ⇒ `["right","wrong","right"]`
 *     （前三条全对 ⇒ `["right","right","right"]`，不会多出一条）
 */
export function legacyOutcomesToRecent(value: unknown): ReviewOutcome[] {
    const { planned, last } = normalizeReviewOutcomes(value);
    const events = planned.filter((v): v is ReviewOutcome => v === 'right' || v === 'wrong');
    if (last && last !== events[events.length - 1]) events.push(last);
    return events;
}

/**
 * 归一化：**新旧形状都认** ⇒ 一律返回"最近结果序列"（正序、≤ `RECENT_REVIEW_LIMIT`）。
 *
 * 任何一处不合法就当"没有结果"（**宁可显示灰圈，也不猜一个结果**）。
 * ⚠️ 超出 4 条时**取末尾 4 条**（末尾才是最近几次）。
 */
export function normalizeRecentOutcomes(value: unknown): ReviewOutcome[] {
    const obj = asObject(value);
    if (!obj) return [];

    if (!('recent' in obj)) {
        // 老形状（或"两个键都没有"的空值）⇒ 走展开
        return isLegacyReviewOutcomes(obj) ? legacyOutcomesToRecent(obj) : [];
    }

    const raw = Array.isArray(obj.recent) ? obj.recent : [];
    const recent = raw.filter((v): v is ReviewOutcome => v === 'right' || v === 'wrong');
    return recent.length > RECENT_REVIEW_LIMIT ? recent.slice(-RECENT_REVIEW_LIMIT) : recent;
}

/** 解析 → 存库字符串（**新形状**；写入侧统一走它，别处不许自己拼 JSON） */
export function serializeRecentOutcomes(recent: readonly ReviewOutcome[]): string {
    const capped = recent.length > RECENT_REVIEW_LIMIT ? recent.slice(-RECENT_REVIEW_LIMIT) : [...recent];
    const payload: ReviewRecentOutcomes = { recent: capped };
    return JSON.stringify(payload);
}

/** 追加一条结果到末尾（**裁到 4 条**）—— 派生时用 */
export function appendRecentOutcome(
    recent: readonly ReviewOutcome[],
    outcome: ReviewOutcome,
): ReviewOutcome[] {
    const next = [...recent, outcome];
    return next.length > RECENT_REVIEW_LIMIT ? next.slice(-RECENT_REVIEW_LIMIT) : next;
}

/**
 * **从流水算派生值** —— 唯一实现在这里（纯函数，前端/服务端都能用）。
 *
 * 入参只要"有 `outcome` 的数组"，**按调用方给的顺序**（调用方按时间正序查出来）。
 * ⚠️ 只取**末尾 4 条**：判等级/紧迫度都够用（规则里"连对 ≥3 就锁 1 级" ⇒ 封顶在 3），
 *    这个结论见 `docs\18` §十.1（真真已论证）。
 */
export function deriveRecentFromEvents(events: readonly { outcome: unknown }[]): ReviewOutcome[] {
    const all = events
        .map((e) => e?.outcome)
        .filter((v): v is ReviewOutcome => v === 'right' || v === 'wrong');
    return all.length > RECENT_REVIEW_LIMIT ? all.slice(-RECENT_REVIEW_LIMIT) : all;
}

/** 派生值的存库字符串（= `serializeRecentOutcomes(deriveRecentFromEvents(...))` 的快捷方式） */
export function deriveReviewOutcomesJson(events: readonly { outcome: unknown }[]): string {
    return serializeRecentOutcomes(deriveRecentFromEvents(events));
}
