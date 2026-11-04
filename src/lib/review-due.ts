/**
 * 【2026-11-04 审计 P0-2】把"这道题到底该哪天练"从**假设**改成**事实**。
 *
 * ── 原来的错 ────────────────────────────────────────────────────
 *   `reviewStatusOf()` 算的 `nextDueKey = 今天 + 间隔` —— 间隔表最小是 1 天，
 *   所以它**永远 ≥ 明天**。用它判"逾期"（`dueKey < 今天`）永远不成立
 *   ⇒ 那个"逾期 N 道"的数字恒为 0，而它本该是最该被看到的一个数。
 *
 * ── 正确的口径 ──────────────────────────────────────────────────
 *   **排程和预测是两件事**：
 *   · 排程：保存/复习那一刻算出"下次哪天"，写进 `ReviewSchedule.scheduledFor`，**从此固定**；
 *   · 预测：读那个已经落库的日子。
 *   拿"今天 + 间隔"当预测，等于每天把全部题往后推一天 —— 图永远是漂亮的假图。
 *
 * ── 这个文件只管两件纯事 ────────────────────────────────────────
 *   ① 同一道题有多条未完成排程时，**取最早那条**（不是最新 —— 最新会把逾期的题藏起来）；
 *   ② 没有排程（新录的题从没练过）时，退回 `nextDueKey`（今天+间隔），这不算错。
 */

import { addDays, dayKey } from './calendar-grid';

/**
 * 从**最后一次真实复习**的日期往后推间隔 —— 这才是"该哪天练"的事实。
 *
 * ⚠️ 2026-11-04 真机库验完补的：原来想用 `ReviewSchedule.scheduledFor`，
 * **库里只有 2 条**（他几乎不走"详情页保存"那条路）⇒ 绝大多数题还是退回假设值。
 * 而 `ReviewEvent` 有 129 条，`occurredOn` 存的就是当天日键（客户端算好，不涉及时区）。
 *
 * @param lastOccurredOn 该题最后一条 ReviewEvent 的 `occurredOn`（`YYYY-MM-DD`）
 * @param intervalDays   `LEVEL_INTERVAL_DAYS[urgency]`；退休传 null
 * @returns 到期日键；任一项缺失 ⇒ null（调用方再退回别的来源）
 */
export function dueKeyFromHistory(
    lastOccurredOn: string | null | undefined,
    intervalDays: number | null | undefined,
): string | null {
    if (!lastOccurredOn || intervalDays === null || intervalDays === undefined) return null;
    return addDays(lastOccurredOn, intervalDays);
}

export interface OpenSchedule {
    errorItemId: string;
    scheduledFor: Date;
}

/**
 * 每道题**最早那条未完成排程**的日键。
 *
 * @param schedules 只应传 `completedAt IS NULL` 的行（查询侧过滤；这里不重复判）
 * @returns Map<errorItemId, 'YYYY-MM-DD'>
 */
export function earliestOpenDueKey(
    schedules: readonly OpenSchedule[],
): Map<string, string> {
    const out = new Map<string, string>();
    for (const s of schedules) {
        const key = dayKey(s.scheduledFor);
        const prev = out.get(s.errorItemId);
        /* 取最早的 —— 一条题可能因为几轮检查留下多条，最老的那条才是"欠账" */
        if (prev === undefined || key < prev) out.set(s.errorItemId, key);
    }
    return out;
}

/**
 * 这道题用来判逾期/画预测的日键：**有排程用排程，没有才退回假设值**。
 *
 * @param scheduledKey `earliestOpenDueKey()` 里查到的（可能没有）
 * @param fallbackNextDueKey `reviewStatusOf().nextDueKey`（今天+间隔；退休为 null）
 */
export function dueKeyFor(
    scheduledKey: string | undefined,
    fallbackNextDueKey: string | null,
): string | null {
    return scheduledKey ?? fallbackNextDueKey;
}
