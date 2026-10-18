/**
 * 日积月累 · **卡片结构**的规范化与体检（2026-10-18）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件：**纸面排版不能交给模型守规矩**
 *
 * 空空定的格式（2026-10-18）：
 *   · 最上面一行是**四级标题**（`#### ` + emoji + ≤15 字概括）——
 *     因为积累纸上一行大约 16 个汉字的宽度，超了就折行、版面就乱；
 *   · 正文短小精悍；
 *   · AI 的补充在正文之后，**md 引用 + 斜体**，开头 `AI:`。
 *
 * 提示词里已经把这些写成硬约束了，但**模型是概率的**：
 * 它会写 `###`、会写 `**AI:**`、会用 ``` 包起来、标题会超一个字。
 * ⇒ 凡是"错一个字符就破坏版面"的地方，**必须由程序再兜一次**。
 *
 * 分工很清楚：
 *   · **内容**（说什么、怎么压缩）→ 模型；
 *   · **结构**（几级标题、引用怎么写、多长算超）→ 这里。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 标题里"概括"部分的上限（汉字数）。他按 16 汉字一行算的，留 4 字余量给 emoji 与折行 */
export const INSIGHT_TITLE_MAX_CHARS = 12;
/** 正文建议上限（字）。超了不硬截（会断句），只提示 */
export const INSIGHT_BODY_MAX_CHARS = 120;
/** AI 段建议上限（字） */
export const INSIGHT_AI_MAX_CHARS = 60;

/** emoji 的粗略判据（够用即可：常见 emoji 区段） */
const EMOJI_RE =
    /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;

function charCount(s: string): number {
    // 按"字"算：emoji 与组合符号尽量算 1 个（用 Array.from 按码点切）
    return Array.from(s).filter((c) => !/\s/.test(c)).length;
}

/**
 * 把模型吐出来的东西**规范成一张合规的卡片**。
 *
 * 做的都是"结构"的事，**不改编内容**：
 *   ① 去掉 ``` 代码块包裹；
 *   ② 第一行统一成 `#### `（`#`/`##`/`###`/无标题 都收过来）；
 *   ③ 标题里没 emoji 且看起来像标题 ⇒ 补一个中性 emoji（📌），不猜内容；
 *   ④ AI 段统一成 `> *AI: …*`（`> **AI**:`、`> AI:`、`AI:` 各种写法都归一）；
 *   ⑤ 压掉连续空行与行尾空白。
 */
