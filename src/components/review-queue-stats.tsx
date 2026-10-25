"use client";

import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { Loader2 } from "lucide-react";

interface QueueData {
    total: number;
    retired: number;
    dueToday: number;
    overdue: number;
    buckets: { urgency: number; count: number }[];
    subjects: { subject: string; fresh: number; due: number; practicing: number; mastered: number; total: number }[];
    forecast: { date: string; count: number }[];
}

/**
 * 五档的**含义**（与 `lib/review-status.ts` 的 urgency 一一对应）。
 *
 * ⚠️ 界面上**不出现"紧迫度""等级"这些词**（定盘星：界面用生活语言）。
 *    这里说的是"多久后会再到期"—— 家长能直接理解成"这周要不要管"。
 */
const BUCKETS = [
    { urgency: 5, zh: "还没练过 / 连着错", en: "Untouched / repeated misses", color: "#dc2626", hintZh: "明天就到期", hintEn: "due tomorrow" },
    { urgency: 4, zh: "最近错了一次", en: "Missed last time", color: "#f97316", hintZh: "3 天后到期", hintEn: "due in 3 days" },
    { urgency: 3, zh: "对了一次", en: "Right once", color: "#eab308", hintZh: "7 天后到期", hintEn: "due in 7 days" },
    { urgency: 2, zh: "连对两次", en: "Right twice", color: "#3b82f6", hintZh: "14 天后到期", hintEn: "due in 14 days" },
    { urgency: 1, zh: "连对三次", en: "Right three times", color: "#14b8a6", hintZh: "28 天后到期", hintEn: "due in 28 days" },
] as const;

export function ReviewQueueStats() {
    const { language } = useLanguage();
    const zh = language === "zh";
    const L = (a: string, b: string) => (zh ? a : b);

    const [data, setData] = useState<QueueData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        apiClient
            .get<QueueData>("/api/analytics/queue")
            .then(setData)
            .catch((e) => console.error(e))
            .finally(() => setLoading(false));
    }, []);

    if (loading) {
        return (
            <div className="flex justify-center p-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }
    if (!data) return null;

    if (data.total === 0) {
        return (
            <Card>
                <CardContent className="p-8 text-center text-sm text-muted-foreground">
                    {L("还没有错题，先录几道再看这里。", "No questions yet — add a few first.")}
                </CardContent>
            </Card>
        );
    }

    const maxBucket = Math.max(1, ...data.buckets.map((b) => b.count));

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* ── 顶部三个数：这三个是"今天要不要动手"的直接答案 ── */}
            <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">{L("今天该练", "Due today")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-bold tabular-nums">{data.dueToday}</div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {L("还没练过 + 最近错的", "Never practiced + recently missed")}
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">{L("补练（已过期）", "Overdue")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div
                            className="text-3xl font-bold tabular-nums"
                            style={{ color: data.overdue > 0 ? "#dc2626" : undefined }}
                        >
                            {data.overdue}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {L("到期日已经过了还没练", "Past due and not yet reviewed")}
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">{L("已经稳住", "Settled")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-bold tabular-nums">{data.retired}</div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {L(`连对三次以上，不再排进复练（共 ${data.total} 道）`, `Right 3+ times, no longer scheduled (of ${data.total})`)}
                        </p>
                    </CardContent>
                </Card>
            </div>

            {/* ── 图 1：该练的队列 ── */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">{L("该练的队列，按「多久后到期」排", "Review queue by how soon it comes due")}</CardTitle>
                    <CardDescription>
                        {L(
                            "越靠上的越快到期。这条不是奖牌，是「先练哪几道」的顺序。",
                            "Top rows come due soonest. This is the order to practice in, not a score.",
                        )}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {BUCKETS.map((b) => {
                        const row = data.buckets.find((x) => x.urgency === b.urgency);
                        const n = row?.count ?? 0;
                        return (
                            <div key={b.urgency} className="flex items-center gap-3">
                                <span className="w-40 shrink-0 text-xs">
                                    {zh ? b.zh : b.en}
                                    <span className="ml-1 text-muted-foreground">· {zh ? b.hintZh : b.hintEn}</span>
                                </span>
                                <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
                                    <div
                                        className="h-full rounded transition-all"
                                        style={{
                                            width: `${(n / maxBucket) * 100}%`,
                                            background: b.color,
                                            opacity: n === 0 ? 0.15 : 0.85,
                                        }}
                                    />
                                </div>
                                <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums">{n}</span>
                            </div>
                        );
                    })}
                </CardContent>
            </Card>

            {/* ── 图 2：学科 × 卡在哪一步 ── */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">{L("哪一科、卡在哪一步", "Which subject is stuck where")}</CardTitle>
                    <CardDescription>
                        {L(
                            "一格一类题。竖着看能看出「某一科的题都堆在同一个阶段」。",
                            "One cell per group. A column of dark cells means a subject piling up at one stage.",
                        )}
                    </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                        <thead>
                            <tr className="border-b text-xs text-muted-foreground">
                                <th className="py-2 text-left font-medium">{L("学科", "Subject")}</th>
                                <th className="py-2 text-right font-medium">{L("没练过", "Untouched")}</th>
                                <th className="py-2 text-right font-medium">{L("该练了", "Due")}</th>
                                <th className="py-2 text-right font-medium">{L("练习中", "Practicing")}</th>
                                <th className="py-2 text-right font-medium">{L("已掌握", "Mastered")}</th>
                                <th className="py-2 text-right font-medium">{L("合计", "Total")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.subjects.map((s) => {
                                /** 底色：这一格占该科的比例越高越深 —— 一眼看出"卡在哪一档" */
                                const cell = (n: number, color: string) => (
                                    <td
                                        className="py-2 text-right tabular-nums"
                                        style={{
                                            background: n ? `${color}${Math.min(60, 12 + Math.round((n / s.total) * 55)).toString(16).padStart(2, "0")}` : undefined,
                                        }}
                                    >
                                        {n || <span className="text-muted-foreground/40">—</span>}
                                    </td>
                                );
                                return (
                                    <tr key={s.subject} className="border-b last:border-0">
                                        <td className="py-2 font-medium">{s.subject}</td>
                                        {cell(s.fresh, "#94a3b8")}
                                        {cell(s.due, "#f97316")}
                                        {cell(s.practicing, "#3b82f6")}
                                        {cell(s.mastered, "#14b8a6")}
                                        <td className="py-2 text-right font-semibold tabular-nums">{s.total}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </CardContent>
            </Card>

            {/* ── 图 3：未来两周到期 ── */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">{L("未来两周，每天会到期多少", "Coming due over the next two weeks")}</CardTitle>
                    <CardDescription>
                        {L(
                            "间隔是 1/3/7/14/28 天，到期会扎堆。提前看到，就不会某天突然被 40 道砸中。",
                            "Intervals are 1/3/7/14/28 days, so they cluster. Seeing it early avoids a sudden 40-item day.",
                        )}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={data.forecast} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                            <Tooltip
                                formatter={(v: number) => [v, L("到期", "due")]}
                                contentStyle={{ fontSize: 12, borderRadius: 8 }}
                            />
                            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                                {data.forecast.map((d, i) => (
                                    <Cell key={i} fill={d.count > 20 ? "#dc2626" : d.count > 8 ? "#f97316" : "#6366f1"} />
                                ))}
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>
        </div>
    );
}
