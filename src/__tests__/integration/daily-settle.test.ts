/**
 * 【2026-10-15 新】每日等级结算执行器的测试（`src/lib/daily-settle.ts`）。
 *
 * 规则本身的单测在 `unit/level-settle.test.ts`（纯函数，41 条）；
 * 这里测的是**服务端那一层**：读库 / 加锁 / 一个事务批量提交 / 吞异常 / 时区兜底。
 *
 * ⚠️ 本文件只验"它会不会按设计去读写"，**不验真实数据库**（本机没有 dev.db，
 *    真实迁移由 CI 与 NAS 上的 `prisma migrate deploy` 负责）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockPrismaDailySettle: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
    },
    mockPrismaErrorItem: {
        findMany: vi.fn(),
        update: vi.fn(),
    },
    mockTransaction: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        dailySettle: mocks.mockPrismaDailySettle,
        errorItem: mocks.mockPrismaErrorItem,
        $transaction: mocks.mockTransaction,
    },
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => mocks.logger,
}));

import { daysBetween, isValidDayKey, maybeSettleDaily, normalizeTodayKey } from '@/lib/daily-settle';

/** 造一份 reviewOutcomes：连对 n 次 */
function rights(n: number): string {
    return JSON.stringify({ planned: Array.from({ length: n }, () => 'right'), last: 'right' });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockPrismaDailySettle.update.mockReturnValue({ __op: 'settleRow' });
    mocks.mockPrismaErrorItem.update.mockImplementation((a: unknown) => ({ __op: 'itemUpdate', a }));
    mocks.mockTransaction.mockResolvedValue([]);
    mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);
});

describe('每日结算 · 日键工具（时区铁律的地基）', () => {
    it('daysBetween 按本地日算差', () => {
        expect(daysBetween('2026-10-15', '2026-10-15')).toBe(0);
        expect(daysBetween('2026-10-15', '2026-10-18')).toBe(3);
        expect(daysBetween('2026-10-18', '2026-10-15')).toBe(-3);
    });

    it('daysBetween 对烂输入返回 0（不返回 NaN —— NaN 会让等级集体跳档）', () => {
        expect(daysBetween('不是日期', '2026-10-15')).toBe(0);
        expect(daysBetween('2026-10-15', '')).toBe(0);
    });

    it('isValidDayKey 挡掉"形状对但不存在"的日期', () => {
        expect(isValidDayKey('2026-10-15')).toBe(true);
        expect(isValidDayKey('2026-13-45')).toBe(false);
        expect(isValidDayKey('2026-2-3')).toBe(false); // 必须补零
        expect(isValidDayKey(20261015)).toBe(false);
        expect(isValidDayKey(null)).toBe(false);
    });

    it('normalizeTodayKey：合理就用客户端的（±1 天内），不合理退回服务器日期', () => {
        const now = new Date(2026, 9, 15, 12, 0, 0); // 本地 2026-10-15
        expect(normalizeTodayKey('2026-10-15', now)).toBe('2026-10-15');
        expect(normalizeTodayKey('2026-10-16', now)).toBe('2026-10-16'); // +1 天：允许（跨时区正常）
        expect(normalizeTodayKey('2026-10-14', now)).toBe('2026-10-14'); // −1 天：允许
        expect(normalizeTodayKey('2026-11-01', now)).toBe('2026-10-15'); // 差太多 ⇒ 退回服务器
        expect(normalizeTodayKey('乱写', now)).toBe('2026-10-15');
        expect(normalizeTodayKey(null, now)).toBe('2026-10-15');
    });
});

