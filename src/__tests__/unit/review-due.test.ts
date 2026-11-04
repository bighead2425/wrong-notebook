/**
 * 【2026-11-04 审计 P0-2 回归钉】**到期日必须读落库的排程，不能现算。**
 *
 * 原来 `nextDueKey = 今天 + 间隔`（间隔最小 1 天）⇒ 永远 ≥ 明天
 * ⇒ 「逾期」恒为 0、预测图是假图。这两条测试把口径钉住。
 */

import { describe, it, expect } from 'vitest';
import { earliestOpenDueKey, dueKeyFor } from '@/lib/review-due';

describe('earliestOpenDueKey —— 每道题取最早那条未完成排程', () => {
    it('一条就取它', () => {
        const m = earliestOpenDueKey([
            { errorItemId: 'q1', scheduledFor: new Date(2026, 10, 1) },
        ]);
        expect(m.get('q1')).toBe('2026-11-01');
    });

    /**
     * 关键口径：**取最早，不取最新**。
     * 一道题可能因为几轮检查留下多条未完成排程，最老的那条才是"欠账"。
     * 取最新会把逾期半个月的题藏起来 —— 正是 P0-2 那个 bug 的一种变体。
     */
    it('多条时取最早那条，不是最新', () => {
        const m = earliestOpenDueKey([
            { errorItemId: 'q1', scheduledFor: new Date(2026, 10, 20) },
            { errorItemId: 'q1', scheduledFor: new Date(2026, 9, 25) },
            { errorItemId: 'q1', scheduledFor: new Date(2026, 10, 5) },
        ]);
        expect(m.get('q1')).toBe('2026-10-25');
    });

    it('多道题各算各的', () => {
        const m = earliestOpenDueKey([
            { errorItemId: 'a', scheduledFor: new Date(2026, 10, 3) },
            { errorItemId: 'b', scheduledFor: new Date(2026, 10, 1) },
        ]);
        expect(m.get('a')).toBe('2026-11-03');
        expect(m.get('b')).toBe('2026-11-01');
    });

    it('空列表不炸', () => {
        expect(earliestOpenDueKey([]).size).toBe(0);
    });
});

describe('dueKeyFor —— 有排程用事实，没有才退回假设', () => {
    it('有排程 ⇒ 用排程（哪怕它已经过去 = 逾期）', () => {
        expect(dueKeyFor('2026-10-01', '2026-11-05')).toBe('2026-10-01');
    });

    /** 新录的题从没练过，没有排程 ⇒ 退回"今天+间隔"，这不算错 */
    it('没排程 ⇒ 退回 nextDueKey', () => {
        expect(dueKeyFor(undefined, '2026-11-05')).toBe('2026-11-05');
    });

    it('都没有 ⇒ null（退休的题不排）', () => {
        expect(dueKeyFor(undefined, null)).toBeNull();
    });
});
