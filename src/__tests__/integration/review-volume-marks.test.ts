/**
 * 【2026-10-16 如如】`GET /api/review-volumes/[id]/review-marks` 的接口测试。
 *
 * 这是**卷页那圈绿/粉 + 轮次角标**的数据源（`docs\18` §4.3）。三条最要紧的事：
 *  ① 只认**这一卷**的记录（换一张没录过的卷 ⇒ 一道都不返回 ⇒ 界面画灰圈）；
 *  ② 每题给**最近一条** + 这张卷上录过**几条**（角标用）；
 *  ③ **一次查完**（不许每道题查一遍 —— `docs\17` 那条性能账）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockPrismaUser: { findUnique: vi.fn() },
    mockPrismaReviewVolume: { findUnique: vi.fn() },
    mockPrismaReviewEvent: { findMany: vi.fn() },
    mockSession: { user: { email: 'user@example.com', name: 'Test User' }, expires: '2025-12-31' },
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.mockPrismaUser,
        reviewVolume: mocks.mockPrismaReviewVolume,
        reviewEvent: mocks.mockPrismaReviewEvent,
    },
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

// Import after mocks
import { GET } from '@/app/api/review-volumes/[id]/review-marks/route';
import { getServerSession } from 'next-auth';

describe('GET /api/review-volumes/[id]/review-marks', () => {
    const call = async (id = 'vol-1') =>
        GET(new Request(`http://localhost/api/review-volumes/${id}/review-marks`), {
            params: Promise.resolve({ id }),
        });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockPrismaUser.findUnique.mockResolvedValue({ id: 'user-123', email: 'user@example.com' });
        vi.mocked(getServerSession).mockResolvedValue(mocks.mockSession);
        mocks.mockPrismaReviewVolume.findUnique.mockResolvedValue({
            id: 'vol-1',
            items: [{ errorItemId: 'e1' }, { errorItemId: 'e2' }],
        });
        mocks.mockPrismaReviewEvent.findMany.mockResolvedValue([]);
    });

    it('没登录 ⇒ 401', async () => {
        vi.mocked(getServerSession).mockResolvedValueOnce(null);
        expect((await call()).status).toBe(401);
    });

    it('卷不存在 ⇒ 404', async () => {
        mocks.mockPrismaReviewVolume.findUnique.mockResolvedValue(null);
        expect((await call()).status).toBe(404);
    });

    it('★ 每题给**最近一条** + 这张卷上录过几条（角标用）', async () => {
        // 正序读进来（服务端就是这么查的）⇒ 每题的末位 = 最近一条
        mocks.mockPrismaReviewEvent.findMany.mockResolvedValue([
            { id: 'ev-1', errorItemId: 'e1', outcome: 'right' },
            { id: 'ev-2', errorItemId: 'e1', outcome: 'wrong' },
            { id: 'ev-3', errorItemId: 'e2', outcome: 'right' },
        ]);

        const res = await call();
        expect(res.status).toBe(200);
        const { marks } = (await res.json()) as {
            marks: Array<{ errorItemId: string; mark: string; eventId: string; rounds: number }>;
        };

        expect(marks).toHaveLength(2);
        const e1 = marks.find((m) => m.errorItemId === 'e1')!;
        expect(e1.mark).toBe('wrong'); // 最近一条是"错"
        expect(e1.eventId).toBe('ev-2'); // 删"这一条"要删的就是它
        expect(e1.rounds).toBe(2); // 这张卷上录过两轮 ⇒ 圈上会画上标 2

        const e2 = marks.find((m) => m.errorItemId === 'e2')!;
        expect(e2.rounds).toBe(1); // 只录过一轮 ⇒ 不画角标
    });

    it('★★ 只认**这一卷**的记录 —— 查询条件里必须带 `volumeId`（换新卷要给灰圈）', async () => {
        await call('vol-2');
        const arg = mocks.mockPrismaReviewEvent.findMany.mock.calls[0][0] as {
            where?: Record<string, unknown>;
            orderBy?: unknown;
            select?: unknown;
        };
        expect(arg.where).toMatchObject({ userId: 'user-123', volumeId: 'vol-2' });
        expect(arg.where?.errorItemId).toMatchObject({ in: ['e1', 'e2'] });
        // 排序必须是"按时间正序"（末位才是最近一条，上面那条断言依赖它）
        expect(arg.orderBy).toBeTruthy();
        // 只取需要的列（卷页可能几十道题）
        expect(arg.select).toBeTruthy();
    });

    it('★ 一次查完 + 该卷没记录 ⇒ 空数组（界面画灰圈，不是报错）', async () => {
        const res = await call();
        expect(await res.json()).toEqual({ marks: [] });
        expect(mocks.mockPrismaReviewEvent.findMany).toHaveBeenCalledTimes(1);
    });

    it('卷里一道题都没有 ⇒ 直接空数组，连流水都不查（省一次查询）', async () => {
        mocks.mockPrismaReviewVolume.findUnique.mockResolvedValue({ id: 'vol-1', items: [] });
        const res = await call();
        expect(await res.json()).toEqual({ marks: [] });
        expect(mocks.mockPrismaReviewEvent.findMany).not.toHaveBeenCalled();
    });
});
