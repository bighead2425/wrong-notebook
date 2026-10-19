"use client";

/**
 * 【2026-10-19 空空第 6 条】主页上的「当前任务简要」
 *
 * 他的原话："下面内容，手机端接在下面，电脑端接在右侧，当前任务的简要情况。"
 *
 * ── 三条设计判断 ────────────────────────────────────────────────────
 *  ① **只显示"真有事"的行**：没有任务的类目直接不出现。首页不该有一排
 *     "0 道 / 0 张"——那会让人以为软件坏了，也让真任务被稀释。
 *  ② **一行一件事，点整行进内阁**：这里不做"点一下就去做"的深链
 *     （不同任务的落点差得远：有的进卷、有的进错题详情），
 *     统一跳 `/cabinet` 让他在那边选，比在这里猜更稳。
 *  ③ **数字来自 `/api/cabinet`**，与内阁同一份 —— 不在这里另算一遍，
 *     否则两边会"首页说 5 道、点进去 3 道"。
 *
 * ⚠️ 传 `today` 是给服务端的**每日等级结算**用的（容器跑 UTC，日子只能客户端算）。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { dayKey } from "@/lib/calendar-grid";

interface Task {
    count: number;
    ids: string[];
}

interface CabinetLite {
    tasks: Record<string, Task | undefined>;
}

/** 显示顺序 = 她该做的顺序（"今天先练"永远第一） */
const ROWS: { key: string; zh: string; en: string; strong?: boolean }[] = [
    { key: "practiceToday", zh: "今天该练", en: "Practice today", strong: true },
    { key: "dueReviews", zh: "该复查", en: "Due for review" },
    { key: "pendingRecover", zh: "待回录分析", en: "Waiting to be recovered" },
    { key: "pendingRecoverVolumes", zh: "待回录的卷", en: "Volumes to recover" },
    { key: "pendingDeepPrint", zh: "待打印深挖纸", en: "Deep-dive sheets to print" },
    { key: "unprintedInsights", zh: "待打印积累", en: "Notes to print" },
    { key: "upgradeSuggestions", zh: "建议升深挖", en: "Suggested upgrades" },
];

export function TaskBrief() {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [data, setData] = useState<CabinetLite | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await apiClient.get<CabinetLite>(
                    `/api/cabinet?today=${encodeURIComponent(dayKey(new Date()))}`,
                );
                if (alive) setData(res);
            } catch (e) {
                console.error(e);
                if (alive) setFailed(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    const rows = data ? ROWS.filter((r) => (data.tasks?.[r.key]?.count ?? 0) > 0) : [];

    return (
        <div className="rounded-lg border bg-card">
            <div className="flex items-baseline gap-2 border-b px-3 py-2">
                <span className="text-sm font-medium">{L("当前任务", "Today")}</span>
                {data && <span className="text-[11px] text-muted-foreground">{rows.length} 类</span>}
                <span className="flex-1" />
                <Link href="/cabinet" className="text-[11px] text-muted-foreground hover:text-foreground">
                    {L("内阁", "Cabinet")} ›
                </Link>
            </div>

            <div className="px-3 py-2">
                {!data && !failed && (
                    <div className="flex items-center justify-center py-6 text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                )}
                {failed && (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                        {L("任务读不出来（点内阁看）", "Could not load tasks")}
                    </p>
                )}
                {data && rows.length === 0 && (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                        {L("今天没有待办。想练就练两道。", "Nothing due today.")}
                    </p>
                )}
                {rows.map((r) => {
                    const n = data?.tasks?.[r.key]?.count ?? 0;
                    return (
                        <Link
                            key={r.key}
                            href="/cabinet"
                            className="flex items-center gap-2 rounded px-1 py-2 text-sm transition-colors hover:bg-accent/40"
                        >
                            <span className={r.strong ? "font-medium" : ""}>{L(r.zh, r.en)}</span>
                            <span className={`text-xs ${r.strong ? "font-medium" : "text-muted-foreground"}`}>
                                {n}
                            </span>
                            <span className="flex-1" />
                            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </Link>
                    );
                })}
            </div>
        </div>
    );
}
