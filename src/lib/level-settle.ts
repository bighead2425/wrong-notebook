/**
 * 【2026-10-15 新】**等级结算** —— 规则在这里，**唯一实现**。
 *
 * 设计原文：`docs\14_等级语义改造v2_完整设计_20261015.md`（第三节规则、第五节结算）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一句话：**等级 = "这道题还剩几天该练"**（越大越急），而"还剩几天"由
 *   「最近的对错」定间隔、再由**时间**每天往下推。
 *
 *  ── 规则只有两条 ─────────────────────────────────────────────────
 *   ① **间隔表**：记下复习结果时，按"最近的对错"决定多少天后再练 ——
 *        | 最近情况              | 间隔  |
 *        |-----------------------|-------|
 *        | 没练过（新）/ 连错 ≥2 | 1 天  |
 *        | 做错 1 次             | 4 天  |
 *        | 连对 1 次             | 7 天  |
 *        | 连对 2 次             | 21 天 |
 *        | 连对 3 次             | 49 天 |
 *   ② **阈值表**：等级 = 看"还剩几天" ——
 *        | 还剩      | 等级        |
 *        |-----------|-------------|
 *        | ≤ 1 天    | 5 🥗 此刻   |
 *        | ≤ 4 天    | 4 🥥 抓紧   |
 *        | ≤ 7 天    | 3 🥐 该练   |
 *        | ≤ 21 天   | 2 🥘 还行   |
 *        | 连对 ≥ 3  | 1 🍜 稳了（锁） |
 *
 *  ── 三个边界（空空 2026-10-15 逐条定过）─────────────────────────────
 *   · 倒数**一律夹在 0，不下负数**；
 *   · 等级 1 + 倒数 0 ⇒ **预掌握**（冻结，用户点一下才变"已掌握"）；
 *   · 等级 ≠1 + 倒数 0 ⇒ **等级 5**（就是"早该练了"）。
 *
 * ⚠️ **本模块是纯函数**（不 import `@/lib/prisma`）—— 照 `overview.ts` / `knowledge-stats.ts`
 *    的样子写，这样规则可以脱离数据库单测。写库的那部分在 `lib/daily-settle.ts`。
 *
 * ⚠️ **判"连对/连错几次"必须复用 `review-status.ts` 的 `reviewEventSequence()`**，
 *    不要自己再解一遍 `reviewOutcomes` —— 那个"计划三格全对 vs 之后再对一次认不出来"
 *    的已知歧义只有一处实现，抄第二份必然分叉（本项目的老教训）。
 */

import { reviewEventSequence } from './review-status';

/* ============================ 常量（唯一出处） ============================ */

/**
 * 间隔表（天）。键是"最近的情况"。
 *
 * ⚠️ 这几个数字是**空空 2026-10-15 定的**，不是凑出来的：
 *    他原话 *"没练过（新题）/ 连错 ≥2，间隔1天；做错1次，间隔4天；连对1次，间隔7天；
 *    连对2次，间隔21天；连对3次，间隔49天（观察期）"*。
 * 📌 顺带：{1, 7, 21, 49} 正好与**纸上那 4 格**（`REVIEW_OFFSETS_DAYS`）是同一组数字
 *    —— 纸是"按 4 次全做对排的计划"，软件是"实况"，不要求逐格对齐（docs\14 §3.5）。
 */
export const LEVEL_INTERVAL_DAYS = {
    /** 没练过（新题）或连错 ≥ 2 次 —— 明天再来 */
    newOrManyWrong: 1,
    /** 做错 1 次 —— 缓 4 天再看看 */
    oneWrong: 4,
    /** 连对 1 次 */
    right1: 7,
    /** 连对 2 次 */
    right2: 21,
    /** 连对 3 次 —— 观察期，倒数走完就是"预掌握" */
    right3: 49,
} as const;

/** 倒数上限 = 最长间隔（连对 3 次的观察期） */
export const MAX_COUNTDOWN: number = LEVEL_INTERVAL_DAYS.right3;

/** 连对几次算"锁住"（等级 1 🍜 稳了） */
export const LOCKED_STREAK = 3;

/** 锁住之后的等级 */
export const LOCKED_LEVEL = 1;

/**
 * 阈值表：还剩几天 ⇒ 等级。**按 maxDays 升序**，第一个满足 `countdown <= maxDays` 的胜出。
 * ⚠️ 表里**故意没有等级 1** —— 1 是"连对 ≥ 3 锁定"那条路给的，不由天数决定。
 */
