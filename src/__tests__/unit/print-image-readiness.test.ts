// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境。项目默认是 jsdom，
// 而本机内存紧张时 jsdom 起 worker 会直接超时（"Timeout waiting for worker"），
// 与测试本身无关却会让本地验证不可用。
import { afterEach, describe, expect, it } from 'vitest';
import {
    __resetImageWorkForTest,
    beginImageWork,
    pendingImageWork,
    whenImagesDecoded,
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

/**
 * 第二道门：等纸面上**所有 img 解码完**。
 *
 * 为什么单独钉它：打印页上图的来源有三个（正面原图照片 / 反面题图 / 现生成的二维码），
 * 少等一个就是"那一种图在纸上空白"。而"空白"不会报错，只会让用户说"打不正常"。
 */
describe('print-image-readiness · 打印前等所有图解码', () => {
    /** 造一个假的"打印容器"，只实现 querySelectorAll('img') */
    function fakeRoot(imgs: unknown[]): ParentNode {
        return { querySelectorAll: () => imgs } as unknown as ParentNode;
    }

    it('容器为空（没传）⇒ 返回 0，不报错', async () => {
        expect(await whenImagesDecoded(null)).toBe(0);
        expect(await whenImagesDecoded(undefined)).toBe(0);
    });

    it('所有图都已解码（complete + 有尺寸）⇒ 一张都不用等', async () => {
        const root = fakeRoot([
            { complete: true, naturalWidth: 100 },
            { complete: true, naturalWidth: 50 },
        ]);
        const t0 = Date.now();
        expect(await whenImagesDecoded(root, 5000)).toBe(0);
        expect(Date.now() - t0).toBeLessThan(50);
    });

    it('有图没解码完 ⇒ 等它 decode() 完成', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const root = fakeRoot([{ complete: false, naturalWidth: 0, decode: () => gate }]);

        let settled = false;
        const p = whenImagesDecoded(root, 5000).then((n) => {
            settled = true;
            return n;
        });

        await new Promise((r) => setTimeout(r, 30));
        expect(settled).toBe(false); // 还没解码完，不能放行

        release();
        expect(await p).toBe(1);
    });

    it('破图（decode 拒绝）⇒ 吞掉错误照常放行，不能连累整次打印', async () => {
        const root = fakeRoot([
            {
                complete: false,
                naturalWidth: 0,
                decode: () => Promise.reject(new Error('broken')),
            },
        ]);
        expect(await whenImagesDecoded(root, 5000)).toBe(1);
    });

    it('图一直解码不出来 ⇒ 超时放行（宁可少一张图，不能卡住打印）', async () => {
        const root = fakeRoot([
            { complete: false, naturalWidth: 0, decode: () => new Promise<void>(() => {}) },
        ]);
        const t0 = Date.now();
        const n = await whenImagesDecoded(root, 80);
        const elapsed = Date.now() - t0;
        expect(n).toBe(1);
        expect(elapsed).toBeGreaterThanOrEqual(70);
        expect(elapsed).toBeLessThan(1000);
    });

    it('浏览器没有 decode() ⇒ 退回 load/error 事件，同样是超时兜底', async () => {
        const root = fakeRoot([
            {
                complete: false,
                naturalWidth: 0,
                addEventListener: () => {},
            },
        ]);
        const n = await whenImagesDecoded(root, 80);
        expect(n).toBe(1);
    });
});
