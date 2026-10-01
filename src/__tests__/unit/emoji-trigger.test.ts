// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EMOJI_QUERY_MAX, parseEmojiTrigger } from '@/lib/emoji-trigger';
import {
    buildEmojiIndex,
    isCombined,
    loadEmojiIndex,
    searchEmojis,
    type EmojiEntry,
} from '@/lib/emoji-search';

/**
 * 【2026-10-01】中文 emoji 选择器的**判定核心**单测。
 *
 * 这一段是"从光标前的文本里找出 `：：…；；`"的纯逻辑，边界最多、最容易出错，
 * 而且它一出错就是"吃掉用户打的字"这种不可接受的事故 —— 所以它被单独抽成
 * 纯函数（src/lib/emoji-trigger.ts），在这里把口径钉死，不跟 ProseMirror 混在一起测。
 *
 * 口径（用户拍板）：`：：` 是开始标记、`；；` 是结束/触发标记，中间是搜索词；
 * 半角 `::` / `;;` 也认；**找不到就返回 null，调用方什么都不做**（原文一个字不动）。
 */
describe('parseEmojiTrigger · 从光标前文本解析 `：：…；；`', () => {
    it('命中：`：：眼镜；；` ⇒ 取到范围与搜索词', () => {
        expect(parseEmojiTrigger('：：眼镜；；')).toEqual({
            start: 0,
            end: 6,
            query: '眼镜',
            raw: '：：眼镜；；',
        });
    });

    it('命中：前面还有正文时，只取最近那一段', () => {
        const hit = parseEmojiTrigger('今天天气不错，：：开心；；');
        expect(hit).not.toBeNull();
        expect(hit!.query).toBe('开心');
        expect(hit!.raw).toBe('：：开心；；');
        expect(hit!.end).toBe('今天天气不错，：：开心；；'.length);
    });

    it('只有 `：：` 没有 `；；` ⇒ 不触发', () => {
        expect(parseEmojiTrigger('：：眼镜')).toBeNull();
    });

    it('只有 `；；` 没有 `：：` ⇒ 不触发（结束标记单独出现没有意义）', () => {
        expect(parseEmojiTrigger('眼镜；；')).toBeNull();
        expect(parseEmojiTrigger('；；')).toBeNull();
    });

    it('单冒号 / 单分号都不算标记', () => {
        expect(parseEmojiTrigger('：：眼镜：')).toBeNull();
        expect(parseEmojiTrigger('；眼镜；；')).toBeNull();
        expect(parseEmojiTrigger('::眼镜:')).toBeNull();
    });

    it('中间为空 ⇒ 不触发', () => {
        expect(parseEmojiTrigger('：：；；')).toBeNull();
        expect(parseEmojiTrigger('：：  ；；')).toBeNull();
        expect(parseEmojiTrigger('::;;')).toBeNull();
    });

    it('半角 `::` / `;;` 都认，且允许半全角混用', () => {
        expect(parseEmojiTrigger('::眼镜;;')?.query).toBe('眼镜');
        expect(parseEmojiTrigger('：：眼镜;;')?.query).toBe('眼镜');
        expect(parseEmojiTrigger('::眼镜；；')?.query).toBe('眼镜');
    });

    it('跨行：标记之间夹换行时，搜索词按 trim 后的结果算', () => {
        const hit = parseEmojiTrigger('：：\n眼镜；；');
        expect(hit?.query).toBe('眼镜');
        expect(hit?.raw).toBe('：：\n眼镜；；'); // raw 保留原样（含换行），插入时用它做原文校验
    });

    it('跨行：开始标记在上一行、结束标记在本行', () => {
        const hit = parseEmojiTrigger('第一行\n：：梯子；；');
        expect(hit?.query).toBe('梯子');
        expect(hit?.start).toBe('第一行\n'.length);
    });

    it('嵌套 / 连续两个标记：取**最近**的那个开始标记', () => {
        expect(parseEmojiTrigger('：：甲：：乙；；')?.query).toBe('乙');
        expect(parseEmojiTrigger('：：：：眼镜；；')?.query).toBe('眼镜');
        expect(parseEmojiTrigger('：：甲：：乙；；')?.start).toBe('：：甲'.length);
    });

    it('结束标记后面还有字（光标不在末尾）⇒ 不触发', () => {
        expect(parseEmojiTrigger('：：眼镜；；后续')).toBeNull();
        expect(parseEmojiTrigger('：：眼镜；； ')).toBeNull(); // 多一个空格都不算
    });

    it('搜索词过长（超过上限）⇒ 不触发，避免把一大段正文当查询', () => {
        const tooLong = 'a'.repeat(EMOJI_QUERY_MAX + 1);
        expect(parseEmojiTrigger(`：：${tooLong}；；`)).toBeNull();
        const justRight = 'a'.repeat(EMOJI_QUERY_MAX);
        expect(parseEmojiTrigger(`：：${justRight}；；`)?.query).toBe(justRight);
    });

    it('★ 上限就是 30（他 2026-10-02 定的规矩，钉死不让人随手改大）', () => {
        // 原话："如果输入 ；； 后，往前倒查 30 个字符，还没有遇到 ：： 的话，
        // 那么就是我真的只是想打 ：：xxx；； 了" ⇒ 日常没人会打这么长的搜索词，
        // 超过就当他在正常写字，**一个字都不许动**。
        expect(EMOJI_QUERY_MAX).toBe(30);
        expect(parseEmojiTrigger(`：：${'字'.repeat(30)}；；`)?.query).toHaveLength(30);
        expect(parseEmojiTrigger(`：：${'字'.repeat(31)}；；`)).toBeNull();
    });

    it('空串 / 无关文本 ⇒ 不触发', () => {
        expect(parseEmojiTrigger('')).toBeNull();
        expect(parseEmojiTrigger('什么都没有')).toBeNull();
    });
});

