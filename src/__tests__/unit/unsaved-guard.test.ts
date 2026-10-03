import { describe, it, expect } from 'vitest';
import {
    reviewLayoutDirty,
    shouldWarnBeforeLeaving,
    unsavedLeaveMessage,
    type ReviewLayoutBaseline,
} from '@/lib/unsaved-guard';

/**
 * 需求第 4 条那套"未保存版面防护"的**纯逻辑**。
 * 钉住三件事：
 *   · 复练卷页原来没有的脏检查怎么判（改了就脏、拖回去就不脏）；
 *   · "该不该拦"只在 dirty 时为真（没改别乱弹确认）；
 *   · 确认文案双语都指名动作。
 */

const baseline: ReviewLayoutBaseline = {
    defaultBlankLines: 5,
    blankLines: { a: 5, b: 3 },
    figureScale: { a: 100, b: 80 },
};

describe('复练卷页 · 版面改过没有', () => {
    it('原样不动 ⇒ 不脏', () => {
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 5, b: 3 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(false);
    });

    it('★ 留白改了 ⇒ 脏', () => {
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 6, b: 3 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(true);
    });

    it('★ 题图改了 ⇒ 脏', () => {
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 5, b: 3 },
                figureScales: { a: 120, b: 80 },
            }),
        ).toBe(true);
    });

    it('整卷默认留白改了 ⇒ 脏', () => {
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 6,
                blankOverrides: { a: 5, b: 3 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(true);
    });

    it('★ 改大了又拖回原值 ⇒ 不脏（比的是值，不是"动过控件"）', () => {
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 8, b: 3 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(true);
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 5, b: 3 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(false);
    });

    it('留白写 null ⇒ 跟默认走；默认没变就不脏', () => {
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: null, b: 3 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(false);
    });

    it('题图两侧都归一（100 vs 100）⇒ 不脏', () => {
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 5, b: 3 },
                figureScales: { a: 100.0001, b: 80 },
            }),
        ).toBe(false);
    });

    it('草稿多出一个 key ⇒ 看它落到什么值：等于默认不算改，不等于默认才算', () => {
        // c 不在基线里 ⇒ 基线侧它按默认 5；草稿显式给 7 ⇒ 脏
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 5, b: 3, c: 7 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(true);
        // 草稿给 c=5（正好等于默认）⇒ 与基线侧等价，不脏
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 5, b: 3, c: 5 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(false);
    });

    it('基线里的一道题被草稿漏掉、落到默认 ⇒ 若默认≠原值则脏', () => {
        // b 原来 3，草稿没设 ⇒ 走默认 5 ⇒ 脏
        expect(
            reviewLayoutDirty(baseline, {
                defaultBlankLines: 5,
                blankOverrides: { a: 5 },
                figureScales: { a: 100, b: 80 },
            }),
        ).toBe(true);
    });
});

describe('该不该拦 + 拦下来说什么', () => {
    it('没改 ⇒ 不拦，别拿确认烦人', () => {
        expect(shouldWarnBeforeLeaving(false)).toBe(false);
    });

    it('改了 ⇒ 拦', () => {
        expect(shouldWarnBeforeLeaving(true)).toBe(true);
    });

    it('中文文案指名动作', () => {
        const msg = unsavedLeaveMessage(true, '切换卷', 'Switch volume');
        expect(msg).toContain('切换卷');
        expect(msg).toContain('还没保存');
    });

    it('英文文案指名动作', () => {
        const msg = unsavedLeaveMessage(false, '切换卷', 'Switch volume');
        expect(msg).toContain('Switch volume');
        expect(msg.toLowerCase()).toContain('unsaved');
    });
});
