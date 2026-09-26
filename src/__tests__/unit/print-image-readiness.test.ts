import { afterEach, describe, expect, it } from 'vitest';
import {
    __resetImageWorkForTest,
    beginImageWork,
    pendingImageWork,
    whenImagesSettled,
} from '@/lib/print-image-readiness';

/**
 * 「图就绪再打印」这道门。
 *
 * 钉的是两件事：
 *   ① 正常情况：图都出来了才放行；
 *   ② **幂等的完工回调** —— 漏配对会让门提前打开，那就退回"打印时图没就绪"，
 *      而提前打开不会报错、只会少一张图，属于最难查的那类。
 */
describe('print-image-readiness · 打印前的就绪门', () => {
    afterEach(() => {
        __resetImageWorkForTest();
    });

    it('没有图在解析时立即放行（不白等）', async () => {
        const t0 = Date.now();
        await whenImagesSettled(5000);
        expect(Date.now() - t0).toBeLessThan(50);
    });

    it('有图在解析时，等它出结果才放行', async () => {
        const done = beginImageWork();
        let released = false;
        const p = whenImagesSettled(5000).then(() => {
            released = true;
        });

        // 还没出结果 ⇒ 不能放行
        await new Promise((r) => setTimeout(r, 30));
        expect(released).toBe(false);

        done();
        await p;
        expect(released).toBe(true);
    });

    it('多张图：最后一张出结果才放行', async () => {
        const a = beginImageWork();
        const b = beginImageWork();
        expect(pendingImageWork()).toBe(2);

        let released = false;
        const p = whenImagesSettled(5000).then(() => {
            released = true;
        });

        a();
        await new Promise((r) => setTimeout(r, 30));
        expect(released).toBe(false); // 还剩 b
        expect(pendingImageWork()).toBe(1);

        b();
        await p;
        expect(released).toBe(true);
    });

    it('同一个 worker 重复完工只算一次（否则门会提前打开）', async () => {
        const a = beginImageWork();
        const b = beginImageWork();

        let released = false;
        const p = whenImagesSettled(5000).then(() => {
            released = true;
        });

        // onload / onerror / effect 清理三处都调同一个 done —— 只该扣一次
        a();
        a();
        a();
        await new Promise((r) => setTimeout(r, 30));

        expect(pendingImageWork()).toBe(1);
        expect(released).toBe(false);

        b();
        await p;
        expect(released).toBe(true);
    });

    it('超时兜底：图一直不出结果也会放行（宁缺一张图，不卡死打印）', async () => {
        beginImageWork(); // 故意不完工（模拟某条路径漏报）
        const t0 = Date.now();
        await whenImagesSettled(80);
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(70);
        expect(elapsed).toBeLessThan(1000);
    });

    it('计数不会掉到负数（误调完工不影响后续判断）', async () => {
        const done = beginImageWork();
        done();
        done();
        expect(pendingImageWork()).toBe(0);
        // 已经是 0，再等也应立即放行
        const t0 = Date.now();
        await whenImagesSettled(5000);
        expect(Date.now() - t0).toBeLessThan(50);
    });
});
