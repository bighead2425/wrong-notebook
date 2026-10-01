/**
 * 【2026-10-01】中文 emoji 选择器的**触发解析**（纯函数，零依赖）。
 *
 * 用户拍板的写法（与 Obsidian 那个插件不同，是"括号式"的）：
 *
 *     输入 `；；眼镜：：` —— 最后敲的 `：：` 唤醒功能，
 *     然后往回找最近的 `；；`，两者之间的中文（"眼镜"）就是搜索词。
 *
 *   `；；` = 开始标记，`：：` = 结束/触发标记，中间 = 搜索词。
 *   半角 `;;` / `::` 也认（手机输入法更容易打成半角）。
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

/** 开始标记（`；；` 全角 / `;;` 半角） */
export const EMOJI_START_MARKERS = ['；；', ';;'] as const;

/** 结束（触发）标记（`：：` 全角 / `::` 半角） */
export const EMOJI_END_MARKERS = ['：：', '::'] as const;

/** 搜索词长度上限（以 UTF-16 码元计）。超过就当用户不是在用这个功能。 */
export const EMOJI_QUERY_MAX = 40;

export interface EmojiTrigger {
    /** 在输入串中，开始标记的起始下标 */
    start: number;
    /** 在输入串中，结束标记结束后的下标（通常 = 输入串长度） */
    end: number;
    /** 两个标记之间的搜索词（已 trim；不会为空） */
    query: string;
    /** 两个标记之间的**原始**子串（含标记本身：`；；…：：`），插入时用它做原文校验 */
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
