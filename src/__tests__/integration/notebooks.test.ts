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
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn(),
    },
    /**
     * 【custom-v25】删除错题本前要数**含回收箱**的全部错题，
     * 所以 DELETE 接口依赖 errorItem.count —— mock 里缺它就会整段 500。
     */
    mockPrismaErrorItem: {
        count: vi.fn(),
    },
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

        it('应该拒绝删除包含错题的错题本', async () => {
            const notebook = {
                id: 'nb-1',
                displayName: '数学',
                userId: 'user-123',
                _count: { errorItems: 5 }, // 有错题
            };
            mocks.mockPrismaNotebook.findUnique.mockResolvedValue(notebook);
            // 接口实际按 errorItem.count 判断（含回收箱），不是按 _count
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
});
