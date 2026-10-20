/**
 * 【2026-10-13 他拍板的设计】**一道题现在该怎么处置** —— 由已有事实**算出来**，不落库。
 *
 * ══════════════════════════════════════════════════════════════════
 * 他要的东西（原话要点）
 *   "我正在放弃我一开始自己设计的思路，我想交给你来设计……
 *    如果把这个属性交给 AI，让 AI 来管理这些题的话，那么应该怎么利用这个属性进行管理，
 *    是添加一个字段、两个字段，还是更多？"
 *
 * ── 我的回答：**不添字段**（至少这一步不添）──────────────────────────
 *   他纠结的根源是"把一个**天天在变**的东西（孩子会不会）钉在了**题**上"，
 *   所以怎么定档都不对。而真相是：
 *     · 题上只该记**事实**（它是什么、发生过什么）—— 这些早就在库里了；
 *     · "会不会"每次**现算**，算出来的东西不落库 ⇒ 永不过期、不用人工维护。
 *
 *   ✅ 现成的事实（`ErrorItem.reviewOutcomes`，见 `lib/review-outcomes.ts`）：
 *      `{"planned":["right",null,null],"last":"wrong"}` = 计划内三次（第 1/7/21 天）+ 最近一次。
 *      扫码页那三态圆（✓/✗）已经在往里写 ⇒ **本模块一上线就有真数据可吃**。
 *   ✅ 本模块只做一件事：把这些事实折成 `状态 + 连对次数 + 紧迫度 + 建议下次`。
 *
 * ── 规则只有一条（他纠结的那几个"要不要降档"从此不用人判）──────────
 *   **对 ⇒ 连对 +1、间隔拉长；错 ⇒ 连对清零、明天再来。**
 *
 *   | 状态 | 怎么进来 | 建议下次 |
 *   |---|---|---|
 *   | 新     | 一条结果都没有 | 明天（= 原计划第 1 天）|
 *   | 要练   | 最近一次做错 | 明天 |
 *   | 复练中 | 连对 1–2 次 | 3 天 / 7 天 |
 *   | 退休   | 连对 ≥ `RETIRE_STREAK`（常量，**别在这儿抄数字**）| 不再排 |
 *
 *   ⚠️⚠️ 【2026-10-16 如如 更新：下面这段是"3 格时代"写的，先看这三条再看它】
 *      ① 纸面上**已加第 4 格**（2026-10-14），`RETIRE_STREAK` 常量**已从 3 改成 4**；
 *      ② 带时间戳的那张表（`ReviewEvent`）**已建好**，但四个前端写入点此前一处都没传
 *         ⇒ 一直是空表；**2026-10-16（`1a2f1b7`）才刚接通** ⇒ 要攒到数据还得等回录；
 *      ③ 所以下面"第 4 次认不出来"的结论**已经过时** —— 保留它是因为那段推理
 *         （"没有时间戳就分不开"）仍然是**为什么必须要有那张表**的最好说明。
 *
 *   ⚠️⚠️ 【原始记录（3 格时代）】为什么当时最上面只到 3、而不是先前说的 4；为什么"稳"这一档没了
 *      读到存储格式之后必须纠正的地方：`reviewOutcomes` 只有**两个**字段 ——
 *      `planned`（计划内三次）与 `last`（最近一次），**没有任何时间戳**，
 *      而且"计划内做完 ⇒ last 同步成同一个结果"（他 2026-09-30 定的规矩 ①）。
 *      ⇒ 「第 4 次也对」这件事**在这份数据里认不出来**：
 *         `planned=[对,对,对] + last=对` 既可能是"计划三次全对（共 3 次）"，
 *         也可能是"计划三次全对之后再计划外对了一次（共 4 次）"，**没有时间戳就分不开**。
 *      要真数到 4，得加一张**带时间戳的复习记录表**（已列入第二步：AI 打标之后的下一件）。
 *      在那之前：**门槛按 3 次**（他自己的原话里就有"如果三次都对了要不要标注这个题已掌握"，
 *      说明 3 次与他的直觉一致），代价是——**有可能会早一点退休**，
 *      这是"能跑起来"与"绝对不误判"之间必须选一个，我选前者并把它写在明面上。
 *      同时把原先那个"稳"档**去掉**：数据只支持 4 档，硬摆 5 档只会好看不实用。
 *
 *   ⚠️ 与既有的"1/7/21 天计划"是**两层，不打架**：那三个节点是**还没有结果时的默认计划**
 *      （界面上那三行日期仍然照它显示，出处见 `review-outcomes.ts`）；
 *      一旦有了结果，**间隔就由连对次数决定** —— 只有一份"什么时候再练"，
 *      不会出现"计划说第 21 天、状态说 3 天后"两个答案。
 *
 * ⚠️ **本模块不知道"上次复习是哪天"**：`reviewOutcomes` 里只有结果、没有时间戳
 *    （那是它 2026-09-30 定稿时的形状）。所以"建议下次"一律按**今天**起算 ——
 *    语义是"从现在起 N 天后再练"，诚实、也不需要瞎编一个日期。
 *    想要"到期日"真准，得另加一张**带时间戳的复习事件表**（已列入第二步）。
 *
 * ── 【2026-10-16 如如 更新：上面那句"得另加一张事件表"**已经做到了**】──────────
 *    `ReviewEvent` 表 2026-10-14 建好、2026-10-16 四个写入点接通（`1a2f1b7`）
 *    ⇒ **带时间戳的流水已经有了**；`ErrorItem.reviewOutcomes` 现在只是它的**派生缓存**。
 *    本文件仍在"按今天起算"（因为派生缓存里只有结果、没有日期），
 *    要精确到期日就查流水 —— 那属于 `docs\09` 第二步「切读源」，**还没做**。
 */

