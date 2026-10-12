/**
 * 学情底账（2026-10-13）—— 内阁页那一块的判据。
 *
 * 守三件事：
 *  ① **口径**：已掌握不算"该练"、"未归本"不是"其他"学科、总数处处一致；
 *  ② **覆盖率**：分母是全部在库题（不是"有结果的题"）—— 分母错了这个数就没意义；
 *  ③ **稳定排序**：题多的在前、同数按 key 固定序，"未归本"永远垫底。
 */

import { describe, it, expect } from 'vitest';
import {
    buildOverview,
    coverageSentence,
    OVERVIEW_URGENT_THRESHOLD,
    type OverviewItem,
} from '@/lib/overview';

const TODAY = new Date(2026, 9, 13); // 2026-10-13

/** 造一份复习结果 */
const res = (planned: ('right' | 'wrong' | null)[], last: 'right' | 'wrong' | null) =>
    JSON.stringify({ planned, last });

let seq = 0;
function item(over: Partial<OverviewItem> = {}): OverviewItem {
    seq += 1;
    return { id: `q${seq}`, ...over };
}

describe('buildOverview —— 学情底账', () => {
    it('空库：一堆 0，不出现 NaN / 不编学科', () => {
        const o = buildOverview([], TODAY);
        expect(o.totals.all).toBe(0);
        expect(o.bySubject).toEqual([]);
        expect(o.coverage.reviewResult).toEqual({ have: 0, all: 0, pct: 0 });
        expect(o.coverage.mistakeCategory.pct).toBe(0);
    });

    it('★ 覆盖率的分母是**全部在库题** —— 不是"有结果的题"（分母错了这个数就没意义）', () => {
        const items = [
            item({ reviewOutcomes: res(['right', null, null], 'right') }),
            item({}), // 没结果
            item({}), // 没结果
            item({}), // 没结果
        ];
        const o = buildOverview(items, TODAY);
        expect(o.coverage.reviewResult).toEqual({ have: 1, all: 4, pct: 25 });
    });

    it('三条覆盖各数各的（有结果 / 有错因 / 定过处置方式 互不代填）', () => {
        const items = [
            item({ reviewOutcomes: res([null, null, null], 'right'), mistakeCategory: 'calc_slip' }),
            item({ mistakeCategory: 'concept_vague', manageType: 'deep' }),
            item({ manageType: 'review' }),
        ];
        const o = buildOverview(items, TODAY);
        expect(o.coverage.reviewResult.have).toBe(1);
        expect(o.coverage.mistakeCategory.have).toBe(2);
        expect(o.coverage.manageType.have).toBe(2);
        // 分母都是 3
        expect([o.coverage.reviewResult.all, o.coverage.mistakeCategory.all, o.coverage.manageType.all]).toEqual([
            3, 3, 3,
        ]);
    });

    it('★ 「未归本」不是「其他」学科，而且永远排在最后', () => {
        const items = [
            item({ subject: 'math' }),
            item({ subject: 'math' }),
            item({ subject: 'math' }),
            item({ subject: 'chinese' }),
            item({ subject: null }), // 没归本
        ];
        const o = buildOverview(items, TODAY);
        expect(o.bySubject.map((s) => s.key)).toEqual(['math', 'chinese', '']);
        const last = o.bySubject[o.bySubject.length - 1];
        expect(last.label).toBe('未归本');
        expect(last.count).toBe(1);
        // 学科名与色来自同一张表（subject-colors），不是这里现编的
        expect(o.bySubject[0]).toMatchObject({ label: '数学', code: 'SX', hex: '#D32F2F', count: 3 });
    });

    it('★ 已掌握（masteryLevel=2）不算"今天该练" —— 四分法里它不进主库，也不该催练', () => {
        // 新题（无结果）本来是 urgency 5 ⇒ 该练
        const normal = item({});
        const mastered = item({ masteryLevel: 2 });
        const o = buildOverview([normal, mastered], TODAY);
        expect(o.totals.all).toBe(2);
        expect(o.totals.mastered).toBe(1);
        expect(o.totals.urgent).toBe(1); // 只有那一张新题
    });

    it('"该练"的判据就是紧迫度到线（与内阁⑦同一条线，不另写一套）', () => {
        const fresh = item({}); // 新 ⇒ 5
        const wrong = item({ reviewOutcomes: res([null, null, null], 'wrong') }); // 刚错 ⇒ 4
        const rightOnce = item({ reviewOutcomes: res([null, null, null], 'right') }); // 连对1 ⇒ 3（不到线）
        const o = buildOverview([fresh, wrong, rightOnce], TODAY);
        expect(OVERVIEW_URGENT_THRESHOLD).toBe(4);
        expect(o.totals.urgent).toBe(2);
    });

    it('状态分布四档齐全（含 0 的那几档也要在，界面才知道该画几个格）', () => {
        const o = buildOverview([item({}), item({})], TODAY);
        expect(o.byReviewState.map((s) => s.state)).toEqual(['new', 'due', 'practicing', 'retired']);
        expect(o.byReviewState.map((s) => s.count)).toEqual([2, 0, 0, 0]);
        expect(o.byReviewState[0].zh).toBe('新');
    });

    it('已退休计数（连对满 3 ⇒ 不必再排）', () => {
        const retired = item({ reviewOutcomes: res(['right', 'right', 'right'], 'right') });
        const o = buildOverview([retired, item({})], TODAY);
        expect(o.totals.retired).toBe(1);
    });

    it('错因分布：按数量倒序，没打错因的单列一项（不混进任何一个错因）', () => {
        const items = [
            item({ mistakeCategory: 'concept_vague' }),
            item({ mistakeCategory: 'concept_vague' }),
            item({ mistakeCategory: 'calc_slip' }),
            item({}), // 没打
        ];
        const o = buildOverview(items, TODAY);
        expect(o.byMistakeCategory[0]).toMatchObject({ key: 'concept_vague', count: 2 });
        const none = o.byMistakeCategory.find((x) => x.key === '__none__');
        expect(none?.count).toBe(1);
    });

    it('没人漏打错因时，就不出现"没打错因"那一行（空行会让人以为漏了）', () => {
        const o = buildOverview([item({ mistakeCategory: 'calc_slip' })], TODAY);
        expect(o.byMistakeCategory.some((x) => x.key === '__none__')).toBe(false);
    });

    it('每个学科的小账相加 = 总数（不重不漏）', () => {
        const items = [
            item({ subject: 'math' }),
            item({ subject: 'chinese' }),
            item({ subject: null }),
            item({ subject: 'math', masteryLevel: 2 }),
        ];
        const o = buildOverview(items, TODAY);
        expect(o.bySubject.reduce((s, x) => s + x.count, 0)).toBe(o.totals.all);
        expect(o.byReviewState.reduce((s, x) => s + x.count, 0)).toBe(o.totals.all);
    });
});

describe('coverageSentence —— 别让覆盖率藏在数字堆里', () => {
    it('空库说"还没有错题"，不说百分比', () => {
        expect(coverageSentence({ have: 0, all: 0, pct: 0 })).toContain('还没有在库的错题');
    });
    it('一条结果都没有时，明说"任何状态都只是占位"', () => {
        const s = coverageSentence({ have: 0, all: 12, pct: 0 });
        expect(s).toContain('0 / 12');
        expect(s).toContain('占位');
    });
    it('不到 30% 提醒"样本还薄"', () => {
        expect(coverageSentence({ have: 3, all: 20, pct: 15 })).toContain('样本还薄');
    });
    it('30–69% 说"能看出大方向"', () => {
        expect(coverageSentence({ have: 10, all: 20, pct: 50 })).toContain('大方向');
    });
    it('70% 以上才说"结论可以当真"', () => {
        expect(coverageSentence({ have: 18, all: 20, pct: 90 })).toContain('可以当真');
    });
    it('英文档也要给（这一页有中英两套文案）', () => {
        expect(coverageSentence({ have: 3, all: 20, pct: 15 }, false)).toContain('thin');
    });
});