export const LEVEL_THRESHOLDS: readonly { maxDays: number; level: number }[] = [
    { maxDays: 1, level: 5 },
    { maxDays: 4, level: 4 },
    { maxDays: 7, level: 3 },
    { maxDays: 21, level: 2 },
];

/** 天数超阈值时（比如还剩 49 天）的兜底等级 */
export const LEVEL_BEYOND_MAX = 2;

/* ============================ 纯函数 ============================ */

/** 从事件序列数出"连对几次 / 连错几次"（从最近一次往前数，遇到反向就停） */
export function streaksOf(events: readonly string[]): { rightStreak: number; wrongStreak: number } {
    let rightStreak = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i] === 'right') rightStreak += 1;
        else break;
    }
    let wrongStreak = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i] === 'wrong') wrongStreak += 1;
        else break;
    }
    return { rightStreak, wrongStreak };
}

/** 这道题有没有"复习结果"（一次都没有 = 新题） */
export function hasEvidence(outcomes: unknown): boolean {
    return reviewEventSequence(outcomes).length > 0;
}

/**
 * **间隔表**：按"最近的对错"给出多少天后再练。
 * 这就是"记下复习结果时写进 `levelCountdown` 的那个数"。
 */
export function intervalForOutcomes(outcomes: unknown): number {
    const events = reviewEventSequence(outcomes);
    if (events.length === 0) return LEVEL_INTERVAL_DAYS.newOrManyWrong; // 新题
    const { rightStreak, wrongStreak } = streaksOf(events);
    if (wrongStreak >= 2) return LEVEL_INTERVAL_DAYS.newOrManyWrong;
    if (wrongStreak === 1) return LEVEL_INTERVAL_DAYS.oneWrong;
    if (rightStreak >= LOCKED_STREAK) return LEVEL_INTERVAL_DAYS.right3;
    if (rightStreak === 2) return LEVEL_INTERVAL_DAYS.right2;
    return LEVEL_INTERVAL_DAYS.right1; // rightStreak === 1
}

/**
 * **阈值表**：还剩几天 + 连对几次 ⇒ 等级。
 *
 * ⚠️ 连对 ≥ 3 **优先于**天数（"锁住"的意思就是不再按天数动）——
 *    这正是"等级 1 的倒数走完会变预掌握、而不会变 5"的原因。
 */
export function levelFromCountdown(countdown: number, rightStreak: number): number {
    if (rightStreak >= LOCKED_STREAK) return LOCKED_LEVEL;
    const c = Math.max(0, countdown);
    for (const t of LEVEL_THRESHOLDS) {
        if (c <= t.maxDays) return t.level;
    }
    return LEVEL_BEYOND_MAX;
}

/**
 * **预掌握**：等级 1（连对 ≥3 锁定）**且**倒数走到 0。
 *
 * ⚠️ **它是算出来的，不落库、不占 `masteryLevel` 的值** —— 空空 2026-10-15 定的
 *    （"0/1/2 一个都不动、迁移为零"）。跟"封印"（本已归档 + 未掌握）同一个思路：
 *    **能推出来就别存**。
 */
export function isPreMastered(attention: number | null | undefined, countdown: number | null | undefined): boolean {
    /**
     * ⚠️⚠️ **必须先挡住 null / undefined** —— 这是单测抓出来的一个真 bug：
     *    `Number(null) === 0`、`Number(undefined) === NaN`，而 `0 <= 0` 为真
     *    ⇒ 老数据（`levelCountdown` 还是 NULL）里凡是等级恰好是 1 的题，
     *      都会被误判成"预掌握"而**永远初始化不了**（结算时被当冻结跳过）。
     *    ⇒ 判据必须是"**倒数是一个真的数字**，且它 ≤ 0"。
     */
    if (countdown === null || countdown === undefined) return false;
    const c = Number(countdown);
    if (!Number.isFinite(c)) return false;
    return Number(attention) === LOCKED_LEVEL && c <= 0;
}

/** 倒数往前推 `daysElapsed` 天，**夹在 0，不下负数** */
export function advanceCountdown(countdown: number, daysElapsed: number): number {
    const c = Math.max(0, Math.trunc(countdown));
    const d = Math.max(0, Math.trunc(daysElapsed));
    return Math.max(0, c - d);
}

/* ============================ 结算 ============================ */

