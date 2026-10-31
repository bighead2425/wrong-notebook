/**
 * 第二段（标签归位）的**串行队列**。
 *
 * 【2026-11-01】用户明确要求：**不要并发，一个一个来，安稳最重要**。
 *
 * 为什么必须是队列而不是 fire-and-forget：
 *   保存接口是逐条调用的，批量保存 20 道就会同时发出 20 个第二段请求。
 *   模型端点本来就有 rpm/tpm 限流（实测商汤这个端点很紧，裸探 5 次 4 次 429），
 *   20 个并发的结果是**全部撞限流、全部重试、全部变慢**。
 *   串行的代价是 20 道大约 5–7 分钟，但每一道都能稳稳跑完。
 *
 * 进程内单例：Next.js 的 route handler 跑在同一个 Node 进程里，模块状态共享，
 * 所以「一个队列 + 一个在跑的任务」是全局的。本机是单容器部署，够用。
 * （将来若多实例，需要换成数据库抢占式队列 —— 这里留了 recoverPending 兜底。）
 *
 * 丢任务的自愈：容器重启（watchtower 重建）会清空内存队列，
 * 那些 `tagStatus='pending'` 的题就永远卡住了。
 * 所以启动时扫一次库，把 pending 的重新入队（见 instrumentation.ts）。
 */

import { logger } from '../logger';
import { prisma } from '../prisma';

type Job = (itemId: string) => Promise<void>;

/** 队列里等待的题号（FIFO） */
const waiting: string[] = [];
/** 已在队列中或正在跑 —— 用来去重，避免同一道题排两次 */
const inFlight = new Set<string>();
/** 当前正在跑的那道（null = 空闲） */
let current: string | null = null;
/** 由 runner 注入，避免这个模块直接依赖 AI 实现 */
let job: Job | null = null;

/** 两道题之间歇一下：不省这点时间，换的是不撞限流 */
let gapMs = 1200;

export function registerJob(fn: Job): void {
    job = fn;
}

export interface EnqueueResult {
    /** 真的排进去了（false = 已经在队列里/正在跑） */
    queued: boolean;
    /** 排在第几位（1 = 下一个就轮到它） */
    position: number;
}

/**
 * 把一道题排进归位队列。
 *
 * 幂等：同一道题重复调用不会排两次（用户改一次存一次也不会叠加）。
 */
export function enqueueRelocate(itemId: string): EnqueueResult {
    if (inFlight.has(itemId) || current === itemId) {
        return { queued: false, position: 0 };
    }
    inFlight.add(itemId);
    waiting.push(itemId);
    /* 不 await：调用方（保存接口）要立刻返回 */
    void pump();
    return { queued: true, position: waiting.length + (current ? 1 : 0) };
}

export interface QueueState {
    /** 正在跑的那道题的 id */
    current: string | null;
    /** 还在排队的题数 */
    waiting: number;
}

export function relocateQueueState(): QueueState {
    return { current, waiting: waiting.length };
}

/** 队列空且没在跑 = 全部归位完成（前端可据此停止轮询） */
export function isRelocateIdle(): boolean {
    return current === null && waiting.length === 0;
}

async function pump(): Promise<void> {
    if (current !== null || waiting.length === 0) return;
    if (!job) {
        /* 还没注册实现（服务刚启动）：500ms 后再试，别把这个任务丢了 */
        setTimeout(() => void pump(), 500);
        return;
    }

    const itemId = waiting.shift()!;
    current = itemId;
    inFlight.delete(itemId);

    try {
        await job(itemId);
    } catch (e) {
        /**
         * runner 内部已经把失败写进 tagStatus='failed'，走到这里的多半是
         * "连数据库都写不进去"这种极端情况 —— 只记日志，不能让队列停摆。
         */
        logger.warn({ itemId, err: String(e) }, '归位队列：任务抛错，继续下一道');
    } finally {
        current = null;
        if (waiting.length > 0) {
            setTimeout(() => void pump(), gapMs);
        }
    }
}

/**
 * 启动时把卡在 pending 的题重新入队。
 *
 * 只在服务启动时跑一次（instrumentation.ts）。返回捞回多少道。
 */
export async function recoverPendingRelocations(limit = 100): Promise<number> {
    try {
        const rows = await prisma.errorItem.findMany({
            where: { tagStatus: 'pending' },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: limit,
        });
        for (const r of rows) enqueueRelocate(r.id);
        if (rows.length > 0) {
            logger.info({ count: rows.length }, '归位队列：重启后恢复未完成的任务');
        }
        return rows.length;
    } catch (e) {
        logger.warn({ err: String(e) }, '归位队列：恢复 pending 失败（不影响服务）');
        return 0;
    }
}

/** 仅供测试：清空内存状态 */
export function __resetQueueForTest(): void {
    waiting.length = 0;
    inFlight.clear();
    current = null;
    job = null;
    gapMs = 1200;
}

/** 仅供测试：把两道题之间的间隔调小，免得单测等十几秒 */
export function __setGapForTest(ms: number): void {
    gapMs = ms;
}
