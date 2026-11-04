/**
 * 【2026-11-04 审计 C5】**纸张回录重试不能把同一道题算两遍**。
 *
 * 背景：回录页原来「先写卷行标记、后写流水」—— 流水一失败，卷已经算"已回录"，
 * 下次再也不提醒，那道题的结果**静默丢了**（真机库里有 6 行是这个症状）。
 *
 * 修法是把顺序反过来（先流水、后标记），但这样"标记失败 → 用户重试"
 * 会把同一条流水再写一遍 ⇒ 同一道题多错一次、紧迫度被拉高、间隔被缩短。
 * 所以在 `recordReviewEvent` 里对**纸张回录**做去重。
 *
 * ⚠️ 去重条件**必须**是「纸张回录 + 带卷」，不能只看"带卷"：
 *    详情页上的题也可能带卷号，而"同一天连判两次错"在那里是真实的两次。
 *    第一版写宽了，集成测试 `★ 传了 reviewEvent ⇒ 落一条流水` 当场由 200/1 次
 *    变成 create 0 次 —— 这条单测也补上对应的反向用例，别再写宽。
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
    volumeId: 'vol1',
};

describe('recordReviewEvent 幂等（C5 回录重试）', () => {
    beforeEach(() => {
        findFirst.mockReset();
        create.mockReset();
    });

    it('纸张回录 + 已经有一条完全相同的 ⇒ 不再写', async () => {
        findFirst.mockResolvedValue({ id: 'ev-existing' });
        await recordReviewEvent({ ...base, source: 'review_paper' });
        expect(findFirst).toHaveBeenCalledTimes(1);
        expect(create).not.toHaveBeenCalled();
    });

    it('模仿纸回录同理', async () => {
        findFirst.mockResolvedValue({ id: 'ev-existing' });
        await recordReviewEvent({ ...base, source: 'imitate_paper' });
        expect(create).not.toHaveBeenCalled();
    });

    it('纸张回录 + 没有相同的 ⇒ 正常写一条', async () => {
        findFirst.mockResolvedValue(null);
        await recordReviewEvent({ ...base, source: 'review_paper' });
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].data).toMatchObject({
            volumeId: 'vol1',
            outcome: 'wrong',
            occurredOn: '2026-11-04',
        });
    });

    it('结果不同 ⇒ 不算重复（错变对就是要两条）', async () => {
        findFirst.mockResolvedValue(null);
        await recordReviewEvent({ ...base, outcome: 'right', source: 'review_paper' });
        expect(findFirst.mock.calls[0][0].where).toMatchObject({ outcome: 'right' });
        expect(create).toHaveBeenCalledTimes(1);
    });

    /**
     * ⚠️ **这条就是第一版写宽的证据**：详情页也带卷号，
     * 但"她又错了一次"必须留下 —— 被吞掉就等于少记一次错、间隔被拉长。
     */
    it('详情页（带卷号但来源是 detail_page）⇒ **不去重**', async () => {
        await recordReviewEvent({ ...base, source: 'detail_page' });
        expect(findFirst).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('不带来源（老调用方）⇒ 不去重，保持原行为', async () => {
        await recordReviewEvent({ ...base, source: null });
        expect(findFirst).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('纸张回录但没带卷号 ⇒ 不去重（没有卷就无从判断"同一张纸"）', async () => {
        await recordReviewEvent({ ...base, volumeId: null, source: 'review_paper' });
        expect(findFirst).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledTimes(1);
    });
});
