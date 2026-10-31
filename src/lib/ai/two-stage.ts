/**
 * 两段式分析（第一段看图、第二段归位）
 *
 * 【2026-11-01 用户定稿的设计】
 *
 *   第一段：**图** → 题干/答案/解析/错因 + 学科 + 3 个考点短语
 *          （不再输出知识点，因此不用带清单，token 从 5,200 降到 ~3,200）
 *
 *   本地：3 个考点短语 → 命中的「节」（`lib/tag-index.ts`，不花钱）
 *
 *   第二段：**纯文字**（题干+答案+解析）+ 几个候选节 → 只输出「选第几个」
 *          （候选只有 10–20 个，模型没地方编）
 *
 * 为什么第二段不看图（用户的判断）：
 *   第一段已经看过图，如果它错了，第二段再看同一张图也可能错；
 *   而第二段任务简单得多（只做定位），读文字更稳也更快。
 *   真要保险，可以在**第二段置信度低时**再带图重跑一次——那才花几个钱。
 *
 * 这个文件只负责「提示词与解析」，不碰数据库、不发请求。
 */

import type { SectionEntry } from '../tag-index';

/** 第一段：把模板里的「知识点段」换成「考点短语段」 */
export function buildStage1Template(template: string): string {
    let t = template;

    /* 删掉旧的知识点段与其判据（它们已经由 keywords 取代） */
    t = t.replace(/<knowledge_points>[\s\S]*?<\/knowledge_points>/gi, '');
    t = t.replace(/<book_reason>[\s\S]*?<\/book_reason>/gi, '');

    /* 删掉「知识点标签列表」相关的说明段（模板里可能带） */
    t = t.replace(/【知识点标签列表（KNOWLEDGE POINT LIST）】[\s\S]*?(?=【|$)/, '');
    t = t.replace(/\*\*选择规则\*\*：[\s\S]*?(?=\n\n|$)/, '');

    const keywordsBlock = `【这道题考什么（KEY POINTS）】

不要选知识点，也不要写知识点编号。
用 **3 个短语**说清楚"这道题在考什么"，短语要能直接对应教材里的单元名或小节名。
- 宁可用教材里的说法（"质量单位换算""复名数互化""列方程解决问题"），不要用"计算""理解"这种空话；
- 三个短语按"最像 → 次像"排列；
- 如果这题确实看不出考什么，写 UNMATCHED。

输出格式（放在最后，一次写清）：

<keywords>短语1 | 短语2 | 短语3</keywords>
<grade_guess>这道题通常出现在几年级（如"三年级下"；判断不了就写 UNKNOWN）</grade_guess>

⚠️ grade_guess 只是**参考线索**，宁可写 UNKNOWN 也不要硬猜。`;

    return `${t.trim()}\n\n${keywordsBlock}\n`;
}

export interface Stage1Result {
    subject: string | null;
    keywords: string[];
    gradeGuess: string | null;
    raw: string;
}

/**
 * 第一段的完整 system prompt。
 *
 * 特意**不走** `generateAnalyzePrompt`：那条路在「有学科但没给清单」时会掉进
 * "五科平铺"的兜底分支，白送几万字。第一段根本不需要清单。
 */
export function buildStage1Prompt(params: {
    template: string;
    gradeSemester?: string | null;
    language?: 'zh' | 'en';
}): string {
    const { template, gradeSemester, language = 'zh' } = params;
    let t = buildStage1Template(template);

    const gradeLine = gradeSemester
        ? `学生当前在读：**${gradeSemester}**。判断学段/年级时以此为基准，但**不要**因为她读这一册就把明显属于别的册的内容硬塞进来。`
        : '';
    const langLine =
        language === 'zh'
            ? "IMPORTANT: For the 'analysis' field, use Simplified Chinese. For 'questionText' and 'answerText', YOU MUST USE THE SAME LANGUAGE AS THE ORIGINAL QUESTION."
            : 'Please ensure all text fields are in English.';

    t = t
        .replace(/\{\{grade_instruction\}\}/g, gradeLine)
        .replace(/\{\{language_instruction\}\}/g, langLine)
        /* 其余占位符（难度、上一题、页码等）第一段用不到，清空即可 */
        .replace(/\{\{[a-z_]+\}\}/g, '');

    return t;
}

function pickTag(text: string, tag: string): string | null {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
}

