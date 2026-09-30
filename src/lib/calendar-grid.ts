/**
 * 【2026-09-30】日历的**纯逻辑**（错题本页「其他日期」那个月历用）。
 *
 * ── 为什么日期一律用 `YYYY-MM-DD` 字符串当"日子" ────────────────────
 *   `new Date('2026-09-30')` 会被**按 UTC 解析**，在东八区会退成 9-29 的 08:00，
 *   于是"点 9-30 却筛出了 9-29 的题"。所以本文件里：解析一律**自己拆字段**造本地日期，
 *   比较一律走字符串（`YYYY-MM-DD` 定长字典序 = 时间序）。
 *
 * ── 与服务端的交接：**不传"日子"，传时间戳** ──────────────────────
 *   容器跑在 UTC（Dockerfile 里没设 TZ），服务端自己算"这一天"会偏 8 小时。
 *   所以客户端用 `dayBoundsISO()` 把本地日界换算成**绝对时刻**再传过去，
 *   服务端只做 `gte/lt` 比较 ⇒ 时区在链路上彻底不参与判断。
 *
 * ⚠️ 归属"哪一天"以**浏览器本地时区**为准（跟列表卡片上显示的 MM/dd 同源）
 *    —— 这才不会出现"卡片显示 9-30、日历算成 9-29"这种自己打自己的事。
 */

/** 本地时区下的 `YYYY-MM-DD` */
export function dayKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` → **本地**当天 00:00（绝不走 `new Date(string)`，那会按 UTC 解析） */
export function parseDayKey(key: string): Date {
    const [y, m, d] = key.split('-').map((v) => parseInt(v, 10));
    return new Date(y, (m || 1) - 1, d || 1);
}

/** 加减天数，返回新的 day key */
export function addDays(key: string, delta: number): string {
    const d = parseDayKey(key);
    d.setDate(d.getDate() + delta);
    return dayKey(d);
}

/** 本地某天的 `[00:00, 次日00:00)` 转成 ISO 时刻（给服务端做精确比较用） */
export function dayBoundsISO(key: string): { start: string; end: string } {
    const start = parseDayKey(key);
    const end = parseDayKey(addDays(key, 1));
    return { start: start.toISOString(), end: end.toISOString() };
}

/** 一段时间（含首尾两天）的 `[起, 止次日)` ISO 时刻 */
export function rangeBoundsISO(fromKey: string, toKey: string): { start: string; end: string } {
    const a = fromKey <= toKey ? fromKey : toKey;
    const b = fromKey <= toKey ? toKey : fromKey;
    return { start: parseDayKey(a).toISOString(), end: parseDayKey(addDays(b, 1)).toISOString() };
}

/** 日期区间规范化（谁前谁后都行） */
export function normalizeRange(a: string, b: string): { from: string; to: string } {
    return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** 某天是否落在区间内（含首尾） */
export function inDayRange(key: string, from: string, to: string): boolean {
    const { from: f, to: t } = normalizeRange(from, to);
    return key >= f && key <= t;
}

/** 拖端点：把区间的一头挪到新日期（越过另一头也没关系 —— 端点互换，区间照样成立） */
export function moveEndpoint(
    range: { from: string; to: string },
    which: 'from' | 'to',
    target: string,
): { from: string; to: string } {
    return which === 'from' ? { from: target, to: range.to } : { from: range.from, to: target };
}

/** 一段时间的**所有**日期（含首尾） */
export function daysBetween(from: string, to: string): string[] {
    const { from: f, to: t } = normalizeRange(from, to);
    const out: string[] = [];
    let cur = f;
    // 防呆：最多 5 年，避免脏数据把浏览器卡死
    for (let i = 0; i < 366 * 5; i++) {
        out.push(cur);
        if (cur === t) break;
        cur = addDays(cur, 1);
    }
    return out;
}

export interface CalDay {
    /** `YYYY-MM-DD` */
    key: string;
    /** 这个月里的日号（1-31） */
    day: number;
    /** 是不是本月（补位的上下月日子 = false，画成浅灰） */
    inMonth: boolean;
}

export interface CalMonth {
    year: number;
    /** 1-12 */
    month: number;
    title: string;
    /** 按周分行，每行 7 天（**周日开头**，与他给的日历截图一致） */
    weeks: CalDay[][];
}

/** 月份标题：`2026年9月` */
export function monthTitle(year: number, month: number): string {
    return `${year}年${month}月`;
}

/**
 * 生成从 `fromKey` 所在月到 `toKey` 所在月的**连续月历**（一个月一组，上下排布）。
 * 每周 7 格、周日开头；月初/月末用相邻月的日子补满整行（灰显）。
 */
export function buildMonths(fromKey: string, toKey: string): CalMonth[] {
    const a = parseDayKey(fromKey);
    const b = parseDayKey(toKey);
    const startYear = a.getFullYear();
    const startMonth = a.getMonth();
    const endYear = b.getFullYear();
    const endMonth = b.getMonth();

    const months: CalMonth[] = [];
    let y = startYear;
    let m = startMonth;
    // 防呆同上：最多 5 年
    for (let guard = 0; guard < 60; guard++) {
        const first = new Date(y, m, 1);
        const lastDay = new Date(y, m + 1, 0).getDate();
        // 本月 1 号是周几（0=周日）
        const lead = first.getDay();

        const cells: CalDay[] = [];
        // 前面补上个月的尾巴
        for (let i = lead; i > 0; i--) {
            const d = new Date(y, m, 1 - i);
            cells.push({ key: dayKey(d), day: d.getDate(), inMonth: false });
        }
        // 本月
        for (let d = 1; d <= lastDay; d++) {
            cells.push({ key: dayKey(new Date(y, m, d)), day: d, inMonth: true });
        }
        // 补齐整行
        while (cells.length % 7 !== 0) {
            const d = new Date(y, m, lastDay + (cells.length - lead - lastDay) + 1);
            cells.push({ key: dayKey(d), day: d.getDate(), inMonth: false });
        }

        const weeks: CalDay[][] = [];
        for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

        months.push({ year: y, month: m + 1, title: monthTitle(y, m + 1), weeks });

        if (y === endYear && m === endMonth) break;
        m += 1;
        if (m > 11) {
            m = 0;
            y += 1;
        }
    }
    return months;
}

/**
 * 把"一串录入时刻"按**本地日期**汇总成 `{ 'YYYY-MM-DD': 条数 }`。
 *
 * 为什么在客户端汇总：容器在 UTC，服务端分"天"会偏 8 小时；
 * 浏览器本地时区与列表卡片上显示的 `MM/dd` 同源 ⇒ 只在客户端算才不会自相矛盾。
 */
export function countByDay(stamps: readonly (string | Date)[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of stamps) {
        const d = typeof s === 'string' ? new Date(s) : s;
        if (Number.isNaN(d.getTime())) continue;
        const k = dayKey(d);
        out[k] = (out[k] ?? 0) + 1;
    }
    return out;
}
