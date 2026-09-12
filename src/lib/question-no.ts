/**
 * 题号（source）生成工具
 *
 * 题号格式：<学科2字简拼小写> + <8位录入日期 YYYYMMDD> + <3位当日流水>
 * 示例：sx20260912001 表示 数学 + 2026-09-12 + 当天第1题
 *
 * 设计说明：
 * - 学科简拼由 inferSubjectFromName 返回的 subjectKey（math/english/...）映射，
 *   这样即使学科名是“小五上数学”这类脏名也能正确识别。
 * - 当日流水为该用户当天已录入错题数 + 1（跨学科统一计数）。
 * - 题号后续将作为文件名 / 二维码地址，用于扫描打开 NAS 上的错题页。
 */

// subjectKey（来自 lib/knowledge-tags.inferSubjectFromName）-> 2 字简拼
const SUBJECT_CODE_MAP: Record<string, string> = {
    math: "sx",      // 数学
    english: "yy",   // 英语
    chinese: "yw",   // 语文
    physics: "wl",   // 物理
    chemistry: "hx", // 化学
    biology: "sw",   // 生物
    politics: "zz",  // 政治
    history: "ls",   // 历史
    geography: "dl", // 地理
};

const FALLBACK_CODE = "ot"; // 其他 / 未识别

/**
 * 将学科 key 转为 2 字简拼（小写）。无法识别时返回 "ot"。
 */
export function subjectKeyToCode(subjectKey: string | null | undefined): string {
    if (!subjectKey) return FALLBACK_CODE;
    return SUBJECT_CODE_MAP[subjectKey] || FALLBACK_CODE;
}

/**
 * 将学科中文名（如“小五上数学”）转为 2 字简拼，便于在前端未拿到 subjectKey 时兜底。
 */
export function subjectNameToCode(subjectName: string | null | undefined): string {
    if (!subjectName) return FALLBACK_CODE;
    const lower = subjectName.toLowerCase();
    if (lower.includes("math") || lower.includes("数学")) return "sx";
    if (lower.includes("english") || lower.includes("英语")) return "yy";
    if (lower.includes("chinese") || lower.includes("语文")) return "yw";
    if (lower.includes("physics") || lower.includes("物理")) return "wl";
    if (lower.includes("chemistry") || lower.includes("化学")) return "hx";
    if (lower.includes("biology") || lower.includes("生物")) return "sw";
    if (lower.includes("politics") || lower.includes("政治")) return "zz";
    if (lower.includes("history") || lower.includes("历史")) return "ls";
    if (lower.includes("geography") || lower.includes("地理")) return "dl";
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
