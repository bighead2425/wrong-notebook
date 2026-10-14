// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来（jsdom worker 会因内存超时）。
import { describe, expect, it } from 'vitest';
import {
    emptyReviewOutcomes,
    normalizeReviewOutcomes,
    PLANNED_REVIEW_OFFSET_DAYS,
    PLANNED_REVIEW_ROUNDS,
    plannedReviewDates,
    recordReviewResult,
    reviewDots,
    serializeReviewOutcomes,
    setLastOutcome,
    setPlannedOutcome,
} from '@/lib/review-outcomes';

/**
 * 复习结果（错题卡底部那些圆圈）。
 *
 * 【2026-10-14 扩格】计划格从 **3 格 → 4 格**（偏移 +1/+7/+21/+49），
 * 配套 `RETIRE_STREAK` 从 3 改回 4。⇒ 圆点总数 **4 → 5**（4 计划格 + 1 最近一次）。
 *
 * 钉住的是他专门解释过的两条规矩（与格子数无关）：
 *   ① 计划内做完一次 ⇒ **最后一个圈（最近一次）同步成同一结果**
 *      （"只复习了一次做对了，第一个圈是绿勾，最后一个圈也是绿勾"）
 *   ② 计划外再复习 ⇒ **计划圈纹丝不动**，只有最后一个圈变成这一次的结果
 */
describe('复习结果 · 归一化', () => {
    it('空值 / 坏 JSON / 非对象 ⇒ 所有圈都是"没结果"，绝不猜', () => {
        for (const v of [null, undefined, '', '   ', '不是 json', '{}', '[]', 123]) {
            const o = normalizeReviewOutcomes(v);
            expect(o).toEqual(emptyReviewOutcomes());
            expect(o.planned).toEqual([null, null, null, null]);
            expect(o.last).toBeNull();
        }
    });

    it('认 JSON 字符串（库里存的样子）也认对象（写入侧手里的样子）', () => {
        expect(
            normalizeReviewOutcomes('{"planned":["right",null,null,null],"last":"wrong"}')
        ).toEqual({
            planned: ['right', null, null, null],
            last: 'wrong',
        });
        expect(normalizeReviewOutcomes({ planned: ['wrong'], last: 'right' })).toEqual({
            planned: ['wrong', null, null, null],
            last: 'right',
        });
    });

    it('计划位多出来的忽略、缺的补 null；不认识的取值一律当"没结果"', () => {
        expect(
            normalizeReviewOutcomes({ planned: ['right', 'wrong', null, 'right', 'wrong'] }).planned
        ).toEqual(['right', 'wrong', null, 'right']);
        expect(normalizeReviewOutcomes({ planned: ['yes', 'no', 'right'] }).planned).toEqual([
            null,
            null,
            'right',
            null,
        ]);
        expect(normalizeReviewOutcomes({ planned: 'right' }).planned).toEqual([
            null,
            null,
            null,
            null,
        ]);
    });

    it('★ 老的 3 格数据读进来会被补成 4 格（扩格不用写迁移脚本）', () => {
        expect(normalizeReviewOutcomes({ planned: ['right', 'wrong', 'right'], last: 'right' })).toEqual({
            planned: ['right', 'wrong', 'right', null],
            last: 'right',
        });
    });

    it('存库字符串能原样读回来（往返保真）', () => {
        const o = { planned: ['right', 'wrong', null, null] as const, last: 'wrong' as const };
        expect(
            normalizeReviewOutcomes(serializeReviewOutcomes({ planned: [...o.planned], last: o.last }))
        ).toEqual({ planned: ['right', 'wrong', null, null], last: 'wrong' });
    });
});

