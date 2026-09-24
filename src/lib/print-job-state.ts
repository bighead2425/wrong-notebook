/**
 * 打印实例的状态推导（M0）
 *
 * 核心口径（2026-09-24 定，已写进 schema.prisma 注释，这里用单测钉住）：
 *
 *   **一道题的当前状态 = 它最近一次「已回收」的打印实例的状态；
 *     尚未回收的实例一律不影响当前状态。**
 *
 * 为什么必须定死这一条：
 *   她手上可能同时有 R1（已做完、已扫回，AI 判过）和 R2（刚打印、还没做）两张纸。
 *   若拿"最新实例"当当前状态，系统就会认为这题还没有任何回音，
 *   把 R1 已经得出的判定静默作废 —— 这类错误**不报错、只静默错**，最难发现。
 *
 * 同理反推：**nextInstanceNo 必须拿「全部实例」算最大值**，
 * 不能只看已回收的 —— 未回收的纸也已经印出去了，它的号不能被第二张纸重复占用。
 */

export interface PrintJobLike {
    instanceNo: number;
    status: string;
}

export const PRINT_JOB_STATUS = {
    /** 已打印（纸进了待做匣。她做没做，软件不猜 —— R16 不做全量监控） */
    printed: 'printed',
    /** 已回收（hill 扫回来了。R18：没她痕迹的纸不扫） */
    returned: 'returned',
} as const;

export type PrintJobStatus = (typeof PRINT_JOB_STATUS)[keyof typeof PRINT_JOB_STATUS];

/** 这条实例是否已经回收（只有回收过的实例才携带"关于她"的信息） */
export function isReturned(job: PrintJobLike): boolean {
    return job.status === PRINT_JOB_STATUS.returned;
}

/**
 * 取**当前有效**的实例：已回收的里面 instanceNo 最大的那一条；一条都没有则返回 null。
 */
export function resolveCurrentInstance<T extends PrintJobLike>(
    jobs: readonly T[] | null | undefined,
): T | null {
    if (!jobs || jobs.length === 0) return null;

    let best: T | null = null;
    for (const job of jobs) {
        if (!isReturned(job)) continue;
        if (!best || job.instanceNo > best.instanceNo) best = job;
    }
    return best;
}

/**
 * 下一张纸的实例号 = **全部实例**的最大号 + 1（没有任何实例时从 1 开始）。
 */
export function nextInstanceNo(jobs: readonly PrintJobLike[] | null | undefined): number {
    if (!jobs || jobs.length === 0) return 1;

    let max = 0;
    for (const job of jobs) {
        if (Number.isInteger(job.instanceNo) && job.instanceNo > max) max = job.instanceNo;
    }
    return max + 1;
}

/**
 * 是否还有印出去但没回收的纸。
 * 用途：hill 想了解进度时按需查询（R16：AI 是被查询者，不是推动者）；
 * **不要**拿它去提醒、推送或显示积压（那是"催"）。
 */
export function hasUnreturned(jobs: readonly PrintJobLike[] | null | undefined): boolean {
    if (!jobs || jobs.length === 0) return false;
    return jobs.some((job) => !isReturned(job));
}
