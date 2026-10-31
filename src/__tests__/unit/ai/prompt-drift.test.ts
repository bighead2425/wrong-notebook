/**
 * 提示词"双份"漂移的自愈测试
 *
 * 【2026-10-31 事故】提示词可以存在配置里（`config.prompts.analyze`）。
 * 存了副本之后，代码里加的 `<mistake_category>` 永远到不了运行时 ——
 * v143 上线时，容器日志里那份 system prompt 里根本没有它，
 * 而我以为"改代码就生效了"。同一天还发现那份旧副本里留着一条
 * 代码里早就没有的"小学补充白名单"，模型照着它选标签，
 * 看上去像"AI 又自己编标签"。
 *
 * 修法不是"记得两边都改"（人一定会忘），而是让模板自愈：
 * 缺哪个字段，就把那段字段规格补在后面。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYZE_TEMPLATE, withRequiredOutputTags } from '@/lib/ai/prompts';

describe('withRequiredOutputTags · 缺字段就自愈', () => {
    it('★ 旧模板没有 mistake_category ⇒ 自动补上', () => {
        const oldTemplate = '一个很旧的模板，只有 <subject> 和 <knowledge_points>。';
        const out = withRequiredOutputTags(oldTemplate);

        expect(out).toContain('<mistake_category>');
        expect(out).toContain('</mistake_category>');
        /* 11 个取值里至少要有这几个 key —— 少了模型就会乱填 */
        expect(out).toContain('concept_vague');
        expect(out).toContain('interpretation_error');
        expect(out).toContain('unknown_reason');
    });

    it('★ 补的时候要说明"以实际列出的为准"——否则旧模板里那句"N 个标签"会打架', () => {
        const out = withRequiredOutputTags('必须严格包含上述 9 个 XML 标签。');
        expect(out).toContain('以实际列出的标签为准');
        /* 原文保留，不做篡改（用户可能自己改过措辞） */
        expect(out).toContain('必须严格包含上述 9 个 XML 标签。');
    });

    it('模板已经有该字段 ⇒ 原样返回，一个字都不加', () => {
        const already = DEFAULT_ANALYZE_TEMPLATE;
        expect(withRequiredOutputTags(already)).toBe(already);
    });

    it('默认模板本身必须带齐必填字段（不然自愈就成了唯一的来源）', () => {
        expect(DEFAULT_ANALYZE_TEMPLATE).toContain('<mistake_category>');
    });

    it('默认模板不再写死字段数量（写死数字＝下一次必然漂移）', () => {
        expect(DEFAULT_ANALYZE_TEMPLATE).not.toMatch(/包含上述 \d+ 个 XML 标签/);
        expect(DEFAULT_ANALYZE_TEMPLATE).toMatch(/包含上述\*\*全部\*\* XML 标签/);
    });
});
