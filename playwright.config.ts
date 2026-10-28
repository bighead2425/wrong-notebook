import { defineConfig, devices } from '@playwright/test';

/** 假的 EasyPrinter（见 e2e/mock-easyprinter.mjs）：CI 连不到 NAS 上那台真机 */
const MOCK_PRINTER = 'http://127.0.0.1:6399';

/** 把当前进程的环境变量原样传给被测应用（webServer.env 一旦提供就不再自动继承） */
const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === 'string'),
) as Record<string, string>;

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    // 【2026-10-20】CI 里重试次数 2 → 1。
    // 失败时每多一次重试就多跑一整轮（三个 spec 全套流程），
    // 2 次重试等于把"红"的成本放大到 3 倍（12.9 分钟里约 8 分钟是这个）。
    // 1 次足够过滤 CI 环境的偶发抖动。
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [['html', { host: '0.0.0.0' }]],
    use: {
        baseURL: 'http://127.0.0.1:3000',
        trace: 'on-first-retry',
    },
    /**
     * 两个服务一起起：
     *   ① 被测应用（dev / start）；
     *   ② 假 EasyPrinter —— 让"共享打印"这条链在 CI 里能真跑一遍，
     *      否则服务端只能去连 192.168.1.10:6310，而 CI 的机器不在那个网里。
     *
     * ⚠️ `webServer.env` 一旦写了就不再自动继承父进程的环境变量，
     *    所以必须显式 `...childEnv` 把 DATABASE_URL / NEXTAUTH_* 带进去。
     */
    webServer: [
        {
            command: process.env.CI ? 'npm run start' : 'npm run dev',
            url: 'http://127.0.0.1:3000',
            reuseExistingServer: !process.env.CI,
            timeout: 120 * 1000,
            env: { ...childEnv, EASYPRINTER_URL: MOCK_PRINTER },
        },
        {
            command: 'node e2e/mock-easyprinter.mjs',
            url: `${MOCK_PRINTER}/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 30 * 1000,
        },
    ],
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
