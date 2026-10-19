/**
 * 【2026-10-19 真真】`GET /api/insights` 的**学科筛选**：点「其他」必须把"没设学科"的也筛出来。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 空空 2026-10-19 报的 bug：
 *   "左边栏中，点击『其他』，不能筛选出科目标注为『其他』的积累条目的。"
 *
 * 真因不是筛选坏了，是**两边口径不一样**：
 *   · 界面：`subjectLabel(null)` 返回「其他」（`lib/notebook-fields.ts:67`）
 *     ⇒ 她看到的"其他"里混着两种：真的选了 `other`、以及压根没选（`null`）；
 *   · 接口：只写 `subject: { in: ['other'] }` ⇒ **`null` 的一条都筛不出来**。
 *
 * ⇒ 她点「其他」看到空列表，会以为那些条目没了。
 * 修法：`subjects` 里含 `other` 时，额外匹配 `subject: null`。
 *
 * ⚠️ 为什么不改显示（把 null 显示成"未设学科"）：她已经在用"其他"理解这些条目了，
 *    改显示等于让她重新学一遍 —— 筛的时候并进来更省事。
 * ══════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockSession: { user: { email: 'u@test.local' } },
    mockPrismaUser: { findUnique: vi.fn() },
    mockPrismaInsight: { findMany: vi.fn(), groupBy: vi.fn() },
    mockPrismaErrorItem: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.mockPrismaUser,
        insight: mocks.mockPrismaInsight,
        errorItem: mocks.mockPrismaErrorItem,
    },
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { GET } from '@/app/api/insights/route';

/** 把 where 拍平成字符串，省得为了一个断言写一堆类型体操 */
const whereText = () => JSON.stringify(mocks.mockPrismaInsight.findMany.mock.calls[0][0].where);

beforeEach(() => {
    mocks.mockPrismaUser.findUnique.mockResolvedValue({ id: 'u1' });
    mocks.mockPrismaInsight.findMany.mockResolvedValue([]);
    mocks.mockPrismaInsight.groupBy.mockResolvedValue([]);
    mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);
});

describe('学科筛选：其他 = 真的 other + 没设学科', () => {
    it('★ `subjects=other` ⇒ where 里必须带 `subject: null`（这就是那个 bug）', async () => {
        await GET(new Request('http://localhost/api/insights?subjects=other'));
        expect(whereText()).toContain('"subject":null');
    });

    it('`subjects=math,other` ⇒ 也带（多选里只要有"其他"就算）', async () => {
        await GET(new Request('http://localhost/api/insights?subjects=math,other'));
        expect(whereText()).toContain('"subject":null');
    });

    it('★ `subjects=math` ⇒ **不许**带 null 分支（否则"数学"会混进没设学科的）', async () => {
        await GET(new Request('http://localhost/api/insights?subjects=math'));
        expect(whereText()).not.toContain('"subject":null');
        expect(whereText()).toContain('"math"');
    });

    it('不带 subjects ⇒ 完全不按学科筛', async () => {
        await GET(new Request('http://localhost/api/insights'));
        expect(whereText()).not.toContain('"subject":null');
        expect(whereText()).not.toContain('"in"');
    });
});
