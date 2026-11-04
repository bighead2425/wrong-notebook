/**
 * 【2026-11-04 审计 C4】回归钉：**快照优先，题库现值只兜底。**
 *
 * 错的版本是"现值优先"：只调一下留白、点"更新组卷"，卷里的题干就被刷成现在的内容。
 * 后果不是显示问题 —— 是**补印的纸和已经发出去的那张对不上**，
 * 而纸上那份才是她做过题、划过勾的凭证。
 */

import { describe, it, expect } from 'vitest';
import { resolveVolumeSnapshot } from '@/lib/volume-snapshot';

describe('resolveVolumeSnapshot —— 快照优先', () => {
    it('有快照 + 题库后来改了 ⇒ **一个字都不动**', () => {
        const out = resolveVolumeSnapshot(
            { itemNo: 'SX20260901001', questionText: '纸上印的题干', manageType: 'review' },
            { source: 'SX20260901001', questionText: '题库里改过的题干', manageType: 'deep' },
        );
        expect(out.questionText).toBe('纸上印的题干');
        expect(out.manageType).toBe('review');
    });

    it('新建行（没有快照）⇒ 从题里取', () => {
        const out = resolveVolumeSnapshot(undefined, {
            source: 'SX20260901002',
            questionText: '现在的题干',
            manageType: 'review',
        });
        expect(out).toEqual({
            itemNo: 'SX20260901002',
            questionText: '现在的题干',
            manageType: 'review',
        });
    });

    it('题被删了（item 缺失）⇒ 仍用快照', () => {
        const out = resolveVolumeSnapshot({ itemNo: 'SX1', questionText: '旧的', manageType: null }, undefined);
        expect(out.itemNo).toBe('SX1');
        expect(out.questionText).toBe('旧的');
    });

    /** 空串要当"没有" —— 否则一个 '' 会把快照顶掉、或者把现值拦下来 */
    it('快照是空串 ⇒ 当作没有，用现值', () => {
        const out = resolveVolumeSnapshot({ questionText: '' }, { questionText: '现值' });
        expect(out.questionText).toBe('现值');
    });

    /** 正文可能被 AI 改写过，OCR 才是纸上的字 —— 没快照时才轮到它们 */
    it('没快照时：正文优先于 OCR', () => {
        const out = resolveVolumeSnapshot(undefined, { questionText: '正文', ocrText: 'OCR 原文' });
        expect(out.questionText).toBe('正文');
    });

    it('没快照也没正文 ⇒ 退回 OCR', () => {
        const out = resolveVolumeSnapshot(undefined, { questionText: null, ocrText: 'OCR 原文' });
        expect(out.questionText).toBe('OCR 原文');
    });

    it('什么都没有 ⇒ 全 null（不抛错）', () => {
        expect(resolveVolumeSnapshot(undefined, undefined)).toEqual({
            itemNo: null,
            questionText: null,
            manageType: null,
        });
    });
});
