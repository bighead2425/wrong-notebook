import { describe, expect, it } from 'vitest';
import {
    getMistakeCategoryLabel,
    isMistakeCategory,
    MISTAKE_CATEGORIES,
    normalizeMistakeCategory,
} from '@/lib/mistake-category';

describe('错因分类（AI 的输出标签，不印在纸上 —— P16）', () => {
    it('P16 原定的 5 类应当都在枚举里，且顺序稳定', () => {
        expect(MISTAKE_CATEGORIES).toEqual([
            'missed_condition',
            'no_method',
            'computation',
            'concept',
            'blank',
            'other',
        ]);
    });

    it('合法值原样通过（含大小写与空白容错）', () => {
        expect(normalizeMistakeCategory('concept')).toBe('concept');
        expect(normalizeMistakeCategory(' BLANK ')).toBe('blank');
        expect(normalizeMistakeCategory('Missed_Condition')).toBe('missed_condition');
    });

    it('空值表示"还没打标"，与"打了 other"不是一回事', () => {
        expect(normalizeMistakeCategory(null)).toBeNull();
        expect(normalizeMistakeCategory(undefined)).toBeNull();
        expect(normalizeMistakeCategory('')).toBeNull();
        expect(normalizeMistakeCategory('   ')).toBeNull();
    });

    it('不认识的值落到 other，绝不留非法值在库里', () => {
        // 外部导入通道写进 errorType 的就是这种英文词，绝不能串进本列
        expect(normalizeMistakeCategory('Calculation')).toBe('other');
        expect(normalizeMistakeCategory('看漏条件')).toBe('other');
        expect(normalizeMistakeCategory(123)).toBe('other');
    });

    it('标签可中英切换，空值返回空串', () => {
        expect(getMistakeCategoryLabel('missed_condition')).toBe('看漏条件');
        expect(getMistakeCategoryLabel('missed_condition', 'en')).toBe('Missed a condition');
        expect(getMistakeCategoryLabel(null)).toBe('');
        expect(getMistakeCategoryLabel('不认识的词')).toBe('其他');
    });

    it('isMistakeCategory 只对合法值返回 true', () => {
        expect(isMistakeCategory('no_method')).toBe(true);
        expect(isMistakeCategory('nope')).toBe(false);
        expect(isMistakeCategory(null)).toBe(false);
        expect(isMistakeCategory(999)).toBe(false);
    });
});
