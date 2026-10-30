import { describe, it, expect } from 'vitest';
import { splitKnowledgePoints } from '@/lib/ai/knowledge-split';

/**
 * 【2026-10-30】知识点切分。
 *
 * 起因是库里真出现过这一对标签：
 *   「等式的性质（等式两边同乘或同除以一个非零数」
 *   「等式仍成立）」
 * 它们都是根节点、各连 0 道题——一个知识点被中文逗号切成了两半。
 */
describe('知识点切分 · 括号内的逗号不算分隔符', () => {
    it('普通逗号分隔', () => {
        expect(splitKnowledgePoints('一元一次方程,移项')).toEqual(['一元一次方程', '移项']);
    });

    it('中文逗号分隔', () => {
        expect(splitKnowledgePoints('分数加法，分数减法')).toEqual(['分数加法', '分数减法']);
    });

    it('★ 括号内的中文逗号不切（真实事故）', () => {
        const raw = '等式的性质（等式两边同乘或同除以一个非零数，等式仍成立）,一元一次方程的解法';
        expect(splitKnowledgePoints(raw)).toEqual([
            '等式的性质（等式两边同乘或同除以一个非零数，等式仍成立）',
            '一元一次方程的解法',
        ]);
    });

    it('英文括号同样保护', () => {
        expect(splitKnowledgePoints('加法(a,b的运算),减法')).toEqual(['加法(a,b的运算)', '减法']);
    });

    it('换行与顿号也当分隔符', () => {
        expect(splitKnowledgePoints('甲\n乙、丙')).toEqual(['甲', '乙', '丙']);
    });

    it('UNMATCHED 是合法输出，不该被当成知识点', () => {
        expect(splitKnowledgePoints('UNMATCHED')).toEqual([]);
        expect(splitKnowledgePoints('unmatched')).toEqual([]);
    });

    it('空值不炸', () => {
        expect(splitKnowledgePoints(null)).toEqual([]);
        expect(splitKnowledgePoints(undefined)).toEqual([]);
        expect(splitKnowledgePoints('')).toEqual([]);
    });

    it('多余空白被去掉', () => {
        expect(splitKnowledgePoints('  甲  ,  乙  ')).toEqual(['甲', '乙']);
    });
});