/** 结算要处理的一道题（**裁剪过的输入**，与库里那张宽表解耦） */
export interface SettleItem {
    id: string;
    /** 复习结果（`ErrorItem.reviewOutcomes` 原样） */
    reviewOutcomes?: unknown;
    /** 现有等级（`ErrorItem.attention`） */
    attention?: number | null;
    /** 现有倒数天数（`ErrorItem.levelCountdown`；null = 老数据没初始化） */
    levelCountdown?: number | null;
    /** 掌握状态（`ErrorItem.masteryLevel`；=2 即已掌握 ⇒ 冻结） */
    masteryLevel?: number | null;
    /** 所属错题本是否已归档（true ⇒ 冻结，即空空的"封印"） */
    notebookArchived?: boolean | null;
}

/** 结算后每道题的新值 */
export interface SettleChange {
    id: string;
    /** 新的倒数天数 */
    levelCountdown: number;
    /** 新的等级 */
    attention: number;
    /** 这次结算是不是**初始化**（老数据第一次补倒数） */
    initialized: boolean;
}

/**
 * 这道题现在**冻不冻结**（冻结 = 结算不碰它）。
 *
 * 三类冻结（`docs\14` §5.4 第 3 条）：
 *   ① **已掌握**（`masteryLevel === 2`）—— 用户点的，或"连对 4 次"自动给的；
 *   ② **预掌握**（等级 1 + 倒数 0）—— 系统算出来的中间态；
 *   ③ **归档本里的题** —— 空空的"封印"：本归档了就该保持归档那一刻的状态。
 *
 * ⚠️ 第 ③ 条最容易漏 —— 归档本里的题**本来就不在主库、不进任务卡**，
 *    但结算若不加这条判断，"重算"照样会把它们改活。
 */
export function isFrozen(item: SettleItem): boolean {
    if (Number(item.masteryLevel) >= 2) return true;
    if (item.notebookArchived) return true;
    if (isPreMastered(item.attention, item.levelCountdown)) return true;
    return false;
}

/**
 * **算出这次结算要改哪些题**（纯函数，不碰数据库）。
 *
 * @param items        候选题（调用方负责只取"未掌握 + 本未归档"的，这里再兜一层）
 * @param daysElapsed  `今天 − 上次结算日`（**减数**；≥ 1 才有意义）
 * @returns 只包含**值真的变了**的题 —— 没变的不要写库（省 IO，也让"批量提交"更快）
 *
 * ⚠️ 初始化：`levelCountdown === null` 的老数据，按"最近的对错"补一个间隔
 *    （等价于"假设刚复习完"）。**这是预期的一次性重算** —— 1-5 的语义变了，
 *    老值的含义已不存在（见迁移文件里的说明）。
 */
export function planSettlement(items: readonly SettleItem[], daysElapsed: number): SettleChange[] {
    const out: SettleChange[] = [];
    /** 减数合法才推进；**但"初始化"与天数无关**，减数为 0 时照样要补老数据 */
    const canAdvance = Number.isFinite(daysElapsed) && daysElapsed > 0;

    for (const it of items) {
        if (isFrozen(it)) continue;

        const events = reviewEventSequence(it.reviewOutcomes);
        const { rightStreak } = streaksOf(events);

        /**
         * ⚠️ **老数据初始化**：`levelCountdown === null` ⇒ 按"最近的对错"补一个间隔
         *    （等价于"假设刚复习完"）。这是**一次性**的，且**当次不再往下扣**
         *    —— 它的间隔是从今天起算的，不该顺手又减掉几天。
         *    这一步**不看减数**（减数为 0 时也要补），否则第一次结算什么都补不上。
         */
        if (it.levelCountdown === null || it.levelCountdown === undefined) {
            const after = Math.max(0, intervalForOutcomes(it.reviewOutcomes));
            out.push({
                id: it.id,
                levelCountdown: after,
                attention: levelFromCountdown(after, rightStreak),
                initialized: true,
            });
            continue;
        }

        if (!canAdvance) continue;

        const before = Math.max(0, Number(it.levelCountdown));
        const after = advanceCountdown(before, daysElapsed);
        const nextLevel = levelFromCountdown(after, rightStreak);
        const prevLevel = Number(it.attention);

        if (after === before && nextLevel === prevLevel) continue; // 没变，不写库

        out.push({ id: it.id, levelCountdown: after, attention: nextLevel, initialized: false });
    }
    return out;
}