import { addDays, dayKey } from './calendar-grid';
import { normalizeRecentOutcomes, type ReviewOutcome } from './review-outcomes';

/**
 * 连对几次算"可以退休"（不再排进复练）。
 *
 * 他 2026-10-13 拍的是 **4**；当时因为存储形状只认得到 3，先按 3 让它能跑。
 * ✅ **2026-10-14 已改回 4** —— 带时间戳的复习事件表（`ReviewEvent`）上线后，
 *    "三格满了之后又对一次"**认得出来**了（写入侧显式声明那次复习，不靠差分猜）。
 *    配套：纸上也加了第 4 格（`REVIEW_OFFSETS_DAYS = [1, 7, 21, 49]`）。
 */
export const RETIRE_STREAK = 4;

/**
 * 连对 N 次之后，隔多少天再练一次。
 *
 * 索引 = 连对次数（0 起）：
 *   0 ⇒ 1 天（5 级：新题 / 连错≥2，明天再来）
 *   1 ⇒ 3 天（4 级：只错过一次）
 *   2 ⇒ 7 天（3 级：对了一次）
 *   3 ⇒ 14 天（2 级：连对两次）
 *   4 ⇒ 28 天（1 级：连对三次 ⇒ 锁定，28 天后再看一眼）
 *   5 及以上 ⇒ 退休（不再排）
 *
 * ⚠️ 这张表与上面的 `RETIRE_STREAK` 是**同一个设计的两半**：连对到 `RETIRE_STREAK` 就退休
 *    ⇒ 表要覆盖到 `RETIRE_STREAK - 1` 这一档。
 *
 * 【2026-10-21 空空】**整表改过一次，原因是"累加"**：
 *   旧：1 → 3 → 7 → 21，每次在上一次的基础上再加 ⇒ 一道一路做对的题要排到第 32 天，
 *       再加上纸上第 4 格 49 天就是第 81 天，"复习"被拖成遥遥无期。
 *   他的原话："不应该是累加 7 天、21 天、49 天，这个算法有问题。"
 *   ⇒ 新表是**固定的档位**（1 / 3 / 7 / 14 / 28），每一档独立，不相加：
 *       5 级 1 天 · 4 级 3 天 · 3 级 7 天 · 2 级 14 天 · 1 级 28 天
 *   连对 3 次 = 1 级（锁定 28 天）；`RETIRE_STREAK` 随之 4 → 5
 *   （否则连对三次就直接退休了，那 28 天这一档永远用不上）。
 */
