/**
 * 教科书级错题本（Notebook）四结构化字段的共享定义（B13 / B14 / Q1）
 *
 * 用途：建本弹窗、编辑弹窗、列表副标题、打印模板共用同一份选项，
 * 避免各写一份导致学科 key 不一致（题号学科码直接读 Notebook.subject）。
 *
 * ⚠️ subject 存的是 **subjectKey**（math / chinese / ...），与 KnowledgeTag.subject 一致。
 *    题号简拼由 src/lib/question-no.ts 的 SUBJECT_CODE_MAP 映射。
 */

export interface OptionItem {
    key: string;
    label: string;
    short: string;
}

/** 学科（9 科 + 其他），与 5.4 简拼表一一对应 */
export const SUBJECT_OPTIONS: OptionItem[] = [
    { key: "math", label: "数学", short: "数" },
    { key: "chinese", label: "语文", short: "语" },
    { key: "english", label: "英语", short: "英" },
    { key: "physics", label: "物理", short: "物" },
    { key: "chemistry", label: "化学", short: "化" },
    { key: "biology", label: "生物", short: "生" },
    { key: "politics", label: "政治", short: "政" },
    { key: "history", label: "历史", short: "史" },
    { key: "geography", label: "地理", short: "地" },
    { key: "other", label: "其他", short: "他" },
];

/** 学段 */
export const GRADE_STAGE_OPTIONS: OptionItem[] = [
    { key: "primary", label: "小学", short: "小" },
    { key: "junior", label: "初中", short: "初" },
    { key: "senior", label: "高中", short: "高" },
];

/** 各学段下的年级（short 用于拼显示名） */
export const GRADES_BY_STAGE: Record<string, OptionItem[]> = {
    primary: [
        { key: "一年级", label: "一年级", short: "一" },
        { key: "二年级", label: "二年级", short: "二" },
        { key: "三年级", label: "三年级", short: "三" },
        { key: "四年级", label: "四年级", short: "四" },
        { key: "五年级", label: "五年级", short: "五" },
        { key: "六年级", label: "六年级", short: "六" },
    ],
    junior: [
        { key: "初一", label: "初一", short: "一" },
        { key: "初二", label: "初二", short: "二" },
        { key: "初三", label: "初三", short: "三" },
    ],
    senior: [
        { key: "高一", label: "高一", short: "一" },
        { key: "高二", label: "高二", short: "二" },
        { key: "高三", label: "高三", short: "三" },
    ],
};

/** 学期 */
export const SEMESTER_OPTIONS: OptionItem[] = [
    { key: "上", label: "上学期", short: "上" },
    { key: "下", label: "下学期", short: "下" },
];

export function subjectLabel(key?: string | null): string {
    if (!key) return "其他";
    return SUBJECT_OPTIONS.find(o => o.key === key)?.label || "其他";
}

export function gradeStageLabel(key: string): string {
    return GRADE_STAGE_OPTIONS.find(o => o.key === key)?.label || "小学";
}

/**
 * 自动拼显示名，如：小学 + 五年级 + 上 + 数学 → "小五上数学"（B14）
 * 用户可手动改成任何名字，机器聚合只看四字段。
 */
export function buildDisplayName(params: {
    gradeStage: string;
    grade: string;
    semester: string;
    subject: string;
}): string {
    const stageShort = GRADE_STAGE_OPTIONS.find(o => o.key === params.gradeStage)?.short || "小";
    const grades = GRADES_BY_STAGE[params.gradeStage] || GRADES_BY_STAGE.primary;
    const gradeShort = grades.find(o => o.key === params.grade)?.short
        || params.grade.replace(/年级|初|高/g, "")
        || "";
    const semShort = params.semester === "下" ? "下" : "上";
    return `${stageShort}${gradeShort}${semShort}${subjectLabel(params.subject)}`;
}

/** 列表副标题，如 "五年级 · 上 · 数学" */
export function buildNotebookMeta(nb: {
    gradeStage?: string;
    grade?: string;
    semester?: string;
    subject?: string;
    archiveStatus?: string;
}): string {
    const parts: string[] = [];
    if (nb.grade) parts.push(nb.grade);
    if (nb.semester) parts.push(nb.semester === "下" ? "下" : "上");
    if (nb.subject) parts.push(subjectLabel(nb.subject));
    if (nb.archiveStatus === "archived") parts.push("已归档");
    return parts.join(" · ");
}
