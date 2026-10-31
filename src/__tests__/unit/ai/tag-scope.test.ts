/**
 * 「给 AI 看哪几册」的规则测试。
 *
 * 这条规则决定模型能看到的候选范围：给多了会稀释注意力（噪音），
 * 给少了会把正常的题逼成 UNMATCHED。两头都是错的，所以要钉住。
 */
import { describe, expect, it } from 'vitest';
import { GRADE_TO_TOPNODE, topNodeNamesForSubject, topNodeNamesUpTo } from '@/lib/ai/tag-scope';

describe('topNodeNamesUpTo · 小学只给"当前年级 + 上一学年"', () => {
    it('★ 五年级 ⇒ 四下、五上、五下（不含一~三，也不含六年级）', () => {
        expect(topNodeNamesUpTo(5)).toEqual(['四年级上', '四年级下', '五年级上', '五年级下']);
    });

    it('★ 一年级没有"上一年"，只给本年级两册（不能出现"零年级"）', () => {
        expect(topNodeNamesUpTo(1)).toEqual(['一年级上', '一年级下']);
    });

    it('六年级 ⇒ 五上~六下（准备小升初，上一学年仍要看）', () => {
        expect(topNodeNamesUpTo(6)).toEqual(['五年级上', '五年级下', '六年级上', '六年级下']);
    });

    it('小学任何一个年级都不会带上初中/高中（学段不能串）', () => {
        for (let g = 1; g <= 6; g++) {
            const names = topNodeNamesUpTo(g);
            expect(names.some((n) => n.includes('七年级') || n.includes('高一'))).toBe(false);
        }
    });
});

describe('topNodeNamesUpTo · 中学保持累进', () => {
    it('八年级 ⇒ 七上到八下（小学不进清单）', () => {
        expect(topNodeNamesUpTo(8)).toEqual([
            '七年级上', '七年级下', '八年级上', '八年级下',
        ]);
    });

    it('高三 ⇒ 从高一上累到高三下', () => {
        const names = topNodeNamesUpTo(12);
        expect(names[0]).toBe('高一上');
        expect(names[names.length - 1]).toBe('高三下');
        expect(names).toHaveLength(6);
    });
});

describe('topNodeNamesUpTo · 年级未知', () => {
    it('null ⇒ 全给（宁可多给，也不要在"不知道几年级"时什么都不给）', () => {
        const all = topNodeNamesUpTo(null);
        expect(all.length).toBe(Object.values(GRADE_TO_TOPNODE).flat().length);
        expect(all).toContain('五年级上');
        expect(all).toContain('高三下');
    });
});

describe('GRADE_TO_TOPNODE · 小学习表必须是一册一个节点', () => {
    it('小学 6 个年级 ⇒ 12 册，不重复', () => {
        const primary = [1, 2, 3, 4, 5, 6].flatMap((g) => GRADE_TO_TOPNODE[g]);
        expect(primary).toHaveLength(12);
        expect(new Set(primary).size).toBe(12);
    });
});

describe('topNodeNamesForSubject · 两类学科两套口径', () => {
    it('★ 链条型（数学）五年级 ⇒ 四下到五下（按册，含上一学年）', () => {
        expect(topNodeNamesForSubject('math', 5)).toEqual([
            '四年级上', '四年级下', '五年级上', '五年级下',
        ]);
    });

    it('★ 能力型（语文）五年级 ⇒ 只给「小学」一个学段', () => {
        expect(topNodeNamesForSubject('chinese', 5)).toEqual(['小学']);
    });

    it('能力型（英语）八年级 ⇒ 初中；高二 ⇒ 高中', () => {
        expect(topNodeNamesForSubject('english', 8)).toEqual(['初中']);
        expect(topNodeNamesForSubject('english', 11)).toEqual(['高中']);
    });

    it('政史地同样按学段（历史：八年级 ⇒ 初中）', () => {
        expect(topNodeNamesForSubject('history', 8)).toEqual(['初中']);
        expect(topNodeNamesForSubject('geography', 11)).toEqual(['高中']);
        expect(topNodeNamesForSubject('politics', 5)).toEqual(['小学']);
    });

    it('年级未知 ⇒ 三个学段全给（能力型），不能返回空', () => {
        expect(topNodeNamesForSubject('chinese', null)).toEqual(['小学', '初中', '高中']);
    });

    it('未登记的学科默认按册处理（不会因为漏登记就一条都不给）', () => {
        expect(topNodeNamesForSubject('unknown-subject', 5)).toEqual([
            '四年级上', '四年级下', '五年级上', '五年级下',
        ]);
    });
});
