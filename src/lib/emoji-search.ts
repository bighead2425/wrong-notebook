/**
 * 【2026-10-01】中文 emoji 的**搜索层**（纯逻辑 + 懒加载）。
 *
 * 数据来自 Obsidian 插件 `cn-emoji`（1916 条 / 404KB），字段：
 *   c 字符 | n 中文名 | k 中英关键词（逗号分隔）| s 英文短码 | u 码位串 | cat/catName 分类
 *
 * 两条硬约束在这里落实：
 *   ① **404KB 不许进首屏包** —— 本模块顶层**不** import 那份 JSON，
 *      只在 `loadEmojiIndex()` 里用 `await import()` 拉 ⇒ 打包器切出独立异步分块，
 *      用户第一次真正用到时才下载（Webpack 给它内容哈希，浏览器可长期缓存）。
 *   ② 搜索"中英都认" —— 每条数据预拼一个 `hay = n + k + s`（转小写），
 *      查询串按空白分词后**每个词都要命中**（子串匹配，不是前缀匹配：
 *      "高兴"要能从"不高兴"里搜到）。1916 条实测单次 0.86ms，无需任何索引结构。
 */

/** 原始数据条目（与 emoji-data.json 的字段一一对应） */
export interface EmojiEntry {
    c: string;
    n: string;
    k?: string;
    s?: string;
    u?: string;
    cat?: string;
    catName?: string;
}

/** 建好 `hay` 索引后的条目（搜索与面板都用它） */
export interface EmojiIndexItem extends EmojiEntry {
    /** n + k + s 拼成、已转小写的检索面 */
    hay: string;
}

/**
 * 空查询时最多渲染多少条 —— 出自 Obsidian 插件（`MAX_RENDER = 140`）：
 * 一次性往 DOM 里塞 1916 个格子会卡，而人眼在面板里本来就翻不到 140 条以后。
 * 手机端可再调小（见 emoji-picker.tsx）。
 */
export const EMOJI_MAX_RENDER = 140;

/** 给每条数据预拼检索面（1916 条约 11ms，只在懒加载时做一次） */
export function buildEmojiIndex(entries: EmojiEntry[]): EmojiIndexItem[] {
    return entries.map((entry) => ({
        ...entry,
        hay: `${entry.n ?? ''} ${entry.k ?? ''} ${entry.s ?? ''}`.toLowerCase(),
    }));
}

/**
 * 在已建好的索引里搜索。
 *
 * - 空查询（或全空白）⇒ 返回前 `limit` 条（"全部"视图）；
 * - 否则按空白分词，**每个词都要命中** `hay`（子串匹配，大小写不敏感）；
 * - 结果最多 `limit` 条。
 */
export function searchEmojis(
    index: EmojiIndexItem[],
    query: string,
    limit: number = EMOJI_MAX_RENDER,
): EmojiIndexItem[] {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out: EmojiIndexItem[] = [];
    if (limit <= 0) return out;
    for (const item of index) {
        if (tokens.every((token) => item.hay.includes(token))) {
            out.push(item);
            if (out.length >= limit) break;
        }
    }
    return out;
}

/**
 * 判断一个 emoji 是不是"多个码位拼成的一个视觉符号"（国旗 🇨🇳、家庭 👨‍👩‍👧、
 * 带修饰符的肤色等）。依据 u 字段（十六进制码位串，如 `1f1e8-1f1f3`）：
 *   - 含零宽连接符 `200d` ⇒ 组合 emoji；
 *   - 含两个以上"区域指示符"（1f1e6–1f1ff）⇒ 国旗。
 * 面板用它决定格子的显示宽度（组合 emoji 更宽，容易顶格）。
 */
export function isCombined(u: string | undefined): boolean {
    const parts = (u ?? '').toLowerCase().split(/[-\s]+/).filter(Boolean);
    if (parts.includes('200d')) return true;
    // 区域指示符 U+1F1E6–U+1F1FF：两个以上拼成一个国旗（如 🇨🇳 = 1f1e8-1f1f3）
    const regional = parts.filter((p) => {
        const code = Number.parseInt(p, 16);
        return Number.isFinite(code) && code >= 0x1f1e6 && code <= 0x1f1ff;
    }).length;
    return regional > 1;
}

/** 懒加载缓存（成功后就一直在内存里；251KB 左右，换来零等待） */
let cachedIndex: EmojiIndexItem[] | null = null;
/** 并发去重：多个调用同时来，只触发一次动态 import */
let pendingLoad: Promise<EmojiIndexItem[]> | null = null;

/**
 * 懒加载并建立搜索索引。**只在这里碰那份 404KB 的 JSON**（动态 import）。
 * 同一个 Promise 会被复用，加载完成后结果常驻。
 */
export function loadEmojiIndex(): Promise<EmojiIndexItem[]> {
    if (cachedIndex) return Promise.resolve(cachedIndex);
    if (pendingLoad) return pendingLoad;
    pendingLoad = import('./emoji-data.json')
        .then((mod) => {
            // ESM / CJS 两种口径都兜住：默认导出就是数组；个别打包器会再包一层。
            const raw = (mod as { default?: EmojiEntry[] }).default ?? (mod as unknown as EmojiEntry[]);
            cachedIndex = buildEmojiIndex(raw);
            return cachedIndex;
        })
        .catch((error) => {
            pendingLoad = null; // 失败后允许重试（弱网下很常见）
            throw error;
        });
    return pendingLoad;
}

/** 索引是否已经加载好（供调用方决定要不要触发预取） */
export function isEmojiIndexLoaded(): boolean {
    return cachedIndex !== null;
}
