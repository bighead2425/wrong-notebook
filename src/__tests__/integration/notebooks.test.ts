/**
 * /api/notebooks API 集成测试
 * 测试错题本创建、获取、更新、删除等接口
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to ensure mocks are initialized before module imports
const mocks = vi.hoisted(() => ({
    mockPrismaUser: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
    },
    mockPrismaNotebook: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn(),
    },
    /**
     * 【custom-v25】删除错题本前要数剩下的错题，
     * 所以 DELETE 接口依赖 errorItem.count —— mock 里缺它就会整段 500。
     * 【2026-10-12 需求第 7/8 条】又要用到：
     *   · `deleteMany` —— 删空本之前先把回收箱里来自它的题**彻底删掉**；
     *   · `updateMany` —— "并入另一本"时把 `notebookId` 整批改挂过去。
     */
    mockPrismaErrorItem: {
        count: vi.fn(),
        deleteMany: vi.fn(),
        updateMany: vi.fn(),
    },
    /** 事务：两种形态都要撑住（回调式 / 数组式，见两个新接口） */
    mockTransaction: vi.fn(),
    mockSession: {
        user: {
            email: 'user@example.com',
            name: 'Test User',
        },
        expires: '2025-12-31',
    },
}));

// Mock Prisma client
vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.mockPrismaUser,
        notebook: mocks.mockPrismaNotebook,
        errorItem: mocks.mockPrismaErrorItem,
        $transaction: mocks.mockTransaction,
    },
}));

// Mock next-auth
vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

// Import after mocks
import { GET, POST } from '@/app/api/notebooks/route';
import { GET as GET_NOTEBOOK, PUT, DELETE } from '@/app/api/notebooks/[id]/route';
// 【2026-10-12 需求第 6/7 条】新加的两个接口：拖动排序 / 并入另一本
import { POST as REORDER } from '@/app/api/notebooks/reorder/route';
import { POST as MERGE } from '@/app/api/notebooks/merge/route';
import { getServerSession } from 'next-auth';

