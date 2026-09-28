/**
 * 卷号（复练卷 RE… / 积累卷 BU…）—— 纯函数，可单测。
 *
 * ── 他定的格式（2026-09-28）──────────────────────────────────────
 *   卷号 = 代号 + 日期 + 当日序号     例：`RE20260926001`
 *   页号 = 卷号 + `-` + 两位页码      例：`RE20260926001-01`
 *   代号：**RE** = review（复练）、**BU** = build up（积累）。
 *
 * 二维码里放的就是**页号**（不是题号）——因为复练/积累纸是"卷"，
 * 扫任何一页都该打开**整卷**并定位到**这一页**，所以页码必须进码里。
 *
 * ── 为什么单独一个模块 ───────────────────────────────────────────
 * 卷号会被至少四处用到：生成（组卷）、渲染（页眉）、解析（扫码）、
 * 排序（卷列表）。**拼法与解析只允许一处实现** —— 两处各写一遍，
 * 迟早出现"生成的是 RE…-01、解析按 RE…-1 找不着"这种查不出来的错。
 *
 * 本模块不碰 DOM、不碰数据库、不碰时区（日期一律按**本地时间**取年月日，
 * 因为"2026年9月26日组的第一张卷"讲的是用户那天，不是 UTC 那天）。
 */

/** 卷的两类（T2 复练 / T3 积累） */
export type VolumeKind = 'review' | 'build';

export const VOLUME_KINDS: readonly VolumeKind[] = ['review', 'build'];

/** 代号：RE = review、BU = build up */
export const VOLUME_KIND_PREFIX: Record<VolumeKind, string> = {
    review: 'RE',
    build: 'BU',
};

/** 人话名字（页眉那个阳文框里的字就是它） */
export const VOLUME_KIND_LABEL: Record<VolumeKind, string> = {
    review: '复练',
    build: '积累',
};

/** 英文（页眉双语用；不印在纸上，留给将来的英文版面） */
export const VOLUME_KIND_LABEL_EN: Record<VolumeKind, string> = {
    review: 'Review',
    build: 'Build-up',
};

/**
 * 阳文框的颜色（框 + 字同色，底为白）。
 * 复练 = **暗红**、积累 = **深绿**（他指定的）。
 * ⚠️ 这两种颜色是**区分"卷"与"纸"**的关键：深挖纸是**实底 + 白字**，
 *    卷是**阳文（白底、彩框彩字）**—— 印刷时底不上色，省墨也更清爽。
 */
export const VOLUME_KIND_COLOR: Record<VolumeKind, string> = {
    review: '#8e2b2b',
    build: '#1f5c3a',
};

/** 代号 → 类型；认不出返回 null（不猜） */
export function volumeKindFromPrefix(prefix: string | null | undefined): VolumeKind | null {
    const p = (prefix ?? '').trim().toUpperCase();
    for (const k of VOLUME_KINDS) {
        if (VOLUME_KIND_PREFIX[k] === p) return k;
    }
    return null;
}

/** 左补零（`7, 3` → `007`） */
export function pad(n: number, width: number): string {
    const s = String(Math.max(0, Math.trunc(n)));
    return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/**
 * 取**本地**年月日拼成 `YYYYMMDD`。
 * ⚠️ 不用 `toISOString()`：那是 UTC，晚上 8 点之后会变成"明天"，
 *    卷号就会与用户看到的日期差一天。
 */
export function stampYmd(date: Date): string {
    return `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
}

/** 印刷日期（页眉「印于 YYYY-MM-DD」） */
export function stampReadable(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/**
 * 学期（他要"按学期分库"）。
 *
 * 口径（中国学年，够用且不折腾）：
 *   · 9–12 月 ⇒ 当年**秋季**学期
 *   · 1–2 月  ⇒ 往年**秋季**学期（寒假还在秋季学期里）
 *   · 3–8 月  ⇒ 当年**春季**学期
 *
 * ⚠️ 用它做**筛选/归档的标签**，不要拿它当主键 ——
 *    真实需求是"翻某学期的卷"，一个字段就够，不需要真的建多张表。
 */
export function semesterOf(date: Date): string {
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    if (m >= 9) return `${y}-秋`;
    if (m <= 2) return `${y - 1}-秋`;
    return `${y}-春`;
}

/* ------------------------------ 卷号 ------------------------------ */

export interface ParsedVolumeNo {
    kind: VolumeKind;
    /** 组卷日（本地日）YYYYMMDD */
    ymd: string;
    /** 当日序号（1 起） */
    seq: number;
    /** 原样卷号 */
    volumeNo: string;
}

/** 组卷号：`buildVolumeNo('review', 2026-09-26, 1)` → `RE20260926001` */
export function buildVolumeNo(kind: VolumeKind, date: Date, seq: number): string {
    return `${VOLUME_KIND_PREFIX[kind]}${stampYmd(date)}${pad(seq, 3)}`;
}

/** 解析卷号；格式不对返回 null（**不猜**，让调用方明确报"这不是卷号"） */
export function parseVolumeNo(no: string | null | undefined): ParsedVolumeNo | null {
    const s = (no ?? '').trim().toUpperCase();
    const m = /^([A-Z]{2})(\d{8})(\d{1,})$/.exec(s);
    if (!m) return null;
    const kind = volumeKindFromPrefix(m[1]);
    if (!kind) return null;
    const seq = Number(m[3]);
    if (!Number.isFinite(seq) || seq <= 0) return null;
    return { kind, ymd: m[2], seq, volumeNo: s };
}

/* ------------------------------ 页号 ------------------------------ */

/** 组页号：`buildPageCode('RE20260926001', 1)` → `RE20260926001-01` */
export function buildPageCode(volumeNo: string, pageNo: number): string {
    return `${volumeNo}-${pad(pageNo, 2)}`;
}

export interface ParsedPageCode extends ParsedVolumeNo {
    /** 1 起的页码 */
    pageNo: number;
    /** 原样页号 */
    pageCode: string;
}

/**
 * 解析页号。**这是扫码入口要用的那一支**：
 * 扫到的可能是页号（复练/积累纸），也可能是裸题号（深挖纸）——
 * 由调用方先试 `parsePageCode`、再试题号，两条路互不干扰。
 */
export function parsePageCode(code: string | null | undefined): ParsedPageCode | null {
    const s = (code ?? '').trim().toUpperCase();
    const m = /^(.+)-(\d{1,3})$/.exec(s);
    if (!m) return null;
    const base = parseVolumeNo(m[1]);
    if (!base) return null;
    const pageNo = Number(m[2]);
    if (!Number.isFinite(pageNo) || pageNo <= 0) return null;
    return { ...base, pageNo, pageCode: s };
}

/* ---------------------------- 当日序号 ---------------------------- */

/**
 * 下一个当日序号：给**同日同类型**的已有卷号列表，返回 max+1。
 *
 * ⚠️ 只认"同一天同类型"的；隔天的卷不参与（`RE20260926001` 与
 *    `RE20260927001` 是两天各第一张）。列表里格式不对的直接忽略，
 *    不让一条脏数据把序号顶到天上去。
 */
export function nextVolumeSeq(
    existingNos: readonly (string | null | undefined)[],
    kind: VolumeKind,
    date: Date,
): number {
    const ymd = stampYmd(date);
    let max = 0;
    for (const raw of existingNos) {
        const p = parseVolumeNo(raw);
        if (!p || p.kind !== kind || p.ymd !== ymd) continue;
        if (p.seq > max) max = p.seq;
    }
    return max + 1;
}
