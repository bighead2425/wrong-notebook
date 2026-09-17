/**
 * 学科 9 色 + 2 字母简拼（5.4 / 5.6 已定稿，勿擅自调色）
 *
 * 定色三条原则（改动前先读）：
 * 1. 明度统一偏深：9 色的白字对比度均 ≥ 4:1（WCAG 大字标准），
 *    保证「实心色块 + 白色文字」每个学科都读得清。刻意避开柠檬黄、浅粉这类浅色。
 * 2. 色相两两拉开 ≥ 45°：易混的红/玫红、青/绿、橙/棕已各自拉开明度或饱和度。
 * 3. 天然冗余：色块旁一定同时印 2 字母简拼（SX/YY/WL…），
 *    黑白复印或色觉差异时，只看字母也能分辨学科 —— 颜色只是一眼识别的加成。
 */

export interface SubjectColorDef {
    key: string;   // subjectKey
    code: string;  // 2 字母简拼（大写）
    label: string; // 中文名
    short: string; // 单字，用于色块窄模式
    hex: string;   // 打印/UI 主色
}

export const SUBJECT_COLORS: SubjectColorDef[] = [
    { key: "math", code: "SX", label: "数学", short: "数", hex: "#D32F2F" },
    { key: "chinese", code: "YW", label: "语文", short: "语", hex: "#E65100" },
    { key: "english", code: "YY", label: "英语", short: "英", hex: "#1565C0" },
    { key: "physics", code: "WL", label: "物理", short: "物", hex: "#6A1B9A" },
    { key: "chemistry", code: "HX", label: "化学", short: "化", hex: "#00838F" },
    { key: "biology", code: "SW", label: "生物", short: "生", hex: "#2E7D32" },
    { key: "politics", code: "ZZ", label: "政治", short: "政", hex: "#AD1457" },
    { key: "history", code: "LS", label: "历史", short: "史", hex: "#795548" },
    { key: "geography", code: "DL", label: "地理", short: "地", hex: "#455A64" },
    { key: "other", code: "OT", label: "其他", short: "他", hex: "#212121" },
];

const FALLBACK: SubjectColorDef = SUBJECT_COLORS[SUBJECT_COLORS.length - 1];

export function getSubjectColorDef(subjectKey?: string | null): SubjectColorDef {
    if (!subjectKey) return FALLBACK;
    const k = subjectKey.toLowerCase().trim();
    return SUBJECT_COLORS.find(s => s.key === k) || FALLBACK;
}

/** 打印色标用：实心填充色 */
export function getSubjectHex(subjectKey?: string | null): string {
    return getSubjectColorDef(subjectKey).hex;
}

/** 打印色标用：2 字母简拼（天然冗余，黑白复印也能认） */
export function getSubjectCode(subjectKey?: string | null): string {
    return getSubjectColorDef(subjectKey).code;
}

/** UI 卡片浅底：学科色 12% 透明度 */
export function getSubjectTint(subjectKey?: string | null, alpha = 0.12): string {
    const hex = getSubjectHex(subjectKey);
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
