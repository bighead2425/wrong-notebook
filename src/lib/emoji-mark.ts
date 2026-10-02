import library from './emoji-print-library.json';

/**
 * 【2026-10-03 需求第 10 条】纸张的**随机 emoji 标识**。
 *
 * 他要的：每份纸页眉"印于 yyyy-mm-dd"**左边**给一个随机 emoji，
 * 像编号二维码一样是**这份纸的属性**（同份纸相对不变，不同纸可以用同一个）。
 *
 * ── 库从哪来 ─────────────────────────────────────────────────────
 * `emoji-print-library.json` 由 `scripts/build-emoji-print-library.mjs`
 * **离线筛一遍**产出（不是运行时现筛）：剔除画不出来的（ZWJ 组合 / 肤色 /
 * 区域指示符 / keycap / 码点数 > 2 / 新符号）与内容负面的（骷髅、鬼、刀枪、烟酒…）。
 * 详见脚本文件头。
 *
 * ── 等概率 ───────────────────────────────────────────────────────
 * `pickRandomEmoji` 就是 `Math.floor(Math.random() * N)` 取下标 —— 不搞加权，
 * 库里每个符号被选中的概率完全相等。
 */
export const EMOJI_PRINT_LIBRARY: readonly string[] = library as string[];

/**
 * 从印刷库里**等概率**随机取一个字符。
 *
 * @param random 随机源，默认 `Math.random` —— 参数化只为单测能在固定随机数下断言。
 */
export function pickRandomEmoji(random: () => number = Math.random): string {
    const size = EMOJI_PRINT_LIBRARY.length;
    if (size === 0) return '';
    // 夹一下上界：Math.random() 理论上 <1，但取整后仍可能等于 size（浮点边界），不能越界
    const index = Math.min(size - 1, Math.max(0, Math.floor(random() * size)));
    return EMOJI_PRINT_LIBRARY[index];
}