describe('/api/notebooks', () => {
    const mockUser = {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockPrismaUser.findUnique.mockResolvedValue(mockUser);
        mocks.mockPrismaUser.findFirst.mockResolvedValue(mockUser);
        // 默认：错题本里一道题都没有（DELETE 需要先过这一关）
        mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
        /** 默认：回收箱里也没有它的题（真删 0 条） */
        mocks.mockPrismaErrorItem.deleteMany.mockResolvedValue({ count: 0 });
        mocks.mockPrismaErrorItem.updateMany.mockResolvedValue({ count: 0 });
        mocks.mockPrismaNotebook.findFirst.mockResolvedValue(null);
        /**
         * 事务两种形态都撑住：
         *   · 回调式（`merge` 用它包住"改挂 + 删本"）⇒ 传一个假的 tx 进去；
         *   · 数组式（`reorder` 用它批改 sortOrder）⇒ 直接 `Promise.all`。
         */
        mocks.mockTransaction.mockImplementation(async (arg: unknown) => {
            if (typeof arg === 'function') {
                return (arg as (tx: unknown) => unknown)({
                    errorItem: mocks.mockPrismaErrorItem,
                    notebook: mocks.mockPrismaNotebook,
                });
            }
            return Promise.all(arg as Promise<unknown>[]);
        });
        vi.mocked(getServerSession).mockResolvedValue(mocks.mockSession);
    });

    describe('GET /api/notebooks (获取所有错题本)', () => {
        it('应该返回用户的所有错题本', async () => {
            const notebooks = [
                { id: 'nb-1', displayName: '数学', userId: 'user-123', _count: { errorItems: 5 } },
                { id: 'nb-2', displayName: '英语', userId: 'user-123', _count: { errorItems: 3 } },
            ];
            mocks.mockPrismaNotebook.findMany.mockResolvedValue(notebooks);

            const response = await GET(new Request('http://localhost/api/notebooks'));
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data).toHaveLength(2);
            expect(data[0].displayName).toBe('数学');
            expect(data[0]._count.errorItems).toBe(5);
        });

        it('应该在没有错题本时创建默认错题本', async () => {
            // 第一次查询返回空数组，创建后第二次查询返回默认错题本
            mocks.mockPrismaNotebook.findMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([
                    { id: 'nb-1', displayName: '数学', userId: 'user-123', _count: { errorItems: 0 } },
                    { id: 'nb-2', displayName: '英语', userId: 'user-123', _count: { errorItems: 0 } },
                ]);
            mocks.mockPrismaNotebook.create.mockResolvedValue({});
            // 一次本子都没有 → 走「自动建默认本」分支（count 用来区分"全都归档了"和"真没有"）
            mocks.mockPrismaNotebook.count.mockResolvedValue(0);

            const response = await GET(new Request('http://localhost/api/notebooks'));
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data).toHaveLength(2);
            // 验证创建了默认错题本
            expect(mocks.mockPrismaNotebook.create).toHaveBeenCalledTimes(2);
        });
    });

    describe('POST /api/notebooks (创建错题本)', () => {
        it('应该成功创建错题本', async () => {
            const newNotebook = {
                id: 'nb-new',
                displayName: '物理',
                userId: 'user-123',
                _count: { errorItems: 0 },
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(null); // 不存在同名
            mocks.mockPrismaNotebook.create.mockResolvedValue(newNotebook);

            const request = new Request('http://localhost/api/notebooks', {
                method: 'POST',
                body: JSON.stringify({ name: '物理' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(201);
            expect(data.displayName).toBe('物理');
            expect(data._count.errorItems).toBe(0);
        });

        it('应该拒绝创建空名称的错题本', async () => {
            const request = new Request('http://localhost/api/notebooks', {
                method: 'POST',
                body: JSON.stringify({ name: '' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(400);
            expect(data.message).toBe('Notebook name is required');
        });

        it('应该拒绝创建只有空格的错题本名称', async () => {
            const request = new Request('http://localhost/api/notebooks', {
                method: 'POST',
                body: JSON.stringify({ name: '   ' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(400);
            expect(data.message).toBe('Notebook name is required');
        });

        it('应该拒绝创建同名错题本', async () => {
            // 模拟已存在同名错题本
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue({
                id: 'existing-nb',
                displayName: '数学',
                userId: 'user-123',
            });

            const request = new Request('http://localhost/api/notebooks', {
                method: 'POST',
                body: JSON.stringify({ name: '数学' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(409);
            expect(data.message).toBe('Notebook with this name already exists');
        });

        it('应该自动 trim 名称两端的空格', async () => {
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(null);
            mocks.mockPrismaNotebook.create.mockResolvedValue({
                id: 'nb-new',
                displayName: '化学',
                userId: 'user-123',
                _count: { errorItems: 0 },
            });

            const request = new Request('http://localhost/api/notebooks', {
                method: 'POST',
                body: JSON.stringify({ name: '  化学  ' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(201);
            expect(data.displayName).toBe('化学');
        });
    });

    describe('GET /api/notebooks/[id] (获取单个错题本)', () => {
        it('应该返回错题本详情', async () => {
            const notebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'user-123',
                _count: { errorItems: 10 },
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(notebook);

            const request = new Request('http://localhost/api/notebooks/nb-1');
            const response = await GET_NOTEBOOK(request, { params: Promise.resolve({ id: 'nb-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.displayName).toBe('数学');
            expect(data._count.errorItems).toBe(10);
        });

        it('应该返回 404 当错题本不存在', async () => {
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(null);

            const request = new Request('http://localhost/api/notebooks/not-exist');
            const response = await GET_NOTEBOOK(request, { params: Promise.resolve({ id: 'not-exist' }) });
            const data = await response.json();

            expect(response.status).toBe(404);
            expect(data.message).toBe('Notebook not found');
        });

        it('应该拒绝访问其他用户的错题本', async () => {
            const notebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'other-user-id', // 不同的用户
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(notebook);

            const request = new Request('http://localhost/api/notebooks/nb-1');
            const response = await GET_NOTEBOOK(request, { params: Promise.resolve({ id: 'nb-1' }) });
            const data = await response.json();

            expect(response.status).toBe(403);
            expect(data.message).toContain('Not authorized');
        });
    });

    describe('PUT /api/notebooks/[id] (更新错题本)', () => {
        it('应该成功更新错题本名称', async () => {
            const existingNotebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'user-123',
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(existingNotebook);
            mocks.mockPrismaNotebook.update.mockResolvedValue({
                ...existingNotebook,
                displayName: '高等数学',
                _count: { errorItems: 5 },
            });

            const request = new Request('http://localhost/api/notebooks/nb-1', {
                method: 'PUT',
                body: JSON.stringify({ name: '高等数学' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'nb-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.displayName).toBe('高等数学');
        });

        it('应该拒绝更新为空名称', async () => {
            const existingNotebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'user-123',
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(existingNotebook);

            const request = new Request('http://localhost/api/notebooks/nb-1', {
                method: 'PUT',
                body: JSON.stringify({ name: '' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'nb-1' }) });
            const data = await response.json();

            expect(response.status).toBe(400);
            expect(data.message).toBe('Notebook name is required');
        });

        it('应该返回 404 当错题本不存在', async () => {
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(null);

            const request = new Request('http://localhost/api/notebooks/not-exist', {
                method: 'PUT',
                body: JSON.stringify({ name: '新名称' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'not-exist' }) });
            const data = await response.json();

            expect(response.status).toBe(404);
            expect(data.message).toBe('Notebook not found');
        });

        it('应该拒绝更新其他用户的错题本', async () => {
            const existingNotebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'other-user-id', // 不同的用户
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(existingNotebook);

            const request = new Request('http://localhost/api/notebooks/nb-1', {
                method: 'PUT',
                body: JSON.stringify({ name: '新名称' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'nb-1' }) });
            const data = await response.json();

            expect(response.status).toBe(403);
            expect(data.message).toContain('Not authorized');
        });
    });

    describe('DELETE /api/notebooks/[id] (删除错题本)', () => {
        it('应该成功删除空的错题本', async () => {
            const notebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'user-123',
                _count: { errorItems: 0 }, // 没有错题
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(notebook);
            mocks.mockPrismaNotebook.delete.mockResolvedValue(notebook);

            const request = new Request('http://localhost/api/notebooks/nb-1', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'nb-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.message).toBe('Notebook deleted successfully');
            expect(mocks.mockPrismaNotebook.delete).toHaveBeenCalledWith({ where: { id: 'nb-1' } });
        });

        /**
         * 【2026-10-12 需求第 8 条】空本里"已经删进回收箱"的题：
         * 不能再拦着不让删，而是**先真删那几道、再删本**，并把删了几道如实回报。
         */
        it('★ 空本 + 回收箱里还有它的题 ⇒ 先彻底删掉那几道，再删本（并回报条数）', async () => {
            const notebook = { id: 'nb-1', displayName: '数学', userId: 'user-123' };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(notebook);
            mocks.mockPrismaNotebook.delete.mockResolvedValue(notebook);
            // 还在用的：0 道；回收箱里的：3 道
            mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
            mocks.mockPrismaErrorItem.deleteMany.mockResolvedValue({ count: 3 });

            const response = await DELETE(
                new Request('http://localhost/api/notebooks/nb-1', { method: 'DELETE' }),
                { params: Promise.resolve({ id: 'nb-1' }) },
            );
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.purgedItems).toBe(3);
            // 真删的是"这本 + 已在回收箱里"的那些（条件必须写全，否则会把还在用的也删掉）
            expect(mocks.mockPrismaErrorItem.deleteMany).toHaveBeenCalledWith({
                where: { notebookId: 'nb-1', deletedAt: { not: null } },
            });
            expect(mocks.mockPrismaNotebook.delete).toHaveBeenCalled();
        });

        it('应该拒绝删除包含错题的错题本', async () => {
            const notebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'user-123',
                _count: { errorItems: 5 }, // 有错题
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(notebook);
            // 接口按"还没删的"那部分判断（`deletedAt: null`），不是按 _count
            mocks.mockPrismaErrorItem.count.mockResolvedValue(5);

            const request = new Request('http://localhost/api/notebooks/nb-1', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'nb-1' }) });
            const data = await response.json();

            expect(response.status).toBe(400);
            expect(data.message).toContain('Cannot delete notebook with error items');
            expect(mocks.mockPrismaNotebook.delete).not.toHaveBeenCalled();
        });

        it('应该返回 404 当错题本不存在', async () => {
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(null);

            const request = new Request('http://localhost/api/notebooks/not-exist', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'not-exist' }) });
            const data = await response.json();

            expect(response.status).toBe(404);
            expect(data.message).toBe('Notebook not found');
        });

        it('应该拒绝删除其他用户的错题本', async () => {
            const notebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'other-user-id', // 不同的用户
                _count: { errorItems: 0 },
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(notebook);

            const request = new Request('http://localhost/api/notebooks/nb-1', {
                method: 'DELETE',
            });

            const response = await DELETE(request, { params: Promise.resolve({ id: 'nb-1' }) });
            const data = await response.json();

            expect(response.status).toBe(403);
            expect(data.message).toContain('Not authorized');
            expect(mocks.mockPrismaNotebook.delete).not.toHaveBeenCalled();
        });
    });

    /**
     * 【2026-10-12 需求第 9 条】重名不许更新。
     * 表上有 `@@unique([displayName, userId])`，但直接撞上去会抛 P2002 ⇒ 500，
     * 界面只能弹一句"更新失败"。接口应当**先查一次**、回 409 把话说清楚。
     */
    describe('PUT /api/notebooks/[id] · 重名拦截', () => {
        it('★ 改成别人已经用了的名字 ⇒ 409，且一个字段都不写', async () => {
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue({
                id: 'nb-1', displayName: '数学', userId: 'user-123',
            });
            mocks.mockPrismaNotebook.findFirst.mockResolvedValue({ id: 'nb-2' }); // 撞上了

            const response = await PUT(
                new Request('http://localhost/api/notebooks/nb-1', {
                    method: 'PUT',
                    body: JSON.stringify({ displayName: '语文' }),
                }),
                { params: Promise.resolve({ id: 'nb-1' }) },
            );

            expect(response.status).toBe(409);
            expect(mocks.mockPrismaNotebook.update).not.toHaveBeenCalled();
        });

        it('名字**没改**（原样提交）⇒ 不能被自己拦下', async () => {
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue({
                id: 'nb-1', displayName: '数学', userId: 'user-123',
            });
            // 查重时明确把自己排除在外 ⇒ 查不到"另一个人"
            mocks.mockPrismaNotebook.findFirst.mockResolvedValue(null);
            mocks.mockPrismaNotebook.update.mockResolvedValue({ id: 'nb-1', displayName: '数学' });

            const response = await PUT(
                new Request('http://localhost/api/notebooks/nb-1', {
                    method: 'PUT',
                    body: JSON.stringify({ displayName: '数学', grade: '六年级' }),
                }),
                { params: Promise.resolve({ id: 'nb-1' }) },
            );

            expect(response.status).toBe(200);
            expect(mocks.mockPrismaNotebook.findFirst).toHaveBeenCalledWith({
                where: { userId: 'user-123', displayName: '数学', id: { not: 'nb-1' } },
                select: { id: true },
            });
        });
    });

    /** 【2026-10-12 需求第 6/12 条】拖动排序：整组重写位次 */
    describe('POST /api/notebooks/reorder', () => {
        it('★ 按给定顺序整批写 sortOrder（0..n-1）', async () => {
            mocks.mockPrismaNotebook.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
            mocks.mockPrismaNotebook.update.mockResolvedValue({});

            const response = await REORDER(
                new Request('http://localhost/api/notebooks/reorder', {
                    method: 'POST',
                    body: JSON.stringify({ ids: ['b', 'a'] }),
                }),
            );
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.ordered).toBe(2);
            expect(mocks.mockPrismaNotebook.update).toHaveBeenNthCalledWith(1, {
                where: { id: 'b' }, data: { sortOrder: 0 },
            });
            expect(mocks.mockPrismaNotebook.update).toHaveBeenNthCalledWith(2, {
                where: { id: 'a' }, data: { sortOrder: 1 },
            });
        });

        it('★ 有一个 id 不是自己的 ⇒ 403，**一条都不写**（半截写入比不写更糟）', async () => {
            mocks.mockPrismaNotebook.findMany.mockResolvedValue([{ id: 'a' }]); // 只认得 a

            const response = await REORDER(
                new Request('http://localhost/api/notebooks/reorder', {
                    method: 'POST',
                    body: JSON.stringify({ ids: ['a', '别人的本'] }),
                }),
            );

            expect(response.status).toBe(403);
            expect(mocks.mockPrismaNotebook.update).not.toHaveBeenCalled();
        });

        it('空数组 / 有重复 id ⇒ 400', async () => {
            const empty = await REORDER(
                new Request('http://localhost/api/notebooks/reorder', {
                    method: 'POST', body: JSON.stringify({ ids: [] }),
                }),
            );
            expect(empty.status).toBe(400);

            const dup = await REORDER(
                new Request('http://localhost/api/notebooks/reorder', {
                    method: 'POST', body: JSON.stringify({ ids: ['a', 'a'] }),
                }),
            );
            expect(dup.status).toBe(400);
        });
    });

    /** 【2026-10-12 需求第 7 条】并本 = 把 from 的题（含回收箱）整批改挂到 to，再删 from */
    describe('POST /api/notebooks/merge', () => {
        beforeEach(() => {
            mocks.mockPrismaNotebook.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
                where.id === 'from' || where.id === 'to'
                    ? { id: where.id, userId: 'user-123', archiveStatus: 'active' }
                    : null,
            );
        });

        it('★ 题（含回收箱里的）整批改挂到目标本，然后删掉源本', async () => {
            mocks.mockPrismaErrorItem.count
                .mockResolvedValueOnce(4)   // 还在用的
                .mockResolvedValueOnce(2);  // 回收箱里的
            mocks.mockPrismaErrorItem.updateMany.mockResolvedValue({ count: 6 });
            mocks.mockPrismaNotebook.delete.mockResolvedValue({});

            const response = await MERGE(
                new Request('http://localhost/api/notebooks/merge', {
                    method: 'POST',
                    body: JSON.stringify({ fromId: 'from', toId: 'to' }),
                }),
            );
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.movedItems).toBe(6);
            expect(data.movedTrashItems).toBe(2);
            // ⚠️ 条件里**不许**带 `deletedAt: null`：回收箱里的题也得一起改挂，
            //    否则删源本时它们会被级联删掉（而他以为只是"并进另一本"）
            expect(mocks.mockPrismaErrorItem.updateMany).toHaveBeenCalledWith({
                where: { notebookId: 'from', userId: 'user-123' },
                data: { notebookId: 'to' },
            });
            expect(mocks.mockPrismaNotebook.delete).toHaveBeenCalledWith({ where: { id: 'from' } });
        });

        it('★ 已归档的本不参与并本（要挪也得走归档那套规则，不能从双击漏进来）', async () => {
            mocks.mockPrismaNotebook.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
                id: where.id, userId: 'user-123',
                archiveStatus: where.id === 'from' ? 'archived' : 'active',
            }));

            const response = await MERGE(
                new Request('http://localhost/api/notebooks/merge', {
                    method: 'POST',
                    body: JSON.stringify({ fromId: 'from', toId: 'to' }),
                }),
            );

            expect(response.status).toBe(400);
            expect(mocks.mockPrismaErrorItem.updateMany).not.toHaveBeenCalled();
        });

        it('自己并自己 ⇒ 400', async () => {
            const response = await MERGE(
                new Request('http://localhost/api/notebooks/merge', {
                    method: 'POST',
                    body: JSON.stringify({ fromId: 'to', toId: 'to' }),
                }),
            );
            expect(response.status).toBe(400);
        });
    });
});
