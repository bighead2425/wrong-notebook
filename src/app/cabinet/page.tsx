"use client";

/**
 * 【2026-10-04 新增】「总理内阁」（`/cabinet`）—— 专门给家长的一间屋子。
 *
 * ── 这一页要解决的事（他的原话）──────────────────────────────────────
 *   "不用再自己思考现在哪个纸、哪个卷是不是该干什么了。" ——
 *   把"该印哪张纸、该回录哪张纸、哪道题该复查"排成一排任务卡：
 *   写清"要做什么 + 有几件 + 一键去做"。
 *
 * ── 三块 ────────────────────────────────────────────────────────────
 *   ① 统计总览：**复用主页统计中心**（`WrongAnswerStats` → `/api/analytics`），不另算一份。
 *   ② 错题本一览：多少本、每本多少题、构成（学科 / 掌握状态 / 错题等级）—— 数据来自 `/api/cabinet`。
 *   ③ 任务台：六类任务的计数 + 清单 + 跳转。
 *
 * ── 跳转（第一版只有"带到正确的页面 + 筛选就位"，不做"一键完成"）──────
 *   · 待打印深挖题 → `/print-preview?mode=deep&ids=…`（预选这批题）
 *   · 该复查的题   → `/print-preview?mode=review&ids=…`（预选，去组复练卷）
 *   · 该回录       → `/recover`（深挖纸与复练卷都在那一屏回录）
 *   · 未打印的日积月累 → `/insights`
 *   · 建议升深挖   → 进到那道题所在的本（建议而已，改不改由人）
 *
 * ⚠️ 判据**不在这里**：全部在 `lib/cabinet.ts`（纯函数、有单测）。
 *    这一页只负责画卡片 + 拼链接，免得"卡片说 12、点进去 9 道"。
 * ⚠️ 不用 `useSearchParams`（页面不读 URL），因此不需要 `<Suspense>`
 *    —— 避开本项目"漏包 Suspense ⇒ next build 中断"那个老坑（见 next-build-conventions.test.ts）。
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { WrongAnswerStats } from "@/components/wrong-answer-stats";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import {
    MANAGE_TYPE_LABEL,
    MANAGE_TYPE_SCREEN_COLOR,
    MANAGE_TYPE_UNDECIDED_COLOR,
} from "@/lib/manage-type";
import {
    ArrowRight,
    BarChart3,
    BookOpen,
    ClipboardCheck,
    Landmark,
    Layers,
    Loader2,
    Printer,
    ScanText,
    Sprout,
    TrendingUp,
} from "lucide-react";

/* ============================ 接口返回形状 ============================ */

interface ManageTypeCounts {
    deep: number;
    review: number;
    undecided: number;
}
interface MasteryCounts {
    fresh: number;
    reviewing: number;
    mastered: number;
}

interface CabinetTask<T> {
    count: number;
    ids: string[];
    items: T[];
    volumeIds?: string[];
}

interface CabinetResponse {
    generatedAt: string;
    overview: {
        notebookCount: number;
        questionCount: number;
        bySubject: { subject: string; label: string; count: number }[];
        byManageType: ManageTypeCounts;
        byMastery: MasteryCounts;
    };
    notebooks: {
        id: string;
        displayName: string;
        subject: string;
        subjectLabel: string;
        grade: string;
        semester: string;
        gradeStage: string;
        count: number;
        byManageType: ManageTypeCounts;
        byMastery: MasteryCounts;
    }[];
    tasks: {
        pendingDeepPrint: CabinetTask<{ id: string; source: string | null }>;
        dueReviews: CabinetTask<{ id: string; source: string | null; dueOn: string; label: string; overdueDays: number }>;
        pendingRecover: CabinetTask<{ id: string; source: string | null; daysSincePrint: number }>;
        pendingRecoverVolumes: CabinetTask<{ id: string; volumeNo: string; unrecoveredCount: number; daysSinceCreated: number }>;
        unprintedInsights: CabinetTask<{ id: string; code: string; subject?: string | null }>;
        upgradeSuggestions: CabinetTask<{ id: string; source: string | null; notebookId?: string | null; wrongCount: number }>;
    };
}