describe('复习结果 · 记一次结果', () => {
    it('★ 第一次计划复习做对 ⇒ 第 1 格绿、**最后一圈也绿**', () => {
        const o = recordReviewResult(null, 'right', 0);
        expect(o.planned).toEqual(['right', null, null, null]);
        expect(o.last).toBe('right');
    });

    it('计划内的一次做错 ⇒ 同样同步到"最近一次"', () => {
        const o = recordReviewResult({ planned: ['right', null, null, null], last: 'right' }, 'wrong', 1);
        expect(o.planned).toEqual(['right', 'wrong', null, null]);
        expect(o.last).toBe('wrong');
    });

    it('★ 计划外再复习 ⇒ 计划格**纹丝不动**，只有最后一圈变', () => {
        const before = { planned: ['right', 'right', 'right', 'right'], last: 'right' };
        const o = recordReviewResult(before, 'wrong'); // 不传 plannedIndex = 计划外
        expect(o.planned).toEqual(['right', 'right', 'right', 'right']);
        expect(o.last).toBe('wrong');
    });

    it('反复记只动该动的那一格（第 3 次计划复习）', () => {
        const o = recordReviewResult(
            { planned: ['right', 'wrong', null, null], last: 'wrong' },
            'right',
            2
        );
        expect(o.planned).toEqual(['right', 'wrong', 'right', null]);
        expect(o.last).toBe('right');
    });

    it('★ 第 4 格（+49 天）也能记 —— 这正是本轮扩出来的那一格', () => {
        const o = recordReviewResult(
            { planned: ['right', 'right', 'right', null], last: 'right' },
            'right',
            3
        );
        expect(o.planned).toEqual(['right', 'right', 'right', 'right']);
        expect(o.last).toBe('right');
    });

    it('计划格就是 4 个（多了没地方放，这是计划本身的定义）', () => {
        expect(PLANNED_REVIEW_ROUNDS).toBe(4);
    });
});

describe('复习结果 · 圆圈画法', () => {
    it('顺序：第 1 / 7 / 21 / 49 天 + 最近一次（共 5 个）', () => {
        const dots = reviewDots({ planned: ['right', null, 'wrong', 'right'], last: 'wrong' });
        expect(dots.map((d) => d.key)).toEqual(['p1', 'p2', 'p3', 'p4', 'last']);
        expect(dots.map((d) => d.state)).toEqual(['right', 'none', 'wrong', 'right', 'wrong']);
    });

    it('每个圈都带一句人话的悬停说明（中文里有"第 7 天"这种可核对的字）', () => {
        const dots = reviewDots(null);
        expect(dots[1].zh).toContain('第 7 天');
        expect(dots[3].zh).toContain('第 49 天');
        expect(dots[4].zh).toContain('最近一次');
        expect(dots[0].zh).toContain('还没有结果');
    });

    it('空值也返回全部圈（画面上不能少一个，否则"第几个"就对不上了）', () => {
        expect(reviewDots(undefined)).toHaveLength(5);
    });
});

/**
 * 【2026-09-30 详情页圆圈编辑器】界面上**直接改某一格**的规则。
 *
 * 他口述得很啰嗦，落成两条结论：
 *   A 改计划格 ⇒ "最近一次"跟着变成**最后一个有结果的**那个；全空 / 完全没变 ⇒ 不动它。
 *   B 只改"最近一次"那一行 ⇒ 计划格一个字都不许动（计划外复习走这条）。
 */
