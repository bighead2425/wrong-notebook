"use client";

/**
 * 【2026-10-20 真真】「任务台」—— 从 `/cabinet` 抽出来，**三处共用**。
 *
 * 空空 2026-10-20 第 3、6 条：
 *   · 主页点「当前任务」要看到的是**内阁的任务台**（卡片式），不是那张简单的分类清单；
 *   · 内阁页的顺序改成：**任务台 → 当前错题本 → 错题统计**。
 * ⇒ 同一块内容要出现在两个地方，抽成组件；否则两处各写一份，迟早一处改一处不改
 *   （这个项目已经踩过好几次"看起来一样、其实两份"）。
 *
 * ⚠️ **数据由调用方传**（`tasks`），组件**不自己 fetch**：
 *   `/cabinet` 一次就把 `overview` 和 `tasks` 都拿到了，再让组件自己请求一遍纯属浪费；
 *   `/tasks` 那边自己请求一次再传进来。谁取数谁负责，组件只管画。
 *
 * ⚠️ 判据**不在这里**：全部在 `lib/cabinet.ts`（纯函数、有单测）。
 *    这里只负责画卡片 + 拼链接，免得"卡片说 12、点进去 9 道"。
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import type { Overview } from "@/lib/overview";
import {
    ArrowRight,
    BarChart3,
    ClipboardCheck,
    Dumbbell,
    Layers,
    Printer,
    ScanText,
    Sprout,
    TrendingUp,
} from "lucide-react";

/* ============================ 接口返回形状 ============================ */

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
    pendingRecoverVolumes: CabinetTask<{ id: string; volumeNo: string; unrecoveredCount: number; daysSinceCreated: number }>;
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

/* ============================ 组件 ============================ */

export function TaskBoard({ tasks }: { tasks: CabinetTasks }) {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);
    const zh = language === "zh";

    const printLink = (mode: "deep" | "review", ids: string[]) =>
        ids.length > 0 ? `/print-preview?mode=${mode}&ids=${encodeURIComponent(ids.join(","))}` : null;

    return (
        <div className="space-y-4">
            <p className="-mt-2 text-sm text-muted-foreground">
                {L(
                    "每张卡就是一件该做的事：有几件、点一下直接去做。",
                    "Each card is one job: how many, and one click to act.",
                )}
            </p>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {/* 【2026-10-13 他拍板的设计 · 放在最前】今天先练这几道 ——
                    判据 = 由复练结果算出来的**紧迫度**（`lib/review-status.ts`），
                    与「该复查的题」分工明确：那个看纸上的日期格，这个看复练结果。
                    ⭐ 它专门补「该复查」的窟窿：计划三次做满之后又做错的题，
                       原来那一块永远不会再提醒（判据是"第一个空格"），这里捞得回来。 */}
                <TaskCard
                    icon={<Dumbbell className="h-5 w-5" />}
                    title={L("今天先练这几道", "Practice these today")}
                    desc={L(
                        "按复练结果算的紧迫度排的：没练过的、上次做错的、连错两次以上的（已掌握的、以及上面几块已经在催的，都不重复算）",
                        "Sorted by urgency from review results: never practiced / last wrong / wrong twice in a row",
                    )}
                    count={tasks.practiceToday.count}
                    unit={L("道", "items")}
                    samples={tasks.practiceToday.items
                        .map((i) => `${i.source || i.id}·${zh ? i.reasonZh : i.reasonEn}`)
                        .slice(0, 4)}
                    href={printLink("review", tasks.practiceToday.ids)}
                    cta={L("去组复练卷", "Build a review volume")}
                />
                {/* 待打印深挖题 */}
                <TaskCard
                    icon={<Printer className="h-5 w-5" />}
                    title={L("待打印深挖题", "Deep sheets to print")}
                    desc={L("判为深挖、但深挖纸一次都还没印过", "Deep questions whose sheet was never printed")}
                    count={tasks.pendingDeepPrint.count}
                    unit={L("道", "items")}
                    samples={tasks.pendingDeepPrint.items.map((i) => i.source || i.id).slice(0, 4)}
                    href={printLink("deep", tasks.pendingDeepPrint.ids)}
                    cta={L("去打印深挖纸", "Print deep sheets")}
                />
                {/* 该复查的题 */}
                <TaskCard
                    icon={<TrendingUp className="h-5 w-5" />}
                    title={L("该复查的题", "Due for review")}
                    desc={L(
                        "印过深挖纸、纸面下一个日期格（+1/+7/+21 天）已到期",
                        "Printed; the next planned review date (+1/+7/+21) has come",
                    )}
                    count={tasks.dueReviews.count}
                    unit={L("道", "items")}
                    samples={tasks.dueReviews.items.map((i) => `${i.source || i.id}·${i.dueOn.slice(5)}`).slice(0, 4)}
                    href={printLink("review", tasks.dueReviews.ids)}
                    cta={L("去组复练卷", "Build a review volume")}
                />
                {/* 该回录的深挖纸 */}
                <TaskCard
                    icon={<ScanText className="h-5 w-5" />}
                    title={L("该回录的深挖纸", "Deep sheets to recover")}
                    desc={L(
                        "印过、过了几天，但还没扫回这道题的日积月累",
                        "Printed a while ago, but no takeaway recovered for this question yet",
                    )}
                    count={tasks.pendingRecover.count}
                    unit={L("道", "items")}
                    samples={tasks.pendingRecover.items.map((i) => i.source || i.id).slice(0, 4)}
                    href={tasks.pendingRecover.count > 0 ? "/recover" : null}
                    cta={L("去回录分析", "Go to recover")}
                />
                {/* 待回录的复练卷 */}
                <TaskCard
                    icon={<Layers className="h-5 w-5" />}
                    title={L("待回录的复练卷", "Review volumes to recover")}
                    desc={L(
                        "组出来过几天了，卷里还有没标对错的行（建议人工看一眼）",
                        "Built days ago and still has unmarked rows (please check by hand)",
                    )}
                    count={tasks.pendingRecoverVolumes.count}
                    unit={L("份", "volumes")}
                    samples={tasks.pendingRecoverVolumes.items.map((i) => i.volumeNo).slice(0, 3)}
                    href={tasks.pendingRecoverVolumes.count > 0 ? "/recover" : null}
                    cta={L("去回录分析", "Go to recover")}
                />
                {/* 未打印的日积月累 */}
                <TaskCard
                    icon={<Sprout className="h-5 w-5" />}
                    title={L("未打印的日积月累", "Takeaways not printed")}
                    desc={L("还没被编进任何一张积累纸", "Not included in any volume yet")}
                    count={tasks.unprintedInsights.count}
                    unit={L("条", "entries")}
                    samples={tasks.unprintedInsights.items.map((i) => i.code).slice(0, 4)}
                    href={tasks.unprintedInsights.count > 0 ? "/insights" : null}
                    cta={L("去日积月累", "Open takeaways")}
                />
                {/* 建议升为深挖 */}
                <TaskCard
                    icon={<BarChart3 className="h-5 w-5" />}
                    title={L("建议升为深挖", "Suggest upgrading")}
                    desc={L(
                        "计划复习里错了 2 次以上（只建议，不会自动改）",
                        "Wrong twice or more in planned reviews (suggestion only)",
                    )}
                    count={tasks.upgradeSuggestions.count}
                    unit={L("道", "items")}
                    samples={tasks.upgradeSuggestions.items.map((i) => i.source || i.id).slice(0, 4)}
                    href={
                        tasks.upgradeSuggestions.count > 0
                            ? tasks.upgradeSuggestions.items[0]?.notebookId
                                ? `/notebooks/${tasks.upgradeSuggestions.items[0].notebookId}`
                                : "/notebooks"
                            : null
                    }
                    cta={L("去该题所在的本", "Open its notebook")}
                />
            </div>
        </div>
    );
}

