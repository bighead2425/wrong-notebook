/**
 * /api/error-items API 集成测试
 * 测试错题创建、获取、更新等接口
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to ensure mocks are initialized before module imports
const mocks = vi.hoisted(() => ({
    mockPrismaUser: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
    },
    mockPrismaErrorItem: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(), // 用于去重检查
        findMany: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn(),
    },
    mockPrismaKnowledgeTag: {
        findFirst: vi.fn(),
        create: vi.fn(),
    },
    mockPrismaNotebook: {
        findUnique: vi.fn(),
    },
    /**
     * 【2026-10-15 补】等级变更留痕表。
     * 缺它的时候，"类型切换 ±1"那条路会打出一条
     * `Cannot read properties of undefined (reading 'createMany')` 的噪声
     * （接口本身不失败 —— 留痕写失败不影响主流程，但日志会被它污染）。
     */
    mockPrismaStateChangeLog: {
        createMany: vi.fn(),
    },
    /**
     * 【2026-10-15 补】每日等级结算的状态表。
     * 错题列表接口（`/api/error-items/list`）现在会顺手调一次 `maybeSettleDaily`，
     * 缺这个 mock 的话它会走到 catch 分支 —— 接口本身不失败（结算吞异常是设计），
     * 但日志会被"结算失败"的噪声刷屏。这里让它**直接返回"今天已结算"**短路掉。
     */
    mockPrismaDailySettle: {
        findUnique: vi.fn(() => Promise.resolve({ lastSettledOn: '2099-01-01' })),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
    },
    /**
     * 【2026-10-16 补】复习流水表（`ReviewEvent`）。
     * 此前**没有任何前端在传 `reviewEvent`** ⇒ 这张表一直是空的、测试也照不出来。
     * 现在有了断言，就要能看见它被写。
     */
    mockPrismaReviewEvent: {
        create: vi.fn(),
        /**
         * 【2026-10-16】派生要用的两个：
         * · `findMany` —— 取这道题**最近 4 条**流水来算派生值（默认给空 = 没录过）
         * · `updateMany` / `deleteMany` —— 表格里"改一条 / 删一条"（`op: update|delete`）
         * · `count` —— 老数据补流水前的"有没有流水"判断
         */
        findMany: vi.fn(() => Promise.resolve([])),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
        deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
        count: vi.fn(() => Promise.resolve(0)),
        createMany: vi.fn(),
    },
    mockSession: {
        user: {
            email: 'user@example.com',
            name: 'Test User',
        },
        expires: '2025-12-31',
    },
    /**
     * 【2026-10-16 补】卷（`ReviewVolume`）—— 详情页那张表的"来源"列要显示卷号
     * （`复练纸 RE20261016001`）。而 `ReviewEvent.volumeId` 是**普通字符串**、不是关系，
     * 所以服务端是**另查一次**卷号（不是 join）。
     */
    mockPrismaReviewVolume: {
        findMany: vi.fn(() => Promise.resolve([])),
    },
}));

// Mock Prisma client
vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.mockPrismaUser,
        errorItem: mocks.mockPrismaErrorItem,
        knowledgeTag: mocks.mockPrismaKnowledgeTag,
        notebook: mocks.mockPrismaNotebook,
        stateChangeLog: mocks.mockPrismaStateChangeLog,
        dailySettle: mocks.mockPrismaDailySettle,
        reviewEvent: mocks.mockPrismaReviewEvent,
        reviewVolume: mocks.mockPrismaReviewVolume,
    },
}));

// Mock next-auth
vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

// Mock grade-calculator
vi.mock('@/lib/grade-calculator', () => ({
    calculateGrade: vi.fn(() => '初一，上期'),
}));

// Import after mocks
import { POST } from '@/app/api/error-items/route';
import { GET as GET_ITEM, PUT } from '@/app/api/error-items/[id]/route';
import { GET as GET_LIST } from '@/app/api/error-items/list/route';
import { PATCH as PATCH_NOTES } from '@/app/api/error-items/[id]/notes/route';
import { PATCH as PATCH_MASTERY } from '@/app/api/error-items/[id]/mastery/route';
import { DELETE as DELETE_ITEM } from '@/app/api/error-items/[id]/delete/route';
/** 【2026-10-16 如如】详情页「复习结果」那张表的数据源（只读） */
import { GET as GET_REVIEW_EVENTS } from '@/app/api/error-items/[id]/review-events/route';
import { getServerSession } from 'next-auth';
/** 【2026-10-16 如如】用**前端那个构造器**拼事件 ⇒ 顺手把"两端形状一致"也验了 */
import { reviewEventDraft } from '@/lib/review-event-draft';

