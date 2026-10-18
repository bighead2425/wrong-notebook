/**
 * 日积月累提示词 · "回指"那一段的拼装（2026-10-18）
 *
 * 钉住两件事：
 *   · 没有旧条目时不能留一个空占位（模型会以为"这里应该有内容"）；
 *   · 旧条目只给**标题 + 开头**，不给全文（否则它会拿旧内容糊弄这一次的整理）。
 */

import { describe, it, expect } from 'vitest';
import { generateInsightsPrompt } from '@/lib/ai/prompts';

const base = { rawContent: '我以为分子大就大，后来发现不是。' };

describe('generateInsightsPrompt · 回指', () => {
    it('没有旧条目 ⇒ 明说"以前还没记过类似的"', () => {
        const p = generateInsightsPrompt(base);
        expect(p).toContain('（她以前还没记过类似的。）');
        // 不应该留着一个光秃秃的占位符
        expect(p).not.toContain('{{related_notes}}');
    });

    it('有旧条目 ⇒ 编号 + 内容都进提示词', () => {
        const p = generateInsightsPrompt({
            ...base,
            relatedNotes: [
                { code: 'JL20261012003', content: '#### 📌 中心思想怎么写\n第一次：看开头结尾' },
                { code: 'JL20261015007', content: '#### 📌 中心思想怎么写\n第二次：看反复出现的词' },
            ],
        });
        expect(p).toContain('JL20261012003');
        expect(p).toContain('JL20261015007');
        expect(p).toContain('第一次：看开头结尾');
        expect(p).not.toContain('（她以前还没记过类似的。）');
    });

    it('旧条目太长 ⇒ 每条只留开头（不让旧内容淹掉这次的原料）', () => {
        const unit = '很长的旧内容'; // 6 字
        const long = unit.repeat(60); // 360 字
        const p = generateInsightsPrompt({ ...base, relatedNotes: [{ code: 'JL20260101001', content: long }] });
        expect(p).not.toContain(long); // 整段没进去
        expect(p).not.toContain(unit.repeat(21)); // 126 字，已经越过 120 字的上限
        expect(p).toContain(unit.repeat(20)); // 正好留在 120 字以内
    });

    it('空数组与 null 走同一条兜底', () => {
        expect(generateInsightsPrompt({ ...base, relatedNotes: [] })).toContain('（她以前还没记过类似的。）');
        expect(generateInsightsPrompt({ ...base, relatedNotes: null })).toContain('（她以前还没记过类似的。）');
    });
});
