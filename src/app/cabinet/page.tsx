"use client";

/**
 * 【2026-10-04 新增】「总理内阁」（`/cabinet`）—— 专门给家长的一间屋子。
 *
 * ── 这一页要解决的事（他的原话）──────────────────────────────────────
 *   "不用再自己思考现在哪个纸、哪个卷是不是该干什么了。" ——
 *   把"该印哪张纸、该回录哪张纸、哪道题该复查"排成一排任务卡：
 *   写清"要做什么 + 有几件 + 一键去做"。
 *
 * ── 三块（顺序按空空 2026-10-20 第 6 条：**任务台 → 当前错题本 → 错题统计**）──────
 *   ① 任务台：六类任务的计数 + 清单 + 跳转（**已抽成 `components/cabinet/task-board.tsx`**，
 *      与 `/tasks` 共用 —— 主页点「当前任务」看到的就是它）。
 *   ② 错题本一览：多少本、每本多少题、构成（学科 / 掌握状态 / 错题等级）—— 数据来自 `/api/cabinet`。
 *   ③ 统计总览：**复用主页统计中心**（`WrongAnswerStats` → `/api/analytics`），不另算一份。
 *
 * ⚠️ 顺序是**他明确要求的**："先是任务台板块，然后是当前错题本板块，最后是错题统计板块。"
 *    原来正好倒过来（统计 → 错题本 → 任务台），进来第一眼看到的是数字而不是"该干什么"。
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

import { useEffect, useState } from "react";
import Link from "next/link";
import { WrongAnswerStats } from "@/components/wrong-answer-stats";
import { TaskBoard, TaskBoardHeading, type CabinetTasks } from "@/components/cabinet/task-board";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
// 【2026-10-15】客户端算"今天"（本地时区）⇒ 传给 /api/cabinet 供每日等级结算用
import { dayKey } from "@/lib/calendar-grid";
import {
    MANAGE_TYPE_LABEL,
    MANAGE_TYPE_SCREEN_COLOR,
    MANAGE_TYPE_UNDECIDED_COLOR,
} from "@/lib/manage-type";
/** 【2026-10-13】学情底账（覆盖率）—— 判据只在 `lib/overview.ts`，这里只管显示 */
import { coverageSentence } from "@/lib/overview";
import {
    BarChart3,
    BookOpen,
    Landmark,
    Loader2,
    Tags,
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
    /** 【2026-10-20 真真】形状搬进 `components/cabinet/task-board.tsx`（与 /tasks 共用） */
    tasks: CabinetTasks;
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

/**
 * 【2026-10-13】复习状态四档的色 —— **与上面掌握状态同一套语义**，别另造一套：
 *   蓝 = 新的（还没起步）／琥珀 = 进行中／绿 = 完成（不必再排）；
 *   红 = **最急**（"要练" = 昨天该做没做）。
 * ⚠️ 这里的红是"催办"，不是"报错"，也不是纸面那个"升级 ⇒ 红" —— 但两者方向一致
 *    （都是"要更用力"），所以同屏不冲突。
 */
const REVIEW_STATE_COLORS: Record<string, string> = {
    new: "#2563eb",
    due: "#dc2626",
    practicing: "#d97706",
    retired: "#16a34a",
};

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
            /**
             * 【2026-10-15】把**客户端的"今天"**带给服务端 —— 每日等级结算要用它。
             *
             * 为什么不靠服务端自己算：容器跑 UTC（Dockerfile 里没配时区），
             * 而**浏览器天生知道用户在哪个时区**（不用问用户、也不用做设置项）
             * ⇒ 这是项目"时区铁律"（"哪一天只在客户端算"）的正解。
             * 服务端有保险：传得不合理（差超过 1 天）就退回服务器日期。
             * 详见 `docs\14` 第六节 / `lib/daily-settle.ts` 的 `normalizeTodayKey`。
             */
            .get<CabinetResponse>(`/api/cabinet?today=${encodeURIComponent(dayKey(new Date()))}`)
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

                {/* 【2026-10-05 他要求】「标签管理」「统计中心」两个入口从主页搬到这里。
                    理由（他的原话）：主页只留六个主线入口，这两个是低频的，
                    摆主页会跟"今天该干什么"这条主线抢注意力。
                    ⚠️ 只是**入口搬家**：两个页面本身一字未改，路径也不变。 */}
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">{L("常用入口：", "Shortcuts:")}</span>
                    <Link href="/tags">
                        <Button variant="outline" size="sm" className="h-8">
                            <Tags className="mr-1.5 h-3.5 w-3.5" />
                            {t.app?.tags || "标签管理"}
                        </Button>
                    </Link>
                    <Link href="/stats">
                        <Button variant="outline" size="sm" className="h-8">
                            <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
                            {t.app?.stats || "统计中心"}
                        </Button>
                    </Link>
                </div>

                {/* ===== 任务台（【2026-10-20 真真】抽成组件，与 /tasks 共用）===== */}
                <section className="space-y-4">
                    <TaskBoardHeading />
                    {/* ⚠️ 取数三态照旧留在这里：`data` 为 null 时组件根本不该渲染 */}
                    {loading ? null : error ? null : data ? <TaskBoard tasks={data.tasks} /> : null}
                </section>

                {/* ===== ② 错题本一览（顺序第 2）===== */}
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
                                    {/* 【2026-10-13】覆盖率 —— 判据在 lib/overview.ts。
                                        放在最显眼处是有意的：下面每个数字都要能看出"基于几道题算的"，
                                        这也是将来任何 AI 结论必须挂靠的那把尺子。 */}
                                    <p className="text-xs text-muted-foreground">
                                        {coverageSentence(data.tasks.ledger.coverage.reviewResult, zh)}
                                    </p>
                                </CardHeader>
                                <CardContent className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
                                    <div className="space-y-3">
                                        <div className="text-sm font-medium">{L("按学科", "By subject")}</div>
                                        {data.tasks.ledger.bySubject.length === 0 ? (
                                            <p className="text-xs text-muted-foreground">{L("还没有错题", "No questions yet")}</p>
                                        ) : (
                                            /**
                                             * 【2026-10-13】改用底账那一份（原来用 `data.overview.bySubject`）：
                                             *  ① 颜色改用**真实学科色**（与错题本卡片那条色带同源，同屏同色），
                                             *     原来 10 个学科一律画成靛蓝，看不出哪科是哪科；
                                             *  ② 每条**带上"其中 N 道待练"** —— 这是学科与状态机第一次连上，
                                             *     "哪一科最需要练"从此不用自己去数。
                                             */
                                            data.tasks.ledger.bySubject.map((s) => (
                                                <DistBar
                                                    key={s.key || "__unfiled__"}
                                                    label={
                                                        s.urgent > 0
                                                            ? `${s.label} · ${L(`${s.urgent} 待练`, `${s.urgent} due`)}`
                                                            : s.label
                                                    }
                                                    value={s.count}
                                                    total={data.overview.questionCount}
                                                    color={s.hex}
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
                                    {/*
                                      * 【2026-10-13】按复习状态 —— 与上面三列**不是同一批口径**：
                                      * 掌握状态是"他自己标的"（masteryLevel），
                                      * 复习状态是**由复练结果现算**的（见 lib/review-status.ts），
                                      * 所以两列数字对不上是**正常**的（一道题可以"已掌握"但状态是"要练"——
                                      * 后者说明他标了已掌握之后又错了，那正是要看见的事）。
                                      * 分母仍用 questionCount：ledger 与它是**同一批题**（同一 items 映射出来的）。
                                      */}
                                    <div className="space-y-3">
                                        <div className="text-sm font-medium">{L("按复习状态", "By review state")}</div>
                                        {data.tasks.ledger.byReviewState.map((s) => (
                                            <DistBar
                                                key={s.state}
                                                label={zh ? s.zh : s.en}
                                                value={s.count}
                                                total={data.overview.questionCount}
                                                color={REVIEW_STATE_COLORS[s.state] ?? "#6b7280"}
                                            />
                                        ))}
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

                {/* ===== ③ 统计总览（复用主页统计中心，顺序最后）===== */}
                <section className="space-y-4">
                    <h2 className="flex items-center gap-2 text-xl font-semibold">
                        <BarChart3 className="h-5 w-5" />
                        {L("统计总览", "Overview")}
                    </h2>
                    <WrongAnswerStats />
                </section>




            </div>
        </main>
    );
}
