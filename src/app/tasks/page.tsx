"use client";

/**
 * 【2026-10-19】当前任务（`/tasks`）—— 从「总理内阁」拆出来的**任务那一半**。
 *
 * 空空的原话："按照我的设计，总理内阁就被拆分了，不存在了。"
 * ⇒ 主页的「当前任务」指向这里。
 *
 * ⚠️ **这一版是"简要"，不是"明细"**：
 *    他把「当前任务」定义成"总理内阁中所有任务的明细内容"，那份明细（每类任务下面
 *    逐条列出题号、能一键跳过去做）还长在 `/cabinet` 的任务台里，没搬过来。
 *    ⇒ 这里先给**分类计数 + 跳内阁**，够用；真要看逐条明细，点右上角「内阁」。
 *    **下一棒别把这个当成做完了**——明细还没拆。
 *
 * 图表的另一半已经拆到 `/stats`（那一页本来就有，直接复用）。
 */

import Link from "next/link";
import { BackButton } from "@/components/ui/back-button";
import { TaskBrief } from "@/components/home/task-brief";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { LayoutDashboard } from "lucide-react";

export default function TasksPage() {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    return (
        <main className="min-h-screen bg-background">
            <div className="container mx-auto max-w-3xl space-y-4 p-4 pb-20">
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
                            <span className="hidden sm:inline">{L("逐条明细", "Details")}</span>
                        </Button>
                    </Link>
                </div>

                <TaskBrief />

                <p className="pt-2 text-center text-[11px] text-muted-foreground">
                    {L(
                        "这里先给分类与数量；每类下面逐条列题号的「明细」还在内阁页里（拆分中）。",
                        "Counts first — the per-item detail list is still inside the cabinet page.",
                    )}
                </p>
            </div>
        </main>
    );
}
