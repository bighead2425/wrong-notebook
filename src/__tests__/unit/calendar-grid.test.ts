import { describe, expect, it } from 'vitest';
import {
    addDays,
    buildMonths,
    countByDay,
    dayBoundsISO,
    dayKey,
    daysBetween,
    inDayRange,
    moveEndpoint,
    normalizeRange,
    parseDayKey,
    rangeBoundsISO,
} from '@/lib/calendar-grid';

/**
 * 日历纯逻辑。两条最容易被踩的坑，这里都钉住：
 *   ① `new Date('2026-09-30')` 按 **UTC** 解析 ⇒ 东八区会退成 9-29；
 *   ② 日界交给服务端算 ⇒ 容器在 UTC，"这一天"会偏 8 小时。
 *   所以：解析自己拆字段、比较走字符串、传给服务端的是**绝对时刻**。
 */
describe('日历 · 日期键', () => {
    it('★ 解析走本地时区，绝不被 UTC 带跑（9-30 就是 9-30）', () => {
        expect(parseDayKey('2026-09-30').getDate()).toBe(30);
        expect(parseDayKey('2026-09-30').getMonth()).toBe(8); // 0 基
        expect(dayKey(parseDayKey('2026-09-30'))).toBe('2026-09-30');
    });

    it('dayKey 取本地年月日；加减小数跨月跨年都对', () => {
        expect(dayKey(new Date(2026, 8, 30, 23, 59))).toBe('2026-09-30');
        expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
        expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    });
});

describe('日历 · 与服务端交接的时刻（不传"日子"，传绝对时刻）', () => {
    it('★ 一天 = [本地当天 00:00, 次日 00:00)，时长恰好 24 小时', () => {
        const { start, end } = dayBoundsISO('2026-09-30');
        expect(new Date(end).getTime() - new Date(start).getTime()).toBe(24 * 3600 * 1000);
        expect(start).toBe(parseDayKey('2026-09-30').toISOString());
    });

    it('区间端点：起=首日 00:00，止=末日**次日** 00:00（含末日整天，交给 gte/lt 判断）', () => {
        const a = rangeBoundsISO('2026-09-10', '2026-09-12');
        expect(a.start).toBe(parseDayKey('2026-09-10').toISOString());
        expect(a.end).toBe(parseDayKey('2026-09-13').toISOString());
        // 起止反过来也给同一个区间（谁前谁后都行）
        expect(rangeBoundsISO('2026-09-12', '2026-09-10')).toEqual(a);
    });
});

describe('日历 · 区间与端点', () => {
    it('normalizeRange 不挑顺序；inDayRange 含首尾', () => {
        expect(normalizeRange('2026-09-20', '2026-09-10')).toEqual({ from: '2026-09-10', to: '2026-09-20' });
        expect(inDayRange('2026-09-10', '2026-09-10', '2026-09-20')).toBe(true);
        expect(inDayRange('2026-09-20', '2026-09-10', '2026-09-20')).toBe(true);
        expect(inDayRange('2026-09-21', '2026-09-10', '2026-09-20')).toBe(false);
    });

    it('★ 拖端点：拖过头就自动互换（区间永远成立，不会出现 from>to）', () => {
        const base = { from: '2026-09-10', to: '2026-09-20' };
        expect(moveEndpoint(base, 'to', '2026-09-25')).toEqual({ from: '2026-09-10', to: '2026-09-25' });
        const crossed = moveEndpoint(base, 'to', '2026-09-05');
        expect(normalizeRange(crossed.from, crossed.to)).toEqual({ from: '2026-09-05', to: '2026-09-10' });
    });

    it('daysBetween 含首尾', () => {
        expect(daysBetween('2026-09-10', '2026-09-12')).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
        expect(daysBetween('2026-09-12', '2026-09-12')).toEqual(['2026-09-12']);
    });
});

describe('日历 · 月历网格', () => {
    const months = buildMonths('2026-09-01', '2026-09-30');

    it('一个月一组，标题形如 2026年9月', () => {
        expect(months).toHaveLength(1);
        expect(months[0].title).toBe('2026年9月');
    });

    it('★ 每周 7 格、周日开头（与他给的日历截图一致）', () => {
        for (const w of months[0].weeks) expect(w).toHaveLength(7);
    });

    it('★ 月初补上月尾巴、月末补下月开头（都标 inMonth=false）', () => {
        // 2026-09-01 是周二 ⇒ 首行是 [8/30(日), 8/31, 9/1, 9/2, 9/3, 9/4, 9/5]
        const first = months[0].weeks[0];
        expect(first[0].key).toBe('2026-08-30');
        expect(first[0].inMonth).toBe(false);
        expect(first[2].key).toBe('2026-09-01');
        expect(first[2].inMonth).toBe(true);
    });

    it('本月每一天都在，且只出现一次', () => {
        const inMonth = months[0].weeks.flat().filter((d) => d.inMonth);
        expect(inMonth).toHaveLength(30);
        expect(new Set(inMonth.map((d) => d.key)).size).toBe(30);
        expect(inMonth[0].key).toBe('2026-09-01');
        expect(inMonth[29].key).toBe('2026-09-30');
    });

    it('跨多月：从 8 月到 10 月给三组，且连续', () => {
        const list = buildMonths('2026-08-15', '2026-10-02');
        expect(list.map((m) => m.title)).toEqual(['2026年8月', '2026年9月', '2026年10月']);
    });
});

describe('日历 · 按天汇总录入量', () => {
    it('★ 按**本地**日期归组（与列表卡片上的 MM/dd 同源）', () => {
        const stamps = [
            new Date(2026, 8, 30, 9, 0),
            new Date(2026, 8, 30, 23, 30),
            new Date(2026, 8, 29, 1, 0),
        ];
        expect(countByDay(stamps)).toEqual({ '2026-09-30': 2, '2026-09-29': 1 });
    });

    it('ISO 字符串 / 脏值：脏值直接跳过，不抛', () => {
        const iso = new Date(2026, 8, 30, 9, 0).toISOString();
        expect(countByDay([iso, 'not-a-date'])).toEqual({ '2026-09-30': 1 });
    });
});
