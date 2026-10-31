import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYZE_TEMPLATE, upgradeKnowledgePointsBlock } from '@/lib/ai/prompts';

/**
 * 【2026-10-31】这条测试守的是"上次踩过的坑"：
 *
 * 提示词可以存在配置里（`config.prompts.analyze`），而配置里那份副本
 * 永远不会自动跟着代码更新。上次加 `<mistake_category>` 就是这样静默失效的。
 *
 * 这次改的是**顺序 + 格式**，而"补缺失字段"的自愈函数管不了顺序。
 * 所以必须验证：喂一份旧模板进来，输出的标签段既在 analysis 之后、又是新格式。
 */

describe('upgradeKnowledgePointsBlock', () => {
    it('代码里的默认模板：标签段在 analysis 之后，且是新格式', () => {
        const out = upgradeKnowledgePointsBlock(DEFAULT_ANALYZE_TEMPLATE);
        expect(out.indexOf('<knowledge_points>')).toBeGreaterThan(out.indexOf('<analysis>'));
        expect(out).toContain('<kp book=');
        expect(out).toContain('<book_reason>');
    });

    it('配置里的旧模板（逗号分隔、位置在前）⇒ 挪到最后并升级格式', () => {
        const legacy = `【角色】
你是分析专家。
<knowledge_points>
知识点1, 知识点2
</knowledge_points>
<question_text>题目</question_text>
<analysis>解析</analysis>`;

        const out = upgradeKnowledgePointsBlock(legacy);
        expect(out.indexOf('<knowledge_points>')).toBeGreaterThan(out.indexOf('<analysis>'));
        expect(out).toContain('<kp book=');
        // 旧的分隔说明必须消失，否则模型会同时看到两种格式要求
        expect(out).not.toContain('知识点1, 知识点2');
    });

    it('book_reason 只会出现一次（不重复拼接）', () => {
        const withReason = `<analysis>a</analysis>
<knowledge_points><kp book="五年级上" name="x"/></knowledge_points>
<book_reason>旧判据</book_reason>`;
        const out = upgradeKnowledgePointsBlock(withReason);
        expect(out.match(/<book_reason>/g)).toHaveLength(1);
    });

    it('完全没有标签段的模板 ⇒ 补一个在末尾（老副本最简形态）', () => {
        const bare = `【角色】分析专家。\n<analysis>解析</analysis>`;
        const out = upgradeKnowledgePointsBlock(bare);
        expect(out).toContain('<knowledge_points>');
        expect(out.indexOf('<knowledge_points>')).toBeGreaterThan(out.indexOf('<analysis>'));
    });
});
