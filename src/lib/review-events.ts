/**
 * 【2026-10-14】复习事件流水 —— 把"复习成绩卡片"换成"流水账"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 背景（详见 `docs\09_review_events改造方案.md`）
 *
 *   老的 `ErrorItem.reviewOutcomes` 是**一张只有四个空格的卡片**：
 *     `{"planned":["right",null,null],"last":"wrong"}`
 *     —— `planned[3]`（第 1/7/21 天三次计划复习）+ `last`（最近一次），
 *        **只有结果、没有日期**。
 *
 *   ⇒ 两个后遗症（都在 `review-status.ts` 的文件头里写着）：
 *     ① **不知道"上次复习是哪天"** ⇒ "建议下次"只能按**今天**起算，
 *        算不出真正的"到期日"；
 *     ② **三个格满了之后再来一次就认不出来** ⇒ `RETIRE_STREAK` 只能取 3
 *        （原本想要 4）。
 *
 *   本模块把"卡片"换成"**流水账**"：一次复习一行，**行数不限、每行带日期**。
 *
 * ── 第一步只做「双写」──────────────────────────────────────────────
 *   `ErrorItem.reviewOutcomes` **照旧写**（读侧一行不动）⇒ 行为零变化、随时可回滚。
 *   本表只是**开始攒带时间戳的数据**。切读源是第二步的事。
 *
 * ── ⚠️ 三条纪律 ────────────────────────────────────────────────────
 *   1. **唯一写入口**：所有写入点都必须走 `recordReviewEvent`，
 *      别处不许直接 `prisma.reviewEvent.create`（同"新写入口必须复用同一个 sink"那条）。
 *   2. **写入侧必须显式声明**"这是一次复习" —— 从 `reviewOutcomes` 的前后差分
 *      **推不出来**（三格满了之后又对一次，与三格全对长得一模一样）。
 *      ⇒ 所以 API 收的是 `reviewEvent` 字段，而不是靠对比猜。
 *   3. **`occurredOn` 是 `YYYY-MM-DD` 字符串**，不是 `Date` —— 遵守"时区铁律"：
 *      容器跑 UTC，"哪一天"必须由**客户端**算好再传进来（`dayKey()`）。
 */

import { prisma } from './prisma';
import { isReviewOutcome, type ReviewOutcome } from './review-outcomes';

/** 一次复习的输入（写入侧显式声明的那份数据） */
export interface ReviewEventInput {
    /** 这一天的日键（`YYYY-MM-DD`）—— **本地时区**，由客户端算好 */
    occurredOn: string;
    outcome: ReviewOutcome;
    /** 计划内第几次（0/1/2/3）；`null` 或不传 = **计划外**的额外复习 */
    plannedIndex?: number | null;
    /** 从哪张卷标回来的（可空） */
    volumeId?: string | null;
}

/** 日键格式：`YYYY-MM-DD`（只认形状，不做日历校验 —— 形状不对就当没传） */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验外部传进来的 `reviewEvent`。
 *
 * 形状不对就返回 `null` ⇒ 调用方**当没传**处理。
 * 与项目里 `cropRegions` / `reviewOutcomes` 同一条规矩：
 * **不因为一个可选字段形状不对就拒掉整条更新**。
 */
export function parseReviewEventInput(value: unknown): ReviewEventInput | null {
    if (!value || typeof value !== 'object') return null;
    const o = value as Record<string, unknown>;

    if (typeof o.occurredOn !== 'string' || !DAY_KEY_RE.test(o.occurredOn)) return null;
    if (!isReviewOutcome(o.outcome)) return null;

    const plannedIndex =
        typeof o.plannedIndex === 'number' && Number.isInteger(o.plannedIndex) && o.plannedIndex >= 0
            ? o.plannedIndex
            : null;

    const volumeId = typeof o.volumeId === 'string' && o.volumeId.trim() ? o.volumeId : null;

    return { occurredOn: o.occurredOn, outcome: o.outcome, plannedIndex, volumeId };
}

/** 记一条复习流水 —— **唯一写入口** */
export async function recordReviewEvent(args: {
    userId: string;
    errorItemId: string;
    occurredOn: string;
    outcome: ReviewOutcome;
    plannedIndex?: number | null;
    volumeId?: string | null;
}): Promise<void> {
    await prisma.reviewEvent.create({
        data: {
            userId: args.userId,
            errorItemId: args.errorItemId,
            occurredOn: args.occurredOn,
            outcome: args.outcome,
            plannedIndex: args.plannedIndex ?? null,
            volumeId: args.volumeId ?? null,
        },
    });
}

/** 某道题的事件流（按日期升序；同一天按入库先后）—— 第二步切读源时用它 */
export async function listReviewEvents(userId: string, errorItemId: string) {
    return prisma.reviewEvent.findMany({
        where: { userId, errorItemId },
        orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
    });
}

/**
 * 连对次数（从最后一条往前数，遇到"错"就停）。
 * 带时间戳 ⇒ **不限次数**，这正是老数据做不到的那件事。
 */
export function rightStreakOf(events: readonly { outcome: string }[]): number {
    let n = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].outcome === 'right') n += 1;
        else break;
    }
    return n;
}

/** 最后一次复习的日期（`YYYY-MM-DD`）；没有事件 ⇒ `null` */
export function lastReviewDay(events: readonly { occurredOn: string }[]): string | null {
    return events.length ? events[events.length - 1].occurredOn : null;
}
