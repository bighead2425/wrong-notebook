"use client";

/**
 * 日积月累 · **读**（`/insights/read`）—— 2026-10-19 如如
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一页，而不是在管理页看：
 *
 * 空空 2026-10-18 说的那句是这一页存在的全部理由 ——
 *   "总归这个东西就是要看上去舒服，读起来得劲，有点原子笔记的感觉，有点干货的感觉。"
 *
 * 管理页（`/insights`）是**"查"的工具**：左边目录、右边编辑框、上面筛选器。
 * 它是为了"找到那一条并改它"而生的，天然不是拿来读的。
 * 这一页是**"读"的书**：单栏、没有按钮、没有筛选器，从上往下翻，
 * 一条接一条 —— 同一批数据，两个视角。
 *
 * ── 三条刻意不做的事 ────────────────────────────────────────────────
 *  ① **不放筛选器**：翻书的时候不会去勾"只看数学"。要筛，回管理页。
 *  ② **不放复选框/编辑框**：一放进来，"读"就变回"整理"了。
 *  ③ **不按词头分组**（第一版）：读的是**时间流** —— 她什么时候想明白的，
 *     这个顺序本身就是内容。分组留到打印（那边才需要主/附）。
 *
 * ⚠️ 没有 `useSearchParams` ⇒ 不需要 `<Suspense>` 包裹
 *    （教训：`next build` 会对漏包的页面直接中断，而 tsc/eslint/单测全绿）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { subjectLabel } from "@/lib/notebook-fields";

interface ReadRow {
    id: string;
    code: string;
    /** `YYYY-MM-DD`（客户端算的本地日期） */
    dateKey: string;
    content: string | null;
    subject: string | null;
}

interface ListResponse {
    insights: ReadRow[];
    nextCursor?: string | null;
}

/** 一次读多少条。比管理页少（管理页 50 是为了"滚一屏就找到"，这里是慢读） */
const PAGE = 20;

export default function InsightReadPage() {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [rows, setRows] = useState<ReadRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async (next: string | null) => {
        const qs = new URLSearchParams({ limit: String(PAGE) });
        if (next) qs.set("cursor", next);
        const res = await apiClient.get<ListResponse>(`/api/insights?${qs.toString()}`);
        return res;
    }, []);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await load(null);
                if (!alive) return;
                setRows(res.insights || []);
                setCursor(res.nextCursor ?? null);
            } catch (e) {
                console.error(e);
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [load]);

    /** 滚到底自动接着往下读（没有"加载更多"按钮 —— 读书不该点按钮） */
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el || !cursor || loadingMore) return;
        const io = new IntersectionObserver(
            (entries) => {
                if (!entries.some((e) => e.isIntersecting)) return;
                setLoadingMore(true);
                void (async () => {
                    try {
                        const res = await load(cursor);
                        setRows((prev) => {
                            const seen = new Set(prev.map((r) => r.id));
                            return [...prev, ...(res.insights || []).filter((r) => !seen.has(r.id))];
                        });
                        setCursor(res.nextCursor ?? null);
                    } catch (e) {
                        console.error(e);
                    } finally {
                        setLoadingMore(false);
                    }
                })();
            },
            { rootMargin: "400px" },
        );
        io.observe(el);
        return () => io.disconnect();
    }, [cursor, loadingMore, load]);

    /** `2026-10-18` → `10月18日`（中文）/ 原样（英文） */
    const dayLabel = (d: string) => {
        const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return d;
        if (language !== "zh") return d;
        return `${Number(m[2])}月${Number(m[3])}日`;
    };

    return (
        <main className="min-h-screen bg-background">
            <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
                <div className="mx-auto flex w-full max-w-[720px] items-center gap-1 px-3 py-2 md:px-6">
                    <Link href="/insights">
                        <Button variant="ghost" size="icon" title={L("回管理页", "Back to manage")}>
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                    </Link>
                    <h1 className="text-sm font-medium">{L("日积月累", "Notes")}</h1>
                    <span className="flex-1" />
                    <Link href="/insights/write">
                        <Button variant="ghost" size="sm" title={L("写一条", "Write")}>
                            <PenLine className="h-4 w-4 sm:mr-1.5" />
                            <span className="hidden sm:inline">{L("写一条", "Write")}</span>
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="mx-auto w-full max-w-[720px] px-4 py-6 md:px-6">
                {loading && (
                    <p className="py-16 text-center text-sm text-muted-foreground">
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    </p>
                )}

                {!loading && rows.length === 0 && (
                    <div className="py-20 text-center">
                        <p className="text-sm text-muted-foreground">
                            {L("还没有记下的东西。", "Nothing written down yet.")}
                        </p>
                        <Link href="/insights/write" className="mt-3 inline-block">
                            <Button size="sm">
                                <PenLine className="mr-1.5 h-4 w-4" />
                                {L("去写第一条", "Write the first one")}
                            </Button>
                        </Link>
                    </div>
                )}

                <div className="space-y-10">
                    {rows.map((r) => (
                        <article key={r.id}>
                            <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                                <span>{dayLabel(r.dateKey)}</span>
                                {r.subject && (
                                    <>
                                        <span>·</span>
                                        <span>{subjectLabel(r.subject)}</span>
                                    </>
                                )}
                                <span className="ml-auto font-mono opacity-60">{r.code}</span>
                            </div>

                            {/**
                             * 正文直接交给渲染器：`#### 词头` 会渲染成小标题、
                             * `> *AI: …*` 会渲染成浅灰竖线的引用块 ——
                             * 这一页**不额外造样式**，与纸上、与管理页是同一个观感。
                             */}
                            {r.content ? (
                                <MarkdownRenderer content={r.content} />
                            ) : (
                                <p className="text-sm text-muted-foreground">{L("（没有正文）", "(empty)")}</p>
                            )}
                        </article>
                    ))}
                </div>

                {cursor && (
                    <div ref={sentinelRef} className="py-10 text-center text-xs text-muted-foreground">
                        {loadingMore ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : null}
                    </div>
                )}

                {!loading && !cursor && rows.length > 0 && (
                    <p className="py-10 text-center text-xs text-muted-foreground">
                        {L("—— 到这儿了 ——", "— the end —")}
                    </p>
                )}
            </div>
        </main>
    );
}
