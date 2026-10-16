/**
 * 【2026-09-30 立 · 2026-10-16 换形状】复习结果 —— 错题卡底部那**四个圆圈**的数据与规则。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⭐【2026-10-16】**唯一真相搬到流水上了**（`docs\18`）
 *
 *   以前：`ErrorItem.reviewOutcomes` 自己就是真相，形状
 *     `{"planned":[right,null,null,null],"last":"wrong"}`
 *     —— 四个计划格 + "最近一次"，**只有结果、没有日期**。
 *   现在：真相是 **`ReviewEvent` 流水**（一条一次、带日期），
 *     这个字段降级成**派生缓存**，形状 `{"recent":["wrong","right"]}`
 *     （**正序**，末尾 = 最近一次，最多 `RECENT_REVIEW_LIMIT` = 4 条）。
 *
 *   ⇒ 于是本模块分两半：
 *     · **新形状**（`recent`）：`normalizeRecentOutcomes` / `serializeRecentOutcomes` /
 *       `deriveRecentFromEvents` —— 读侧与派生都用这三个；
 *     · **老形状**（`planned`/`last`）：只剩**读**的能力（`normalizeReviewOutcomes` /
 *       `legacyOutcomesToRecent`），供过渡期与"老数据补流水"用。
 *       ⚠️ 写老形状的两个入口（`setPlannedOutcome` / `setLastOutcome`）与
 *          `recordReviewResult` **已于 2026-10-16 删除** —— 留着只会让下一个人
 *          写回一个没人读的形状（"界面显示 4 个圈、流水里却是另外几条"那类静默 bug）。
 *
 * ── 卡片上那四个圈（`reviewDots`）────────────────────────────────────
 *   现在是 **4 个圈 = `recent` 的 4 条**（不足 4 条 ⇒ 后面的画灰圈），
 *   **没有 `|` 分隔、没有日期**（他原话："卡片不大，有四个圈就够了"）。
 * ══════════════════════════════════════════════════════════════════
 *
 * ── 老形状那两条容易搞混的规矩（保留下来给迁移用）────────────────────
 *  ① **计划内的一次做完 ⇒ 最后一个圈同步成同一个结果**（因为"最近一次"就是它）。
 *    他说："如果只复习了一次做对了，则第一个圆圈是绿色对号，而第四个圆圈也为绿色对号。"
 *  ② **计划外的复习只动最后一个圈**：前面的计划圈纹丝不动。
 *  ⇒ 展开成 `recent` 时这两条合并成一句：**`planned` 里的非空值按序留下，
 *     `last` 与"最后一条"不同才追加**（见 `legacyOutcomesToRecent`）。
 *
 * 值存在 `ErrorItem.reviewOutcomes`（TEXT，JSON）。形状：
 *   新：`{"recent":["right","wrong"]}`          ← 现在是这个
 *   老：`{"planned":["right",null,null,null],"last":"wrong"}`
 */

// ⚠️ 日期偏移**只此一处**（`deep-dive-card.ts` 是它的家）—— 本模块不再自己写一遍。
//    【2026-10-16】原来这里还 import 了 `addDays/dayKey`（算计划日期用），
//    那个"把日期印在界面上"的用法随旧编辑器一起删了 ⇒ 这两个 import 也一并去掉。
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

/**
 * 错题卡上显示几条（= 新形状最多存几条）。
 * ⚠️ 声明必须**在 `REVIEW_DOT_COUNT` 之前**（后者直接引用它；`const` 有 TDZ，
 *    放后面就是模块初始化时直接抛错）。
 */
export const RECENT_REVIEW_LIMIT = 4;

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

/** 界面上一个圆圈要画成什么样 */
export interface ReviewDot {
    /** 位置（`r0` = 最早那条 … 末尾 = 最近一次）；固定 4 个，仅作 React key */
    key: string;
    state: 'none' | 'right' | 'wrong';
    /** 悬停提示（中文） */
    zh: string;
    /** 悬停提示（英文） */
    en: string;
}

/** 卡片上固定画几个圈（= `RECENT_REVIEW_LIMIT`） */
export const REVIEW_DOT_COUNT = RECENT_REVIEW_LIMIT;

/**
 * 卡片底部那**四个圈**（`docs\18` §4.1）。
 *
 *  ⚠️【2026-10-16 如如】**判据整个换了**：
 *    · 以前 = 4 个计划格 + 1 个"最近一次"（**5 个圈**，中间画 `|`，每个圈带计划日期）；
 *    · 现在 = **`recent` 的 4 条**（不足 4 条 ⇒ 后面画灰圈），**没有 `|`、没有日期**。
 *    出处：他原话"卡片不大，有四个圈就够了"。
 *
 *  ⚠️ **顺序 = 正序**（左边最早、右边最近）—— 与新结果往右追加的直觉一致，
 *     也与 `recent` 自己的"末尾 = 最近一次"一致。
 */
export function reviewDots(outcomes: unknown): ReviewDot[] {
    const recent = normalizeRecentOutcomes(outcomes);
    const total = recent.length;
    return Array.from({ length: REVIEW_DOT_COUNT }, (_, i) => {
        const state = recent[i] ?? null;
        /**
         * 悬停提示按"离最近一次多远"来说（比"第几条"好懂）：
         *   最后一个有结果的圈 ⇒ "最近一次复习"；再往前 ⇒ "倒数第 N 次"。
         * ⚠️ 灰圈一律"还没有结果"（还没有录到这一条）。
         */
        const fromEnd = total - 1 - i; // 0 = 最近一次那条
        const isLatest = state !== null && fromEnd === 0;
        return {
            key: `r${i}`,
            state: state ?? 'none',
            zh: state === null
                ? '还没有结果'
                : isLatest
                  ? `最近一次复习：${stateLabel(state, 'zh')}`
                  : `倒数第 ${fromEnd + 1} 次复习：${stateLabel(state, 'zh')}`,
            en: state === null
                ? 'No result yet'
                : isLatest
                  ? `Latest review: ${stateLabel(state, 'en')}`
                  : `${fromEnd + 1} review(s) ago: ${stateLabel(state, 'en')}`,
        };
    });
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
