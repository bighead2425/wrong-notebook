"use client";

/**
 * 【2026-10-19 空空第 6 条建，2026-10-20 真真按第 3、4 条改】主页上的「当前任务简要」
 *
 * ══════════════════════════════════════════════════════════════════════
 * 空空 2026-10-20 的两条：
 *   · 第 3 条："目前有 6 项任务，但点进去任务台有 7 个卡片，为什么对不上"
 *   · 第 4 条："每一行后面的向右箭头，和卡片上『去XXX』按钮去向要一致起来。
 *              目前点箭头都会进入总理内阁，完全谈不上快速操作"
 *
 * ── 第 3 条的真因 ──────────────────────────────────────────────────
 * 这里原来有一句 `ROWS.filter(count > 0)` —— **计数为 0 的类目直接不出现**，
 * 而任务台的卡片**0 也照样显示**（只是虚线 + 半透明）。
 * 那天"该复查"正好是 0 道 ⇒ 主页 6 行、任务台 7 张卡。不是数据错，是**两边口径不同**。
 * ⇒ 现在**都显示**（0 的行置灰），数量永远对得上。
 *
 * ── 第 4 条的真因 ──────────────────────────────────────────────────
 * 原来每一行都是 `href="/cabinet"` —— 点了只是"到内阁自己再找一遍"。
 * ⇒ 现在用 `taskHref()`，**与卡片上那个「去XXX」按钮同一个答案**（判据在 `lib/cabinet-targets.ts`）。
 *   两处不再各自维护一份，也就不会再脱节。
 *
 * ⚠️ `TASK_ORDER` 是任务的**唯一清单**（顺序、名称都在那儿）——
 *    要加/减一类任务，只改 `lib/cabinet-targets.ts` 一处。
 * ⚠️ 传 `today` 是给服务端的**每日等级结算**用的（容器跑 UTC，日子只能客户端算）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { dayKey } from "@/lib/calendar-grid";
import { TASK_ORDER, taskHref, type CabinetTasks } from "@/lib/cabinet-targets";

interface CabinetLite {
    tasks: CabinetTasks;
}

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

    return (
        <div className="rounded-lg border bg-card">
            <div className="flex items-baseline gap-2 border-b px-3 py-2">
                <span className="text-sm font-medium">{L("当前任务", "Today")}</span>
                {/**
                 * 【2026-10-20 第 3 条】这里显示的是**全部类目数**（= 任务台的卡片数），
                 * 不再是"有事的类目数" —— 两个数字必须是同一个，否则他会再问一次。
                 */}
                {data && <span className="text-[11px] text-muted-foreground">{TASK_ORDER.length} 类</span>}
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
                {data &&
                    TASK_ORDER.map((r) => {
                        const n = data.tasks?.[r.key]?.count ?? 0;
                        const href = data.tasks ? taskHref(r.key, data.tasks) : null;
                        const empty = n === 0;
                        const inner = (
                            <>
                                <span className={`${r.strong && !empty ? "font-medium" : ""} ${empty ? "text-muted-foreground" : ""}`}>
                                    {L(r.zh, r.en)}
                                </span>
                                <span
                                    className={`text-xs ${
                                        empty ? "text-muted-foreground/60" : r.strong ? "font-medium" : "text-muted-foreground"
                                    }`}
                                >
                                    {n}
                                </span>
                                <span className="flex-1" />
                                {/* 没地方可去时不给箭头 —— 给了却不能点，比不给更差 */}
                                {href && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
                            </>
                        );
                        const cls = "flex items-center gap-2 rounded px-1 py-2 text-sm transition-colors";
                        return href ? (
                            <Link key={r.key} href={href} className={`${cls} hover:bg-accent/40`}>
                                {inner}
                            </Link>
                        ) : (
                            <div key={r.key} className={`${cls} opacity-60`} title={L("这一项现在没有要做的事", "Nothing to do here")}>
                                {inner}
                            </div>
                        );
                    })}
                {data && TASK_ORDER.every((r) => (data.tasks?.[r.key]?.count ?? 0) === 0) && (
                    /* 【2026-10-20 美化】空状态给个很淡的勾 —— 否则那一块读起来像"没加载出来" */
                    <div className="flex flex-col items-center gap-1.5 pt-2 text-center">
                        <CheckCircle2 aria-hidden className="h-6 w-6 text-muted-foreground opacity-20" />
                        <p className="text-[11px] text-muted-foreground">
                            {L("今天没有待办。想练就练两道。", "Nothing due today.")}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