describe('searchEmojis · 中英子串匹配（合成数据，纯逻辑）', () => {
    const entries: EmojiEntry[] = [
        { c: '🪜', n: '梯子', k: '爬,梯级,阶梯,ladder,climb', s: 'ladder' },
        { c: '👓', n: '眼镜', k: '眼睛,服饰,eyeglasses,eyewear', s: 'glasses' },
        { c: '😀', n: '嘿嘿', k: '笑脸,高兴,smile,grin,happy', s: 'grinning_face' },
    ];
    const index = buildEmojiIndex(entries);

    it('中文名 / 中文关键词都能命中', () => {
        expect(searchEmojis(index, '梯子').map((i) => i.c)).toEqual(['🪜']);
        expect(searchEmojis(index, '眼镜').map((i) => i.c)).toEqual(['👓']);
        expect(searchEmojis(index, '高兴').map((i) => i.c)).toEqual(['😀']);
    });

    it('英文关键词 / 短码也认，且大小写不敏感', () => {
        expect(searchEmojis(index, 'GRIN').map((i) => i.c)).toEqual(['😀']);
        expect(searchEmojis(index, 'Eyeglasses').map((i) => i.c)).toEqual(['👓']);
    });

    it('子串匹配（不是前缀）：“高兴”能从“不高兴”这类词里命中', () => {
        const withNegative: EmojiEntry[] = [{ c: '😀', n: '不高兴变高兴', k: '' }];
        expect(searchEmojis(buildEmojiIndex(withNegative), '高兴')).toHaveLength(1);
    });

    it('空格分词后**每个词都要命中**', () => {
        expect(searchEmojis(index, '梯 爬').map((i) => i.c)).toEqual(['🪜']);
        expect(searchEmojis(index, '梯 眼睛')).toEqual([]);
    });

    it('搜不到 ⇒ 空数组（调用方据此不弹面板）', () => {
        expect(searchEmojis(index, '这个词肯定搜不到xyz')).toEqual([]);
    });

    it('空查询 ⇒ 返回（最多 limit 条）全部', () => {
        expect(searchEmojis(index, '')).toHaveLength(3);
        expect(searchEmojis(index, '   ')).toHaveLength(3);
        expect(searchEmojis(index, '', 2)).toHaveLength(2);
        expect(searchEmojis(index, '', 0)).toHaveLength(0);
    });
});

describe('真实数据（1916 条，懒加载）', () => {
    it('loadEmojiIndex 能加载并建成索引；中文/英文都能搜到', async () => {
        const index = await loadEmojiIndex();
        expect(index.length).toBe(1916);
        expect(searchEmojis(index, '梯子').some((i) => i.c === '🪜')).toBe(true);
        expect(searchEmojis(index, '眼镜').some((i) => i.c === '👓')).toBe(true);
        expect(searchEmojis(index, '高兴').some((i) => i.c === '😀')).toBe(true);
        expect(searchEmojis(index, 'grin').length).toBeGreaterThan(0);
        // 空查询限流到 140（照搬 Obsidian 插件的 MAX_RENDER，防止一次性塞太多 DOM）
        expect(searchEmojis(index, '')).toHaveLength(140);
        // 搜不到词
        expect(searchEmojis(index, '这个词肯定搜不到xyz')).toEqual([]);
    });

    it('isCombined：国旗 / 组合 emoji 认得出，单体 emoji 不是', () => {
        expect(isCombined('1f1e8-1f1f3')).toBe(true); // 🇨🇳 两个区域指示符
        expect(isCombined('1f468-200d-1f469-200d-1f467')).toBe(true); // 👨‍👩‍👧 含 ZWJ
        expect(isCombined('1f600')).toBe(false); // 😀
        expect(isCombined(undefined)).toBe(false);
    });
});
