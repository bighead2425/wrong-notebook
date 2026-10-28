import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

/**
 * 打印版面回归 —— **不需要打印机，也不需要 NAS**。
 *
 * 为什么要有这一条：2026-10-28 出过一次"印出来底部空 24mm 而不是 18mm"的事故。
 * 起因是包着纸面的容器上多了一个 `px-4`（16px），把 152mm 的纸挤成 156.2mm，
 * Chrome 打印时**把整份文档等比缩到 97.3%**。
 *
 * ⚠️ 这种事故用"页面尺寸 / 页数"是抓不到的：PDF 仍是 182×257、页数也对，
 *    只有**内容被整体缩小**。所以这里量的是"版面几何"：
 *      · 有没有横向溢出（有 ⇒ 打印时一定被缩）
 *      · 每一面是不是 152×225mm
 *      · 打孔位是不是正面在左、反面在右
 *      · 页脚是不是贴到该面的底边
 *
 * 视口宽取 **152mm = 574.5px**（= 打印时的可打印宽度），而不是 182mm：
 * 只有在这个宽度下，"多出来的内边距"才会像真打印那样把纸挤出去。
 * 多给 1px 是为了避开 574.488 的取整误差。
 */
const PRINT_CONTENT_WIDTH_PX = 575;
const MM_PER_PX = 25.4 / 96;

/** 与真实卡片一致的容差：0.8mm ≈ 3px，足够卡住"整页缩 2.4%"这种量级 */
const TOL_MM = 0.8;

const ITEM_ID = 'e2e-print-geometry';

test.describe('打印版面几何', () => {
    let prisma: PrismaClient;

    test.beforeAll(async () => {
        prisma = new PrismaClient();
        const admin = await prisma.user.findFirst({ where: { email: 'admin@localhost' } });
        if (!admin) throw new Error('e2e 库里没有 admin@localhost —— seed 没跑？');

        /* 造一道**最短**的题：版面几何与题干长短无关，短题干最快、最稳。
           1×1 透明 PNG 当原图：卡片会把它放进 <img>，解码失败也只是空白，
           不会影响"每一面 225mm"这条断言。 */
        const dot =
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        await prisma.errorItem.upsert({
            where: { id: ITEM_ID },
            update: {},
            create: {
                id: ITEM_ID,
                userId: admin.id,
                originalImageUrl: dot,
                questionText: '1 + 1 = ?',
                ocrText: '1 + 1 = ?',
            },
        });
    });

    test.afterAll(async () => {
        await prisma?.$disconnect();
    });

    test('深挖纸：152×225mm、无横向溢出、打孔位交替、页脚贴底', async ({ page }) => {
        test.setTimeout(90_000);

        // 1) 登录（与其它 spec 同一套）
        await page.goto('/login');
        await page.locator('input[name="email"]').fill('admin@localhost');
        await page.locator('input[name="password"]').fill('123456');
        await page.locator('button[type="submit"]').click();
        await page.waitForURL('**/', { timeout: 20_000 });

        // 2) 关键：视口 = 打印可打印宽度，媒体 = print
        await page.setViewportSize({ width: PRINT_CONTENT_WIDTH_PX, height: 900 });
        await page.emulateMedia({ media: 'print' });

        await page.goto(`/print-preview?ids=${ITEM_ID}&mode=deep`);

        const sides = page.locator('.print-deep-side');
        await expect(sides).toHaveCount(2, { timeout: 30_000 });

        const m = await page.evaluate((mmPerPx: number) => {
            const box = (el: Element) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return {
                    w: r.width * mmPerPx,
                    h: r.height * mmPerPx,
                    bottom: r.bottom * mmPerPx,
                    padL: parseFloat(cs.paddingLeft) * mmPerPx,
                    padR: parseFloat(cs.paddingRight) * mmPerPx,
                };
            };
            const root = document.documentElement;
            const all = Array.from(document.querySelectorAll('.print-deep-side'));
            const footer = document.querySelector('.print-deep-footer');
            return {
                scrollW: root.scrollWidth * mmPerPx,
                clientW: root.clientWidth * mmPerPx,
                sides: all.map(box),
                footer: footer ? box(footer) : null,
            };
        }, MM_PER_PX);

        // 3) 没有横向溢出 —— 有溢出，Chrome 打印时就会把整页等比缩小
        // ⚠️ 比的是"152mm 这个绝对量"，不是 clientWidth：headless 里万一有竖向滚动条，
        //    clientWidth 会少掉十几像素，拿它当基准会把真问题放过去。
        expect(
            m.scrollW,
            `内容宽 ${m.scrollW.toFixed(1)}mm，超过了可打印宽度 152mm（视口 ${m.clientW.toFixed(1)}mm）` +
            `：打印时会被整体缩小（这正是"底部 24mm"那次的病根）。` +
            `查包着 .print-sheet 的那几层容器还有没有 padding。`,
        ).toBeLessThanOrEqual(152.8);

        // 4) 两面都在、尺寸正确
        expect(m.sides).toHaveLength(2);
        for (const [i, s] of m.sides.entries()) {
            expect(s.w, `第 ${i + 1} 面宽度`).toBeCloseTo(152, 0);
            expect(Math.abs(s.w - 152), `第 ${i + 1} 面宽 152mm`).toBeLessThan(TOL_MM);
            expect(Math.abs(s.h - 225), `第 ${i + 1} 面高 225mm`).toBeLessThan(TOL_MM);
        }

        // 5) 打孔位：正面在左、反面在右（反了就会把孔打在装订边外侧）
        expect(Math.abs(m.sides[0].padL - 12), '正面左侧打孔位 12mm').toBeLessThan(TOL_MM);
        expect(m.sides[0].padR, '正面不该有右侧打孔位').toBeLessThan(TOL_MM);
        expect(Math.abs(m.sides[1].padR - 12), '反面右侧打孔位 12mm').toBeLessThan(TOL_MM);
        expect(m.sides[1].padL, '反面不该有左侧打孔位').toBeLessThan(TOL_MM);

        // 6) 页脚贴底（2026-10-28：曾因 align-items:center 而浮起 6mm）
        expect(m.footer, '反面页脚应该存在').not.toBeNull();
        const footerGap = Math.abs((m.footer!.bottom) - m.sides[1].bottom);
        expect(
            footerGap,
            `页脚底边与反面的底边差了 ${footerGap.toFixed(1)}mm：` +
            `页脚必须贴着纸底，否则纸上会凭空多出这段空白。`,
        ).toBeLessThan(TOL_MM);
    });
});
