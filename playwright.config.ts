import { defineConfig, devices } from '@playwright/test';

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
    webServer: {
        command: process.env.CI ? 'npm run start' : 'npm run dev',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
