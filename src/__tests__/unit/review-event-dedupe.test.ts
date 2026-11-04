/**
 * 【2026-11-04 审计 C5】**回录重试不能把同一道题算两遍**。
 *
 * 背景：回录页原来「先写卷行标记、后写流水」—— 流水一失败，卷已经算"已回录"，
 * 下次再也不提醒，那道题的结果**静默丢了**（真机库里有 6 行是这个症状）。
 *
 * 修法是把顺序反过来（先流水、后标记），但这样"标记失败 → 用户重试"
 * 会把同一条流水再写一遍 ⇒ 同一道题多错一次、紧迫度被拉高、间隔被缩短。
 * 所以在 `recordReviewEvent` 里对**带卷的**结果做去重。
 *
 * 这条测试钉住三件事：
 *   ① 带卷 + 已有同一条 ⇒ 不写
 *   ② 带卷 + 没有 ⇒ 写
 *   ③ **不带卷 ⇒ 不去重**（手动录结果时"今天又错一次"是真实的第二次，不能被吞）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `vi.mock` 会被提升到文件顶部，所以 mock 出来的函数也必须一起提升
 * （用普通 `const` 会报 "Cannot access before initialization"）。
 */
const { findFirst, create } = vi.hoisted(() => ({
    findFirst: vi.fn(),
    create: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        reviewEvent: { findFirst, create },
    },
}));

// eslint-disable-next-line import/first -- 必须在 vi.mock 之后才能拿到 mock 过的 prisma
import { recordReviewEvent } from '@/lib/review-events';

const base = {
    userId: 'u1',
    errorItemId: 'q1',
    occurredOn: '2026-11-04',
    outcome: 'wrong' as const,
};

describe('recordReviewEvent 幂等（C5 回录重试）', () => {
    beforeEach(() => {
        findFirst.mockReset();
        create.mockReset();
    });

    it('带卷 + 已经有一条完全相同的 ⇒ 不再写', async () => {
        findFirst.mockResolvedValue({ id: 'ev-existing' });
        await recordReviewEvent({ ...base, volumeId: 'vol1' });
        expect(findFirst).toHaveBeenCalledTimes(1);
        expect(create).not.toHaveBeenCalled();
    });

    it('带卷 + 没有相同的 ⇒ 正常写一条', async () => {
        findFirst.mockResolvedValue(null);
        await recordReviewEvent({ ...base, volumeId: 'vol1' });
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({
            volumeId: 'vol1',
            outcome: 'wrong',
            occurredOn: '2026-11-04',
        });
    });

    it('结果不同 ⇒ 不算重复（错变对就是要两条）', async () => {
        findFirst.mockResolvedValue(null);
        await recordReviewEvent({ ...base, outcome: 'right', volumeId: 'vol1' });
        /* 查询条件里带着 outcome ⇒ 上次标"错"、这次改成"对"，查不到、照写 */
        expect(findFirst.mock.calls[0][0].where).toMatchObject({ outcome: 'right' });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('**不带卷** ⇒ 完全不去重（手动录结果允许同一天多次）', async () => {
        await recordReviewEvent({ ...base });
        expect(findFirst).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledTimes(1);
    });
});
