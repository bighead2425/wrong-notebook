/**
 * 【2026-10-01】中文 emoji 选择器的**触发解析**（纯函数，零依赖）。
 *
 * 用户拍板的写法（"括号式"，两端分别是开始与触发）：
 *
 *     输入 `：：笑脸；；` —— 最后敲的 `；；` 唤醒功能，
 *     然后往回找最近的 `：：`，两者之间的中文（"笑脸"）就是搜索词。
 *
 *   `：：` = 开始标记，`；；` = 结束/触发标记，中间 = 搜索词。
 *   半角 `::` / `;;` 也认（手机输入法更容易打成半角）。
 *
 * 📌 之所以是"先 `：：` 后 `；；`"（而不是反过来）：他在 Obsidian 的插件里就是
 *    **先打 `：：` 唤起、再打中文**，两边保持同一套输入肌肉记忆。
 *
 * 为什么把这段单独抽成纯函数（而不是塞在 ProseMirror 插件里）：
 *   ① 它是整个功能的**判定核心**，边界情况最多，必须能被单测钉死；
 *   ② 不依赖 ProseMirror / DOM —— 本模块可在 Node 里直接跑（见 emoji-trigger.test.ts）。
 *
 * 判定口径（与"宁可没反应，绝不能吃掉用户打的字"这条红线一致）：
 *   - 光标前文本必须**正好以** `：：` 或 `::` 结尾（后面多一个空格都不算）；
 *   - 往回找**最近的**开始标记（两个半/全角候选里取更靠后的那个）；
 *   - 中间不能为空（全空白也算空）；
 *   - 搜索词过长（超过 MAX）不认，避免误把一大段正文当查询；
 *   - 找不到 → 返回 null（调用方据此**什么都不做**，原文一个字不动）。
 */

/**
 * 开始标记（`：：` 全角 / `::` 半角）—— **先输这个**。
 *
 * 📌【2026-10-01 对调】原来开始是 `；；`、结束是 `：：`。他提出改过来，理由是**肌肉记忆统一**：
 *    "在 obsidian 中的插件，我用 `：：` 唤起；现在也先输入 `：：`，然后都是后输入汉语，
 *     无非在错题本中再输入 `；；` 唤起，两者在输入逻辑上基本统一，这样更好，
 *     否则我可能得重新记忆输入逻辑。"
 *    ⇒ 两个软件里都是"先 `：：`、再打中文"，只有"收尾键"不同（Obsidian 是直接唤起，
 *      这里多一个 `；；`）。他不用为这个功能另记一套指法。
 */
export const EMOJI_START_MARKERS = ['：：', '::'] as const;

/** 结束（触发）标记（`；；` 全角 / `;;` 半角）—— **后输这个，敲下去就唤起** */
export const EMOJI_END_MARKERS = ['；；', ';;'] as const;

/**
 * 搜索词长度上限（以 UTF-16 码元计）。超过就当用户不是在用这个功能。
 *
 * 📌【2026-10-02 他定的规矩】从 `；；` 往前**倒查 30 个字符**还没遇到 `：：`，
 * 就当他真的只是想打 `：：xxx；；` 这几个字（不是在用 emoji 功能）——
 * 他说"日常应该不会输入这种奇怪的东西"，所以超限一律不触发、原文不动。
 */
export const EMOJI_QUERY_MAX = 30;

export interface EmojiTrigger {
    /** 在输入串中，开始标记的起始下标 */
    start: number;
    /** 在输入串中，结束标记结束后的下标（通常 = 输入串长度） */
    end: number;
    /** 两个标记之间的搜索词（已 trim；不会为空） */
    query: string;
    /** 两个标记之间的**原始**子串（含标记本身：`：：…；；`），插入时用它做原文校验 */
    raw: string;
}

/**
 * 从"光标前的文本"里解析出触发信息。
 *
 * @param before 光标之前的那段文本（可含换行；见调用方 md-editor.tsx 的取法）
 * @returns 命中则给出范围与搜索词；否则 null
 */
export function parseEmojiTrigger(before: string): EmojiTrigger | null {
    if (!before) return null;

    // ① 必须正好以结束标记收尾
    const endMarker = EMOJI_END_MARKERS.find((m) => before.endsWith(m));
    if (!endMarker) return null;
    const endIdx = before.length - endMarker.length;

    // ② 往回找最近的开始标记（要在结束标记之前，两个候选取更靠后的）
    let startIdx = -1;
    for (const marker of EMOJI_START_MARKERS) {
        // lastIndexOf 的 fromIndex 是"匹配起点允许的最大下标"：
        // 开始标记整体要落在 endIdx 之前 ⇒ 起点 ≤ endIdx - marker.length
        const found = before.lastIndexOf(marker, endIdx - marker.length);
        if (found > startIdx) startIdx = found;
    }
    if (startIdx < 0) return null;

    // ③ 中间必须是"非空"文字
    const between = before.slice(startIdx + EMOJI_START_MARKERS[0].length, endIdx);
    const query = between.trim();
    if (query.length === 0) return null;
    if (query.length > EMOJI_QUERY_MAX) return null;

    return {
        start: startIdx,
        end: before.length,
        query,
        raw: before.slice(startIdx),
    };
}
