/**
 * /api/settings API 集成测试
 * 测试应用配置获取和更新接口
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to ensure mocks are initialized before module imports
const mocks = vi.hoisted(() => ({
    mockGetAppConfig: vi.fn(() => ({
        aiProvider: 'gemini',
        allowRegistration: true,
        openai: {
            instances: [{
                id: 'test-instance',
                name: 'Test',
                apiKey: 'sk-test-key',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o',
            }],
            activeInstanceId: 'test-instance',
        },
        gemini: {
            apiKey: 'AIza-test-key',
            baseUrl: '',
            model: 'gemini-2.5-flash',
        },
        prompts: {
            analyze: '',
            similar: '',
        },
    })),
    mockUpdateAppConfig: vi.fn((config: any) => ({
        ...config,
        aiProvider: config.aiProvider || 'gemini',
    })),
    /** 【custom-v30】该路由补上了鉴权，测试里得能控制"谁在调用" */
    mockGetServerSession: vi.fn(),
}));

// Mock config module
vi.mock('@/lib/config', () => ({
    getAppConfig: mocks.mockGetAppConfig,
    updateAppConfig: mocks.mockUpdateAppConfig,
}));

// 【custom-v30】middleware 的 matcher 排除了 /api，接口必须自己检查会话，
// 所以这里也要把会话来源 mock 掉，才能分别测"管理员/普通用户/未登录"三种情形。
vi.mock('next-auth', () => ({ getServerSession: mocks.mockGetServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

// Import after mocks
import { GET, POST } from '@/app/api/settings/route';

describe('/api/settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // 默认按管理员登录：绝大多数用例测的是"管理员能正常改配置"
        mocks.mockGetServerSession.mockResolvedValue({
            user: { email: 'admin@test.com', role: 'admin' },
            expires: '2099-01-01T00:00:00.000Z',
        });
    });

    describe('GET /api/settings', () => {
        it('应该返回完整的应用配置', async () => {
            const response = await GET();
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.aiProvider).toBe('gemini');
            expect(data.openai).toBeDefined();
            expect(data.gemini).toBeDefined();
            expect(data.prompts).toBeDefined();
        });

        it('应该返回 AI 提供商设置', async () => {
            const response = await GET();
            const data = await response.json();

            expect(data.openai.instances[0].apiKey).toBe('sk-test-key');
            expect(data.gemini.apiKey).toBe('AIza-test-key');
            expect(data.gemini.model).toBe('gemini-2.5-flash');
        });

        it('应该返回注册开关状态', async () => {
            const response = await GET();
            const data = await response.json();

            expect(data.allowRegistration).toBe(true);
        });
    });

    describe('POST /api/settings', () => {
        it('应该成功更新 AI 提供商', async () => {
            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify({ aiProvider: 'openai' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(mocks.mockUpdateAppConfig).toHaveBeenCalledWith(
                expect.objectContaining({ aiProvider: 'openai' })
            );
        });

        it('应该成功更新 OpenAI 配置', async () => {
            const newConfig = {
                openai: {
                    instances: [{
                        id: 'new-instance',
                        name: 'New Instance',
                        apiKey: 'sk-new-key',
                        baseUrl: 'https://custom.api.com',
                        model: 'gpt-4-turbo',
                    }],
                    activeInstanceId: 'new-instance',
                },
            };

            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify(newConfig),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);

            expect(response.status).toBe(200);
            expect(mocks.mockUpdateAppConfig).toHaveBeenCalledWith(
                expect.objectContaining({
                    openai: expect.objectContaining({
                        instances: expect.arrayContaining([
                            expect.objectContaining({
                                apiKey: 'sk-new-key',
                                model: 'gpt-4-turbo',
                            }),
                        ]),
                    }),
                })
            );
        });

        it('应该成功更新 Gemini 配置', async () => {
            const newConfig = {
                gemini: {
                    apiKey: 'AIza-new-key',
                    model: 'gemini-3.0-flash',
                },
            };

            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify(newConfig),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);

            expect(response.status).toBe(200);
            expect(mocks.mockUpdateAppConfig).toHaveBeenCalledWith(
                expect.objectContaining({
                    gemini: expect.objectContaining({
                        apiKey: 'AIza-new-key',
                    }),
                })
            );
        });

        it('应该保留掩码 API Key（********）的原有值', async () => {
            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify({
                    openai: {
                        instances: [{
                            id: 'test-instance', // 使用 mock 中已存在的实例 ID
                            name: 'Masked',
                            apiKey: '********',
                            baseUrl: 'https://api.openai.com/v1',
                            model: 'gpt-4o',
                        }],
                    },
                    gemini: { apiKey: '********' },
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);

            expect(response.status).toBe(200);
            // 验证更新时保留了原有的 key
            const updateCall = mocks.mockUpdateAppConfig.mock.calls[0][0];
            // OpenAI instances 应该保留，且 apiKey 应为原有值
            expect(updateCall.openai?.instances?.length).toBe(1);
            expect(updateCall.openai?.instances?.[0]?.apiKey).toBe('sk-test-key');
            expect(updateCall.gemini?.apiKey).toBe('AIza-test-key');
        });

        it('应该成功更新自定义提示词', async () => {
            const newConfig = {
                prompts: {
                    analyze: '自定义分析提示词',
                    similar: '自定义类似题提示词',
                },
            };

            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify(newConfig),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);

            expect(response.status).toBe(200);
            expect(mocks.mockUpdateAppConfig).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompts: expect.objectContaining({
                        analyze: '自定义分析提示词',
                    }),
                })
            );
        });

        it('应该成功更新注册开关', async () => {
            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify({ allowRegistration: false }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);

            expect(response.status).toBe(200);
            expect(mocks.mockUpdateAppConfig).toHaveBeenCalledWith(
                expect.objectContaining({ allowRegistration: false })
            );
        });

        it('应该处理更新失败的情况', async () => {
            mocks.mockUpdateAppConfig.mockImplementationOnce(() => {
                throw new Error('Write failed');
            });

            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify({ aiProvider: 'openai' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            const data = await response.json();

            expect(response.status).toBe(500);
            expect(data.message).toBe('Failed to update settings');
        });
    });

    /**
     * 【custom-v30 安全回归】这个路由以前是完全裸的：
     * 任何人（连登录都不用）GET /api/settings 就能拿到明文 AI 密钥，
     * POST 还能把 baseUrl 改到别人的服务器上、把用户的 AI 请求劫持走。
     * 下面这几条把修复后的边界钉住，以后谁把它改回去都会立刻红。
     */
    describe('鉴权与权限边界', () => {
        it('未登录：GET 返回 401，不吐任何配置', async () => {
            mocks.mockGetServerSession.mockResolvedValue(null);
            const response = await GET();
            expect(response.status).toBe(401);
        });

        it('未登录：POST 返回 401，且一个字都不写盘', async () => {
            mocks.mockGetServerSession.mockResolvedValue(null);
            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify({ aiProvider: 'openai' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            expect(response.status).toBe(401);
            expect(mocks.mockUpdateAppConfig).not.toHaveBeenCalled();
        });

        it('普通用户：拿不到真实密钥，一律掩码（但页面要用的字段照常给）', async () => {
            mocks.mockGetServerSession.mockResolvedValue({
                user: { email: 'kid@test.com', role: 'user' },
                expires: '2099-01-01T00:00:00.000Z',
            });

            const response = await GET();
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.openai.instances[0].apiKey).toBe('********');
            expect(data.gemini.apiKey).toBe('********');
            expect(data.gemini.model).toBe('gemini-2.5-flash');
        });

        it('普通用户：绕过界面直接 POST，也改不动 AI 配置和转存路径', async () => {
            mocks.mockGetServerSession.mockResolvedValue({
                user: { email: 'kid@test.com', role: 'user' },
                expires: '2099-01-01T00:00:00.000Z',
            });

            const request = new Request('http://localhost/api/settings', {
                method: 'POST',
                body: JSON.stringify({
                    aiProvider: 'openai',
                    // 典型的劫持尝试：把 baseUrl 换到自己的服务器
                    openai: {
                        instances: [{
                            id: 'x',
                            name: 'x',
                            apiKey: 'sk-hijack',
                            baseUrl: 'https://evil.example.com',
                            model: 'm',
                        }],
                    },
                    scanInbox: { subPath: '../../etc' },
                    timeouts: { analyze: 999000 },
                }),
                headers: { 'Content-Type': 'application/json' },
            });

            await POST(request);

            const payload = mocks.mockUpdateAppConfig.mock.calls[0][0];
            // 只放行 timeouts，其余字段被整份丢掉
            expect(payload).toEqual({ timeouts: { analyze: 999000 } });
            expect(payload.openai).toBeUndefined();
            expect(payload.scanInbox).toBeUndefined();
        });
    });
});
