/**
 * 【2026-10-20 真真】任务台 / 任务简报的**共用类型与"去哪儿"**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 空空 2026-10-20 第 3、4 条：
 *   · "主页『当前任务』有 6 项，点进去任务台有 7 个卡片，为什么对不上"
 *   · "每一行任务后面的向右箭头，和卡片上的『去XXX』按钮去向要一致起来。
 *      目前点箭头都进总理内阁，完全谈不上快速操作"
 *
 * 两个问题的**同一个根**：这两处各自维护了一份"任务清单 + 跳转"，
 * 一份过滤了 0、一份没过滤；一份跳 `/cabinet`、一份跳真正的落点。
 *
 * ⇒ 把**判据和落点**收进这一个文件：
 *   · `TASK_ORDER` —— 有哪些任务、什么顺序、中文叫什么（两处共用，不可能一边 6 一边 7）
 *   · `taskHref()` —— 这个任务该跳哪儿（与卡片上的「去XXX」**同一份逻辑**）
 * 两处只负责"怎么画"，不再各自决定"跳哪"。
 *
 * ⚠️ 落点都是**已经存在**的页面，不新增路由（除了需求 6 那个 `/deep-suggestions`）。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { Overview } from "@/lib/overview";

export interface CabinetTask<T> {
    count: number;
    ids: string[];
    items: T[];
    volumeIds?: string[];
}

/** `/api/cabinet` 里 `tasks` 那一半（`overview` 不在这里） */
export interface CabinetTasks {
    pendingDeepPrint: CabinetTask<{ id: string; source: string | null }>;
    dueReviews: CabinetTask<{ id: string; source: string | null; dueOn: string; label: string; overdueDays: number }>;
    pendingRecover: CabinetTask<{ id: string; source: string | null; daysSincePrint: number }>;
    pendingRecoverVolumes: CabinetTask<{ id: string; volumeNo: string; emojiMark?: string | null; unrecoveredCount: number; daysSinceCreated: number }>;
    unprintedInsights: CabinetTask<{ id: string; code: string; subject?: string | null }>;
    upgradeSuggestions: CabinetTask<{ id: string; source: string | null; notebookId?: string | null; wrongCount: number }>;
    /**
     * 【2026-10-13 他拍板的设计】"今天先练这几道"（由复练结果算出来的紧迫度，
     * 规则在 `lib/review-status.ts` + `lib/cabinet.ts` 的 `practiceTodayItems`）。
     */
    practiceToday: CabinetTask<{
        id: string;
        source: string | null;
        notebookId?: string | null;
        urgency: number;
        reasonZh: string;
        reasonEn: string;
    }>;
    /**
     * 【2026-10-13】学情底账（覆盖率 / 状态分布）。
     * ⚠️ 与 `overview`（questionCount/byManageType/byMastery）**不是一回事**：
     *    那个回答"有多少题"，这个回答"**数据有多厚**"。
     */
    ledger: Overview;
}

export type TaskKey = keyof Pick<
    CabinetTasks,
    | "practiceToday"
    | "dueReviews"
    | "pendingRecover"
    | "pendingRecoverVolumes"
    | "pendingDeepPrint"
    | "unprintedInsights"
    | "upgradeSuggestions"
>;

/**
 * 任务的**唯一清单**：有哪些、什么顺序、叫什么。
 * 主页简报与任务台都从这里取 —— 一边 6 一边 7 那种事从根上不会再发生。
 *
 * 顺序 = 她该做的顺序（"今天先练"永远第一）。
 */
export const TASK_ORDER: { key: TaskKey; zh: string; en: string; strong?: boolean }[] = [
    { key: "practiceToday", zh: "今天该练", en: "Practice today", strong: true },
    { key: "dueReviews", zh: "该复查", en: "Due for review" },
    { key: "pendingRecover", zh: "待回录分析", en: "Waiting to be recovered" },
    { key: "pendingRecoverVolumes", zh: "待回录的卷", en: "Volumes to recover" },
    { key: "pendingDeepPrint", zh: "待打印深挖纸", en: "Deep-dive sheets to print" },
    { key: "unprintedInsights", zh: "待打印积累", en: "Notes to print" },
    { key: "upgradeSuggestions", zh: "建议升深挖", en: "Suggested upgrades" },
];

const printLink = (mode: "deep" | "review", ids: string[]) =>
    ids.length > 0 ? `/print-preview?mode=${mode}&ids=${encodeURIComponent(ids.join(","))}` : null;

/**
 * **这个任务点一下去哪儿** —— 与任务卡上「去XXX」按钮**同一个答案**。
 *
 * ⚠️ 返回 `null` 表示"这件事现在没有可去的地方"（比如 0 道待回录）。
 *    调用方该把箭头藏掉或置灰，**不要**退回到"统一跳内阁"——那正是他抱怨的。
 */
export function taskHref(key: TaskKey, tasks: CabinetTasks): string | null {
    switch (key) {
        case "practiceToday":
            return printLink("review", tasks.practiceToday.ids);
        case "dueReviews":
            return printLink("review", tasks.dueReviews.ids);
        case "pendingDeepPrint":
            return printLink("deep", tasks.pendingDeepPrint.ids);
        case "pendingRecover":
            // 【2026-10-20 需求 5】把待回录的题号带过去，回录页在最后列出它们
            return tasks.pendingRecover.count > 0
                ? `/recover?nos=${encodeURIComponent(
                      tasks.pendingRecover.items.map((i) => i.source || i.id).join(","),
                  )}`
                : null;
        case "pendingRecoverVolumes":
            // 【2026-10-20 需求 5】把卷号带过去，回录页在最后列出这些卷
            return tasks.pendingRecoverVolumes.count > 0
                ? `/recover?volumes=${encodeURIComponent(
                      tasks.pendingRecoverVolumes.items.map((i) => i.volumeNo).join(","),
                  )}`
                : null;
        case "unprintedInsights":
            return tasks.unprintedInsights.count > 0 ? "/insights" : null;
        case "upgradeSuggestions":
            // 【2026-10-20 需求 6】新页面「建议深挖」已建好 ⇒ 从这里直达，不再绕"该题所在的本"
            return tasks.upgradeSuggestions.count > 0 ? "/deep-suggestions" : null;
        default:
            return null;
    }
}

/** 任务卡上那个按钮该写什么（与 `taskHref` 配套，免得文案和落点各说各话） */
export function taskCta(key: TaskKey, zh: boolean): string {
    const L = (a: string, b: string) => (zh ? a : b);
    switch (key) {
        case "practiceToday":
            return L("去组复练卷", "Build a review volume");
        case "dueReviews":
            return L("去组复练卷", "Build a review volume");
        case "pendingDeepPrint":
            return L("去打印深挖纸", "Print deep sheets");
        case "pendingRecover":
            return L("去回录分析", "Go to recover");
        case "pendingRecoverVolumes":
            return L("去回录分析", "Go to recover");
        case "unprintedInsights":
            return L("去日积月累", "Open takeaways");
        case "upgradeSuggestions":
            return L("查看相关习题", "Review these questions");
        default:
            return L("去看看", "Open");
    }
}
