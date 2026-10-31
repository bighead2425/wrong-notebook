/**
 * 归位队列的单测 —— 钉住"一个一个来"这条用户明确提过的要求。
 *
 * 背景：第二段是 AI 调用，端点限流很紧（实测裸探 5 次 4 次 429）。
 * 批量保存时如果并发，结果是**全部撞限流、全部重试、比串行还慢**。
 * 所以这个队列的行为必须被钉住，不能因为以后"顺手优化"退化成并发。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    enqueueRelocate,
    registerJob,
    relocateQueueState,
    isRelocateIdle,
    __resetQueueForTest,
    __setGapForTest,
} from '@/lib/ai/relocate-queue';

/** 等队列跑空（真实计时器，间隔已调成 1ms） */
async function drain(maxMs = 2000): Promise<void> {
    const t0 = Date.now();
    while (!isRelocateIdle()) {
        if (Date.now() - t0 > maxMs) throw new Error('队列没在预期时间内跑空');
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe('归位队列 · 串行', () => {
    beforeEach(() => {
        __resetQueueForTest();
        __setGapForTest(1);
    });

    it('同时入队 3 道，任何时刻只有 1 道在跑', async () => {
        let concurrent = 0;
        let peak = 0;
        const order: string[] = [];

        registerJob(async (id) => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            order.push(`start:${id}`);
            await new Promise((r) => setTimeout(r, 20));
            order.push(`end:${id}`);
            concurrent -= 1;
        });

        enqueueRelocate('a');
        enqueueRelocate('b');
        enqueueRelocate('c');

        await drain();

        expect(peak).toBe(1);                    // 从来没有两个同时在跑
        /* 完成顺序 = 入队顺序（a 的 end 在 b 的 start 之前） */
        expect(order).toEqual([
            'start:a', 'end:a',
            'start:b', 'end:b',
            'start:c', 'end:c',
        ]);
    });

    it('同一道题重复入队不会排两次', async () => {
        const seen: string[] = [];
        registerJob(async (id) => {
            seen.push(id);
            await new Promise((r) => setTimeout(r, 10));
        });

        const r1 = enqueueRelocate('x');
        const r2 = enqueueRelocate('x');
        enqueueRelocate('x');

        expect(r1.queued).toBe(true);
        expect(r2.queued).toBe(false);

        await drain();
        expect(seen).toEqual(['x']);
    });

    it('一道题抛错，队列继续跑后面的（不能让整条队列停摆）', async () => {
        const done: string[] = [];
        registerJob(async (id) => {
            if (id === 'bad') throw new Error('模拟第二段炸了');
            done.push(id);
        });

        enqueueRelocate('bad');
        enqueueRelocate('good');

        await drain();
        expect(done).toEqual(['good']);
        expect(isRelocateIdle()).toBe(true);
    });

    it('队列状态能说清"在跑哪一道、还有几道在等"', async () => {
        let release: (() => void) | null = null;
        /* 只让**第一道**卡住（后面的正常跑完），否则 drain 永远等不到 */
        let blocked = false;
        registerJob(async () => {
            if (blocked) return;
            blocked = true;
            await new Promise<void>((r) => { release = r; });
        });

        enqueueRelocate('first');
        enqueueRelocate('second');
        enqueueRelocate('third');

        /* 等第一个真正开始 */
        await new Promise((r) => setTimeout(r, 10));
        expect(relocateQueueState()).toEqual({ current: 'first', waiting: 2 });

        release!();
        await drain();
        expect(relocateQueueState()).toEqual({ current: null, waiting: 0 });
    });

    it('没注册实现时不会把任务丢掉（服务刚启动的那一小段时间）', async () => {
        /* 故意不 registerJob */
        enqueueRelocate('later');
        await new Promise((r) => setTimeout(r, 30));
        expect(isRelocateIdle()).toBe(false);     // 还挂着

        const done: string[] = [];
        registerJob(async (id) => { done.push(id); });
        await drain();
        expect(done).toEqual(['later']);
    });
});
