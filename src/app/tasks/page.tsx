"use client";

/**
 * 【2026-10-19 建，2026-10-20 真真按空空第 3 条改】当前任务（`/tasks`）
 *
 * ── 空空 2026-10-20 的原话 ───────────────────────────────────────────
 *   "点击主页下的『当前任务』跳出当前任务界面显示 [一张简单的六行分类清单]，
 *    事实上我需要这个跳出总理内阁的任务台内容显示 [卡片式任务台]。"
 *
 * ⇒ 这一版不再是"简要计数 + 跳内阁"，而是**直接渲染内阁那块任务台**。
 *   两处共用同一个组件（`components/cabinet/task-board.tsx`），
 *   否则"卡片说 12、点进去 9 道"这种不一致迟早出现。
 *
 * ⚠️ 数据自己取一次 `/api/cabinet`（与内阁页同一个接口、同一个 `today` 参数）。
 *    内阁页那边是把同一份数据**传**给组件（它还要用 `overview` 画错题本），
 *    这里只有任务台，自己取更简单，也不会有"传进来的是半份"的风险。
 *
 * ⚠️ 不用 `useSearchParams` ⇒ 不需要 `<Suspense>`
 *    （教训：`next build` 会对漏包的页面直接中断，而 tsc/eslint/单测全绿）。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { TaskBoard, TaskBoardHeading } from "@/components/cabinet/task-board";
import type { CabinetTasks } from "@/lib/cabinet-targets";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { dayKey } from "@/lib/calendar-grid";
import { LayoutDashboard, Loader2 } from "lucide-react";

export default function TasksPage() {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [tasks, setTasks] = useState<CabinetTasks | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        apiClient
            /** `today` 由**客户端**算（时区铁律），与内阁页同一个参数 */
            .get<{ tasks: CabinetTasks }>(`/api/cabinet?today=${encodeURIComponent(dayKey(new Date()))}`)
            .then((d) => {
                if (!cancelled) setTasks(d.tasks);
            })
            .catch((e) => {
                console.error("Failed to load tasks:", e);
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
            <div className="container mx-auto max-w-6xl space-y-4 p-4 pb-20 md:p-8">
                <div className="flex items-center gap-2">
                    <BackButton fallbackUrl="/" className="shrink-0" />
                    <h1 className="text-base font-semibold sm:text-lg">{L("当前任务", "Tasks")}</h1>
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                        {L("今天该做什么，按顺序排好", "What to do today, in order")}
                    </span>
                    <span className="flex-1" />
                    <Link href="/cabinet">
                        <Button variant="outline" size="sm">
                            <LayoutDashboard className="h-4 w-4 sm:mr-1.5" />
                            <span className="hidden sm:inline">{L("内阁", "Cabinet")}</span>
                        </Button>
                    </Link>
                </div>

                <TaskBoardHeading />

                {loading ? (
                    <div className="flex items-center gap-2 p-8 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        {L("正在算…", "Calculating…")}
                    </div>
                ) : error || !tasks ? (
                    <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
                        {L("数据没取到，稍后再试。", "Failed to load. Try again later.")}
                    </div>
                ) : (
                    <TaskBoard tasks={tasks} />
                )}
            </div>
        </main>
    );
}