/** 解析第一段输出 */
export function parseStage1(raw: string): Stage1Result {
    const kwRaw = pickTag(raw, 'keywords') || '';
    const keywords = kwRaw
        .split(/[|｜,，、;；]/)
        .map((s) => s.trim())
        .filter((s) => s && s.toUpperCase() !== 'UNMATCHED')
        .slice(0, 3);

    const gradeRaw = pickTag(raw, 'grade_guess');
    return {
        subject: pickTag(raw, 'subject')?.trim() || null,
        keywords,
        gradeGuess: gradeRaw && gradeRaw.toUpperCase() !== 'UNKNOWN' ? gradeRaw : null,
        raw,
    };
}

/**
 * 第二段的**可编辑模板**（设置页用）。
 *
 * 占位符只有三个：{{subject}} {{case_text}} {{candidates}}
 * 用户改坏了的代价是"第二段选不准"，不会崩 —— 但页面会给"恢复默认"。
 */
export const DEFAULT_STAGE2_TEMPLATE = `你是一个{{subject}}教研员。下面是一道学生做错的题，以及它可能的归属位置（编号候选）。

**题目**
{{case_text}}

**候选位置**（格式：[编号] 册 · 章 · 节 / 该节下的知识点）
{{candidates}}

**任务**
从上面的候选里挑出这道题**真正考的位置**，最多两处。规则：

- 只能从候选里选，**不要发明新的册/章/节/知识点**；
- 标了〔当前册〕的，是学生**现在正在读**的那一册 —— 如果题目确实是当前册内容，优先选它；
  但如果题目明显是别的册的内容（比如复习旧学期、提前学），**不要因为它是当前册就将就**；
- 拿不准就少选，甚至可以不选 —— **选错比不选更糟**。

**输出格式**

<pick>3</pick>                      ← 选中的编号，多个用逗号：<pick>3, 7</pick>；不选写 <pick></pick>
<confidence>high|medium|low</confidence>
<reason>一句话说明你为什么选它（不超过 30 字）</reason>
`;

/**
 * 第二段提示词。
 *
 * 刻意做得**很短**：没有模板式长规则，只有"题目 + 编号候选 + 选择要求"。
 * 这一段的任务是"在已有候选里挑"，不是"理解题目"——理解在第一段已经做完了。
 *
 * `template` 可传设置页里用户改过的那份；不传就用默认。
 */
export function buildStage2Prompt(params: {
    caseText: string;
    candidates: SectionEntry[];
    currentBook?: string | null;
    subjectCn: string;
    template?: string | null;
}): string {
    const { caseText, candidates, currentBook, subjectCn, template } = params;

    const list = candidates
        .map((c, i) => {
            const head = [c.book, c.chapter, c.section].filter(Boolean).join(' · ');
            const mark = currentBook && c.book === currentBook ? '〔当前册〕' : '';
            return `[${i + 1}] ${head}${mark}\n    ${c.tags.join(' / ')}`;
        })
        .join('\n');

    const tpl = template && template.trim() ? template : DEFAULT_STAGE2_TEMPLATE;

    return tpl
        .replace(/\{\{subject\}\}/g, subjectCn)
        .replace(/\{\{case_text\}\}/g, caseText)
        .replace(/\{\{candidates\}\}/g, list);
}

export interface Stage2Result {
    picks: number[];
    confidence: 'high' | 'medium' | 'low';
    reason: string | null;
}

/** 解析第二段输出（编号是 1 起的，转成 0 起的下标由调用方决定） */
export function parseStage2(raw: string): Stage2Result {
    const pickRaw = pickTag(raw, 'pick') || '';
    const picks = pickRaw
        .split(/[,\s，、;；]+/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);

    const confRaw = (pickTag(raw, 'confidence') || '').toLowerCase();
    const confidence: Stage2Result['confidence'] =
        confRaw.includes('high') ? 'high' : confRaw.includes('low') ? 'low' : 'medium';

    return {
        picks: [...new Set(picks)],
        confidence,
        reason: pickTag(raw, 'reason'),
    };
}

/** 把第一段的转录结果拼成第二段要读的文本（不放错因 —— 它不影响"这题考什么"） */
export function composeCaseText(p: {
    questionText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
}): string {
    const parts: string[] = [];
    if (p.questionText) parts.push(`题干：${p.questionText}`);
    if (p.answerText) parts.push(`答案：${p.answerText}`);
    if (p.analysis) parts.push(`解析：${p.analysis}`);
    return parts.join('\n');
}
