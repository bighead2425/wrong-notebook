import { describe, expect, it } from 'vitest';
import {
    QUEUE_LEVELS,
    QUEUE_LEVELS_META,
    queueHeadline,
    summarizeQueue,
} from '@/lib/queue-summary';

/**
 * 首页「今天该练什么」的摘要计算。
 *
 * 这些断言钉的是**给人看的那句话和那五根条**：
 *   · 缺档位要补 0（否则图上会少一行，看着像"没有这一档"）；
 *   · 脏数据要夹住（"-1 道"比不显示更糟）；
 *   · 一句话结论要能区分三种情况：没题 / 今天没事 / 有事且有过期。
 */
describe('summarizeQueue', () => {
    it('没有数据时全是 0，且不显示任何档位', () => {
        const s = summarizeQueue(null);
        expect(s.total).toBe(0);
        expect(s.dueNow).toBe(0);
        expect(s.hasWork).toBe(false);
        expect(s.firstLevel).toBeNull();
        expect(s.levels).toEqual([
            { urgency: 5, count: 0 },
            { urgency: 4, count: 0 },
            { urgency: 3, count: 0 },
            { urgency: 2, count: 0 },
            { urgency: 1, count: 0 },
        ]);
    });

    it('档位缺失要补齐，且顺序固定 5→1', () => {
        const s = summarizeQueue({
            total: 10,
            dueToday: 3,
            overdue: 2,
            buckets: [{ urgency: 3, count: 4 }, { urgency: 5, count: 1 }],
        });
        expect(s.levels.map((l) => l.urgency)).toEqual([5, 4, 3, 2, 1]);
        expect(s.levels.map((l) => l.count)).toEqual([1, 0, 4, 0, 0]);
        expect(s.dueNow).toBe(5);
        /* 10 道里 5 道到期 ⇒ 另有 5 道没到期（五根条加起来是 10，不是 5） */
        expect(s.notYetDue).toBe(5);
        expect(s.hasWork).toBe(true);
    });

    it('先动最急的那一档：取第一个 count>0 的档位', () => {
        expect(summarizeQueue({ total: 3, dueToday: 1, buckets: [{ urgency: 2, count: 1 }] }).firstLevel).toBe(2);
        expect(
            summarizeQueue({
                total: 3, dueToday: 2,
                buckets: [{ urgency: 2, count: 1 }, { urgency: 5, count: 1 }],
            }).firstLevel,
        ).toBe(5);
    });

    it('脏数据夹成非负整数（负数 / 小数 / 字符串 / NaN）', () => {
        const s = summarizeQueue({
            total: -5,
            dueToday: 2.6,
            overdue: Number.NaN,
            buckets: [
                { urgency: 5, count: -3 },
                { urgency: 4, count: '2.4' as unknown as number },
                { urgency: 99, count: 7 },   // 越界档位直接丢
                { urgency: 0, count: 7 },
            ],
        });
        expect(s.total).toBe(0);
        expect(s.dueNow).toBe(3);
        /* 总数 0 却算出 3 道到期（脏数据）⇒ 差额夹在 0，不能出现负数 */
        expect(s.notYetDue).toBe(0);
        expect(s.levels).toEqual([
            { urgency: 5, count: 0 },
            { urgency: 4, count: 2 },
            { urgency: 3, count: 0 },
            { urgency: 2, count: 0 },
            { urgency: 1, count: 0 },
        ]);
    });
});

describe('queueHeadline', () => {
    it('三种情况各有一句话，且不出现"紧迫度/等级"这类词', () => {
        expect(queueHeadline(summarizeQueue(null), true)).toBe('还没有错题');
        expect(queueHeadline(summarizeQueue({ total: 5, dueToday: 0 }), true)).toBe('今天没有到期的');
        expect(queueHeadline(summarizeQueue({ total: 5, dueToday: 3 }), true)).toBe('今天该练 3 道');
        const overdue = queueHeadline(summarizeQueue({ total: 5, dueToday: 3, overdue: 2 }), true);
        expect(overdue).toContain('5');
        expect(overdue).toContain('过期');

        for (const zh of [true, false]) {
            const text = queueHeadline(summarizeQueue({ total: 5, dueToday: 3, overdue: 2 }), zh);
            expect(text).not.toMatch(/紧迫度|等级|urgency|level/i);
        }
    });
});

describe('五档文案表', () => {
    it('覆盖 5 个档位、颜色互不相同', () => {
        expect(QUEUE_LEVELS).toEqual([5, 4, 3, 2, 1]);
        expect(QUEUE_LEVELS_META).toHaveLength(5);
        expect(new Set(QUEUE_LEVELS_META.map((m) => m.color)).size).toBe(5);
        for (const m of QUEUE_LEVELS_META) {
            expect(m.zh.length).toBeGreaterThan(0);
            expect(m.en.length).toBeGreaterThan(0);
        }
    });
});
