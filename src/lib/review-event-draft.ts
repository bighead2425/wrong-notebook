/**
 * 【2026-10-16 如如】**复习事件**的客户端构造器 —— 纯函数，可被前端直接 import。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要单独一个模块
 *
 * `lib/review-events.ts` **不能被前端 import** —— 它是服务端模块，里面有直接读写流水表的调用。
 * 而"这次复习是哪一天、对还是错、落在计划第几格"这份**入参**在几个页面上都要拼，
 * ⇒ 把**纯的那一半**（形状 + 构造）放这里，服务端那半留在 `review-events.ts`。
 *
 * ⚠️ **两边必须一致**：服务端 `parseReviewEventInput()` 只认
 *    `{ occurredOn: 'YYYY-MM-DD', outcome: 'right'|'wrong', plannedIndex?: number,
 *       volumeId?: string, source?: string, op?: 'add'|'update'|'delete', eventId?: string }`。
 *    本模块有单测钉住"形状与字段名"，改一边必须改另一边。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 为什么**必须显式构造**，不许"从 `reviewOutcomes` 前后差分推"
 *
 * 出处：`app/api/error-items/[id]/route.ts` 里那段注释，以及 `review-status.ts` 文件头的 ⚠️⚠️：
 *   `planned` + `last` 两个字段**没有时间戳** ⇒ "三格满了之后又对一次"与"三格全对（就是三次）"
 *   在数据上长得一模一样，**差分认不出来**。
 * ⇒ 写入侧必须自己声明"**这是一次复习**"，本模块就是那个声明的产地。
 *
 * ══════════════════════════════════════════════════════════════════
 * 口径三则（**如如 2026-10-16 定的，请下一棒复核**）
 *
 * ① **"哪一天"在客户端算** —— 用 `dayKey()`（本地时区），与服务端那条时区铁律一致
 *    （容器跑 UTC；"哪一天"只在客户端算）。
 * ② **只有"点出了一个结果"才记** —— 点成 **空圈**（撤销这一格）**不记**：
 *    那不是一次复习，只是把这格恢复成"还没有结果"。
 * ③ ⚠️ **同一格同一天"改主意"会记两条**（先 ✓ 后 ✗ ⇒ 一条 right + 一条 wrong）——
 *    因为"她改主意"本身也是事实。**读侧若要按"当天最终结果"算，需自己取同一天的**最后一条**；
 *    要不要改成"同一天同格幂等更新"，**留给下一棒/空空定**（本棒不擅自定）。
 */

import { dayKey } from './calendar-grid';
import type { ReviewOutcome } from './review-outcomes';
import type { ReviewEventSource } from './review-event-source';

/** 与 `lib/review-events.ts` 的 `ReviewEventInput` **同形**（改一处必须改另一处，有单测钉） */
export interface ReviewEventDraft {
    /** 这一天的日键（`YYYY-MM-DD`）—— **本地时区** */
    occurredOn: string;
    outcome: ReviewOutcome;
    /** 计划内第几次（0/1/2/3）；`null` = **计划外**的额外复习（含"最近一次"那一行） */
    plannedIndex: number | null;
    /** 从哪张卷标回来的（可空） */
    volumeId?: string | null;
    /** 来源（见 `lib/review-event-source.ts`）—— 不传时服务端按"单题扫描录入"兜 */
    source?: ReviewEventSource;
}

/**
 * 拼一条复习事件。
 *
 * @param plannedIndex 计划内第几格（0 起）；传 `'last'` 或 `null` = **计划外**
 * @param source       来自哪个入口（**必须由调用方按"自己是谁"给** ——
 *                     判据是"从哪个入口进来"，不能靠码内容猜，见 `review-event-source.ts`）
 * @param today        只给测试用；默认取当前本地时间
 */
export function reviewEventDraft(opts: {
    outcome: ReviewOutcome;
    plannedIndex: number | 'last' | null;
    volumeId?: string | null;
    source?: ReviewEventSource;
    today?: Date;
}): ReviewEventDraft {
    const draft: ReviewEventDraft = {
        occurredOn: dayKey(opts.today ?? new Date()),
        outcome: opts.outcome,
        plannedIndex:
            typeof opts.plannedIndex === 'number' && Number.isInteger(opts.plannedIndex)
                ? opts.plannedIndex
                : null,
    };
    if (opts.volumeId) draft.volumeId = opts.volumeId;
    if (opts.source) draft.source = opts.source;
    return draft;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-16 如如】改 / 删某一条（`docs\18` §4.2：详情页表格里点一下那一行）
 *
 * 形状与服务端 `parseReviewEventInput()` 对齐：`update` 要 `eventId + outcome`，
 * `delete` 只要 `eventId`。
 * ⚠️ **不带日期、来源、卷号** —— 那是"这一次复习"的事实；改主意只是改正
 *    "结果记错了"，不是把这次复习挪到别的时间（服务端也确实不看）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 改某一条流水的**结果** */
export interface ReviewEventPatchDraft {
    op: 'update' | 'delete';
    eventId: string;
    outcome?: ReviewOutcome;
}

export function reviewEventUpdateDraft(eventId: string, outcome: ReviewOutcome): ReviewEventPatchDraft {
    return { op: 'update', eventId, outcome };
}

export function reviewEventDeleteDraft(eventId: string): ReviewEventPatchDraft {
    return { op: 'delete', eventId };
}
