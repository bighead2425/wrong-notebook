/**
 * 【2026-10-17 如如】`GET /api/review-volumes` 的**"只看含这道题的卷"**筛选（空空第 5 条）。
 *
 * 这一条是"题 → 卷"那个方向唯一的新逻辑，所以单独钉一次：
 *   · 带 `hasItem` ⇒ where 里必须出现 `items.some.errorItemId = 那道题`
 *     （⭐ 判据是 `ReviewVolumeItem` 的行**存在** ⇒ 模仿卷里**主题与附题都算**，
 *       他第 5 条要的就是这个）；
 *   · 不带 ⇒ **不许**凭空加这个条件（否则所有卷都被筛掉）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockPrismaUser: { findUnique: vi.fn() },
    mockPrismaReviewVolume: { findMany: vi.fn(), findUnique: vi.fn() },
    mockSession: { user: { email: 'user@example.com', name: 'Test User' }, expires: '2025-12-31' },
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.mockPrismaUser,
        reviewVolume: mocks.mockPrismaReviewVolume,
    },
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

import { GET } from '@/app/api/review-volumes/route';
import { getServerSession } from 'next-auth';

describe('GET /api/review-volumes · 只看含这道题的卷', () => {
    const call = async (qs = '') =>
        GET(new Request(`http://localhost/api/review-volumes${qs}`) as never);

    /** 取这次 findMany 的 where（穿过 AND 数组看看有没有那条 some） */
    const whereOfLastCall = () => {
        const arg = mocks.mockPrismaReviewVolume.findMany.mock.calls[0][0] as {
            where?: { AND?: unknown[] };
        };
        return JSON.stringify(arg.where ?? {});
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockPrismaUser.findUnique.mockResolvedValue({ id: 'user-123', email: 'user@example.com' });
        vi.mocked(getServerSession).mockResolvedValue(mocks.mockSession);
        mocks.mockPrismaReviewVolume.findMany.mockResolvedValue([]);
    });

    it('没登录 ⇒ 401', async () => {
        vi.mocked(getServerSession).mockResolvedValueOnce(null);
        expect((await call()).status).toBe(401);
    });

    it('★ 带 `hasItem` ⇒ where 里出现 `items.some.errorItemId`', async () => {
        await call('?kind=review&hasItem=e1');
        expect(whereOfLastCall()).toContain('"errorItemId":"e1"');
        expect(whereOfLastCall()).toContain('"some"');
    });

    it('★★ 不带 `hasItem` ⇒ **不许**加这个条件（否则一份卷都查不出来）', async () => {
        await call('?kind=review');
        expect(whereOfLastCall()).not.toContain('errorItemId');
    });

    it('★ 与其它筛选能叠加（kind + hasItem 同时在）', async () => {
        await call('?kind=imitate&hasItem=e9');
        const w = whereOfLastCall();
        expect(w).toContain('"kind":"imitate"');
        expect(w).toContain('"errorItemId":"e9"');
    });
});
