"use client";
import { useBackHref, withBack } from "@/lib/back";

/**
 * 日积月累 · **读**（`/insights/read`）—— 2026-10-19 如如建，同日真真按空空的要求扩
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一页，而不是在管理页看：
 *
 * 空空 2026-10-18 说的那句是这一页存在的全部理由 ——
 *   "总归这个东西就是要看上去舒服，读起来得劲，有点原子笔记的感觉，有点干货的感觉。"
 *
 * 管理页（`/insights`）是**"查"的工具**：左边目录、右边编辑框、上面筛选器。
 * 它是为了"找到那一条并改它"而生的，天然不是拿来读的。
 * 这一页是**"读"的书**：单栏、没有编辑框，从上往下翻，一条接一条。
 *
 * ── 2026-10-19 空空改主意了（这一版）────────────────────────────────
 * 他原话："功能都已经写到这了，这样读也确实有一点点干巴巴的，我们不妨把
 *          日积月累·管理的一些功能也拉过来，包括学期、学科、搜索，都拿过来，
 *          然后在每个积累号的右边增加一个选择框……这样在读的页面中，
 *          我们也能筛选读，并且能组积累纸了。"
 * ⇒ 加了三样：**筛选（学期/学科/搜索）· 勾选 · 送入积累纸打印**。
 *   原来文件头写着"不放筛选器/不放复选框"—— 那是如如按"纯读书"的判断，
 *   **空空的判断优先**，那两条已作废（保留这段说明，免得下一个人又"帮他改回去"）。
 *
 * ── 仍然刻意不做的 ──────────────────────────────────────────────────
 *  · **不放编辑框**：一放进来，"读"就变回"整理"了（要改，去管理页）。
 *  · **不按词头分组**：读的是**时间流** —— 她什么时候想明白的，这个顺序本身就是内容。
 *    分组留到打印（那边才需要主/附）。
 *
 * ⚠️ 没有 `useSearchParams` ⇒ 不需要 `<Suspense>` 包裹
 *    （教训：`next build` 会对漏包的页面直接中断，而 tsc/eslint/单测全绿）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, PenLine, Printer, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { SUBJECT_OPTIONS, subjectLabel } from "@/lib/notebook-fields";
import { GRADE_SEMESTER_OPTIONS } from "@/lib/grade-semester-options";

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
    /** 【2026-10-25】返回键：认入口带来的 back，没有才回管理页 */
    const backHref = useBackHref("/insights");
    const L = (a: string, b: string) => (language === "zh" ? a : b);
    const router = useRouter();

    const [rows, setRows] = useState<ReadRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    /* ── 筛选（空空 2026-10-19 要求与管理页对齐）────────────────────── */
    const [grade, setGrade] = useState("");
    /** 单选就够 —— 这一页是"读"，不是"查"；要组合筛选回管理页 */
    const [subject, setSubject] = useState("");
    /** 输入框里的值（防抖之后才变成 `query`，否则每敲一个字就发一次请求） */
    const [queryInput, setQueryInput] = useState("");
    const [query, setQuery] = useState("");

    useEffect(() => {
        const t = setTimeout(() => setQuery(queryInput.trim()), 300);
        return () => clearTimeout(t);
    }, [queryInput]);

    /* ── 勾选（送去排积累纸）────────────────────────────────────────── */
    const [picked, setPicked] = useState<Set<string>>(new Set());

    const togglePick = (id: string) =>
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const load = useCallback(async (next: string | null) => {
        const qs = new URLSearchParams({ limit: String(PAGE) });
        if (grade) qs.set("grade", grade);
        if (subject) qs.set("subjects", subject);
        if (query) qs.set("q", query);
        if (next) qs.set("cursor", next);
        return apiClient.get<ListResponse>(`/api/insights?${qs.toString()}`);
    }, [grade, subject, query]);

    /** 筛选一变就**从头读**（并且清空勾选 —— 被筛掉的条目不该还占着"已勾 N 条"） */
    useEffect(() => {
        let alive = true;
        setLoading(true);
        setPicked(new Set());
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

    const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));

    /**
     * 送去排积累纸。
     * ⚠️ 顺序按**这一页显示的顺序**（她读的时候看到的就是这个），
     *    与 `sendToPrint` 同一条规矩 —— 打印页那边只管排版，不管顺序。
     */
    const sendToPrint = () => {
        if (picked.size === 0) return;
        const ordered = rows.filter((r) => picked.has(r.id)).map((r) => r.id);
        router.push(withBack(`/insights/print?new=${ordered.join(",")}`));
    };

    return (
        <main className="min-h-screen bg-background">
            <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
                <div className="mx-auto flex w-full max-w-[720px] items-center gap-1 px-3 py-2 md:px-6">
                    <Link href={backHref}>
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

                {/* 筛选：学期 / 学科 / 搜索（与管理页同一套参数，只是学科这里单选） */}
                <div className="mx-auto flex w-full max-w-[720px] flex-wrap items-center gap-2 px-3 pb-2 md:px-6">
                    <select
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                        value={grade}
                        onChange={(e) => setGrade(e.target.value)}
                        aria-label={L("年级学期", "Grade and term")}
                    >
                        <option value="">{L("全部学期", "All terms")}</option>
                        {GRADE_SEMESTER_OPTIONS.map((g) => (
                            <option key={g} value={g}>
                                {g}
                            </option>
                        ))}
                    </select>
                    <select
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        aria-label={L("学科", "Subject")}
                    >
                        <option value="">{L("全部学科", "All subjects")}</option>
                        {SUBJECT_OPTIONS.map((s) => (
                            <option key={s.key} value={s.key}>
                                {s.label}
                            </option>
                        ))}
                    </select>
                    <div className="relative min-w-[140px] flex-1">
                        <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                        <Input
                            className="h-8 pl-8 text-xs"
                            placeholder={L("搜编号或内容…", "Search code or text…")}
                            value={queryInput}
                            onChange={(e) => setQueryInput(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            <div className="mx-auto w-full max-w-[720px] px-4 py-6 pb-24 md:px-6">
                {loading && (
                    <p className="py-16 text-center text-sm text-muted-foreground">
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    </p>
                )}

                {!loading && rows.length === 0 && (
                    <div className="py-20 text-center">
                        <p className="text-sm text-muted-foreground">
                            {query || grade || subject
                                ? L("没有符合条件的条目。", "Nothing matches.")
                                : L("还没有记下的东西。", "Nothing written down yet.")}
                        </p>
                        {!query && !grade && !subject && (
                            <Link href="/insights/write" className="mt-3 inline-block">
                                <Button size="sm">
                                    <PenLine className="mr-1.5 h-4 w-4" />
                                    {L("去写第一条", "Write the first one")}
                                </Button>
                            </Link>
                        )}
                    </div>
                )}

                {/**
                 * 条目之间用**蓝色虚线**隔开 —— 与积累纸中间那条同色（`#5b9bd5`）。
                 * 他原话："每条积累之间用也用一个蓝色虚线隔开，就像积累纸中间的虚线一样，
                 *          这样更加干净利索。"
                 */}
                <div>
                    {rows.map((r, i) => (
                        <article
                            key={r.id}
                            className={
                                i === 0
                                    ? "pb-10"
                                    : "mt-10 border-t border-dashed border-[#5b9bd5]/60 pt-10"
                            }
                        >
                            <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                                <span>{dayLabel(r.dateKey)}</span>
                                {r.subject && (
                                    <>
                                        <span>·</span>
                                        <span>{subjectLabel(r.subject)}</span>
                                    </>
                                )}
                                {/* 【2026-10-19 空空】勾选框放在**积累号右边** */}
                                <span className="ml-auto font-mono opacity-60">{r.code}</span>
                                <input
                                    type="checkbox"
                                    className="shrink-0"
                                    checked={picked.has(r.id)}
                                    onChange={() => togglePick(r.id)}
                                    title={L("勾上，之后可以送去排积累纸", "Pick to print later")}
                                />
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

            {/**
             * 【2026-10-19 空空】勾了才出现的底栏：已勾 N 条 / 全选 / 清空 / 送入积累纸打印。
             * ⚠️ 固定在底部而不是塞进顶栏：顶栏在滚动时一直占着，"读书"的页面里
             *    多一行常驻按钮会一直分神；只有她真的开始挑东西了才出来。
             */}
            {picked.size > 0 && (
                <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur">
                    <div className="mx-auto flex w-full max-w-[720px] items-center gap-3 px-4 py-2 text-xs md:px-6">
                        <span className="font-medium">{L(`已勾 ${picked.size} 条`, `${picked.size} picked`)}</span>
                        <button
                            type="button"
                            className="underline text-muted-foreground"
                            onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))}
                        >
                            {allPicked ? L("全不选", "None") : L("全选", "All")}
                        </button>
                        <button
                            type="button"
                            className="underline text-muted-foreground"
                            onClick={() => setPicked(new Set())}
                        >
                            {L("清空", "Clear")}
                        </button>
                        <span className="flex-1" />
                        <Button size="sm" className="h-7" onClick={sendToPrint}>
                            <Printer className="mr-1 h-3.5 w-3.5" />
                            {L("送入积累纸打印", "Send to print")}
                        </Button>
                    </div>
                </div>
            )}
        </main>
    );
}
