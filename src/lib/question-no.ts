/**
 * 题号（source）生成工具
 *
 * 题号格式：<学科2字简拼大写> + <8位录入日期 YYYYMMDD> + <3位当日流水>
 * 示例：SX20260912001 表示 数学 + 2026-09-12 + 当天第1题
 *
 * 设计说明（Q2 / 5.4 / 5.5）：
 * - 学科简拼统一**大写**（旧版小写 sx，已按 Q2 改）。
 * - 学科码**直接读 Notebook.subject**（subjectKey），不再从显示名反推——
 *   旧版 inferSubjectFromName 依赖名字里必须含学科词，太脆弱。
 * - 当日流水为该用户当天已录入错题数 + 1（跨学科统一计数）。
 * - 题号后续将作为文件名 / 二维码地址，用于扫描打开 NAS 上的错题页。
 */

// subjectKey（Notebook.subject）-> 2 字简拼（大写）
const SUBJECT_CODE_MAP: Record<string, string> = {
    math: "SX",      // 数学
    english: "YY",   // 英语
    chinese: "YW",   // 语文
    physics: "WL",   // 物理
    chemistry: "HX", // 化学
    biology: "SW",   // 生物
    politics: "ZZ",  // 政治
    history: "LS",   // 历史
    geography: "DL", // 地理
    other: "OT",     // 其他
};

const FALLBACK_CODE = "OT"; // 其他 / 未识别

/**
 * 将学科 key 转为 2 字简拼（大写）。无法识别时返回 "OT"。
 */
export function subjectKeyToCode(subjectKey: string | null | undefined): string {
    if (!subjectKey) return FALLBACK_CODE;
    // 兼容历史小写 key 与中文名：统一小写化后再查表
    return SUBJECT_CODE_MAP[subjectKey.toLowerCase().trim()] || FALLBACK_CODE;
}

/**
 * 将学科中文名（如“小五上数学”）转为 2 字简拼（大写）。
 * ⚠️ 仅作兜底：新代码应直接读 Notebook.subject，不要用这个函数猜名字（5.5）。
 */
export function subjectNameToCode(subjectName: string | null | undefined): string {
    if (!subjectName) return FALLBACK_CODE;
    const lower = subjectName.toLowerCase();
    if (lower.includes("math") || lower.includes("数学")) return "SX";
    if (lower.includes("english") || lower.includes("英语")) return "YY";
    if (lower.includes("chinese") || lower.includes("语文")) return "YW";
    if (lower.includes("physics") || lower.includes("物理")) return "WL";
    if (lower.includes("chemistry") || lower.includes("化学")) return "HX";
    if (lower.includes("biology") || lower.includes("生物")) return "SW";
    if (lower.includes("politics") || lower.includes("政治")) return "ZZ";
    if (lower.includes("history") || lower.includes("历史")) return "LS";
    if (lower.includes("geography") || lower.includes("地理")) return "DL";
    return FALLBACK_CODE;
}

/**
 * 生成 8 位日期串 YYYYMMDD。
 */
export function formatDateStamp(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
}

/**
 * 组合完整题号。serial 为当日流水（从 1 开始），自动补零到 3 位。
 */
export function formatQuestionNo(code: string, dateStamp: string, serial: number): string {
    const serialStr = String(serial).padStart(3, "0");
    return `${code}${dateStamp}${serialStr}`;
}

/**
 * 计算某用户“今天 00:00”的 Date 对象（用于按天统计流水）。
 */
export function startOfToday(now: Date = new Date()): Date {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
}