export const LEVEL_INTERVAL_DAYS: Readonly<Record<number, number>> = {
    5: 1,  // 新题 / 连错 ≥2
    4: 3,  // 只错过一次（原来 4 天）
    3: 7,  // 对了一次
    2: 14, // 连对两次（原来 21 天）
    1: 28, // 连对三次 ⇒ 锁定（原来 49 天）
};

export type ReviewState = 'new' | 'due' | 'practicing' | 'retired';

export interface ReviewStatus {
    state: ReviewState;
    /** 连对次数（从最近一次往前数，遇到"错"就停） */
    rightStreak: number;
    /** 连错次数（同上，反着数） */
    wrongStreak: number;
    /**
     * **复习紧迫度 1–5**（5 最急、1 最不急）。
     * 这正好接上他原来那个 1–5 档的位置，但**由事实自动推出**，不再人工记账
     * ⇒ 顺带了结两笔旧账：「奖牌语义反转」（做错⇒更急，不是"升级当奖牌"）与
     *   「账本没人读」（这个数一算出来就有用：排"今天先练哪几道"）。
     */
    urgency: 1 | 2 | 3 | 4 | 5;
    /** 建议下次复练的日期（`YYYY-MM-DD`，按**今天**起算）；`null` = 退休，不再排 */
    nextDueKey: string | null;
    /** 一并记过几次结果（**证据条数** —— 显示判断时要把它一起亮出来，别让人以为很准） */
    evidenceCount: number;
}

/** 界面上的名字（中/英）—— 两处要用同一份，别各写一遍 */
export const REVIEW_STATE_LABELS: Record<ReviewState, { zh: string; en: string }> = {
    new: { zh: '新', en: 'New' },
    due: { zh: '要练', en: 'Due' },
    practicing: { zh: '复练中', en: 'Practicing' },
    retired: { zh: '退休', en: 'Retired' },
};

/** 【2026-10-16 如如】**整理**：把归一化后的"最近几次结果"直接当事件序列用。
 *
 * ⭐ 这是本轮（"流水为真相"，`docs\18` §3.2）**唯一的读源切换点** ——
 *    本文件下游（`reviewStatusOf` / `RETIRE_STREAK` / 紧迫度）以及
 *    `level-settle.ts` 的**全部**函数都经由它 ⇒ 改这一处，规则层全线跟上 ✓
 *
 * ── 换之前是什么样（留档，别删）────────────────────────────────────
 * 老实现从 `{planned,last}` 两个字段**拼**出一条序列："`planned` 里的非空按序 + `last`
 * （与最后一条不同才追加）"。那套拼接有两个毛病：
 *   ① `planned` 绑死"第 1/7/21/49 天"，**第 5 次及以后进不去**；
 *   ② **没有时间戳** ⇒ 「三格满了之后又对一次」与「三格全对」**数据上长得一样**，
 *      分不出来（当年 `RETIRE_STREAK` 只能取 3，就是这个原因）。
 * ⇒ 现在序列来自 `ErrorItem.reviewOutcomes` 的**新形状 `{recent:[…]}`**（派生缓存，
 *    由流水 `ReviewEvent` 算出来写回）；老形状仍然读得出来（`normalizeRecentOutcomes` 新旧都认）✓
 *
 * ⚠️ 新序列**最多 4 条**（派生时截断）⇒ 连对次数最多数到 4。
 *    够用，因为规则里"连对 ≥ 3 就锁 1 级" ⇒ **封顶在 3**（`docs\18` §十.1 已论证）。
 */
export function reviewEventSequence(outcomes: unknown): ReviewOutcome[] {
    return normalizeRecentOutcomes(outcomes);
}