describe('复习结果 · 改计划格（入口 A：人工更正）', () => {
    it('★ 他举的例子：只有第 1 次、标成做对 ⇒ 最近一次也是做对', () => {
        const o = setPlannedOutcome(null, 0, 'right');
        expect(o.planned).toEqual(['right', null, null, null]);
        expect(o.last).toBe('right');
    });

    it('★ 改中间那次（前面空着）⇒ 最近一次 = 那次的结果', () => {
        const o = setPlannedOutcome(null, 1, 'wrong');
        expect(o.planned).toEqual([null, 'wrong', null, null]);
        expect(o.last).toBe('wrong');
    });

    it('★ 补改前面的、后面已有结果 ⇒ 最近一次**不动**（他已定型）', () => {
        const a = setPlannedOutcome(null, 1, 'wrong');
        const b = setPlannedOutcome(a, 0, 'right');
        expect(b.planned).toEqual(['right', 'wrong', null, null]);
        expect(b.last).toBe('wrong');
    });

    it('★ 最后一次是第 21 天那位 ⇒ 最近一次就等于它', () => {
        const o = setPlannedOutcome(
            { planned: ['right', 'right', null, null], last: 'right' },
            2,
            'wrong'
        );
        expect(o.planned).toEqual(['right', 'right', 'wrong', null]);
        expect(o.last).toBe('wrong');
    });

    it('★ 第 4 格也走同一条规则：它就是新的"最后一个有结果的"', () => {
        const o = setPlannedOutcome(
            { planned: ['right', 'right', 'right', null], last: 'right' },
            3,
            'wrong'
        );
        expect(o.planned).toEqual(['right', 'right', 'right', 'wrong']);
        expect(o.last).toBe('wrong');
    });

    it('★ 改动**没带来任何变化** ⇒ 原样返回（"AI 给的和已记录的一样 ⇒ 最近一次保持不变"）', () => {
        const before = { planned: ['right', null, null, null] as const, last: 'wrong' as const };
        const after = setPlannedOutcome(before, 0, 'right');
        expect(after).toEqual(normalizeReviewOutcomes(before));
        expect(after.last).toBe('wrong');
    });

    it('★ 全空 ⇒ 最近一次**保持当前状态不变**（他明说的）', () => {
        const before = { planned: ['right', null, null, null], last: 'wrong' };
        const after = setPlannedOutcome(before, 0, null);
        expect(after.planned).toEqual([null, null, null, null]);
        expect(after.last).toBe('wrong');
    });

    it('整批（AI 回传）也走同一条：结果与库里一致 ⇒ last 不动', () => {
        const before = '{"planned":["right","wrong",null,null],"last":"wrong"}';
        const same = setPlannedOutcome(normalizeReviewOutcomes(before), 1, 'wrong');
        expect(same.last).toBe('wrong');
    });
});

describe('复习结果 · 只改"最近一次"（入口 B：计划外复习）', () => {
    it('★ 计划格一个字都不动', () => {
        const o = setLastOutcome(
            { planned: ['right', 'right', 'right', 'right'], last: 'right' },
            'wrong'
        );
        expect(o.planned).toEqual(['right', 'right', 'right', 'right']);
        expect(o.last).toBe('wrong');
    });

    it('第 4 格已有结果后，再来新结果就只落在这里（计划位不再动）', () => {
        const before = setPlannedOutcome(null, 3, 'right');
        const after = setLastOutcome(before, 'wrong');
        expect(after.planned).toEqual([null, null, null, 'right']);
        expect(after.last).toBe('wrong');
    });

    it('把它清回"无结果"也只动它自己', () => {
        const o = setLastOutcome({ planned: ['wrong'], last: 'right' }, null);
        expect(o.last).toBeNull();
        expect(o.planned).toEqual(['wrong', null, null, null]);
    });
});

describe('复习结果 · 计划节点的日期', () => {
    it('录入日 +1 / +7 / +21 / +49 天，YYYY-MM-DD', () => {
        expect(PLANNED_REVIEW_OFFSET_DAYS).toEqual([1, 7, 21, 49]);
        // 用本地时间构造，避免时区把日子挪掉
        const d = new Date(2026, 8, 30, 10, 0); // 2026-09-30
        expect(plannedReviewDates(d)).toEqual([
            '2026-10-01',
            '2026-10-07',
            '2026-10-21',
            '2026-11-18',
        ]);
    });

    it('ISO 字符串（接口给的样子）也算对', () => {
        const iso = new Date(2026, 8, 30, 10, 0).toISOString();
        expect(plannedReviewDates(iso)[0]).toBe('2026-10-01');
    });

    it('跨月跨年也对', () => {
        expect(plannedReviewDates(new Date(2026, 11, 20, 9, 0))).toEqual([
            '2026-12-21',
            '2026-12-27',
            '2027-01-10',
            '2027-02-07',
        ]);
    });

    it('没录入时间 ⇒ 全空串（宁可不显示，也不要编一个日期出来）', () => {
        expect(plannedReviewDates(null)).toEqual(['', '', '', '']);
        expect(plannedReviewDates('不是日期')).toEqual(['', '', '', '']);
    });
});