describe('每日结算 · 什么时候跑 / 什么时候不跑', () => {
    it('今天已经结算过 ⇒ 直接返回，**一次写库都不做**', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue({ lastSettledOn: '2026-10-15' });

        const r = await maybeSettleDaily('u1', '2026-10-15');

        expect(r.ran).toBe(false);
        expect(r.reason).toBe('already-settled-today');
        expect(mocks.mockPrismaErrorItem.findMany).not.toHaveBeenCalled();
        expect(mocks.mockTransaction).not.toHaveBeenCalled();
    });

    it('拿不到锁（别人正在跑）⇒ 跳过，不写库', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue({ lastSettledOn: '2026-10-14' });
        mocks.mockPrismaDailySettle.updateMany.mockResolvedValue({ count: 0 });

        const r = await maybeSettleDaily('u1', '2026-10-15');

        expect(r.ran).toBe(false);
        expect(r.reason).toBe('locked');
        expect(mocks.mockTransaction).not.toHaveBeenCalled();
    });

    it('首次（没有状态行）⇒ 建行 + 只做**初始化**，减数为 0', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue(null);
        mocks.mockPrismaDailySettle.create.mockResolvedValue({});
        mocks.mockPrismaErrorItem.findMany.mockResolvedValue([
            { id: 'q1', reviewOutcomes: rights(2), attention: 1, levelCountdown: null, masteryLevel: 0 },
        ]);

        const r = await maybeSettleDaily('u1', '2026-10-15');

        expect(r.ran).toBe(true);
        expect(r.initialized).toBe(1);
        expect(r.advanced).toBe(0);
        // 老数据被补上：连对 2 ⇒ 倒数 14（2026-10-21：原 21）、等级 2
        const arg = mocks.mockPrismaErrorItem.update.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(arg.data.levelCountdown).toBe(14);
        expect(arg.data.attention).toBe(2);
    });

    it('★ 幂等：漏跑 3 天 ⇒ 一次减 3（不是只减 1）', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue({ lastSettledOn: '2026-10-12' });
        mocks.mockPrismaDailySettle.updateMany.mockResolvedValue({ count: 1 });
        mocks.mockPrismaErrorItem.findMany.mockResolvedValue([
            { id: 'q1', reviewOutcomes: rights(2), attention: 2, levelCountdown: 21, masteryLevel: 0 },
        ]);

        const r = await maybeSettleDaily('u1', '2026-10-15');

        expect(r.ran).toBe(true);
        expect(r.advanced).toBe(1);
        const arg = mocks.mockPrismaErrorItem.update.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(arg.data.levelCountdown).toBe(18); // 21 − 3
    });

    it('★ **一个事务批量提交** —— 所有题的新值 + 结算日，都在同一次 $transaction 里', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue({ lastSettledOn: '2026-10-14' });
        mocks.mockPrismaDailySettle.updateMany.mockResolvedValue({ count: 1 });
        mocks.mockPrismaErrorItem.findMany.mockResolvedValue([
            { id: 'q1', reviewOutcomes: rights(2), attention: 2, levelCountdown: 21, masteryLevel: 0 },
            { id: 'q2', reviewOutcomes: rights(1), attention: 3, levelCountdown: 7, masteryLevel: 0 },
        ]);

        await maybeSettleDaily('u1', '2026-10-15');

        expect(mocks.mockTransaction).toHaveBeenCalledTimes(1);
        const ops = mocks.mockTransaction.mock.calls[0][0] as unknown[];
        // 2 道题 + 1 行结算状态
        expect(ops).toHaveLength(3);
    });

    it('没有题要改时**仍然推进结算日**（否则明天会重复扫一遍）', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue({ lastSettledOn: '2026-10-14' });
        mocks.mockPrismaDailySettle.updateMany.mockResolvedValue({ count: 1 });
        mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

        await maybeSettleDaily('u1', '2026-10-15');

        expect(mocks.mockTransaction).toHaveBeenCalledTimes(1);
        const ops = mocks.mockTransaction.mock.calls[0][0] as unknown[];
        expect(ops).toHaveLength(1); // 只有结算状态那一行
        expect(mocks.mockPrismaDailySettle.update).toHaveBeenCalled();
    });

    it('★★ 数据库出错 ⇒ **不抛异常**（结算失败绝不能让"打开内阁"失败）', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockRejectedValue(new Error('db down'));

        const r = await maybeSettleDaily('u1', '2026-10-15');

        expect(r.ran).toBe(false);
        expect(r.reason).toBe('error');
    });

    it('★★ 写库失败时**也要放锁** —— 否则那道题永远结算不了（静默失效）', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue({ lastSettledOn: '2026-10-14' });
        mocks.mockPrismaDailySettle.updateMany.mockResolvedValue({ count: 1 });
        mocks.mockPrismaErrorItem.findMany.mockRejectedValue(new Error('boom'));

        const r = await maybeSettleDaily('u1', '2026-10-15');

        expect(r.ran).toBe(false);
        expect(r.reason).toBe('error');
        // finally 里那次放锁（把 runningSince 清成 null）
        const releaseCall = mocks.mockPrismaDailySettle.update.mock.calls.find(
            (c) => (c[0] as { data: Record<string, unknown> }).data.runningSince === null,
        );
        expect(releaseCall).toBeTruthy();
    });

    it('查询条件必须**在 SQL 层就排掉两类冻结**（已掌握 + 归档本）', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue({ lastSettledOn: '2026-10-14' });
        mocks.mockPrismaDailySettle.updateMany.mockResolvedValue({ count: 1 });

        await maybeSettleDaily('u1', '2026-10-15');

        const where = (mocks.mockPrismaErrorItem.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
        expect(where.userId).toBe('u1');
        expect(where.masteryLevel).toEqual({ lt: 2 }); // 已掌握不进结算
        expect(JSON.stringify(where.OR)).toContain('archived'); // 归档本不进结算
    });

    it('陈锁能自动失效（进程被杀后不至于永久锁死）', async () => {
        mocks.mockPrismaDailySettle.findUnique.mockResolvedValue({ lastSettledOn: '2026-10-14' });
        mocks.mockPrismaDailySettle.updateMany.mockResolvedValue({ count: 1 });

        await maybeSettleDaily('u1', '2026-10-15');

        const where = (mocks.mockPrismaDailySettle.updateMany.mock.calls[0][0] as { where: Record<string, unknown> })
            .where;
        // 条件里必须有 "runningSince 为 null **或** 早于某个时刻"
        expect(JSON.stringify(where.OR)).toContain('runningSince');
        expect(JSON.stringify(where.OR)).toContain('lt');
    });
});