export function normalizeInsightMarkdown(raw: string): string {
    let s = (raw || '').replace(/\r\n/g, '\n').trim();

    // ① 去掉代码块围栏（模型很爱包一层）
    s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();

    const lines = s.split('\n');

    // ② 找第一行非空，把标题统一成 ####
    const firstIdx = lines.findIndex((l) => l.trim() !== '');
    if (firstIdx >= 0) {
        const first = lines[firstIdx].trim();
        // 已经是 #### 就保留；是 1~6 级标题 ⇒ 降/升到 4 级；完全没标题 ⇒ 造一个
        const heading = first.match(/^#{1,6}\s+(.*)$/);
        if (heading) {
            lines[firstIdx] = `#### ${heading[1].trim()}`;
        } else if (!first.startsWith('>')) {
            /**
             * 没有标题：拿第一句当标题（**不编内容**）。
             * 但只在"第一行很短"时这么做；第一行是一大段正文时，宁可补一个占位标题也不吞掉它。
             */
            const shortEnough = charCount(first) <= INSIGHT_TITLE_MAX_CHARS;
            if (shortEnough) {
                lines[firstIdx] = `#### ${first}`;
            } else {
                lines.splice(firstIdx, 0, '#### 📌 这一条');
            }
        }
    }

    // ③ 标题里补 emoji（只在完全没有 emoji 时；补中性标记，不猜语义）
    const hi = lines.findIndex((l) => /^####\s+/.test(l));
    if (hi >= 0) {
        const text = lines[hi].replace(/^####\s+/, '').trim();
        if (!EMOJI_RE.test(text)) lines[hi] = `#### 📌 ${text}`;
    }

    // ④ AI 段归一：所有形如 "> **AI**: xxx" / "AI: xxx" / "> AI: xxx" 都变成 "> *AI: xxx*"
    const out: string[] = [];
    for (const line of lines) {
        const t = line.trim();
        /**
         * 只认"整行是一段 AI 补充"的三种写法：
         *   > AI: xxx   /  > **AI**: xxx  /  直接 AI: xxx
         * ⚠️ 不能把正文里提到 "AI" 的句子改掉 —— 所以要求"AI"出现在**行首**（可带引用符）。
         */
        const m = t.match(/^>?\s*(?:\*\*)?AI(?:\*\*)?\s*[:：]\s*(.+)$/i);
        if (m) {
            const body = m[1].trim().replace(/^\*+|\*+$/g, '').trim();
            out.push(`> *AI: ${body}*`);
            continue;
        }
        out.push(line.replace(/\s+$/, ''));
    }
    s = out.join('\n');

    // ⑤ 压空行（最多保留 1 个连续空行）
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    return s;
}

export interface InsightNoteInspection {
    /** 有没有（规范化之后的）四级标题 */
    hasTitle: boolean;
    /** 标题里的概括部分（去 emoji 之后） */
    titleText: string;
    titleChars: number;
    /** 正文（标题与 AI 段之间）的非空白字数 */
    bodyChars: number;
    /** AI 段字数（0 = 没有 AI 段） */
    aiChars: number;
    /** 全文 emoji 个数（含标题那个） */
    emojiCount: number;
    /** 给人看的提醒（空数组 = 没毛病）。**只提醒、不擅自改** */
    warnings: string[];
}

/**
 * 体检一张卡片 —— **只报告，不修改**。
 *
 * 用途：① 单测钉住规范化；② 界面上给一句"AI 写长了"的提示（他可以选择重来）。
 * ⚠️ 故意**不自动截断正文**：截断会把一句话切断，比长一点更糟。
 */
export function inspectInsightNote(md: string): InsightNoteInspection {
    const s = normalizeInsightMarkdown(md);
    const lines = s.split('\n');
    const hi = lines.findIndex((l) => /^####\s+/.test(l));

    const titleRaw = hi >= 0 ? lines[hi].replace(/^####\s+/, '').trim() : '';
    const titleText = titleRaw.replace(new RegExp(EMOJI_RE.source, 'gu'), '').trim();

    // 正文 = 标题之后、第一个 AI 段之前
    const bodyStart = hi + 1;
    let bodyEnd = lines.length;
    for (let i = bodyStart; i < lines.length; i++) {
        if (/^>\s*\*?AI/i.test(lines[i].trim())) {
            bodyEnd = i;
            break;
        }
    }
    const body = lines.slice(bodyStart, bodyEnd).join('\n');
    const ai = lines.slice(bodyEnd).join('\n');

    const emojiCount = (s.match(new RegExp(EMOJI_RE.source, 'gu')) || []).length;
    const warnings: string[] = [];
    if (hi < 0) warnings.push('没有四级标题（#### ）—— 纸面上会失去那一行概括');
    if (charCount(titleText) > INSIGHT_TITLE_MAX_CHARS)
        warnings.push(`标题 ${charCount(titleText)} 字，超过 ${INSIGHT_TITLE_MAX_CHARS} 字（会折行破版）`);
    if (charCount(body) > INSIGHT_BODY_MAX_CHARS)
        warnings.push(`正文 ${charCount(body)} 字，超过建议的 ${INSIGHT_BODY_MAX_CHARS} 字`);
    if (charCount(ai) > INSIGHT_AI_MAX_CHARS + 4)
        warnings.push(`AI 补充 ${charCount(ai)} 字，超过建议的 ${INSIGHT_AI_MAX_CHARS} 字`);
    if (emojiCount > 4) warnings.push(`emoji ${emojiCount} 个，偏多（建议含标题共 ≤4 个）`);

    return {
        hasTitle: hi >= 0,
        titleText,
        titleChars: charCount(titleText),
        bodyChars: charCount(body),
        aiChars: charCount(ai),
        emojiCount,
        warnings,
    };
}
