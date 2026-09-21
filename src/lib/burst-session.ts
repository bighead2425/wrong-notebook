/**
 * 【custom-v32】连拍转存收件箱的「一轮账」。
 *
 * 为什么把这几行单独拎成一个模块：这里出过一个 off-by-one 的真 bug
 * （拍 1 张，收工时提示「已转存 0 张」，见 `noteBurstResult` 的注释）。
 * 记账这件事与界面无关、纯函数即可验证，拎出来就能被单测永久钉住 ——
 * 以后再有人调整收工与记账的先后顺序，测试会当场变红。
 *
 * 术语：一轮（session）= 从第一次按快门到点「完成」之间拍的那批照片。
 */

export interface BurstSession {
    /** 这一轮一共按下了几下快门（含正在上传、还没出结果的那张） */
    total: number;
    /** 已经确认转存成功的张数 */
    saved: number;
    /** 转存失败、等着退回「待处理」队列的照片（一张都不能丢） */
    failed: File[];
    /** 是否已经收过工（点过「完成」）。只用来决定要不要动界面，不参与记账 */
    closed: boolean;
}

export function createBurstSession(): BurstSession {
    return { total: 0, saved: 0, failed: [], closed: false };
}

/** 按下一张：先把数记上，真正的上传由调用方丢进串行队列 */
export function noteBurstShot(session: BurstSession): void {
    session.total += 1;
}

/** 这一轮已经有结果的张数（成功 + 失败）—— 进度条「i/n」的 i 用它 */
export function burstDone(session: BurstSession): number {
    return session.saved + session.failed.length;
}

/**
 * 一张照片的出账结果。
 *
 * 【为什么必须无条件记账，不能先判 closed】
 * 「完成」那一张，是在 `closed` 已经被置为 true **之后**才轮到这里上传的 ——
 * 因为收工标志和它的上传是排队在同一个 handler 里发生的（先 setBurstSaving，
 * 再 append 上传，紧接着就 closed)。如果先判 closed 再记账，会有两处伤：
 *   ① 收工提示永远少 1 张：拍 1 张显示「已转存 0 张」（custom-v31 的实测 bug）；
 *   ② 更糟的是最后一张**万一上传失败**，它连 `failed` 都进不去 ——
 *      既没进收件箱、也不会退回待处理队列，这张照片直接消失。
 *
 * 所以：记账无条件做，`closed` 只用来决定「要不要顺手刷新进度界面」
 * （收工后的界面归结算那一步统一交代）。
 *
 * @returns true = 可以刷新进度界面；false = 这一轮已收尾，别再动界面了
 */
export function noteBurstResult(session: BurstSession, ok: boolean, file: File): boolean {
    if (ok) session.saved += 1;
    else session.failed.push(file);
    return !session.closed;
}
