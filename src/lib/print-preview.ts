type PrintSelectableItem = {
    id: string;
};

export function getSelectedPrintItems<T extends PrintSelectableItem>(
    items: T[],
    selectedIds: Set<string>,
): T[] {
    return items.filter((item) => selectedIds.has(item.id));
}

export function shouldReserveAnswerSpace(showAnswers: boolean, showAnalysis: boolean): boolean {
    return !showAnswers && !showAnalysis;
}

export function getPrintPreviewCountLabel(totalCount: number, selectedCount: number): string {
    return selectedCount === totalCount
        ? String(totalCount)
        : `${selectedCount}/${totalCount}`;
}

export function getPrintPreviewEmptyState(
    totalCount: number,
    selectedCount: number,
): 'noItems' | 'noSelection' | null {
    if (totalCount === 0) return 'noItems';
    if (selectedCount === 0) return 'noSelection';
    return null;
}

/* ============================================================================
 * 下面几项原先长在 print-preview/page.tsx 里，M3 重排时下沉到这里。
 * 理由：它们是**纯函数**（只吃数据、吐字符串），埋在 661 行的页面组件里既没法单测，
 * 也没法给新的「T1 深挖纸」复用 —— 而两套版式必须用**同一份**年级/知识点取法，
 * 否则同一道题在两张纸上显示成两个名字。
 * ==========================================================================*/

/**
 * 年级字段归一化：库里混有「五年级」「五年级上」「Grade 6, 1st Semester」等写法。
 * 英文写法统一收回中文，免得纸面上中英混排。
 */
export function normalizeGrade(raw?: string | null): string {
    if (!raw) return '';
    const en = raw.match(/^\s*grade\s*(\d+)/i);
    if (en) {
        const cn: Record<string, string> = {
            '1': '一年级',
            '2': '二年级',
            '3': '三年级',
            '4': '四年级',
            '5': '五年级',
            '6': '六年级',
        };
        return cn[en[1]] || raw;
    }
    return raw.replace(/_/g, ' ').trim();
}

/** 知识点标签：优先用关联表，退回 knowledgePoints 里存的 JSON（旧数据） */
export function getTags(item: { tags?: { name: string }[] | null; knowledgePoints?: string | null }): string[] {
    if (item.tags && item.tags.length > 0) return item.tags.map((x) => x.name);
    try {
        const arr = JSON.parse(item.knowledgePoints || '[]');
        return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * 剥离解析里的【错因分析】段落。
 * AI 会把错因同时写进 analysis 和 mistakeAnalysis 两个字段，
 * 全开就会重复印两遍，所以独立错因字段有内容时，从解析里去掉这一段。
 */
export function stripMistakeSection(analysis: string): string {
    const start = analysis.indexOf('【错因分析】');
    if (start < 0) return analysis;
    const rest = analysis.slice(start);
    const nextTitle = rest.indexOf('\n【', 1);
    if (nextTitle < 0) return analysis.slice(0, start).trimEnd();
    return (analysis.slice(0, start) + rest.slice(nextTitle + 1)).trim();
}

export interface NotebookPrintInfo {
    gradeText: string;
    subjectKey: string;
}

/**
 * 错题所属本 → 页头年级学期与学科色标。
 * @param unfiledLabel 「未分本」的写法（中英文不同，由调用方给）
 */
export function getNotebookPrintInfo(
    item: {
        gradeSemester?: string | null;
        notebook?: {
            grade?: string | null;
            semester?: string | null;
            displayName?: string | null;
            subject?: string | null;
        } | null;
    },
    unfiledLabel: string,
): NotebookPrintInfo {
    const nb = item.notebook;
    if (!nb) {
        return {
            gradeText: normalizeGrade(item.gradeSemester) || unfiledLabel,
            subjectKey: 'other',
        };
    }
    const grade = nb.grade || normalizeGrade(item.gradeSemester);
    const sem = nb.semester ? (nb.semester === '下' ? '下' : '上') : '';
    const gradeText =
        [grade, sem ? `${sem}学期` : ''].filter(Boolean).join(' · ') || nb.displayName || unfiledLabel;
    return { gradeText, subjectKey: nb.subject || 'other' };
}
