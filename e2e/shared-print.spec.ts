import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

/**
 * 「共享打印」整条链 —— **不碰打印机、不碰 NAS**。
 *
 * 验的是这条路：
 *   点「打印」→ 出口是 shared → 弹四格设置 → 浏览器把纸面拍成 PDF
 *   → POST /api/print/submit → 服务端转成 EasyPrinter 认的表单 → 那边返回 job_id
 *   → 界面说"已送到打印机"。
 *
 * 链条末端用 `e2e/mock-easyprinter.mjs` 接着（真机在 NAS 的局域网里，CI 连不到）。
 * 假服务会记下收到的表单，用例据此断言"纸型 B5 / 单面 / 1 份 / 确实是一份 PDF"——
 * 这四样任何一样传错，印出来就是废纸。
 */
const MOCK = 'http://127.0.0.1:6399';
const ITEM_ID = 'e2e-shared-print';

test.describe('共享打印链路', () => {
    let prisma: PrismaClient;

    test.beforeAll(async () => {
        prisma = new PrismaClient();
        const admin = await prisma.user.findFirst({ where: { email: 'admin@localhost' } });
        if (!admin) throw new Error('e2e 库里没有 admin@localhost —— seed 没跑？');
        const dot =
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        await prisma.errorItem.upsert({
            where: { id: ITEM_ID },
            update: {},
            create: {
                id: ITEM_ID,
                userId: admin.id,
                originalImageUrl: dot,
                questionText: '2 + 3 = ?',
                ocrText: '2 + 3 = ?',
            },
        });
    });

    test.afterAll(async () => {
        await prisma?.$disconnect();
    });

    test('四格设置 → 生成 PDF → 交给打印机 → 表单参数正确', async ({ page }) => {
        test.setTimeout(180_000);

        /**
         * 拍图自检的告警要当成失败。
         *
         * 事故背景（2026-10-28 手机真机）：版心按整纸宽铺开、右边被裁，
         * 参数全对、PDF 也真、纸却废了。两处自检（DOM 宽度 / 画布右侧出血）
         * 会把这种情况喊出来 —— 这里把它接住，别让它只留在控制台里。
         */
        const captureWarnings: string[] = [];
        page.on('console', (msg) => {
            if (msg.text().includes('[print-capture]')) captureWarnings.push(msg.text());
        });

        await page.goto('/login');
        await page.locator('input[name="email"]').fill('admin@localhost');
        await page.locator('input[name="password"]').fill('123456');
        await page.locator('button[type="submit"]').click();
        await page.waitForURL('**/', { timeout: 20_000 });

        /* 把"电脑端出口"临时改成 shared —— 否则默认是 local（会去调浏览器打印）。
           用接口改而不是写文件：走的就是用户点设置时那条路。 */
        const cfgResp = await page.request.get('/api/settings');
        expect(cfgResp.ok()).toBeTruthy();
        const cfg = await cfgResp.json();
        const originalPrint = cfg.print ?? null;
        const saved = await page.request.post('/api/settings', {
            data: { ...cfg, print: { ...(cfg.print ?? {}), desktop: 'shared' } },
        });
        expect(saved.ok()).toBeTruthy();

        try {
            await page.goto(`/print-preview?ids=${ITEM_ID}&mode=deep`);
            await expect(page.locator('.print-deep-side')).toHaveCount(2, { timeout: 30_000 });

            await page.getByRole('button', { name: /^打印$/ }).click();

            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible({ timeout: 10_000 });
            await expect(dialog.getByText(/送到共享打印机/)).toBeVisible();
            await expect(dialog.getByText(/共 2 页/)).toBeVisible();

            /* 四格里只动"单双面"（默认是双面）。顺序：0=单双面，1=纸型，2=页范围 */
            const combos = dialog.getByRole('combobox');
            await combos.nth(0).click();
            await page.getByRole('option', { name: '单面' }).click();

            await dialog.getByRole('button', { name: /开始打印/ }).click();

            /* 拍图 + 拼 PDF + 上传，CI 上大约 5~20 秒 */
            await expect(dialog.getByText(/已送到打印机/)).toBeVisible({ timeout: 120_000 });

            const last = await (await page.request.get(`${MOCK}/_last`)).json();
            expect(last, '假打印机没收到任务').not.toBeNull();

            /* 这四项任何一项错，纸上就是废的 */
            expect(last.paper_size, '纸型必须是 B5').toBe('B5');
            expect(last.duplex, '选了单面就必须传 none').toBe('none');
            expect(last.copies, '份数默认 1').toBe('1');
            expect(last.orientation).toBe('portrait');

            /* 传过去的必须是一份真 PDF，而不是空表单 */
            expect(last.isPdf, '收到的内容不是 PDF（缺 %PDF 头）').toBe(true);
            expect(last.bytes, `PDF 太小（${last.bytes} 字节），像是拍空了`).toBeGreaterThan(20_000);
            expect(last.fileName || '').toMatch(/\.pdf$/);

            /* 纸面几何自检：版心宽度 / 右侧出血。参数对但版面错，印出来一样是废纸 */
            expect(
                captureWarnings,
                `拍图自检没通过：\n${captureWarnings.join('\n')}`,
            ).toEqual([]);
        } finally {
            /* 还原配置：别把"电脑端=共享"留给后面的用例 */
            await page.request.post('/api/settings', {
                data: { ...cfg, print: originalPrint ?? {} },
            });
        }
    });
});
