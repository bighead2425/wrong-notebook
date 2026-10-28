"use client";

/**
 * 首页的「今天该练什么」摘要 —— **一行结论 + 五根条**。
 *
 * 为什么不直接把 `/stats` 的「该练什么」整页搬过来：那一页有分档柱图、
 * 学科表、到期预测、84 天热力图，四百多行；首页只需要回答一句话
 * ——"今天要不要管，管几道"。所以这里只留最必要的两样。
 *
 * 数据源与整页同一个接口（`/api/analytics/queue`），不新增后端。
 * 文案与配色取自 `lib/queue-summary.ts`，与整页共用一份，避免两处说法分叉。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    QUEUE_LEVELS_META,
    queueHeadline,
    summarizeQueue,
    type QueueLike,
} from "@/lib/queue-summary";

export function ReviewQueueMini() {
    const { language } = useLanguage();
    const zh = language === "zh";
    const [data, setData] = useState<QueueLike | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        apiClient
            .get<QueueLike>("/api/analytics/queue")
            .then((d) => { if (alive) setData(d); })
            /* 拉不到就整块不显示 —— 首页不该因为一个统计接口挂了就报红 */
            .catch(() => { if (alive) setData(null); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, []);

    if (loading) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {zh ? "正在读练习队列…" : "Loading queue…"}
            </div>
        );
    }
    if (!data) return null;

    const s = summarizeQueue(data);
    const max = Math.max(1, ...s.levels.map((l) => l.count));

    return (
        <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-medium">{queueHeadline(s, zh)}</div>
                <Link
                    href="/stats"
                    className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                    {zh ? "看明细" : "Details"}
                    <ArrowRight className="h-3 w-3" />
                </Link>
            </div>

            {/* 五档：条的长度 = 该档数量 / 最满那一档。
                没到期的档也画出来 —— 一眼能看出"后面还有多少要接上"。 */}
            <div className="space-y-1">
                {QUEUE_LEVELS_META.map((meta) => {
                    const count = s.levels.find((l) => l.urgency === meta.urgency)?.count ?? 0;
                    return (
                        <div key={meta.urgency} className="flex items-center gap-2">
                            <span className="w-[92px] shrink-0 truncate text-[11px] text-muted-foreground">
                                {zh ? meta.zh : meta.en}
                            </span>
                            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                <span
                                    className="block h-full rounded-full transition-[width]"
                                    style={{
                                        width: `${(count / max) * 100}%`,
                                        background: meta.color,
                                        /* 0 也要留一条细线，否则那一行看着像"没有这一档" */
                                        minWidth: count > 0 ? undefined : "2px",
                                    }}
                                />
                            </span>
                            <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                                {count}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