/* ============================ 小件 ============================ */

/** 一条构成比例条（标签 + 数值 + 占比） */
function DistBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium tabular-nums">
                    {value}
                    <span className="ml-1 text-muted-foreground">({pct}%)</span>
                </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-muted">
                <div className="h-2 rounded" style={{ width: `${pct}%`, background: color }} />
            </div>
        </div>
    );
}

/** 简单统计块（本数 / 题数） */
function StatTile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
    return (
        <div className="rounded-lg border bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
            {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
        </div>
    );
}

const MASTERY_COLORS = { fresh: "#2563eb", reviewing: "#d97706", mastered: "#16a34a" };

/* ============================ 页面 ============================ */

export default function CabinetPage() {
    const { t, language } = useLanguage();
    const zh = language === "zh";
    const L = (a: string, b: string) => (zh ? a : b);

    const [data, setData] = useState<CabinetResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        apiClient
            .get<CabinetResponse>("/api/cabinet")
            .then((d) => {
                if (!cancelled) setData(d);
            })
            .catch((e) => {
                console.error("Failed to load cabinet data:", e);
                if (!cancelled) setError(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const printLink = (mode: "deep" | "review", ids: string[]) =>
        ids.length > 0 ? `/print-preview?mode=${mode}&ids=${encodeURIComponent(ids.join(","))}` : null;

    return (
        <main className="min-h-screen bg-background">
            <div className="container mx-auto max-w-6xl space-y-8 p-4 pb-20 md:p-8">
                {/* ===== 头部 ===== */}
                <div className="flex items-start gap-4">
                    <BackButton fallbackUrl="/" />
                    <div className="flex-1 space-y-1">
                        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
                            <Landmark className="h-7 w-7" />
                            {L("总理内阁", "Cabinet")}
                        </h1>
                        <p className="text-sm text-muted-foreground sm:text-base">
                            {L(
                                "专门给家长的控制台：一眼看清家底，再把该干的活排成一排，一件一件做。不用再自己想着哪张纸、哪份卷是不是该干什么了。",
                                "A console for the parent: see the whole state, and get the next actions lined up one by one.",
                            )}
                        </p>
                    </div>
                </div>

                {/* ===== ① 统计总览（复用主页统计中心）===== */}
                <section className="space-y-4">
                    <h2 className="flex items-center gap-2 text-xl font-semibold">
                        <BarChart3 className="h-5 w-5" />
                        {L("统计总览", "Overview")}
                    </h2>
                    <WrongAnswerStats />
                </section>

                {/* ===== ② 错题本一览 ===== */}
                <section className="space-y-4">
                    <h2 className="flex items-center gap-2 text-xl font-semibold">
                        <BookOpen className="h-5 w-5" />
                        {L("当前错题本", "Notebooks")}
                    </h2>

                    {loading ? (
                        <div className="flex items-center gap-2 p-8 text-muted-foreground">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            {t.common?.loading || "Loading..."}
                        </div>
                    ) : error ? (
                        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
                            {L("数据没取到，稍后再试。", "Failed to load. Try again later.")}
                        </div>
                    ) : data ? (
                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                <StatTile label={L("在用错题本", "Active notebooks")} value={data.overview.notebookCount} />
                                <StatTile label={L("错题总数", "Total questions")} value={data.overview.questionCount} />
                                <StatTile
                                    label={L("深挖 / 复练", "Deep / Review")}
                                    value={`${data.overview.byManageType.deep} / ${data.overview.byManageType.review}`}
                                    hint={`${L("未定", "Undecided")} ${data.overview.byManageType.undecided}`}
                                />
                                <StatTile
                                    label={L("已掌握", "Mastered")}
                                    value={data.overview.byMastery.mastered}
                                    hint={`${L("复习中", "Reviewing")} ${data.overview.byMastery.reviewing}`}
                                />
                            </div>

                            {/* 全局构成 */}
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-base">{L("整体构成", "Composition")}</CardTitle>
                                </CardHeader>
                                <CardContent className="grid gap-6 md:grid-cols-3">
                                    <div className="space-y-3">
                                        <div className="text-sm font-medium">{L("按学科", "By subject")}</div>
                                        {data.overview.bySubject.length === 0 ? (
                                            <p className="text-xs text-muted-foreground">{L("还没有错题", "No questions yet")}</p>
                                        ) : (
                                            data.overview.bySubject.map((s) => (
                                                <DistBar
                                                    key={s.subject}
                                                    label={s.label}
                                                    value={s.count}
                                                    total={data.overview.questionCount}
                                                    color="#6366f1"
                                                />
                                            ))
                                        )}
                                    </div>
                                    <div className="space-y-3">
                                        <div className="text-sm font-medium">{L("按错题等级", "By manage type")}</div>
                                        <DistBar
                                            label={MANAGE_TYPE_LABEL.deep}
                                            value={data.overview.byManageType.deep}
                                            total={data.overview.questionCount}
                                            color={MANAGE_TYPE_SCREEN_COLOR.deep}
                                        />
                                        <DistBar
                                            label={MANAGE_TYPE_LABEL.review}
                                            value={data.overview.byManageType.review}
                                            total={data.overview.questionCount}
                                            color={MANAGE_TYPE_SCREEN_COLOR.review}
                                        />
                                        <DistBar
                                            label={L("未定", "Undecided")}
                                            value={data.overview.byManageType.undecided}
                                            total={data.overview.questionCount}
                                            color={MANAGE_TYPE_UNDECIDED_COLOR}
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <div className="text-sm font-medium">{L("按掌握状态", "By mastery")}</div>
                                        <DistBar
                                            label={L("新题", "New")}
                                            value={data.overview.byMastery.fresh}
                                            total={data.overview.questionCount}
                                            color={MASTERY_COLORS.fresh}
                                        />
                                        <DistBar
                                            label={L("复习中", "Reviewing")}
                                            value={data.overview.byMastery.reviewing}
                                            total={data.overview.questionCount}
                                            color={MASTERY_COLORS.reviewing}
                                        />
                                        <DistBar
                                            label={L("已掌握", "Mastered")}
                                            value={data.overview.byMastery.mastered}
                                            total={data.overview.questionCount}
                                            color={MASTERY_COLORS.mastered}
                                        />
                                    </div>
                                </CardContent>
                            </Card>

                            {/* 每本一行 */}
                            {data.notebooks.length === 0 ? (
                                <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
                                    {L("还没有在用错题本。", "No active notebooks yet.")}
                                </div>
                            ) : (
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {data.notebooks.map((nb) => (
                                        <Link key={nb.id} href={`/notebooks/${nb.id}`} className="block">
                                            <Card className="h-full transition-colors hover:border-primary/50">
                                                <CardHeader className="flex flex-row items-center justify-between gap-2">
                                                    <CardTitle className="text-base">{nb.displayName}</CardTitle>
                                                    <span className="shrink-0 text-sm text-muted-foreground">
                                                        {nb.count} {L("题", "items")}
                                                    </span>
                                                </CardHeader>
                                                <CardContent className="space-y-3">
                                                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                                        <span>
                                                            {L("深挖", "Deep")} {nb.byManageType.deep}
                                                        </span>
                                                        <span>
                                                            {L("复练", "Review")} {nb.byManageType.review}
                                                        </span>
                                                        <span>
                                                            {L("未定", "Undecided")} {nb.byManageType.undecided}
                                                        </span>
                                                        <span>
                                                            {L("已掌握", "Mastered")} {nb.byMastery.mastered}
                                                        </span>
                                                    </div>
                                                    <DistBar
                                                        label={nb.subjectLabel}
                                                        value={nb.count}
                                                        total={Math.max(data.overview.questionCount, 1)}
                                                        color="#6366f1"
                                                    />
                                                </CardContent>
                                            </Card>
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : null}
                </section>

                {/* ===== ③ 任务台 ===== */}
                <section className="space-y-4">
                    <h2 className="flex items-center gap-2 text-xl font-semibold">
                        <ClipboardCheck className="h-5 w-5" />
                        {L("任务台", "Task board")}
                    </h2>
                    <p className="-mt-2 text-sm text-muted-foreground">
                        {L(
                            "每张卡就是一件该做的事：有几件、点一下直接去做。",
                            "Each card is one job: how many, and one click to act.",
                        )}
                    </p>

                    {loading ? null : error ? null : data ? (
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                            {/* 待打印深挖题 */}
                            <TaskCard
                                icon={<Printer className="h-5 w-5" />}
                                title={L("待打印深挖题", "Deep sheets to print")}
                                desc={L("判为深挖、但深挖纸一次都还没印过", "Deep questions whose sheet was never printed")}
                                count={data.tasks.pendingDeepPrint.count}
                                unit={L("道", "items")}
                                samples={data.tasks.pendingDeepPrint.items.map((i) => i.source || i.id).slice(0, 4)}
                                href={printLink("deep", data.tasks.pendingDeepPrint.ids)}
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
                                count={data.tasks.dueReviews.count}
                                unit={L("道", "items")}
                                samples={data.tasks.dueReviews.items
                                    .map((i) => `${i.source || i.id}·${i.dueOn.slice(5)}`)
                                    .slice(0, 4)}
                                href={printLink("review", data.tasks.dueReviews.ids)}
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
                                count={data.tasks.pendingRecover.count}
                                unit={L("道", "items")}
                                samples={data.tasks.pendingRecover.items.map((i) => i.source || i.id).slice(0, 4)}
                                href={data.tasks.pendingRecover.count > 0 ? "/recover" : null}
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
                                count={data.tasks.pendingRecoverVolumes.count}
                                unit={L("份", "volumes")}
                                samples={data.tasks.pendingRecoverVolumes.items.map((i) => i.volumeNo).slice(0, 3)}
                                href={data.tasks.pendingRecoverVolumes.count > 0 ? "/recover" : null}
                                cta={L("去回录分析", "Go to recover")}
                            />
                            {/* 未打印的日积月累 */}
                            <TaskCard
                                icon={<Sprout className="h-5 w-5" />}
                                title={L("未打印的日积月累", "Takeaways not printed")}
                                desc={L("还没被编进任何一张积累纸", "Not included in any volume yet")}
                                count={data.tasks.unprintedInsights.count}
                                unit={L("条", "entries")}
                                samples={data.tasks.unprintedInsights.items.map((i) => i.code).slice(0, 4)}
                                href={data.tasks.unprintedInsights.count > 0 ? "/insights" : null}
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
                                count={data.tasks.upgradeSuggestions.count}
                                unit={L("道", "items")}
                                samples={data.tasks.upgradeSuggestions.items.map((i) => i.source || i.id).slice(0, 4)}
                                href={
                                    data.tasks.upgradeSuggestions.count > 0
                                        ? data.tasks.upgradeSuggestions.items[0]?.notebookId
                                            ? `/notebooks/${data.tasks.upgradeSuggestions.items[0].notebookId}`
                                            : "/notebooks"
                                        : null
                                }
                                cta={L("去该题所在的本", "Open its notebook")}
                            />
                        </div>
                    ) : null}
                </section>
            </div>
        </main>
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
                        {empty ? "暂时没有这一项" : ""}
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
