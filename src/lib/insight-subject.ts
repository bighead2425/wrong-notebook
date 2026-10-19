/**
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-10-19 空空第 2 条】**让 AI 顺手判学科**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 他的原话：
 *   "在所有送AI的情况下，如果学科还没有指定，则让AI自己判断一下，应该将这个日积月累
 *    归到什么学科合适，并反馈回来，直接在学科中选择上。如果目前已选定的学科和输入的内容
 *    明显不一致，则直接将这个学科改到正确的学科上。因为年级学期基本能够长期固定，
 *    而学科可能来回变换，而AI对分析学科应该难度不大。"
 *
 * ── 为什么用"正文末尾一行标记"而不是 JSON ──────────────────────────
 * `chatText()` 返回的是**纯文本**，整条链路（`normalizeInsightMarkdown`）都按 markdown 处理。
 * 让它改成返回 JSON，等于把"整理卡片"这条已经跑通的链子整个翻掉 —— 而且模型
 * 在 JSON 里写长文本容易把换行/引号写坏（那才是真正难查的故障）。
 * ⇒ 折中：**卡片照旧是 markdown，只在最后多一行 `[[学科:数学]]`**，由程序剥掉。
 *   模型偶尔漏写/写错，也只是"这次没判出学科"，不会毁掉卡片。
 *
 * ⚠️ 这个标记**不写进用户可配置的模板**（模板在设置页里能被改得面目全非），
 *    而是由 `generateInsightsPrompt` 在**末尾统一追加** —— 见那里的说明。
 */

import { SUBJECT_OPTIONS } from "@/lib/notebook-fields";

/** 模型要输出的那一行：`[[学科:数学]]`（中英文冒号都认） */
export const SUBJECT_MARK_RE = /\[\[\s*学科\s*[:：]\s*([^\]\n]{1,20}?)\s*\]\]/g;

/**
 * 从模型输出里把学科标记**取出来并剥掉**。
 *
 * 三个刻意的做法：
 *  ① **全局匹配、取最后一个** —— 模型偶尔会先写一个再改口，以最后那个为准；
 *  ② 标记可能出现在正文中间（模型不听话时），所以是**全部剥掉**，不是只剥末尾；
 *  ③ 剥完如果只剩空白，就当没写（`text` 为空由调用方决定怎么报错）。
 *
 * @returns `subject` 是**归一化后的 key**（如 `math`），认不出就是 null
 */
export function takeSubjectMark(raw: string): { text: string; subject: string | null } {
    const source = raw ?? '';
    let subject: string | null = null;
    for (const m of source.matchAll(SUBJECT_MARK_RE)) {
        const key = resolveSubjectKey(m[1]);
        if (key) subject = key;
    }
    const text = source.replace(SUBJECT_MARK_RE, '').trim();
    return { text, subject };
}

/**
 * 把模型写的"学科"归一成 `SUBJECT_OPTIONS` 的 key。
 *
 * 认三种写法（模型三种都会写）：`数学`（中文标签）/ `math`（key）/ `数`（short）。
 * ⚠️ **认不出返回 null，绝不猜**：猜错一次就把这条积累归到别的学科去了，
 *    而学科会影响打印分组、内阁统计、AI 回指时取的"同学科旧条目"。
 */
export function resolveSubjectKey(raw: string | null | undefined): string | null {
    const v = (raw ?? '').trim();
    if (!v) return null;
    const lower = v.toLowerCase();
    const hit =
        SUBJECT_OPTIONS.find((o) => o.key === lower) ??
        SUBJECT_OPTIONS.find((o) => o.label === v) ??
        SUBJECT_OPTIONS.find((o) => o.short === v);
    return hit?.key ?? null;
}

/**
 * 学科要不要被 AI 覆盖（他第 2 条的两句话，落成一条判据）。
 *
 * | 当前 | AI 判出 | 结果 |
 * |---|---|---|
 * | 空 | 数学 | **填上**（"如果学科还没有指定……直接在学科中选择上"） |
 * | 语文 | 数学 | **改成数学**（"如果……明显不一致，则直接将这个学科改到正确的学科上"） |
 * | 数学 | 数学 | 不动 |
 * | 任意 | 没判出 / 判成"其他" | **不动**（"其他"是兜底值，拿它覆盖等于把信息擦掉） |
 *
 * ⚠️ 为什么"其他"不覆盖：`other` 既是"真的其他"也是"判不出来"。
 *    用它去改一个已经填好的学科，只会让本来对的变错。
 */
export function nextSubjectByAi(current: string | null | undefined, aiSubject: string | null | undefined): string | null {
    const ai = (aiSubject ?? '').trim();
    if (!ai || ai === 'other') return null;
    const cur = (current ?? '').trim();
    if (!cur) return ai;
    if (cur === ai) return null;
    return ai;
}
