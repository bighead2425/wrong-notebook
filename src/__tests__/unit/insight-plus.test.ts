import { describe, expect, it } from 'vitest';
import {
    INSIGHT_PLUS_GLYPH_COLOR,
    INSIGHT_PLUS_LINKED_COLOR,
    INSIGHT_PLUS_PLAIN_COLOR,
    insightPlusColor,
} from '@/lib/insight-plus';

/**
 * 【2026-10-03 需求第 11 条】扫到的积累纸：每条中间那个圆圈加号的配色规则。
 *
 * 钉住三条（他定的）：
 *   · 未关联错题 ⇒ 棕黄；
 *   · 关联了错题 ⇒ 紫；
 *   · 加号白 —— 且两种底色不能撞色（撞了就分不出"有没有关联错题"）。
 */
describe('积累纸 · 圆圈加号配色（需求第 11 条）', () => {
    it('未关联错题（false / null / undefined）⇒ 棕黄', () => {
        expect(insightPlusColor(false)).toBe(INSIGHT_PLUS_PLAIN_COLOR);
        expect(insightPlusColor(null)).toBe(INSIGHT_PLUS_PLAIN_COLOR);
        expect(insightPlusColor(undefined)).toBe(INSIGHT_PLUS_PLAIN_COLOR);
    });

    it('关联了错题 ⇒ 紫', () => {
        expect(insightPlusColor(true)).toBe(INSIGHT_PLUS_LINKED_COLOR);
    });

    it('两种颜色必须不同（否则分不出该条有没有关联错题）', () => {
        expect(INSIGHT_PLUS_PLAIN_COLOR).not.toBe(INSIGHT_PLUS_LINKED_COLOR);
    });

    it('加号一律白色', () => {
        expect(INSIGHT_PLUS_GLYPH_COLOR).toBe('#ffffff');
    });
});
