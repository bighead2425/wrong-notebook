import { describe, expect, it } from 'vitest';
import { GRADE_TERMS, normalizeTerm, splitGradeText, termLabel, volumeMatchesTerm } from '@/lib/grade-term';
import { ATTENTION_LEVELS, attentionLabel, attentionLevelOf, cycleAttentionLevel, isAttentionUnfiltered, toggleAttentionLevel } from '@/lib/attention-level';

/**
 * 年级·学期的归一（复练卷页"年级/学期"筛选用）。
 *
 * 为什么需要归一：库里存的是 `六年级上`（打印页眉上见到的就是它），
 * 他嘴上说的是 `小六上`；初中还有 `初一` / `七年级` 两套写法。
 * 直接字符串比就会"明明有卷却筛不出来"。
 */
describe('年级·学期 · 选项表', () => {
    it('24 个学期：小学 6 + 初中 3 + 高中 3，每个 上/下 —— 从 小一上 到 高三下', () => {
        expect(GRADE_TERMS).toHaveLength(24);
        expect(GRADE_TERMS[0]).toEqual({ key: '一年级上', label: '小一上' });
        expect(GRADE_TERMS[23]).toEqual({ key: '高三下', label: '高三下' });
        // 顺序就是他说的那串：小一上 小一下 小二上 …… 高三下
        expect(GRADE_TERMS.slice(0, 4).map((t) => t.label)).toEqual(['小一上', '小一下', '小二上', '小二下']);
    });

    it('termLabel：规范键 → 他习惯的短名（认不出就原样返回，不抛）', () => {
        expect(termLabel('六年级上')).toBe('小六上');
        expect(termLabel('初一上')).toBe('初一上');
        expect(termLabel('火星上')).toBe('火星上');
    });
});

describe('年级·学期 · 归一', () => {
    it('★ 三种写法都归到同一个键：小六上 / 六年级上 / 6年级上', () => {
        expect(normalizeTerm('小六上')).toBe('六年级上');
        expect(normalizeTerm('六年级上')).toBe('六年级上');
        expect(normalizeTerm('6年级上')).toBe('六年级上');
    });

    it('初中两套叫法互通：七年级下 ≡ 初一下', () => {
        expect(normalizeTerm('七年级下')).toBe('初一下');
        expect(normalizeTerm('初一下')).toBe('初一下');
    });

    it('认不出的一律 null（**不猜** —— 猜错会筛出空列表，让人以为卷丢了）', () => {
        expect(normalizeTerm('六年级')).toBeNull(); // 缺学期
        expect(normalizeTerm('2026-秋')).toBeNull();
        expect(normalizeTerm('')).toBeNull();
        expect(normalizeTerm(null)).toBeNull();
    });
});

describe('年级·学期 · 卷的匹配', () => {
    it('跨本组卷（六年级上·五年级上）：命中任一部分就算', () => {
        expect(splitGradeText('六年级上·五年级上')).toEqual(['六年级上', '五年级上']);
        expect(volumeMatchesTerm('六年级上·五年级上', '五年级上')).toBe(true);
        expect(volumeMatchesTerm('六年级上·五年级上', '三年级上')).toBe(false);
    });

    it('写法不同也能命中（卷里存"六年级上"、筛的是"小六上"）', () => {
        expect(volumeMatchesTerm('六年级上', normalizeTerm('小六上')!)).toBe(true);
        expect(volumeMatchesTerm('六年级上，五年级上', '六年级上')).toBe(true);
    });

    it('空值/脏值不匹配，也不抛', () => {
        expect(volumeMatchesTerm(null, '六年级上')).toBe(false);
        expect(volumeMatchesTerm('乱写的', '六年级上')).toBe(false);
    });
});

/**
 * 等级（关注档 1-5 → 🥉🥈🥇💎👑）。
 * 他说"先改显示，分级以后再说" ⇒ 只测显示映射，不动数据语义。
 */
describe('等级 · 奖牌映射', () => {
    it('1-5 对应 青铜/白银/黄金/钻石/王者', () => {
        expect(ATTENTION_LEVELS.map((l) => l.medal)).toEqual(['🥉', '🥈', '🥇', '💎', '👑']);
        expect(attentionLevelOf(1).zh).toBe('青铜');
        expect(attentionLevelOf(3).zh).toBe('黄金');
        expect(attentionLevelOf(5).zh).toBe('王者');
    });

    it('越界/空值兜底到青铜，绝不返回 undefined', () => {
        expect(attentionLevelOf(0).zh).toBe('青铜');
        expect(attentionLevelOf(9).zh).toBe('王者');
        expect(attentionLevelOf(null).zh).toBe('青铜');
        expect(attentionLevelOf(undefined).zh).toBe('青铜');
    });

    it('显示串：徽章 + 名称（中/英）', () => {
        expect(attentionLabel(3, true)).toBe('🥇 黄金');
        expect(attentionLabel(3, false)).toBe('🥇 Gold');
    });
});

/**
 * 【2026-09-30】等级在界面上有两个动作，两条规则都写进 lib（唯一实现）：
 *   ① 卡片右边那枚奖牌点一下：**升一级，👑 之后回 🥉**
 *   ② 「等级」多选下拉点一下：切换勾选，但**至少留一个勾**
 */
describe('等级 · 点一下升一级（卡片上的奖牌）', () => {
    it('1→2→3→4→5，5 之后回 1', () => {
        expect(cycleAttentionLevel(1)).toBe(2);
        expect(cycleAttentionLevel(2)).toBe(3);
        expect(cycleAttentionLevel(3)).toBe(4);
        expect(cycleAttentionLevel(4)).toBe(5);
        expect(cycleAttentionLevel(5)).toBe(1);
    });

    it('空值 / 越界值也能安全升（老数据没有这道坎）', () => {
        expect(cycleAttentionLevel(null)).toBe(2); // 空按青铜(1) 算 ⇒ 升到白银
        expect(cycleAttentionLevel(9)).toBe(1); // 越界按王者(5) 算 ⇒ 回青铜
    });
});

describe('等级 · 多选下拉的勾选', () => {
    it('点没勾的 ⇒ 勾上，并按 1→5 排序（URL 参数才是稳定的 1,3,5）', () => {
        expect(toggleAttentionLevel([1, 5], 3)).toEqual([1, 3, 5]);
        expect(toggleAttentionLevel([4], 2)).toEqual([2, 4]);
    });

    it('点已勾的 ⇒ 取消它', () => {
        expect(toggleAttentionLevel([1, 3, 5], 3)).toEqual([1, 5]);
    });

    it('★ 只剩一个勾时，点它不动 —— 他明说的"不能让对号消失"', () => {
        expect(toggleAttentionLevel([3], 3)).toEqual([3]);
        expect(toggleAttentionLevel([1, 3], 1)).toEqual([3]);
    });

    it('5 档全选 = 没筛（判"已筛"、决定要不要传 attention 参数都用它）', () => {
        expect(isAttentionUnfiltered([1, 2, 3, 4, 5])).toBe(true);
        expect(isAttentionUnfiltered([1, 2, 3, 4])).toBe(false);
        expect(isAttentionUnfiltered([])).toBe(false);
    });
});
