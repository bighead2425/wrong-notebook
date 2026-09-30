import { describe, expect, it } from 'vitest';
import {
    getMistakeCategoryLabel,
    groupOf,
    isMistakeCategory,
    MISTAKE_CATEGORIES,
    MISTAKE_GROUPS,
    normalizeMistakeCategory,
    pickPrimaryCategory,
    priorityOf,
} from '@/lib/mistake-category';

/**
 * 错因分类（2026-09-30 换代：6 个自由分类 → **8 种、分 3 组、带优先级**）。
 *
 * 钉住的是他口述的三条规矩，不是实现细节：
 *   ① 8 种分三组（不掌握 / 没做对 / 其他），组决定复习类型（见 manage-type.test）
 *   ② **顺序即优先级**，一题只留一个错因
 *   ③ 旧值能平滑搬过来（库里不能留两套说法）
 */
describe('错因分类 · 8 种三组', () => {
    it('8 种，顺序就是他列的那个顺序（顺序 = 优先级，改顺序就是改优先级）', () => {
        expect(MISTAKE_CATEGORIES).toEqual([
            'concept_vague',
            'knowledge_gap',
            'memory_weak',
            'misread',
            'calc_slip',
            'fixed_mindset',
            'just_record',
            'unknown_reason',
        ]);
    });

    it('三组，每组三个 / 三个 / 两个，且不重不漏', () => {
        expect(MISTAKE_GROUPS.map((g) => g.zh)).toEqual(['不掌握', '没做对', '其他']);
        expect(MISTAKE_GROUPS[0].items).toEqual(['concept_vague', 'knowledge_gap', 'memory_weak']);
        expect(MISTAKE_GROUPS[1].items).toEqual(['misread', 'calc_slip', 'fixed_mindset']);
        expect(MISTAKE_GROUPS[2].items).toEqual(['just_record', 'unknown_reason']);
        const flat = MISTAKE_GROUPS.flatMap((g) => g.items);
        expect([...flat].sort()).toEqual([...MISTAKE_CATEGORIES].sort());
    });

    it('错因 → 组', () => {
        expect(groupOf('knowledge_gap')).toBe('not_mastered');
        expect(groupOf('calc_slip')).toBe('not_right');
        expect(groupOf('unknown_reason')).toBe('other');
    });

    it('优先级序号从 1 起，与数组顺序一致', () => {
        expect(priorityOf('concept_vague')).toBe(1);
        expect(priorityOf('knowledge_gap')).toBe(2);
        expect(priorityOf('calc_slip')).toBe(5);
        expect(priorityOf('unknown_reason')).toBe(8);
    });
});

describe('错因分类 · 一题只留一个（越靠前越优先）', () => {
    it('★ 他举的那个例子：知识盲区(2) + 计算失误(5) ⇒ **记知识盲区**', () => {
        expect(pickPrimaryCategory(['calc_slip', 'knowledge_gap'])).toBe('knowledge_gap');
    });

    it('多个候选取优先级最高的那个（与传入顺序无关）', () => {
        expect(pickPrimaryCategory(['unknown_reason', 'fixed_mindset', 'concept_vague'])).toBe('concept_vague');
        expect(pickPrimaryCategory(['just_record', 'misread'])).toBe('misread');
    });

    it('单个候选取它自己', () => {
        expect(pickPrimaryCategory(['memory_weak'])).toBe('memory_weak');
    });

    it('空数组 / 全不认识 ⇒ null（保持"没打标"，不硬塞一个）', () => {
        expect(pickPrimaryCategory([])).toBeNull();
        expect(pickPrimaryCategory(null)).toBeNull();
        expect(pickPrimaryCategory('concept_vague')).toBeNull();
    });
});

describe('错因分类 · 归一化与旧值迁移', () => {
    it('合法值原样通过（含大小写与空白容错）', () => {
        expect(normalizeMistakeCategory('concept_vague')).toBe('concept_vague');
        expect(normalizeMistakeCategory(' CALC_SLIP ')).toBe('calc_slip');
    });

    it('空值 = "还没打标"，与"打了未知错因"不是一回事', () => {
        expect(normalizeMistakeCategory(null)).toBeNull();
        expect(normalizeMistakeCategory(undefined)).toBeNull();
        expect(normalizeMistakeCategory('')).toBeNull();
        expect(normalizeMistakeCategory('   ')).toBeNull();
    });

    it('★ 老枚举的 6 个值按语义搬到新值（库里不许留两套说法）', () => {
        expect(normalizeMistakeCategory('concept')).toBe('concept_vague');
        expect(normalizeMistakeCategory('blank')).toBe('knowledge_gap');
        expect(normalizeMistakeCategory('no_method')).toBe('knowledge_gap');
        expect(normalizeMistakeCategory('missed_condition')).toBe('misread');
        expect(normalizeMistakeCategory('computation')).toBe('calc_slip');
        expect(normalizeMistakeCategory('other')).toBe('unknown_reason');
    });

    it('完全不认识的值落到"未知错因"，绝不留非法值在库里', () => {
        expect(normalizeMistakeCategory('Calculation')).toBe('unknown_reason');
        expect(normalizeMistakeCategory('看漏条件')).toBe('unknown_reason');
        expect(normalizeMistakeCategory(123)).toBe('unknown_reason');
    });

    it('标签可中英切换，空值返回空串', () => {
        expect(getMistakeCategoryLabel('knowledge_gap')).toBe('知识盲区');
        expect(getMistakeCategoryLabel('knowledge_gap', 'en')).toBe('Knowledge gap');
        expect(getMistakeCategoryLabel(null)).toBe('');
    });

    it('isMistakeCategory 只对合法值返回 true', () => {
        expect(isMistakeCategory('fixed_mindset')).toBe(true);
        expect(isMistakeCategory('nope')).toBe(false);
        expect(isMistakeCategory('blank')).toBe(false); // 旧值不算合法值（要经归一化）
        expect(isMistakeCategory(null)).toBe(false);
    });
});
