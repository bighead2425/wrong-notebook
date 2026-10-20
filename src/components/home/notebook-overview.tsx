"use client";

/**
 * 【2026-10-20 真真】主页底部的「**当前错题本**」板块。
 *
 * 空空第 4 条："主页目前最下面显示的是总理内阁中的统计总览，我需要显示的是
 *              当前错题本板块和统计总览板块，都放上去。注意顺序，先放当前错题本板块，
 *              后放统计总览板块。"
 *
 * ── 为什么不直接复用内阁那一整块 ────────────────────────────────────
 * 内阁的「当前错题本」= 4 个数字 + **整体构成**（按学科/等级/掌握三组比例条）+ 每本一行。
 * 而主页底部**紧挨着就有「统计总览」**（`WrongAnswerStats`），两块都会画学科/等级分布
 * ⇒ 直接搬过来是**同一批数字在一屏里出现两次**，反而更难读。
 *
 * ⇒ 主页这块取它的**前半段**：四个关键数字 + 每本一行（名称/题数/四项计数）。
 *   要看完整的构成比例，点右上角「内阁」。两处数据同源（都是 `/api/cabinet`），
 *   口径一致 —— 不会出现"主页说 33、内阁说 34"。
 *
 * ⚠️ 数据自己取一次：主页不该为了这一块把 `cabinet` 的整份数据都拉进来
 *    （那还会连带算六类任务的清单，白费）。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { dayKey } from "@/lib/calendar-grid";
import { BookOpen, Loader2 } from "lucide-react";

interface Counts {
    deep: number;
    review: number;
    undecided: number;
}
interface Mastery {
    fresh: number;
    reviewing: number;
    mastered: number;
}
interface NotebookRow {
    id: string;
    displayName: string;
    subjectLabel: string;
    count: number;
    byManageType: Counts;
    byMastery: Mastery;
}
interface CabinetSlice {
    overview: {
        notebookCount: number;
        questionCount: number;
        byManageType: Counts;
        byMastery: Mastery;
    };
    notebooks: NotebookRow[];
}

function StatTile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
    return (
        <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-0.5 text-xl font-bold tabular-nums">{value}</div>
            {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
        </div>
    );
}

export function NotebookOverview() {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [data, setData] = useState<CabinetSlice | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        apiClient
            .get<CabinetSlice>(`/api/cabinet?today=${encodeURIComponent(dayKey(new Date()))}`)
            .then((d) => {
                if (!cancelled) setData(d);
            })
            .catch((e) => {
                console.error("Failed to load notebooks:", e);
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
        <section className="space-y-3">
            <div className="flex items-center gap-2">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <BookOpen className="h-5 w-5" />
                    {L("当前错题本", "Notebooks")}
                </h2>
                <span className="flex-1" />
                <Link href="/cabinet" className="text-xs text-muted-foreground underline hover:text-foreground">
                    {L("看构成", "Composition")}
                </Link>
            </div>

            {loading ? (
                <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {L("正在算…", "Loading…")}
                </div>
            ) : error || !data ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    {L("数据没取到，稍后再试。", "Failed to load. Try again later.")}
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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

                    {data.notebooks.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                            {L("还没有在用错题本。", "No active notebooks yet.")}
                        </div>
                    ) : (
                        <div className="grid gap-2 sm:grid-cols-2">
                            {data.notebooks.map((nb) => (
                                <Link key={nb.id} href={`/notebooks/${nb.id}`} className="block">
                                    <Card className="h-full transition-colors hover:border-primary/50">
                                        <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
                                            <CardTitle className="text-sm">{nb.displayName}</CardTitle>
                                            <span className="shrink-0 text-xs text-muted-foreground">
                                                {nb.count} {L("题", "items")}
                                            </span>
                                        </CardHeader>
                                        <CardContent className="flex flex-wrap gap-x-3 gap-y-1 pb-3 text-[11px] text-muted-foreground">
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
                                        </CardContent>
                                    </Card>
                                </Link>
                            ))}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
