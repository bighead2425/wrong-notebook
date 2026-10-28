/**
 * 复习排程的**落库形状** —— 把 `reviewStatusOf()` 算出来的"下次哪天"变成
 * `ReviewSchedule` 能存的一行。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 * 规则本身（间隔表、退休门槛、紧迫度）全在 `lib/review-status.ts`，
 * 这个项目里**只允许有一处**记着那套账。这里只做两件纯事：
 *   ① 把 `YYYY-MM-DD` 变成**当天中午**的时间戳（不是午夜）；
 *   ② 决定这一行算第几轮。
 *
 * ── 为什么是中午，不是 00:00 ─────────────────────────────────────────
 * `new Date(y, m-1, d)` 是**本地零点**。它一旦被序列化进库、再在别处按 UTC 读出来，
 * 就会掉到前一天（东八区 00:00 = UTC 前一天 16:00）。这种错很难看出来：
 * 到期日整整早一天，而且只在某些路径上出现。
 * 取**本地 12:00**，两侧各留 12 小时余量，怎么换算都不会跨日。
 */

import { dayKey, parseDayKey } from './calendar-grid';
import type { ReviewStatus } from './review-status';

export interface ScheduleRow {
    /** 存库用的到期时刻（本地 12:00） */
    dueAt: Date;
    /** 第几轮：1 = 首次深挖，2 = 第一次复练，3 = 第二次…… */
    round: number;
}

/** 轮次上限：只为挡住脏数据把 round 撑成天文数字（界面不显示它） */
const MAX_ROUND = 99;

/**
 * 由状态算出"下一行排程"。
 *
 * @param status         `reviewStatusOf()` 的结果
 * @param evidenceCount  已经记过几次结果（= 这是第几次之后的重排）
 * @returns 退休 / 没有下一日 ⇒ `null`（调用方据此**撤掉**未完成的排程）
 */
export function scheduleFromStatus(
    status: Pick<ReviewStatus, 'nextDueKey'>,
    evidenceCount: number,
): ScheduleRow | null {
    const key = status?.nextDueKey;
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;

    const dueAt = parseDayKey(key);
    /* ⚠️ 回写校验：`parseDayKey('2026-13-99')` 不会报错，它会**滚到 2027-04-09**。
       这种"能解析但不存在"的日期一旦落库，排程就悄悄错到几个月后。
       ⇒ 解析完再格式化回字符串，和原值不一致就当作脏数据。 */
    if (dayKey(dueAt) !== key) return null;
    /* 本地 12:00 —— 见文件头：零点跨时区会掉一天 */
    dueAt.setHours(12, 0, 0, 0);

    const n = Number.isFinite(evidenceCount) ? Math.floor(evidenceCount) : 0;
    const round = Math.min(MAX_ROUND, Math.max(1, n + 1));

    return { dueAt, round };
}

/**
 * 两条排程是不是**同一天**。
 *
 * 用途：录完一次结果后判断"日期其实没变" ⇒ 不写日志、不更新库。
 * 只比日、不比时分秒 —— 12:00 这个值是我们自己造的，比秒没有意义。
 */
export function sameScheduleDay(a: Date | null | undefined, b: Date | null | undefined): boolean {
    if (!a || !b) return a === b;
    return (
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate()
    );
}
