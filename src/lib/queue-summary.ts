/**
 * 「该练什么」的**摘要计算** —— 把 `/api/analytics/queue` 的原始数据压成
 * 首页那一小块能直接画的东西。
 *
 * 为什么单独成函数（而不是写在组件里）：组件里写等于没法测。
 * 这块要回答的问题只有一个 —— **"今天要不要管，管几道"**，
 * 所以它必须能算，而不是靠眼睛从图里读。
 */

/**
 * 五档的**文案与配色** —— 首页摘要和「该练什么」整页**共用这一份**。
 *
 * ⚠️ 界面上**不出现"紧迫度""等级"这些词**（定盘星：界面用生活语言）。
 *    这里说的是"多久后会再到期"，家长能直接理解成"这周要不要管"。
 * ⚠️ 以前这份表只在 `components/review-queue-stats.tsx` 里，首页要画同一件事
 *    就必须抄一份 —— 抄了迟早会分叉（一边改了文案、另一边的图还是旧说法）。
 *    所以提到这里，两处 import 同一个常量。
 */
export const QUEUE_LEVELS_META = [
    { urgency: 5, zh: "还没练过 / 连着错", en: "Untouched / repeated misses", color: "#dc2626", hintZh: "明天就到期", hintEn: "due tomorrow" },
    { urgency: 4, zh: "最近错了一次", en: "Missed last time", color: "#f97316", hintZh: "3 天后到期", hintEn: "due in 3 days" },
    { urgency: 3, zh: "对了一次", en: "Right once", color: "#eab308", hintZh: "7 天后到期", hintEn: "due in 7 days" },
    { urgency: 2, zh: "连对两次", en: "Right twice", color: "#3b82f6", hintZh: "14 天后到期", hintEn: "due in 14 days" },
    { urgency: 1, zh: "连对三次", en: "Right three times", color: "#14b8a6", hintZh: "28 天后到期", hintEn: "due in 28 days" },
] as const;

/** 五个档位号（5 = 最急），顺序固定 5→1 */
export const QUEUE_LEVELS: readonly number[] = QUEUE_LEVELS_META.map((m) => m.urgency);

export interface QueueBucket {
    urgency: number;
    count: number;
}

export interface QueueLike {
    total: number;
    dueToday: number;
    /** 已经过了到期日还没练的 */
    overdue?: number;
    buckets?: QueueBucket[];
}

export interface QueueSummary {
    /** 库里一共多少道（含已退役） */
    total: number;
    /** 今天到期 + 逾期 = 现在就该动的 */
    dueNow: number;
    /** 逾期（超过到期日还没练） */
    overdue: number;
    /** 五档各自的数量，**固定 5 项、按 5→1 排**，缺的补 0 —— 画图时不会缺柱子 */
    levels: { urgency: number; count: number }[];
    /** 现在有没有事可做（用于"空态"文案） */
    hasWork: boolean;
    /**
     * 建议先动哪一档：从最急往下找第一个 count>0 的；
     * 全空返回 null。首页那句"今天先练这 X 道"就用它。
     */
    firstLevel: number | null;
}

/**
 * ⚠️ 脏数据一律夹成非负整数：这个数会直接显示成"今天还有 3 道"，
 *    出现 -1 或 2.5 比不显示更糟。
 */
function count(v: unknown): number {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function summarizeQueue(q: QueueLike | null | undefined): QueueSummary {
    const total = count(q?.total);
    const dueToday = count(q?.dueToday);
    const overdue = count(q?.overdue);

    /* 后端可能只给部分档位（比如某一档为 0 就不返回）⇒ 这里补全成固定 5 档 */
    const byLevel = new Map<number, number>();
    for (const b of q?.buckets ?? []) {
        const u = Math.round(Number(b?.urgency));
        if (u >= 1 && u <= 5) byLevel.set(u, count(b?.count));
    }
    const levels = QUEUE_LEVELS.map((urgency) => ({ urgency, count: byLevel.get(urgency) ?? 0 }));

    const dueNow = dueToday + overdue;
    const firstLevel = levels.find((l) => l.count > 0)?.urgency ?? null;

    return { total, dueNow, overdue, levels, hasWork: dueNow > 0, firstLevel };
}

/**
 * 首页那一小块的**一句话结论**。
 *
 * 刻意不出现"紧迫度/等级"（定盘星：界面上用生活语言），
 * 也不出现"请""建议"这类礼貌用语 —— 它是标签，不是对话框。
 */
export function queueHeadline(s: QueueSummary, zh: boolean): string {
    if (s.total === 0) return zh ? "还没有错题" : "No questions yet";
    if (s.dueNow === 0) return zh ? "今天没有到期的" : "Nothing due today";
    if (s.overdue > 0) {
        return zh
            ? `今天该练 ${s.dueNow} 道（${s.overdue} 道已过期）`
            : `${s.dueNow} due now (${s.overdue} overdue)`;
    }
    return zh ? `今天该练 ${s.dueNow} 道` : `${s.dueNow} due today`;
}