/**
 * **记下复习结果时**要写的新值（不是结算，是"录入那一刻"）。
 *
 * 为什么录入时就要写等级，而不是等结算：规则是"**等级 = 由倒数 + 连对次数决定**"，
 * 若录入只写倒数、不改等级，库里就会出现"倒数是 7 但等级还是 5"这种**自相矛盾**的状态。
 * ⇒ 录入时**同时**把倒数与等级写对；结算只负责"时间往前推"。
 */
export function planAfterReview(outcomes: unknown): { levelCountdown: number; attention: number } {
    const events = reviewEventSequence(outcomes);
    const { rightStreak } = streaksOf(events);
    const levelCountdown = intervalForOutcomes(outcomes);
    return { levelCountdown, attention: levelFromCountdown(levelCountdown, rightStreak) };
}

/** 连对几次（给"连对 4 次 ⇒ 直接已掌握"那条规则用） */
export function rightStreakOf(outcomes: unknown): number {
    return streaksOf(reviewEventSequence(outcomes)).rightStreak;
}

/**
 * 【2026-10-15 新】**点一下"掌握开关"，应该变成哪个值**。
 *
 * 规则（空空 2026-10-15 定的点击规则，`docs\14` §4.3）：
 *   · 未掌握（0 / 1）⇒ **已掌握（2）**
 *   · 预掌握（等级1 + 倒数0）⇒ **已掌握（2）**（预掌握不给人工点，点就进已掌握）
 *   · 已掌握（2）⇒ **未掌握（0）**，并且服务端会给回 `4 抓紧 + 倒数 4 天`（见 `planAfterUnmaster`）
 *
 * ⚠️ 原来是 `masteryLevel > 0 ? 0 : 2` —— 那个写法在 `masteryLevel === 1`（复习中）时会
 *    **跑到 0 去**（等于"点一下没反应"）。虽然 `1` 这个值业务上从未被写入过
 *    （真真 2026-10-15 全仓查实），但判据本身是错的，顺手改对。
 *
 * ⚠️ **唯一实现**：错题卡 / 扫码面板 / 分析页三处都调它，别各写一遍。
 */
export function nextMasteryLevel(current: unknown): 0 | 2 {
    return Number(current) >= 2 ? 0 : 2;
}

/**
 * 【2026-10-15 新】**从"已掌握"改回"未掌握"时，给哪一档**。
 *
 * 空空 2026-10-15 定：*"用户再点击这个已掌握，则又变为未掌握，同时倒数 4 天转为 4 抓紧档"*
 * （他先写的是"倒数 7 天"，后更正为 **4 天** —— 因为按阈值表"≤4 天 ⇒ 4 档"，
 *   7 天会落在 3 档，与"转 4 抓紧"自相矛盾）。
 *
 * ⚠️ 为什么"退回去"要给一个档位而不是清空：他给的理由很实在 ——
 *   *"倒数日期为 0 了才会给'预掌握'，用户点击后才能成为'已掌握'，
 *     那么这个已掌握可能是有水分的，即看了一眼觉得会了就给'已掌握'了，
 *     再点回'未掌握'，那么很可能后续又什么时候做错了。"*
 *   ⇒ 所以退回来时**当成"刚做错过一次"**（间隔 4 天、4 抓紧），
 *     重新进入复习流程。这也顺手解决了"等级 1 期间做错了怎么办"——
 *     同一套规则，没有特例。
 */
export function planAfterUnmaster(): { levelCountdown: number; attention: number } {
    const levelCountdown = LEVEL_INTERVAL_DAYS.oneWrong;
    return { levelCountdown, attention: levelFromCountdown(levelCountdown, 0) };
}

/**
 * **连对 4 次 ⇒ 直接已掌握**（空空 2026-10-15 定：*"我们的目的就是 4 次已掌握"*）。
 *
 * ⚠️ 与"等级 1 的四个出口"配套：
 *    · 连对 3 次 ⇒ 锁等级 1（倒数 49 天）；
 *    · 这期间**又对一次**（连对 4 次）⇒ **直接已掌握**（不等 49 天走完）；
 *    · 这期间**做错** ⇒ 按间隔表回 4 抓紧（`planAfterReview` 天然算对）；
 *    · 什么都不做 ⇒ 49 天走完 ⇒ 预掌握 ⇒ 用户点一下 ⇒ 已掌握。
 */
export function shouldAutoMaster(outcomes: unknown): boolean {
    return rightStreakOf(outcomes) >= 4;
}
