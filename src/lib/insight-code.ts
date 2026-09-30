/**
 * 【2026-10-01】日积月累条目的**编号**：`JL` + `yyyymmdd` + 三位当日流水（001 起）。
 *
 * 他定的规则（原话）："每一个条目按照 JLyyyymmddxxx 记录编号，是其中 yyyymmdd 是日期编号，
 * xxx 是当日流水号从 001 开始记录"。例：`JL20260930001`。
 *
 * ── 两条容易踩的地方 ────────────────────────────────────────────────
 *  ① **日期段按本地日期算**（`YYYY-MM-DD` 由客户端给）。容器跑在 UTC，
 *     服务端自己取 `new Date()` 分天会偏 8 小时 —— 半夜录的条目会跑到前一天去。
 *     这与全项目那条时区铁律一致（见 `calendar-grid.ts` 的文件头）。
 *  ② 流水号**服务端发**（"这个日期段里已有几条 + 1"）：客户端发号会在两台设备上撞号。
 *     唯一约束 `@@unique([userId, dateKey, seq])` 是最后一道保险。
 *
 * 本模块是纯函数：不碰数据库、不碰 DOM。
 */

export const INSIGHT_CODE_PREFIX = 'JL';

/** 流水号位数（001 … 999；超过 999 就让它自然变成四位，不截断 —— 宁可编号变长也不重号） */
const SEQ_WIDTH = 3;

/** 编号里的日期段：把 `YYYY-MM-DD` 压成 `YYYYMMDD` */
export function compactDateKey(dateKey: string): string {
    return dateKey.replace(/-/g, '');
}

/** `YYYYMMDD` 还原成 `YYYY-MM-DD`（解析不出就返回空串，不猜） */
export function expandDateKey(compact: string): string {
    if (!/^\d{8}$/.test(compact)) return '';
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/** 生成编号：`JL` + 日期 + 三位流水 */
export function formatInsightCode(dateKey: string, seq: number): string {
    const n = Math.max(1, Math.round(Number(seq) || 1));
    return `${INSIGHT_CODE_PREFIX}${compactDateKey(dateKey)}${String(n).padStart(SEQ_WIDTH, '0')}`;
}

/**
 * 下一个流水号：给定"这个日期段里已用掉的最大流水号"，返回下一个。
 * 没有任何记录 ⇒ 1（也就是 001）。
 */
export function nextInsightSeq(maxUsed: number | null | undefined): number {
    const n = Number(maxUsed);
    if (!Number.isFinite(n) || n < 0) return 1;
    return Math.round(n) + 1;
}

/** 认一个编号，拆出日期段与流水号；不是这个格式就返回 null（不猜） */
export function parseInsightCode(code: unknown): { dateKey: string; seq: number } | null {
    if (typeof code !== 'string') return null;
    const m = /^JL(\d{8})(\d{3,})$/.exec(code.trim().toUpperCase());
    if (!m) return null;
    const dateKey = expandDateKey(m[1]);
    if (!dateKey) return null;
    return { dateKey, seq: parseInt(m[2], 10) };
}

export function isInsightCode(code: unknown): boolean {
    return parseInsightCode(code) !== null;
}