/** 任务台那一块的标题（两处共用同一句，免得 `/tasks` 与 `/cabinet` 文案不一致） */
export function TaskBoardHeading() {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);
    return (
        <h2 className="flex items-center gap-2 text-xl font-semibold">
            <ClipboardCheck className="h-5 w-5" />
            {L("任务台", "Task board")}
        </h2>
    );
}

/* ============================ 任务卡 ============================ */

function TaskCard({
    icon,
    title,
    desc,
    count,
    unit,
    samples,
    href,
    cta,
}: {
    icon: ReactNode;
    title: string;
    desc: string;
    count: number;
    unit: string;
    samples: string[];
    href: string | null;
    cta: string;
}) {
    /**
     * ⚠️ 【2026-10-04 审理补】TaskCard 是**模块级独立组件**，`L` 是主组件里的闭包
     *    ⇒ 这里**拿不到**，直接写 `L(...)` 会编译报 `Cannot find name 'L'`（CI Build Check 就是这么红的）。
     *    所以本组件自己读一次语言上下文。其余文案（title/desc/cta）仍由调用方生成后传进来。
     */
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);
    const empty = count === 0;
    return (
        <Card className={empty ? "border-dashed opacity-80" : ""}>
            <CardHeader className="gap-1">
                <CardTitle className="flex items-center gap-2 text-base">
                    <span className={empty ? "text-muted-foreground" : "text-primary"}>{icon}</span>
                    {title}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{desc}</p>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold tabular-nums">{count}</span>
                    <span className="text-sm text-muted-foreground">{unit}</span>
                </div>

                {samples.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                        {samples.map((s) => (
                            <span key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                                {s}
                            </span>
                        ))}
                        {count > samples.length && (
                            <span className="px-1 text-[11px] text-muted-foreground">
                                +{count - samples.length}
                            </span>
                        )}
                    </div>
                )}

                {empty || !href ? (
                    <div className="text-xs text-muted-foreground">
                        {empty ? L("暂时没有这一项", "Nothing here right now") : ""}
                    </div>
                ) : (
                    <Link href={href}>
                        <Button size="sm" className="w-full sm:w-auto">
                            {cta}
                            <ArrowRight className="ml-1.5 h-4 w-4" />
                        </Button>
                    </Link>
                )}
            </CardContent>
        </Card>
    );
}
