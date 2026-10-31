/**
 * 归位服务：对外的唯一入口。
 *
 * 存在这层是为了把「谁来做这件事」（runner）和「什么时候做、排不排队」（queue）
 * 分开，同时保证**注册一定发生过** —— 调用方不需要记得先 register。
 *
 * 使用方：`app/api/error-items/route.ts`（保存后入队）、
 *         `app/api/error-items/[id]/relocate/route.ts`（手动重试）、
 *         `instrumentation.ts`（启动后恢复 pending）。
 */

import { relocateItem } from './two-stage-runner';
import {
    registerJob,
    enqueueRelocate as rawEnqueue,
    recoverPendingRelocations as rawRecover,
    relocateQueueState,
    isRelocateIdle,
    type EnqueueResult,
    type QueueState,
} from './relocate-queue';

let registered = false;

function ensureRegistered(): void {
    if (registered) return;
    registered = true;
    registerJob(relocateItem);
}

export function enqueueRelocate(itemId: string): EnqueueResult {
    ensureRegistered();
    return rawEnqueue(itemId);
}

export async function recoverPendingRelocations(limit?: number): Promise<number> {
    ensureRegistered();
    return rawRecover(limit);
}

export { relocateQueueState, isRelocateIdle };
export type { EnqueueResult, QueueState };
