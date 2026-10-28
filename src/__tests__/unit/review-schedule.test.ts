import { describe, expect, it } from 'vitest';
import { sameScheduleDay, scheduleFromStatus } from '@/lib/review-schedule';

/**
 * 排程落库的**形状**。
 *
 * 这套断言看着琐碎，但每一条都对着一个会静默出错的地方：
 *   · 到期时刻必须是**本地 12:00**（零点跨时区会掉一整天，且只在某些路径上出现）；
 *   · 轮次要**从 1 起**并夹住上限（脏数据不能把 round 撑爆）；
 *   · 退休 ⇒ null（调用方据此撤掉未完成的排程，而不是排到几百年后）。
 */
describe('scheduleFromStatus', () => {
    it('到期日 → 当天本地 12:00，不是零点', () => {
        const row = scheduleFromStatus({ nextDueKey: '2026-10-29' }, 0);
        expect(row).not.toBeNull();
        expect(row!.dueAt.getFullYear()).toBe(2026);
        expect(row!.dueAt.getMonth()).toBe(9); // 0-based
        expect(row!.dueAt.getDate()).toBe(29);
        expect(row!.dueAt.getHours()).toBe(12);
        expect(row!.dueAt.getMinutes()).toBe(0);
    });

    it('轮次从 1 起：第 0 条证据 ⇒ 第 1 轮', () => {
        expect(scheduleFromStatus({ nextDueKey: '2026-10-29' }, 0)!.round).toBe(1);
        expect(scheduleFromStatus({ nextDueKey: '2026-10-29' }, 1)!.round).toBe(2);
        /* 【2026-10-28】schema 只定义了 1/2/3 三轮 ⇒ 第四次以后一律记 3 */
        expect(scheduleFromStatus({ nextDueKey: '2026-10-29' }, 3)!.round).toBe(3);
        expect(scheduleFromStatus({ nextDueKey: '2026-10-29' }, 8)!.round).toBe(3);
    });

    it('轮次被夹在 1..99（负数 / 小数 / NaN 都不会传出去）', () => {
        expect(scheduleFromStatus({ nextDueKey: '2026-10-29' }, -5)!.round).toBe(1);
        expect(scheduleFromStatus({ nextDueKey: '2026-10-29' }, 2.7)!.round).toBe(3);
        expect(scheduleFromStatus({ nextDueKey: '2026-10-29' }, Number.NaN)!.round).toBe(1);
        expect(scheduleFromStatus({ nextDueKey: '2026-10-29' }, 5000)!.round).toBe(3);
    });

    it('退休 / 没有下一日 / 脏日期 ⇒ null（不排，而不是排到一个假日期）', () => {
        expect(scheduleFromStatus({ nextDueKey: null }, 2)).toBeNull();
        expect(scheduleFromStatus({}, 2)).toBeNull();
        expect(scheduleFromStatus({ nextDueKey: '2026-13-99' }, 2)).toBeNull();
        expect(scheduleFromStatus({ nextDueKey: 'tomorrow' }, 2)).toBeNull();
    });
});

describe('sameScheduleDay', () => {
    it('同一天、不同时刻 ⇒ 算同一天（我们只关心日期）', () => {
        expect(sameScheduleDay(new Date(2026, 9, 29, 0, 0), new Date(2026, 9, 29, 12, 0))).toBe(true);
    });

    it('差一天 / 差一小时但跨日 ⇒ 不是同一天', () => {
        expect(sameScheduleDay(new Date(2026, 9, 29, 23, 0), new Date(2026, 9, 30, 1, 0))).toBe(false);
    });

    it('两边都空 / 一边空 ⇒ 只有"都空"算相同', () => {
        expect(sameScheduleDay(null, null)).toBe(true);
        expect(sameScheduleDay(null, new Date())).toBe(false);
        expect(sameScheduleDay(new Date(), undefined)).toBe(false);
    });
});