describe('/api/error-items', () => {
    const mockUser = {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
        educationStage: 'junior_high',
        enrollmentYear: 2024,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockPrismaUser.findUnique.mockResolvedValue(mockUser);
        vi.mocked(getServerSession).mockResolvedValue(mocks.mockSession);

        // Default: subject not found (handle null case)
        mocks.mockPrismaNotebook.findUnique.mockResolvedValue(null);

        // Default: knowledgeTag returns a mock tag (used when finding existing tags)
        mocks.mockPrismaKnowledgeTag.findFirst.mockImplementation(async (args: any) => {
            // Return a mock tag based on the search name
            const name = args?.where?.name;
            if (name) {
                return { id: `tag-${name}`, name, subject: 'math', isSystem: false };
            }
            return null;
        });

        // Default: create returns the created tag
        mocks.mockPrismaKnowledgeTag.create.mockImplementation(async (args: any) => ({
            id: `tag-new-${Date.now()}`,
            ...args.data,
        }));

        // Default: errorItem.findFirst returns null (no duplicate found)
        mocks.mockPrismaErrorItem.findFirst.mockResolvedValue(null);
    });

    describe('POST /api/error-items (创建错题)', () => {
        it('应该成功创建错题', async () => {
            const errorItemData = {
                questionText: '求解 x + 2 = 5',
                answerText: 'x = 3',
                analysis: '移项得 x = 5 - 2 = 3',
                knowledgePoints: ['一元一次方程', '移项'],
                originalImageUrl: 'data:image/png;base64,test...',
            };

            const createdItem = {
                id: 'error-item-1',
                ...errorItemData,
                userId: 'user-123',
                masteryLevel: 0,
                createdAt: new Date(),
            };
            mocks.mockPrismaErrorItem.create.mockResolvedValue(createdItem);

            const request = new Request('http://localhost/api/error-items', {
                method: 'POST',
                body: JSON.stringify(errorItemData),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(201);
            expect(data.id).toBe('error-item-1');
            expect(data.questionText).toBe('求解 x + 2 = 5');
        });

        it('应该成功创建错题并关联到科目', async () => {
            const errorItemData = {
                questionText: '计算 1 + 1',
                answerText: '2',
                analysis: '简单加法',
                knowledgePoints: ['加法'],
                originalImageUrl: 'data:image/png;base64,test...',
                notebookId: 'subject-math-id',
            };

            const createdItem = {
                id: 'error-item-2',
                ...errorItemData,
                userId: 'user-123',
                masteryLevel: 0,
            };
            mocks.mockPrismaErrorItem.create.mockResolvedValue(createdItem);

            const request = new Request('http://localhost/api/error-items', {
                method: 'POST',
                body: JSON.stringify(errorItemData),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(201);
            expect(data.notebookId).toBe('subject-math-id');
        });

        it('应该成功创建错题并设置年级学期', async () => {
            const errorItemData = {
                questionText: '求解方程',
                answerText: 'x = 5',
                analysis: '解析',
                knowledgePoints: ['方程'],
                originalImageUrl: 'data:image/png;base64,test...',
                gradeSemester: '初一上期',
                paperLevel: 'A',
            };

            const createdItem = {
                id: 'error-item-3',
                ...errorItemData,
                userId: 'user-123',
                masteryLevel: 0,
            };
            mocks.mockPrismaErrorItem.create.mockResolvedValue(createdItem);

            const request = new Request('http://localhost/api/error-items', {
                method: 'POST',
                body: JSON.stringify(errorItemData),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(201);
            expect(data.gradeSemester).toBe('初一上期');
            expect(data.paperLevel).toBe('A');
        });

        it('应该拒绝未登录用户创建错题', async () => {
            mocks.mockPrismaUser.findUnique.mockResolvedValue(null);
            mocks.mockPrismaUser.findFirst.mockResolvedValue(null);

            const request = new Request('http://localhost/api/error-items', {
                method: 'POST',
                body: JSON.stringify({
                    questionText: 'test',
                    originalImageUrl: 'test',
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(401);
            expect(data.message).toBeDefined(); // 可能返回不同的消息
        });

        it('应该自动计算年级学期（如果未提供）', async () => {
            const errorItemData = {
                questionText: '题目',
                answerText: '答案',
                analysis: '解析',
                knowledgePoints: ['知识点'],
                originalImageUrl: 'data:image/png;base64,test...',
                // 不提供 gradeSemester，应该自动计算
            };

            mocks.mockPrismaErrorItem.create.mockResolvedValue({
                id: 'error-item-4',
                ...errorItemData,
                userId: 'user-123',
                gradeSemester: '初一，上期',
                masteryLevel: 0,
            });

            const request = new Request('http://localhost/api/error-items', {
                method: 'POST',
                body: JSON.stringify(errorItemData),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);

            expect(response.status).toBe(201);
            // 验证 create 被调用时包含了计算后的 gradeSemester
            expect(mocks.mockPrismaErrorItem.create).toHaveBeenCalled();
        });

        it('应该正确处理字符串格式的知识点', async () => {
            const errorItemData = {
                questionText: '题目',
                answerText: '答案',
                analysis: '解析',
                knowledgePoints: '一元一次方程, 移项',
                originalImageUrl: 'data:image/png;base64,test...',
            };

            mocks.mockPrismaErrorItem.create.mockResolvedValue({
                id: 'error-item-5',
                ...errorItemData,
                userId: 'user-123',
                masteryLevel: 0,
            });

            const request = new Request('http://localhost/api/error-items', {
                method: 'POST',
                body: JSON.stringify(errorItemData),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);

            expect(response.status).toBe(201);
        });
    });

    describe('GET /api/error-items/[id] (获取单个错题)', () => {
        it('应该返回错题详情', async () => {
            const errorItem = {
                id: 'error-item-1',
                userId: 'user-123',
                questionText: '求解 x + 2 = 5',
                answerText: 'x = 3',
                analysis: '移项得 x = 5 - 2 = 3',
                knowledgePoints: '["一元一次方程", "移项"]',
                originalImageUrl: 'data:image/png;base64,test...',
                masteryLevel: 0,
                notebook: { id: 'math', displayName: '数学', subject: 'math' },
            };
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(errorItem);

            const request = new Request('http://localhost/api/error-items/error-item-1');
            const response = await GET_ITEM(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.questionText).toBe('求解 x + 2 = 5');
            expect(data.notebook.displayName).toBe('数学');
        });

        it('应该返回 404 当错题不存在', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(null);

            const request = new Request('http://localhost/api/error-items/not-exist');
            const response = await GET_ITEM(request, { params: Promise.resolve({ id: 'not-exist' }) });
            const data = await response.json();

            expect(response.status).toBe(404);
            expect(data.message).toBe('Item not found');
        });

        it('应该拒绝访问其他用户的错题', async () => {
            const errorItem = {
                id: 'error-item-1',
                userId: 'other-user-id', // 不同的用户
                questionText: '其他人的错题',
            };
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(errorItem);

            const request = new Request('http://localhost/api/error-items/error-item-1');
            const response = await GET_ITEM(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(403);
            expect(data.message).toContain('Not authorized');
        });
    });

    describe('PUT /api/error-items/[id] (更新错题)', () => {
        it('应该成功更新知识点', async () => {
            const existingItem = {
                id: 'error-item-1',
                userId: 'user-123',
                knowledgePoints: '["旧知识点"]',
            };
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(existingItem);
            mocks.mockPrismaErrorItem.update.mockResolvedValue({
                ...existingItem,
                knowledgePoints: '["新知识点1", "新知识点2"]',
            });

            const request = new Request('http://localhost/api/error-items/error-item-1', {
                method: 'PUT',
                body: JSON.stringify({ knowledgePoints: '["新知识点1", "新知识点2"]' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.knowledgePoints).toContain('新知识点1');
        });

        it('应该成功更新年级学期', async () => {
            const existingItem = {
                id: 'error-item-1',
                userId: 'user-123',
                gradeSemester: '初一上期',
            };
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(existingItem);
            mocks.mockPrismaErrorItem.update.mockResolvedValue({
                ...existingItem,
                gradeSemester: '初二下期',
            });

            const request = new Request('http://localhost/api/error-items/error-item-1', {
                method: 'PUT',
                body: JSON.stringify({ gradeSemester: '初二下期' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.gradeSemester).toBe('初二下期');
        });

        it('应该成功更新试卷等级', async () => {
            const existingItem = {
                id: 'error-item-1',
                userId: 'user-123',
                paperLevel: 'A',
            };
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(existingItem);
            mocks.mockPrismaErrorItem.update.mockResolvedValue({
                ...existingItem,
                paperLevel: 'B',
            });

            const request = new Request('http://localhost/api/error-items/error-item-1', {
                method: 'PUT',
                body: JSON.stringify({ paperLevel: 'B' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.paperLevel).toBe('B');
        });

        it('应该拒绝更新其他用户的错题', async () => {
            const existingItem = {
                id: 'error-item-1',
                userId: 'other-user-id', // 不同的用户
            };
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(existingItem);

            const request = new Request('http://localhost/api/error-items/error-item-1', {
                method: 'PUT',
                body: JSON.stringify({ knowledgePoints: '["test"]' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(403);
            expect(data.message).toContain('Not authorized');
        });

        it('应该返回 404 当错题不存在', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(null);

            const request = new Request('http://localhost/api/error-items/not-exist', {
                method: 'PUT',
                body: JSON.stringify({ knowledgePoints: '["test"]' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PUT(request, { params: Promise.resolve({ id: 'not-exist' }) });
            const data = await response.json();

            expect(response.status).toBe(404);
            expect(data.message).toBe('Item not found');
        });
    });

    /* ==========================================================================
     * 【2026-10-14 加第 4 格】复习结果四格 —— 走**真接口**再验一次
     *
     * 背景：空空报"点第 4 个复习圆圈 ⇒ 更新失败"。单元层已经查明根因在等级联动
     * （`level-linkage` 的槽位名表停在 3 格 ⇒ `slot = undefined`），
     * 这里从**接口层**确认"填第 4 格 / 清第 4 格都是 200"，并把临时口径钉住。
     * ======================================================================== */
    describe('PUT /api/error-items/[id] · 传旧形状的 `reviewOutcomes` ⇒ 被忽略（2026-10-16 起）', () => {
        /**
         * 【2026-10-16 如如】这个 describe 原来是"加第 4 格"的回归测试（老形状的写入路径）。
         * 现在**写入路径整个换掉了**（`docs\18` §3.1：流水是唯一真相，`reviewOutcomes` 是派生缓存）
         * ⇒ 客户端传什么都不再直接落库。
         *
         * 📌 **老的回归意图保留**：**"点第 4 格 ⇒ 接口 500"那个 bug 结构上不可能再发生** ——
         *    那条路径（`computeLevelLinkage` 按 planned 下标算账）已经不存在了。
         */
        const itemWith = (reviewOutcomes: string | null) => ({
            id: 'error-item-1',
            userId: 'user-123',
            attention: 3,
            levelCountdown: 3,
            manageType: 'review',
            levelLedger: null,
            reviewOutcomes,
            createdAt: new Date(2026, 8, 20),
        });

        const put = async (body: Record<string, unknown>) => {
            const request = new Request('http://localhost/api/error-items/error-item-1', {
                method: 'PUT',
                body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json' },
            });
            return PUT(request, { params: Promise.resolve({ id: 'error-item-1' }) });
        };

        it('★★ 传旧形状 ⇒ 200，但**一个字节都不写**（派生值只认流水）', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(
                itemWith(JSON.stringify({ planned: ['right', 'wrong', 'right', null], last: 'wrong' })),
            );
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));

            const res = await put({
                reviewOutcomes: JSON.stringify({ planned: ['right', 'wrong', 'right', 'right'], last: 'right' }),
            });

            expect(res.status).toBe(200);
            const arg = mocks.mockPrismaErrorItem.update.mock.calls[0][0] as { data: Record<string, unknown> };
            expect(arg.data).not.toHaveProperty('reviewOutcomes');
            expect(arg.data).not.toHaveProperty('attention');
            expect(arg.data).not.toHaveProperty('levelCountdown');
        });

        it('★★ 老 bug"点第 4 格 ⇒ 500"**结构上不可能再发生**（那条路径已删）', async () => {
            // 老形状里最容易崩的两个样子：第 4 格刚填、以及把它清空
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(
                itemWith(JSON.stringify({ planned: ['right', 'wrong', 'right', 'right'], last: 'right' })),
            );
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));

            const filled = await put({
                reviewOutcomes: JSON.stringify({ planned: ['right', 'wrong', 'right', 'right'], last: 'right' }),
            });
            const cleared = await put({
                reviewOutcomes: JSON.stringify({ planned: ['right', 'wrong', 'right', null], last: 'right' }),
            });

            expect(filled.status).toBe(200);
            expect(cleared.status).toBe(200);
            // 而且**连带写等级的手也没抖**：这条路径不再碰等级
            const arg = mocks.mockPrismaErrorItem.update.mock.calls[0][0] as { data: Record<string, unknown> };
            expect(arg.data).not.toHaveProperty('levelCountdown');
        });

        it('★ 传了**不报错**（改个备注不该因为夹带老字段就整个失败）', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(itemWith(null));
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));

            const res = await put({ userNotes: '备注', reviewOutcomes: '不是-json-也不是对象' });
            expect(res.status).toBe(200);
        });
    });

    /* ==========================================================================
     * 【2026-10-15 **等级完全收回系统管理**】—— 注意分清两件事：
     *
     *   ✅ **请求不能"指定"等级** —— `attention` 入参被忽略（后门已关）。
     *   ✅ **但"记下复习结果"会按规则重算等级** —— 这是**系统**在算，不是人在改：
     *      间隔表（对错 ⇒ 多少天后再练）+ 阈值表（还剩几天 ⇒ 哪个档），
     *      规则唯一实现在 `lib/level-settle.ts`（纯函数，41 条单测）。
     *
     *   ❌ 停掉的三条"人工/旧机制"路径：
     *      ① 复习结果按**旧账本**组合加减（记在 `levelLedger` 上）—— 整段停用；
     *      ② 类型切换 ±1（复练 ⇄ 深挖）—— 空空："纸型和紧迫程度联系不是那么紧密"；
     *      ③ 四处 UI 的人工改档入口（卡片图标 / 详情页下拉 / 扫码面板 / 分析页）。
     *
     * ⚠️ 这几条断言是**跟着行为一起改的**，不是"测试红了就改测试"——
     *    行为本身是空空明确要改的（教训 #17：改断言前先确认"它钉的行为本身对不对"）。
     * ======================================================================== */
    describe('PUT /api/error-items/[id] · 等级由系统算（2026-10-15 收回人工入口）', () => {
        const itemWith = (reviewOutcomes: string | null) => ({
            id: 'error-item-1',
            userId: 'user-123',
            attention: 3,
            manageType: 'review',
            levelLedger: null,
            reviewOutcomes,
        });

        const putBody = async (body: Record<string, unknown>) => {
            const request = new Request('http://localhost/api/error-items/error-item-1', {
                method: 'PUT',
                body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json' },
            });
            return PUT(request, { params: Promise.resolve({ id: 'error-item-1' }) });
        };

        it('★★ 记一次复习结果 ⇒ 按**新规则**重算等级，并把派生缓存写回去', async () => {
            /**
             * 【2026-10-16 如如】**这条原来走的是"传 `reviewOutcomes` 旧形状"那条路**
             * （因为那时写入路径还是"整包覆盖"）。现在流行为真相 ⇒ 改成**发一条 `reviewEvent`**，
             * 意图一字不改：**同样的输入必须算出同样的倒数与等级**。
             */
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(itemWith(null));
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));
            /**
             * ⚠️ **假数据必须按 `desc` 给** —— 真实查询是 `orderBy desc` + `take` 再**反转**
             *    （见 `listRecentEvents`：那样才能取到"**最近** N 条"）。
             *    这里如果按正序给，被反转之后就变成倒的，规则会按"最近一条是对"去算
             *    —— 2026-10-16 第一次写就是这么错的，测试当场抓住。
             */
            mocks.mockPrismaReviewEvent.findMany.mockResolvedValue([
                { id: 'e2', outcome: 'wrong', occurredOn: '2026-10-16', createdAt: new Date(2026, 9, 16) },
                { id: 'e1', outcome: 'right', occurredOn: '2026-10-10', createdAt: new Date(2026, 9, 10) },
            ]);

            await putBody({
                reviewEvent: { occurredOn: '2026-10-16', outcome: 'wrong', source: 'detail_page' },
            });

            const arg = mocks.mockPrismaErrorItem.update.mock.calls[0][0] as { data: Record<string, unknown> };
            /**
             * 序列 = 对、错 ⇒ 最近一次错（连错 1）⇒ 间隔 4 天 ⇒ 倒数 4、等级 4（🥥 抓紧）。
             *
             * ⚠️ 这里**故意同时钉住"倒数"和"等级"两个值** —— 只钉等级的话，
             *    万一实现里"倒数写对了但等级算错了"，测试照样绿。两者都钉才真验了规则。
             * ⚠️ 与旧机制的区别：旧的记在 `levelLedger` 账本上、靠"这次变化了几笔"推；
             *    新的**直接由事实推出**（间隔表 + 阈值表），不落任何中间账。
             */
            /** 【2026-10-21】4 级间隔 4 → 3 天 */
            expect(arg.data.levelCountdown).toBe(3);
            expect(arg.data.attention).toBe(4);
            // ★ 派生缓存也写回去了（这就是"错题卡上那 4 个圈"的数据源）
            expect(JSON.parse(String(arg.data.reviewOutcomes)).recent).toEqual(['right', 'wrong']);
            // 旧账本不许再被读写
            expect(arg.data).not.toHaveProperty('levelLedger');
        });

        it('★★ 【2026-10-15 也停用了】改类型**不再牵动等级**', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                ...itemWith(null),
                attention: 1,
                manageType: 'review',
            });
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));

            await putBody({ manageType: 'deep' });

            const arg = mocks.mockPrismaErrorItem.update.mock.calls[0][0] as { data: Record<string, unknown> };
            // 类型本身照旧要落库（深挖/复练仍然能改 —— 停的只是"它牵动等级"）
            expect(arg.data.manageType).toBe('deep');
            // ⚠️ 但**等级一点都不许动** —— 等级与纸型脱钩，归系统管
            expect(arg.data).not.toHaveProperty('attention');
        });

        it('★★ 请求里直接传 `attention` 也**写不进去**（后门已关）', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                ...itemWith(null),
                attention: 3,
            });
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));

            await putBody({ attention: 5, userNotes: '顺手改个备注' });

            const arg = mocks.mockPrismaErrorItem.update.mock.calls[0][0] as { data: Record<string, unknown> };
            // 等级不许动
            expect(arg.data).not.toHaveProperty('attention');
            // ⚠️ 但**别的字段照旧要落库** —— 不能因为忽略了一个字段就让整次"改题"失败
            expect(arg.data.userNotes).toBe('顺手改个备注');
        });
    });

    /* ==========================================================================
     * 【2026-10-16 如如】复习流水（`ReviewEvent`）—— **端到端**：
     * 前端构造的草稿 → 接口 → 落库。
     *
     * 背景（真真 2026-10-15 复核发现，见 HANDOFF §③-11）：这张表 10-14 就建好、
     * API 也接得住，但**四个前端写入点一处都没传** ⇒ 表永远为空，而且**完全静默**
     * （不报错、日志也没有）。本组把**接口这一侧**钉死；前端四点由
     * `review-event-draft` 的单测 + 类型一起钉住。
     * ======================================================================== */
    describe('PUT /api/error-items/[id] · 复习流水（ReviewEvent）', () => {
        const itemWith = (reviewOutcomes: string | null) => ({
            id: 'error-item-1',
            userId: 'user-123',
            attention: 5,
            manageType: 'review',
            levelLedger: null,
            reviewOutcomes,
        });

        const put = async (body: Record<string, unknown>) => {
            const request = new Request('http://localhost/api/error-items/error-item-1', {
                method: 'PUT',
                body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json' },
            });
            return PUT(request, { params: Promise.resolve({ id: 'error-item-1' }) });
        };

        it('★★ 已掌握的题 ⇒ 流水被忽略，但**响应里必须明确告诉前端**（2026-10-18）', async () => {
            /**
             * 为什么要这条：
             *   服务端对已掌握的题会**忽略**流水（`docs\18` 决策 ⑧：冻住就真冻住）。
             *   原来它只 `logger.warn` 就返回 200 —— 前端不知道，于是"乐观改了圈 → 重拉记录
             *   → 圈跳回"，用户看到的是"我点错了 / 点了没反应"（空空 2026-10-18 报的第 3 条）。
             * ⇒ 现在响应里带 `reviewEventIgnored: 'mastered'`，前端据此说一句人话。
             */
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                ...itemWith('{}'),
                masteryLevel: 2, // 已掌握
            });
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));
            mocks.mockPrismaReviewEvent.create.mockClear();

            const res = await put({ reviewEvent: reviewEventDraft({ outcome: 'wrong', plannedIndex: null }) });
            const body = await res.json();

            expect(res.status).toBe(200); // 不报错：同一条请求还可能带别的主字段更新
            expect(mocks.mockPrismaReviewEvent.create).not.toHaveBeenCalled();
            expect(body.reviewEventIgnored).toBe('mastered');
        });

        it('★★ 传了 reviewEvent ⇒ 落一条流水（用前端那个构造器拼的，形状必须被认）', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(itemWith(null));
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));

            const event = reviewEventDraft({ outcome: 'wrong', plannedIndex: 2, volumeId: 'vol-9' });
            const res = await put({
                reviewOutcomes: JSON.stringify({ planned: [null, null, 'wrong', null], last: 'wrong' }),
                reviewEvent: event,
            });

            expect(res.status).toBe(200);
            expect(mocks.mockPrismaReviewEvent.create).toHaveBeenCalledTimes(1);
            expect(mocks.mockPrismaReviewEvent.create.mock.calls[0][0]).toMatchObject({
                data: {
                    userId: 'user-123',
                    errorItemId: 'error-item-1',
                    occurredOn: event.occurredOn,
                    outcome: 'wrong',
                    plannedIndex: 2,
                    volumeId: 'vol-9',
                },
            });
        });

        it("★ 不传 reviewEvent ⇒ **一条都不写**（不许“顺手补一条”）", async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(itemWith(null));
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));

            const res = await put({
                reviewOutcomes: JSON.stringify({ planned: ['right', null, null, null], last: 'right' }),
            });

            expect(res.status).toBe(200);
            expect(mocks.mockPrismaReviewEvent.create).not.toHaveBeenCalled();
        });

        it('★ 形状不对（日期不是 `YYYY-MM-DD`）⇒ **当没传**，但主更新照旧成功', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(itemWith(null));
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));

            const res = await put({
                reviewOutcomes: JSON.stringify({ planned: ['right', null, null, null], last: 'right' }),
                reviewEvent: { occurredOn: '2026/10/16', outcome: 'right' },
            });

            expect(res.status).toBe(200);
            expect(mocks.mockPrismaReviewEvent.create).not.toHaveBeenCalled();
        });

        it('★ 流水写失败**不许**连带让"改题"失败（与留痕同一条规矩）', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(itemWith(null));
            mocks.mockPrismaErrorItem.update.mockResolvedValue(itemWith('{}'));
            mocks.mockPrismaReviewEvent.create.mockRejectedValueOnce(new Error('db down'));

            const res = await put({
                reviewOutcomes: JSON.stringify({ planned: [null, null, null, 'right'], last: 'right' }),
                reviewEvent: reviewEventDraft({ outcome: 'right', plannedIndex: 3 }),
            });

            expect(res.status).toBe(200);
        });
    });

    describe('GET /api/error-items/[id]/review-events (详情页那张表要读的流水)', () => {
        const call = async (id = 'error-item-1') =>
            GET_REVIEW_EVENTS(new Request(`http://localhost/api/error-items/${id}/review-events`), {
                params: Promise.resolve({ id }),
            });

        it('没登录 ⇒ 401', async () => {
            vi.mocked(getServerSession).mockResolvedValueOnce(null);
            const res = await call();
            expect(res.status).toBe(401);
        });

        it('别人的题 ⇒ 403（不许读别人的复习流水）', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({ userId: 'someone-else' });
            const res = await call();
            expect(res.status).toBe(403);
        });

        it('题不存在 ⇒ 404', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(null);
            const res = await call();
            expect(res.status).toBe(404);
        });

        it('★★ 一次查完 + **正序**返回 + 带卷号（`take: 4` 取的是最近 4 条）', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({ userId: 'user-123' });
            // 真实查询是 desc 取 N 条再反转 ⇒ 这里也给 desc 顺序的一组
            mocks.mockPrismaReviewEvent.findMany.mockResolvedValue([
                { id: 'e3', occurredOn: '2026-10-16', outcome: 'right', source: 'review_paper', volumeId: 'vol-1', createdAt: new Date('2026-10-16T13:30:00Z') },
                { id: 'e2', occurredOn: '2026-10-12', outcome: 'wrong', source: 'single_scan', volumeId: null, createdAt: new Date('2026-10-12T11:02:00Z') },
                { id: 'e1', occurredOn: '2026-10-10', outcome: 'right', source: 'legacy', volumeId: null, createdAt: new Date('2026-10-10T02:00:00Z') },
            ]);
            mocks.mockPrismaReviewVolume.findMany.mockResolvedValue([
                { id: 'vol-1', volumeNo: 'RE20261016001' },
            ]);

            const res = await call();
            expect(res.status).toBe(200);
            const body = (await res.json()) as { events: Array<Record<string, unknown>> };

            // ① 正序：最早的在前，末尾 = 最近一次
            expect(body.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
            // ② 卷号查得到（`volumeId` 是普通字符串，卷号是**另查一次**拼上的）
            expect(body.events[2].volumeNo).toBe('RE20261016001');
            expect(body.events[1].volumeNo).toBeNull();
            // ③ 老数据补的那条（legacy）也在 —— 界面自己决定"不显示它的日期"
            expect(body.events[0].source).toBe('legacy');

            // ④ 只查一次、且只取 4 条、且**显式 select**（不许拉全表）
            expect(mocks.mockPrismaReviewEvent.findMany).toHaveBeenCalledTimes(1);
            const arg = mocks.mockPrismaReviewEvent.findMany.mock.calls[0][0] as {
                take?: number;
                select?: Record<string, unknown>;
                orderBy?: unknown;
            };
            expect(arg.take).toBe(4);
            expect(arg.select).toBeTruthy();
            // ⑤ 卷号**一次查完**（`in: [...]`），不许每行查一遍（`docs\17` 那条性能账）
            expect(mocks.mockPrismaReviewVolume.findMany).toHaveBeenCalledTimes(1);
        });

        it('没有流水 ⇒ 空数组（界面那一行写"无"，不是报错）', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({ userId: 'user-123' });
            mocks.mockPrismaReviewEvent.findMany.mockResolvedValue([]);

            const res = await call();
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ events: [] });
            // 一条流水都没有 ⇒ 不必去查卷
            expect(mocks.mockPrismaReviewVolume.findMany).not.toHaveBeenCalled();
        });
    });

    describe('GET /api/error-items/list (获取错题列表)', () => {
        it('应该返回用户的错题（分页响应）', async () => {
            const errorItems = [
                { id: '1', questionText: '题目1', userId: 'user-123' },
                { id: '2', questionText: '题目2', userId: 'user-123' },
            ];
            mocks.mockPrismaErrorItem.count.mockResolvedValue(2);
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue(errorItems);

            const request = new Request('http://localhost/api/error-items/list');
            const response = await GET_LIST(request);
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.items).toHaveLength(2);
            expect(data.total).toBe(2);
            expect(data.page).toBe(1);
            expect(data.pageSize).toBe(18);
            expect(data.totalPages).toBe(1);
        });

        it('应该支持按科目筛选', async () => {
            mocks.mockPrismaErrorItem.count.mockResolvedValue(1);
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([
                { id: '1', questionText: '数学题', notebookId: 'math-id' },
            ]);

            const request = new Request('http://localhost/api/error-items/list?notebookId=math-id');
            const response = await GET_LIST(request);

            expect(response.status).toBe(200);
            // 验证查询时使用了 notebookId 筛选
            expect(mocks.mockPrismaErrorItem.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        notebookId: 'math-id',
                    }),
                })
            );
        });

        it('应该支持搜索查询', async () => {
            mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

            const request = new Request('http://localhost/api/error-items/list?query=方程');
            const response = await GET_LIST(request);

            expect(response.status).toBe(200);
            // 搜索条件现在被包装在 AND 数组中，以便与其他筛选条件正确组合
            expect(mocks.mockPrismaErrorItem.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        AND: expect.arrayContaining([
                            expect.objectContaining({
                                OR: expect.any(Array),
                            }),
                        ]),
                    }),
                })
            );
        });

        /**
         * ⚠️⚠️【2026-10-15 **修正口径**】原来是 `mastery=1 ⇒ masteryLevel > 0`，
         *    那等于把 **`1`（复习中）也算成"已掌握"** —— 名不副实。
         *    空空 2026-10-15 把模型说死了："二分"（已掌握 / 未掌握）
         *    ⇒ **只有 `= 2` 才是已掌握**（`1` 从未被业务写入，是预留档）。
         */
        it('应该支持按掌握程度筛选（=2 才算已掌握）', async () => {
            mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

            const request = new Request('http://localhost/api/error-items/list?mastery=1');
            const response = await GET_LIST(request);

            expect(response.status).toBe(200);
            expect(mocks.mockPrismaErrorItem.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        masteryLevel: { equals: 2 },
                    }),
                })
            );
        });

        // ====================================================================
        // ⭐【2026-10-15 新】「掌握 / 等级」**合并筛选**（`docs\14` §7.5）
        // 空空把原【筛选】里的「掌握状态」整组并进【等级】⇒ 6 个选项，
        // 且明确了两件事：
        //   ① **已掌握默认可见**（"这道题虽然'已掌握'，但我还是要能够看得见"）；
        //   ② **已掌握优先于等级**（已掌握的题不出现在任何等级档的结果里）。
        // ====================================================================
        describe('合并筛选 levelFilter（掌握 + 等级）', () => {
            const listWhere = () =>
                (mocks.mockPrismaErrorItem.findMany.mock.calls[0][0] as {
                    where: { AND?: { OR?: unknown[] }[]; masteryLevel?: unknown; attention?: unknown };
                }).where;

            it('★★ **默认不再排除已掌握** —— 不传 levelFilter 也不传 mastery', async () => {
                mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
                mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

                await GET_LIST(new Request('http://localhost/api/error-items/list'));

                const where = listWhere();
                expect(where.masteryLevel).toBeUndefined();
                expect(JSON.stringify(where.AND ?? [])).not.toContain('masteryLevel');
            });

            it('★★ 选中某一档等级 ⇒ 等级分支带 `masteryLevel: { lt: 2 }`（**已掌握优先**）', async () => {
                mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
                mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

                await GET_LIST(new Request('http://localhost/api/error-items/list?levelFilter=3'));

                const branches = (listWhere().AND ?? []).flatMap((c) => c.OR ?? []);
                expect(branches).toEqual(
                    expect.arrayContaining([{ masteryLevel: { lt: 2 }, attention: { in: [3] } }]),
                );
            });

            it('★★ 同时选"已掌握 + 一档" ⇒ 两个分支**并列**（OR），谁也不挤掉谁', async () => {
                mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
                mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

                await GET_LIST(new Request('http://localhost/api/error-items/list?levelFilter=mastered,3'));

                const branches = (listWhere().AND ?? []).flatMap((c) => c.OR ?? []);
                expect(branches).toHaveLength(2);
                expect(branches).toEqual(
                    expect.arrayContaining([
                        { masteryLevel: { gte: 2 } },
                        { masteryLevel: { lt: 2 }, attention: { in: [3] } },
                    ]),
                );
            });

            /**
             * 【2026-10-20 改】**7 项全选 = 没筛** —— 空空加了「预掌握」（`preMastered`）。
             * ⚠️ 原来这里写死 `mastered,1,2,3,4,5`（6 项），加档位后它不再等于"全选"，
             *    接口就会真的加一条 OR 条件 ⇒ 这条测试当场红。
             *    测的是"全选不加条件"这条**规则**，所以键必须跟着 `FILTER_KEYS` 走。
             */
            it('★★ **7 项全选 = 没筛**（一个条件都不加），脏键直接丢掉', async () => {
                mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
                mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

                await GET_LIST(
                    new Request('http://localhost/api/error-items/list?levelFilter=mastered,preMastered,1,2,3,4,5'),
                );
                expect(JSON.stringify(listWhere().AND ?? [])).not.toContain('masteryLevel');
                expect(JSON.stringify(listWhere().AND ?? [])).not.toContain('attention');

                // 脏键（`9`、`外星人`）不该让接口报错，也不该影响筛选
                mocks.mockPrismaErrorItem.findMany.mockClear();
                const dirtyRes = await GET_LIST(
                    new Request('http://localhost/api/error-items/list?levelFilter=9,外星人'),
                );
                expect(dirtyRes.status).toBe(200);
                const dirtyWhere = listWhere();
                expect(dirtyWhere.masteryLevel).toBeUndefined();
                expect(JSON.stringify(dirtyWhere.AND ?? [])).not.toContain('attention');
            });
        });

        /**
         * ⭐⭐【2026-10-16 真真】**性能修复的看门测试：默认不许传题图。**
         *
         * 背景（空空实测）：局域网打开"小五上数学大库"（才 66 道题），错题卡出来要 **10 秒**。
         * 根因：这个接口原来没有 `select`/`omit` ⇒ 把 `ErrorItem` 的**全部标量字段**都返回，
         * 其中 `originalImageUrl` 是**题图 base64**（单张最大约 1.37MB，见 `lib/image-utils.ts`
         * 的 `compressImage(maxSizeMB = 1)`），默认每页 18 条 ⇒ **一次请求最多约 24MB**。
         * 而 6 个调用方里**只有打印预览**需要题图。
         *
         * ⇒ 契约：**默认 `omit` 掉题图；只有 `?withImages=1` 才带。**
         * ⚠️ 这里只能钉"有没有把 omit 传下去"（mock 的 findMany 不会真的执行 omit）——
         *    真正"返回体里没有图"要靠真实 DB，那种测试在本仓太重，不值得。
         *    钉住调用参数已经足够拦住"以后有人把 omit 删了"。
         */
        describe('题图（originalImageUrl）默认不返回', () => {
            const selectOf = () =>
                mocks.mockPrismaErrorItem.findMany.mock.calls[0][0] as { select?: Record<string, unknown> };

            it('★★ 默认**不许**把 `originalImageUrl` 放进 select —— 否则一次列表又白传 9MB', async () => {
                mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
                mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

                await GET_LIST(new Request('http://localhost/api/error-items/list'));

                expect(selectOf().select).toBeDefined();
                expect(selectOf().select!.originalImageUrl).toBeUndefined();
                // 关系也要带上（原来 include 的那两个）
                expect(selectOf().select!.notebook).toBe(true);
                expect(selectOf().select!.tags).toBe(true);
            });

            it('★ `?withImages=1` 时才把题图带回来（打印预览要印题图）', async () => {
                mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
                mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

                await GET_LIST(new Request('http://localhost/api/error-items/list?withImages=1'));

                expect(selectOf().select!.originalImageUrl).toBe(true);
            });

            it('★ 传别的值（如 `withImages=0`）一律当"不要图" —— 只认 `1`', async () => {
                mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
                mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

                await GET_LIST(new Request('http://localhost/api/error-items/list?withImages=0'));

                expect(selectOf().select!.originalImageUrl).toBeUndefined();
            });

            it('★ 常用的那些字段**必须在 select 里**（别为了省图把字段也省没了）', async () => {
                mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
                mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

                await GET_LIST(new Request('http://localhost/api/error-items/list'));

                const sel = selectOf().select!;
                for (const f of [
                    'id', 'userId', 'questionText', 'attention', 'levelCountdown', 'masteryLevel',
                    'reviewOutcomes', 'manageType', 'printCount', 'reviewPrintCount',
                    'mistakeCategory', 'knowledgePoints', 'createdAt', 'source', 'deletedAt',
                ]) {
                    expect(sel[f], `select 里少了 ${f}`).toBe(true);
                }
            });
        });

        it('应该支持按知识点标签筛选', async () => {
            mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

            const request = new Request('http://localhost/api/error-items/list?tag=一元一次方程');
            const response = await GET_LIST(request);

            expect(response.status).toBe(200);
            expect(mocks.mockPrismaErrorItem.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        knowledgePoints: { contains: '一元一次方程' },
                    }),
                })
            );
        });

        it('应该支持按时间范围筛选（最近一周）', async () => {
            mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

            const request = new Request('http://localhost/api/error-items/list?timeRange=week');
            const response = await GET_LIST(request);

            expect(response.status).toBe(200);
            expect(mocks.mockPrismaErrorItem.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        createdAt: expect.objectContaining({
                            gte: expect.any(Date),
                        }),
                    }),
                })
            );
        });

        it('应该支持按试卷等级筛选', async () => {
            mocks.mockPrismaErrorItem.count.mockResolvedValue(0);
            mocks.mockPrismaErrorItem.findMany.mockResolvedValue([]);

            const request = new Request('http://localhost/api/error-items/list?paperLevel=A');
            const response = await GET_LIST(request);

            expect(response.status).toBe(200);
            expect(mocks.mockPrismaErrorItem.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        paperLevel: 'A',
                    }),
                })
            );
        });
    });

    describe('PATCH /api/error-items/[id]/notes (更新笔记)', () => {
        it('应该成功更新用户笔记', async () => {
            const existingItem = {
                id: 'error-item-1',
                userId: 'user-123',
                userNotes: '',
            };
            mocks.mockPrismaErrorItem.update.mockResolvedValue({
                ...existingItem,
                userNotes: '这道题需要注意移项变号',
            });

            const request = new Request('http://localhost/api/error-items/error-item-1/notes', {
                method: 'PATCH',
                body: JSON.stringify({ userNotes: '这道题需要注意移项变号' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_NOTES(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.userNotes).toBe('这道题需要注意移项变号');
        });

        it('应该成功清空笔记', async () => {
            const existingItem = {
                id: 'error-item-1',
                userId: 'user-123',
                userNotes: '旧笔记内容',
            };
            mocks.mockPrismaErrorItem.update.mockResolvedValue({
                ...existingItem,
                userNotes: '',
            });

            const request = new Request('http://localhost/api/error-items/error-item-1/notes', {
                method: 'PATCH',
                body: JSON.stringify({ userNotes: '' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_NOTES(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.userNotes).toBe('');
        });

        it('应该成功保存长笔记', async () => {
            const longNote = '这是一段很长的笔记内容。'.repeat(100);
            mocks.mockPrismaErrorItem.update.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
                userNotes: longNote,
            });

            const request = new Request('http://localhost/api/error-items/error-item-1/notes', {
                method: 'PATCH',
                body: JSON.stringify({ userNotes: longNote }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_NOTES(request, { params: Promise.resolve({ id: 'error-item-1' }) });

            expect(response.status).toBe(200);
        });

        it('应该拒绝未登录用户', async () => {
            mocks.mockPrismaUser.findUnique.mockResolvedValue(null);
            mocks.mockPrismaUser.findFirst.mockResolvedValue(null);

            const request = new Request('http://localhost/api/error-items/error-item-1/notes', {
                method: 'PATCH',
                body: JSON.stringify({ userNotes: '笔记' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_NOTES(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(401);
            expect(data.message).toBeDefined();
        });

        it('应该处理数据库错误', async () => {
            mocks.mockPrismaErrorItem.update.mockRejectedValue(new Error('Database error'));

            const request = new Request('http://localhost/api/error-items/error-item-1/notes', {
                method: 'PATCH',
                body: JSON.stringify({ userNotes: '笔记' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_NOTES(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(500);
            expect(data.message).toBe('Failed to update notes');
        });
    });

    describe('PATCH /api/error-items/[id]/mastery (更新掌握程度)', () => {
        it('应该成功更新掌握程度为已掌握', async () => {
            // Mock ownership check (findUnique)
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
            });
            mocks.mockPrismaErrorItem.update.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
                masteryLevel: 1,
            });

            const request = new Request('http://localhost/api/error-items/error-item-1/mastery', {
                method: 'PATCH',
                body: JSON.stringify({ masteryLevel: 1 }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_MASTERY(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.masteryLevel).toBe(1);
        });

        it('应该成功更新掌握程度为未掌握', async () => {
            // Mock ownership check (findUnique)
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
            });
            mocks.mockPrismaErrorItem.update.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
                masteryLevel: 0,
            });

            const request = new Request('http://localhost/api/error-items/error-item-1/mastery', {
                method: 'PATCH',
                body: JSON.stringify({ masteryLevel: 0 }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_MASTERY(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.masteryLevel).toBe(0);
        });

        it('应该支持 0 / 1 / 2 三档掌握程度', async () => {
            const levels = [0, 1, 2];

            for (const level of levels) {
                // Mock ownership check (findUnique)
                mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                    id: 'error-item-1',
                    userId: 'user-123',
                });
                mocks.mockPrismaErrorItem.update.mockResolvedValue({
                    id: 'error-item-1',
                    userId: 'user-123',
                    masteryLevel: level,
                });

                const request = new Request('http://localhost/api/error-items/error-item-1/mastery', {
                    method: 'PATCH',
                    body: JSON.stringify({ masteryLevel: level }),
                    headers: { 'Content-Type': 'application/json' },
                });

                const response = await PATCH_MASTERY(request, { params: Promise.resolve({ id: 'error-item-1' }) });
                expect(response.status).toBe(200);
            }
        });

        it('★ 超出 0~2 的值必须被拒绝（不能让脏值进库）', async () => {
            /**
             * 【2026-10-10】这条钉的是**新契约**，也是对旧断言的修正。
             *
             * 原来这条用例是 `levels = [0, 1, 2, 3]` 全部断言 200 —— 即"原样写进库"，
             * 于是一个 `3` 能落进数据库。而界面判断"已掌握"用的是 `masteryLevel > 0`、
             * 系统内部判断用的是 `=== 2`，**3 会让两边结论相反**
             * （卡片上显示"已掌握"，程序却认为没掌握）。这类值就是脏值，不该进库。
             * 现在：三档以外一律 400，且**一个字都不写库**。
             * （`PATCH /api/error-items/[id]` 也认这个口径，但那里是"静默忽略" ——
             *   因为那条路由是一堆字段一起保存，为一个非法值让整次保存失败不划算。）
             */
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
            });

            const request = new Request('http://localhost/api/error-items/error-item-1/mastery', {
                method: 'PATCH',
                body: JSON.stringify({ masteryLevel: 3 }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_MASTERY(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            expect(response.status).toBe(400);
            expect(mocks.mockPrismaErrorItem.update).not.toHaveBeenCalled();
        });

        it('应该拒绝未登录用户', async () => {
            mocks.mockPrismaUser.findUnique.mockResolvedValue(null);

            const request = new Request('http://localhost/api/error-items/error-item-1/mastery', {
                method: 'PATCH',
                body: JSON.stringify({ masteryLevel: 1 }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_MASTERY(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(401);
            expect(data.message).toBeDefined();
        });

        it('应该处理数据库错误', async () => {
            // Mock ownership check succeeds, but update fails
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
            });
            mocks.mockPrismaErrorItem.update.mockRejectedValue(new Error('Database error'));

            const request = new Request('http://localhost/api/error-items/error-item-1/mastery', {
                method: 'PATCH',
                body: JSON.stringify({ masteryLevel: 1 }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await PATCH_MASTERY(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(500);
            expect(data.message).toBe('Failed to update error item');
        });
    });

    describe('DELETE /api/error-items/[id]/delete (删除错题)', () => {
        it('应该成功删除自己的错题', async () => {
            const existingItem = {
                id: 'error-item-1',
                userId: 'user-123',
                questionText: '要删除的错题',
            };
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(existingItem);
            mocks.mockPrismaErrorItem.delete.mockResolvedValue(existingItem);

            const request = new Request('http://localhost/api/error-items/error-item-1/delete', {
                method: 'DELETE',
            });

            const response = await DELETE_ITEM(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.message).toBe('Deleted successfully');
            expect(mocks.mockPrismaErrorItem.delete).toHaveBeenCalledWith({
                where: { id: 'error-item-1' },
            });
        });

        it('应该返回 404 当错题不存在', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(null);

            const request = new Request('http://localhost/api/error-items/not-exist/delete', {
                method: 'DELETE',
            });

            const response = await DELETE_ITEM(request, { params: Promise.resolve({ id: 'not-exist' }) });
            const data = await response.json();

            expect(response.status).toBe(404);
            expect(data.message).toBe('Item not found');
            expect(mocks.mockPrismaErrorItem.delete).not.toHaveBeenCalled();
        });

        it('应该拒绝删除其他用户的错题', async () => {
            const existingItem = {
                id: 'error-item-1',
                userId: 'other-user-id', // 不同的用户
                questionText: '其他人的错题',
            };
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue(existingItem);

            const request = new Request('http://localhost/api/error-items/error-item-1/delete', {
                method: 'DELETE',
            });

            const response = await DELETE_ITEM(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(403);
            expect(data.message).toContain('Not authorized');
            expect(mocks.mockPrismaErrorItem.delete).not.toHaveBeenCalled();
        });

        it('应该拒绝未登录用户', async () => {
            mocks.mockPrismaUser.findUnique.mockResolvedValue(null);
            mocks.mockPrismaUser.findFirst.mockResolvedValue(null);

            const request = new Request('http://localhost/api/error-items/error-item-1/delete', {
                method: 'DELETE',
            });

            const response = await DELETE_ITEM(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(401);
            expect(data.message).toBeDefined();
        });

        it('应该处理数据库错误', async () => {
            mocks.mockPrismaErrorItem.findUnique.mockResolvedValue({
                id: 'error-item-1',
                userId: 'user-123',
            });
            mocks.mockPrismaErrorItem.delete.mockRejectedValue(new Error('Database error'));

            const request = new Request('http://localhost/api/error-items/error-item-1/delete', {
                method: 'DELETE',
            });

            const response = await DELETE_ITEM(request, { params: Promise.resolve({ id: 'error-item-1' }) });
            const data = await response.json();

            expect(response.status).toBe(500);
            expect(data.message).toBe('Failed to delete error item');
        });
    });
});