/** 从事件序列算状态（纯函数，今天由调用方给，方便单测） */
export function reviewStatusOf(outcomes: unknown, today: Date = new Date()): ReviewStatus {
    const events = reviewEventSequence(outcomes);

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

    /** 状态（顺序即优先级：没结果 > 刚错 > 连对够多 > 其余） */
    let state: ReviewState;
    if (events.length === 0) state = 'new';
    else if (events[events.length - 1] === 'wrong') state = 'due';
    else if (rightStreak >= RETIRE_STREAK) state = 'retired';
    else state = 'practicing';

    /**
     * 紧迫度 1–5（**就是"能不能排序"的那个数**，不是奖牌）。
     *   5 = 新录入（还没练过，就是该练）／**连着错了两次以上**（那就不是偶然）
     *   4 = 最近一次错
     *   3 = 连对 1 次（还在巩固）
     *   2 = 连对 2 次（快稳了）
     *   1 = 退休
     * ⚠️ 单调递减 ⇒ 直接 `ORDER BY urgency DESC` 就是"今天先练哪几道"。
     */
    /**
     * 【2026-10-21 空空】**等级改成"五档各管一段"，与间隔表一一对应。**
     *   5 = 新 / 连错 ≥2      → 1 天
     *   4 = 只错过一次        → 3 天
     *   3 = 对了一次          → 7 天
     *   2 = 连对两次          → 14 天
     *   1 = 连对三次（锁定）  → 28 天
     * retired（连对四次）= 已掌握，不排。
     *
     * ⚠️ 以前 `practicing` 只分 "≥2 ⇒ 2" 两段，所以"连对三次"和"连对两次"同是 2 级，
     *    28 天那一档永远走不到。现在把 `rightStreak >= 3` 单独拎出来当 1 级。
     */
    let urgency: ReviewStatus['urgency'];
    if (state === 'retired') urgency = 1;
    else if (state === 'practicing') urgency = rightStreak >= 3 ? 1 : rightStreak === 2 ? 2 : 3;
    else if (state === 'new' || wrongStreak >= 2) urgency = 5;
    else urgency = 4;

    /** 建议下次：查上面那张间隔表；退休 = null（不再排） */
    /** 退休 = null（不再排）；其余按**等级**查表（不是按连对次数 —— 5 级和 4 级的连对次数都是 0，区分不开） */
    const offset = state === 'retired' ? null : LEVEL_INTERVAL_DAYS[urgency] ?? 1;

    return {
        state,
        rightStreak,
        wrongStreak,
        urgency,
        nextDueKey: offset === null || offset === undefined ? null : addDays(dayKey(today), offset),
        evidenceCount: events.length,
    };
}

/**
 * 一句话说明（界面直接显示）—— **必须把证据条数一起说出来**：
 * 只有一两次结果的判断不值得信（"别让人以为很准"是这个项目一直的规矩）。
 */
export function reviewStatusSentence(status: ReviewStatus, zh: boolean): string {
    const label = REVIEW_STATE_LABELS[status.state];
    const name = zh ? label.zh : label.en;
    const ev = zh ? `已有 ${status.evidenceCount} 次复练结果` : `${status.evidenceCount} result(s) so far`;
    if (status.state === 'retired') {
        return zh ? `${name}（连对 ${status.rightStreak} 次）—— 不必再排进复练。${ev}` : `${name} — no need to schedule it again. ${ev}`;
    }
    if (status.state === 'new') {
        return zh ? `${name} —— 还没复练过，建议尽快练一次。${ev}` : `${name} — not practiced yet. ${ev}`;
    }
    if (status.state === 'due') {
        return zh
            ? `${name}（${status.wrongStreak >= 2 ? `连错 ${status.wrongStreak} 次` : '上次做错'}）—— 建议明天再练。${ev}`
            : `${name} — practice again tomorrow. ${ev}`;
    }
    return zh
        ? `${name}（连对 ${status.rightStreak} 次）—— 建议 ${status.nextDueKey} 再练。${ev}`
        : `${name} — next review around ${status.nextDueKey}. ${ev}`;
}
