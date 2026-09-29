"use client";

/**
 * 【2026-09-29 新增】**复练卷页**（复练卷管理页）—— 他要的"存在哪、能回头改"的那一页。
 *
 * ── 这一页干什么、不干什么 ────────────────────────────────────────
 *   ✅ 列出**已经生成的卷**，点一份看它的纸面，改留白 / 改题图大小，覆盖保存（更新组卷）、删除、打印。
 *   ❌ **不在这里生成新卷**（他明确说的）：新卷只在打印预览页从"选题 → 生成"产生。
 *      理由也对：卷是"某一批题的凭证"，凭证该在"选完题"的地方签发。
 *
 * ── 右栏为什么是"重新排版"而不是"回放快照" ────────────────────────
 *   快照里存了每道题的页/栏位置，照它回放当然也能画出来。但这一页的用途是**改**
 *   （调留白、调题图大小），改完要能立刻看见新纸面 ⇒ 必须重新量高度、重新分页。
 *   所以：**顺序与初始留白/图大小从快照来，版面现算**；点「更新组卷」再把新版面覆盖回去。
 *   ⚠️ 单测/真机上"打开就少了一题"这类问题，先去核对 `items` 与快照的对应关系（见下面 mergeItems）。
 *
 * ── 题被删了怎么办 ──────────────────────────────────────────────
 *   快照里的 `errorItemId` 是**软链接**：题删了它变空，但卷照常打开。
 *   这种题在预览里显示成一条"原题已删除"的占位，**不静默丢**（他得知道纸上会有个洞）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { House, PanelLeftClose, PanelLeftOpen, Printer, RefreshCw, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { apiClient } from "@/lib/api-client";
import type { ErrorItem, PaginatedResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { whenImagesDecoded, whenImagesSettled } from "@/lib/print-image-readiness";
import { makeQrDataUrl } from "@/lib/qr";
import { ReviewSheet, ReviewQuestionBlock, pageQrPayload } from "@/components/print/review-card";
import {
    blankLinesFromDrag,
    normalizeBlankLines,
    normalizeFigureScale,
    paginateMeasured,
    VOLUME_VARIANTS,
    type MeasuredBlock,
} from "@/lib/review-card";
import { VOLUME_KINDS, VOLUME_KIND_LABEL, VOLUME_KIND_LABEL_EN, type VolumeKind } from "@/lib/volume-code";

/** 卷列表里一条（GET /api/review-volumes 的返回） */
interface VolumeSummary {
    id: string;
    volumeNo: string;
    kind: VolumeKind;
    semester: string;
    gradeSemester?: string | null;
    pageCount: number;
    defaultBlankLines: number;
    createdAt: string;
    itemCount: number;
}

interface VolumeItemRow {
    id: string;
    seqInVolume: number;
    pageIndex: number;
    columnIndex: number;
    seqInColumn: number;
    errorItemId: string | null;
    itemNo: string | null;
    questionText: string | null;
    manageType: string | null;
    blankLines: number;
    figureScale: number;
}

interface VolumeDetail extends VolumeSummary {
    items: VolumeItemRow[];
}

export default function ReviewVolumesPage() {
    const { language } = useLanguage();
    const zh = language === "zh";
    const L = useCallback((a: string, b: string) => (zh ? a : b), [zh]);

    // ---------- 左栏：卷列表 ----------
    const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
    const [listLoading, setListLoading] = useState(true);
    const [listError, setListError] = useState("");
    const [query, setQuery] = useState("");
    const [kindFilter, setKindFilter] = useState<"all" | VolumeKind>("all");
    const [leftHidden, setLeftHidden] = useState(false);

    // ---------- 右栏：选中的那一卷 ----------
    const [selectedId, setSelectedId] = useState<string>("");
    const [detail, setDetail] = useState<VolumeDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [items, setItems] = useState<ErrorItem[]>([]);
    /** 快照里有、但原题已经不在库里的（题被删了）—— 只在预览里占位提示 */
    const [missingItems, setMissingItems] = useState<VolumeItemRow[]>([]);
    const [busy, setBusy] = useState<"" | "saving" | "deleting">("");
    const [notice, setNotice] = useState("");

    // ---------- 屏幕上可调的三个量：留白行数 / 题图大小 / 分页 ----------
    const [blankOverrides, setBlankOverrides] = useState<Record<string, number | null | undefined>>({});
    const [blankDefault, setBlankDefault] = useState<number>(VOLUME_VARIANTS.review.defaultBlankLines);
    const [figureScales, setFigureScales] = useState<Record<string, number | null | undefined>>({});
    const [measuredBlocks, setMeasuredBlocks] = useState<MeasuredBlock[] | null>(null);
    const measureRef = useRef<HTMLDivElement | null>(null);
    const figureDragRef = useRef<{ id: string; startX: number; startPx: number } | null>(null);
    const dividerDragRef = useRef<{ id: string; startY: number; startLines: number } | null>(null);
    const [pageQr, setPageQr] = useState<Record<number, string>>({});
    const [printDate] = useState(() => new Date());

    const kind: VolumeKind = detail?.kind && VOLUME_KINDS.includes(detail.kind) ? detail.kind : "review";

    /**
     * 某道题当前生效的留白行数：**逐题覆盖优先**，没有就用这一卷自己存的默认值
     * （注意不是 `VOLUME_VARIANTS[kind]` 那个全局默认 —— 卷可能是在别处用别的默认值组的）。
     */
    const blankValueOf = useCallback(
        (id: string) => blankOverrides?.[id] ?? blankDefault,
        [blankOverrides, blankDefault],
    );
    const figureScaleOf = useCallback(
        (id: string) => normalizeFigureScale(figureScales?.[id]),
        [figureScales],
    );

    // ================= 拉数据 =================

    const fetchList = useCallback(async () => {
        setListLoading(true);
        setListError("");
        try {
            const res = await apiClient.get<{ volumes: VolumeSummary[] }>("/api/review-volumes?limit=200");
            setVolumes(res.volumes || []);
        } catch (error) {
            console.error("Failed to load volumes:", error);
            setListError(L("加载卷列表失败", "Failed to load volumes"));
        } finally {
            setListLoading(false);
        }
    }, [L]);

    useEffect(() => {
        fetchList();
    }, [fetchList]);

    /**
     * 打开一份卷：① 读快照（顺序 / 留白 / 图大小 / 页数）② 按 id 拉**现库里的题**。
     *
     * ⚠️ 顺序以**快照**为准（那才是当初印出来的顺序），所以拉回来之后要按 seqInVolume 重排；
     *    题没了就把快照那行放进 `missingItems`，预览里占位显示。
     */
    const openVolume = useCallback(
        async (id: string) => {
            setSelectedId(id);
            setDetailLoading(true);
            setNotice("");
            setMeasuredBlocks(null);
            setPageQr({});
            try {
                const { volume } = await apiClient.get<{ volume: VolumeDetail }>(`/api/review-volumes/${id}`);
                setDetail(volume);

                const rows = [...(volume.items || [])].sort((a, b) => a.seqInVolume - b.seqInVolume);
                const ids = rows.map((r) => r.errorItemId).filter((v): v is string => !!v);

                let live: ErrorItem[] = [];
                if (ids.length > 0) {
                    const params = new URLSearchParams();
                    params.set("ids", ids.join(","));
                    params.set("pageSize", String(Math.max(50, ids.length)));
                    const res = await apiClient.get<PaginatedResponse<ErrorItem>>(
                        `/api/error-items/list?${params.toString()}`,
                    );
                    live = res.items || [];
                }
                const byId = new Map(live.map((it) => [it.id, it]));
                const ordered: ErrorItem[] = [];
                const missing: VolumeItemRow[] = [];
                for (const row of rows) {
                    const found = row.errorItemId ? byId.get(row.errorItemId) : undefined;
                    if (found) ordered.push(found);
                    else missing.push(row);
                }

                setItems(ordered);
                setMissingItems(missing);

                // 初始留白 / 图大小：**从快照来**（打开就是当初印出来的样子）
                const blanks: Record<string, number> = {};
                const figures: Record<string, number> = {};
                for (const it of ordered) {
                    const row = rows.find((r) => r.errorItemId === it.id);
                    if (row) {
                        blanks[it.id] = row.blankLines;
                        figures[it.id] = row.figureScale;
                    }
                }
                setBlankDefault(volume.defaultBlankLines);
                setBlankOverrides(blanks);
                setFigureScales(figures);
            } catch (error) {
                console.error("Failed to open volume:", error);
                setNotice(L("打开这份卷失败", "Failed to open this volume"));
                setDetail(null);
            } finally {
                setDetailLoading(false);
            }
        },
        [L],
    );

    // ================= 量高度 → 分页（与打印预览同一套：只量不估） =================

    const reviewItemByKey = useMemo(() => {
        const map: Record<string, ErrorItem> = {};
        for (const it of items) map[it.id] = it;
        return map;
    }, [items]);

    const measureKey = useMemo(
        () =>
            [
                kind,
                items.map((i) => i.id).join("|"),
                JSON.stringify(blankOverrides),
                JSON.stringify(figureScales),
            ].join("#"),
        [kind, items, blankOverrides, figureScales],
    );

    useEffect(() => {
        if (items.length === 0) {
            setMeasuredBlocks([]);
            return;
        }
        let cancelled = false;
        (async () => {
            await whenImagesSettled();
            await whenImagesDecoded(measureRef.current);
            if (cancelled) return;
            const el = measureRef.current;
            if (!el) return;
            const out: MeasuredBlock[] = [];
            el.querySelectorAll<HTMLElement>("[data-review-block]").forEach((node) => {
                const key = node.dataset.reviewBlock;
                if (!key) return;
                out.push({ key, heightMM: (node.getBoundingClientRect().height * 25.4) / 96 });
            });
            if (!cancelled && out.length > 0) setMeasuredBlocks(out);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [measureKey]);

    const reviewLayout = useMemo(() => {
        if (!measuredBlocks) return null;
        return paginateMeasured(measuredBlocks, kind);
    }, [measuredBlocks, kind]);

    /** 页二维码：内容 = 卷号-页码（与打印预览一模一样，扫回来才能定位到页） */
    const qrKey = detail ? `${detail.volumeNo}:${reviewLayout?.pages.length ?? 0}` : "";
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!detail || !reviewLayout) {
                setPageQr({});
                return;
            }
            const entries: Record<number, string> = {};
            await Promise.all(
                reviewLayout.pages.map(async (_page, i) => {
                    try {
                        entries[i + 1] = await makeQrDataUrl(pageQrPayload(detail.volumeNo, i + 1), {
                            width: 120,
                            margin: 1,
                        });
                    } catch {
                        entries[i + 1] = "";
                    }
                }),
            );
            if (!cancelled) setPageQr(entries);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [qrKey]);

    // ================= 拖拽：题图大小 / 题间虚线（留白） =================

    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const fig = figureDragRef.current;
            if (fig) {
                const next = normalizeFigureScale(
                    ((fig.startPx + (e.clientX - fig.startX)) / fig.startPx) * 100,
                );
                setFigureScales((prev) => ({ ...prev, [fig.id]: next }));
                return;
            }
            const div = dividerDragRef.current;
            if (div) {
                const next = blankLinesFromDrag(div.startLines, e.clientY - div.startY, div.startLines);
                if (next === div.startLines) return;
                div.startLines = next;
                div.startY = e.clientY;
                setBlankOverrides((prev) => ({ ...prev, [div.id]: next }));
            }
        };
        const onUp = () => {
            if (!figureDragRef.current && !dividerDragRef.current) return;
            figureDragRef.current = null;
            dividerDragRef.current = null;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
    }, []);

    const handleFigureDown = useCallback(
        (id: string) => (e: React.PointerEvent) => {
            const box = (e.currentTarget as HTMLElement).parentElement;
            figureDragRef.current = { id, startX: e.clientX, startPx: box ? box.getBoundingClientRect().width : 1 };
            document.body.style.cursor = "nwse-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        },
        [],
    );

    const handleDividerDown = useCallback(
        (aboveItemId: string, startLines: number) => (e: React.PointerEvent) => {
            dividerDragRef.current = { id: aboveItemId, startY: e.clientY, startLines };
            document.body.style.cursor = "ns-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        },
        [],
    );

    const onBlankChange = useCallback(
        (id: string, next: number) => {
            setBlankOverrides((prev) => ({
                ...prev,
                [id]: normalizeBlankLines(next, VOLUME_VARIANTS[kind].defaultBlankLines),
            }));
        },
        [kind],
    );

    // ================= 更新组卷 / 删除整卷 =================

    /**
     * 「更新组卷」= 把**当前纸面**覆盖回这一份卷（**卷号不变**）。
     * 条目、页数、留白、题图大小一起写回 —— 与打印预览页那个按钮同一个接口（PATCH）。
     */
    const updateVolume = useCallback(async () => {
        if (!detail || !reviewLayout || items.length === 0) return;
        setBusy("saving");
        setNotice("");
        try {
            const payload = reviewLayout.pages.flatMap((page, pi) =>
                page.columns.flatMap((col, ci) =>
                    col.blocks.map((b, bi) => {
                        const item = reviewItemByKey[b.key];
                        return {
                            errorItemId: item?.id ?? null,
                            seqInVolume: b.seq,
                            pageIndex: pi + 1,
                            columnIndex: ci,
                            seqInColumn: bi + 1,
                            itemNo: item?.source ?? null,
                            questionText: (item?.questionText || item?.ocrText) ?? null,
                            manageType: item?.manageType ?? null,
                            blankLines: blankValueOf(b.key),
                            figureScale: figureScaleOf(b.key),
                        };
                    }),
                ),
            );
            const res = await apiClient.patch<{ volume: VolumeSummary }>(`/api/review-volumes/${detail.id}`, {
                kind,
                gradeSemester: detail.gradeSemester ?? null,
                defaultBlankLines: blankDefault,
                pageCount: reviewLayout.pages.length,
                items: payload,
            });
            setDetail((prev) => (prev ? { ...prev, ...res.volume } : prev));
            setNotice(L("已更新组卷（卷号不变）", "Volume updated (same volume no.)"));
            fetchList();
        } catch (error) {
            console.error("Failed to update volume:", error);
            setNotice(L("更新组卷失败，请重试", "Failed to update the volume"));
        } finally {
            setBusy("");
        }
    }, [detail, reviewLayout, items.length, reviewItemByKey, blankValueOf, figureScaleOf, blankDefault, kind, L, fetchList]);

    /** 「删除组卷」= 连条目一起删（服务端 onDelete: Cascade）。删之前必须确认。 */
    const deleteVolume = useCallback(async () => {
        if (!detail) return;
        const msg = L(
            `删除整卷 ${detail.volumeNo}？（卷内 ${detail.items?.length ?? 0} 道题的排版一起删掉，原题不受影响）`,
            `Delete volume ${detail.volumeNo}? The questions themselves are not affected.`,
        );
        if (!confirm(msg)) return;
        setBusy("deleting");
        setNotice("");
        try {
            await apiClient.delete(`/api/review-volumes/${detail.id}`);
            setDetail(null);
            setItems([]);
            setMissingItems([]);
            setSelectedId("");
            setNotice(L("已删除这一卷", "Volume deleted"));
            fetchList();
        } catch (error) {
            console.error("Failed to delete volume:", error);
            setNotice(L("删除失败，请重试", "Failed to delete"));
        } finally {
            setBusy("");
        }
    }, [detail, L, fetchList]);

    // ================= 过滤后的列表 =================

    const visibleVolumes = useMemo(() => {
        const q = query.trim().toLowerCase();
        return volumes.filter((v) => {
            if (kindFilter !== "all" && v.kind !== kindFilter) return false;
            if (!q) return true;
            return v.volumeNo.toLowerCase().includes(q) || (v.gradeSemester || "").toLowerCase().includes(q);
        });
    }, [volumes, kindFilter, query]);

    const formatTime = (iso: string) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    return (
        <main className="print-preview-shell min-h-screen bg-background">
            {/* ===== 顶栏：左＝返回 + 标题；右＝隐藏左栏 / 打印 / 主页 ===== */}
            <div className="print-preview-topbar no-print flex items-center gap-2 border-b bg-background px-3 py-2">
                <BackButton fallbackUrl="/" className="shrink-0" />
                <h1 className="text-base sm:text-lg font-semibold truncate">{L("复练卷页", "Review volumes")}</h1>
                <span className="text-xs text-muted-foreground hidden sm:inline">
                    {L("已生成的卷都在这里（新卷请到打印预览页组）", "All built volumes live here")}
                </span>
                <span className="flex-1" />
                <Button variant="outline" size="icon" title={L("隐藏 / 显示左栏", "Toggle list")} onClick={() => setLeftHidden((v) => !v)}>
                    {leftHidden ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="icon" title={L("打印这一卷", "Print this volume")} disabled={!reviewLayout} onClick={() => window.print()}>
                    <Printer className="h-4 w-4" />
                </Button>
                <Link href="/">
                    <Button variant="ghost" size="icon" title={L("返回主页", "Home")}>
                        <House className="h-5 w-5" />
                    </Button>
                </Link>
            </div>

            <div className="print-preview-frame">
                {/* ===== 左栏：卷列表 ===== */}
                {!leftHidden && (
                    <aside className="print-preview-left no-print">
                        <div className="space-y-3">
                            <div className="flex items-center gap-2">
                                <div className="relative flex-1">
                                    <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                                    <input
                                        className="w-full rounded-md border bg-background pl-7 pr-2 py-1.5 text-sm"
                                        placeholder={L("搜卷号 / 年级学期", "Search volume no.")}
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                    />
                                </div>
                                <Button variant="ghost" size="icon" title={L("刷新", "Refresh")} onClick={fetchList}>
                                    <RefreshCw className="h-4 w-4" />
                                </Button>
                            </div>

                            {/* 类型筛选：复练 / 积累 / 全部 */}
                            <div className="flex items-center gap-1 bg-muted/50 rounded-md p-0.5 w-fit">
                                {(["all", "review", "build"] as const).map((k) => (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => setKindFilter(k)}
                                        className="px-2 py-0.5 rounded text-xs"
                                        style={{
                                            background: kindFilter === k ? "var(--primary)" : "transparent",
                                            color: kindFilter === k ? "var(--primary-foreground)" : "inherit",
                                        }}
                                    >
                                        {k === "all" ? L("全部", "All") : L(VOLUME_KIND_LABEL[k], VOLUME_KIND_LABEL_EN[k])}
                                    </button>
                                ))}
                            </div>

                            {listLoading && <p className="text-xs text-muted-foreground">{L("加载中…", "Loading…")}</p>}
                            {listError && <p className="text-xs text-red-600">{listError}</p>}
                            {!listLoading && !listError && visibleVolumes.length === 0 && (
                                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
                                    <p>{L("还没有组过卷。", "No volumes yet.")}</p>
                                    <p>
                                        {L(
                                            "去「打印预览页」选好题、点「生成复练卷」，卷号与页二维码才会出现，然后在这里能回头改。",
                                            "Open the print preview page, pick questions and press Build volume.",
                                        )}
                                    </p>
                                </div>
                            )}

                            <div className="space-y-1">
                                {visibleVolumes.map((v) => {
                                    const active = v.id === selectedId;
                                    return (
                                        <button
                                            key={v.id}
                                            type="button"
                                            onClick={() => openVolume(v.id)}
                                            className="w-full text-left rounded-md border px-2 py-1.5 transition-colors"
                                            style={{
                                                borderColor: active ? "var(--primary)" : "var(--border)",
                                                background: active ? "var(--accent)" : "transparent",
                                            }}
                                        >
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold whitespace-nowrap">{v.volumeNo}</span>
                                                <span className="text-[10px] px-1 rounded border whitespace-nowrap">
                                                    {L(VOLUME_KIND_LABEL[v.kind], VOLUME_KIND_LABEL_EN[v.kind])}
                                                </span>
                                            </div>
                                            <div className="text-[11px] text-muted-foreground">
                                                {v.itemCount} {L("题", "q")} · {v.pageCount} {L("页", "p")}
                                                {v.gradeSemester ? ` · ${v.gradeSemester}` : ""}
                                            </div>
                                            <div className="text-[11px] text-muted-foreground">{formatTime(v.createdAt)}</div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </aside>
                )}

                {/* ===== 右栏：选中卷的纸面 ===== */}
                <div className="print-preview-right">
                    {!selectedId && (
                        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground no-print">
                            {L("左边点一份卷，这里就能看到它的纸面。", "Pick a volume on the left.")}
                        </div>
                    )}

                    {selectedId && (
                        <div className="mb-3 flex flex-wrap items-center gap-2 no-print">
                            <Button size="sm" onClick={updateVolume} disabled={busy === "saving" || !reviewLayout}>
                                {busy === "saving" ? L("保存中…", "Saving…") : L("更新组卷", "Update volume")}
                            </Button>
                            <Button size="sm" variant="destructive" onClick={deleteVolume} disabled={busy === "deleting"}>
                                <Trash2 className="mr-1.5 h-4 w-4" />
                                {busy === "deleting" ? L("删除中…", "Deleting…") : L("删除组卷", "Delete volume")}
                            </Button>
                            {detail && (
                                <span className="text-xs sm:text-sm">
                                    {L("卷号", "No.")} <b>{detail.volumeNo}</b>
                                    {" · "}
                                    {L("共", "total")} {reviewLayout?.pages.length ?? detail.pageCount} {L("页", "pages")}
                                </span>
                            )}
                            <span className="text-xs text-muted-foreground">
                                {L(
                                    "改留白 / 题图大小后点「更新组卷」覆盖保存（卷号不变）",
                                    "Adjust spacing or figure size, then Update volume.",
                                )}
                            </span>
                            {notice && <span className="text-xs text-emerald-700">{notice}</span>}
                        </div>
                    )}

                    {detailLoading && <p className="text-sm text-muted-foreground no-print">{L("载入中…", "Loading…")}</p>}

                    {/* 题被删掉的占位提示：不静默丢，他得知道纸上会有个洞 */}
                    {!detailLoading && missingItems.length > 0 && (
                        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900 no-print">
                            {L(
                                `这份卷里有 ${missingItems.length} 道题的原题已经不在库里了（${missingItems
                                    .map((m) => m.itemNo || `#${m.seqInVolume}`)
                                    .join("、")}）—— 纸上会少这几道。`,
                                `${missingItems.length} question(s) in this volume no longer exist.`,
                            )}
                        </div>
                    )}

                    {/* 隐藏量尺：与正式版面**同宽同内容**，量到的才是印出来的 */}
                    {items.length > 0 && (
                        <div
                            ref={measureRef}
                            aria-hidden="true"
                            className="print-review-measure no-print"
                            style={{ width: `${VOLUME_VARIANTS[kind].columnWidthMM}mm` }}
                        >
                            {items.map((item, i) => (
                                <ReviewQuestionBlock
                                    key={item.id}
                                    item={item}
                                    seq={i + 1}
                                    blankLines={blankValueOf(item.id)}
                                    showDivider={false}
                                    figureScale={figureScaleOf(item.id)}
                                    L={L}
                                />
                            ))}
                        </div>
                    )}

                    {reviewLayout?.overflow && reviewLayout.overflow.length > 0 && (
                        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900 no-print">
                            {L(
                                `有 ${reviewLayout.overflow.length} 道题一栏都装不下（太长）—— 建议改用「深挖纸」。`,
                                `${reviewLayout.overflow.length} question(s) too long for one column.`,
                            )}
                        </div>
                    )}

                    {reviewLayout?.pages.map((page, i) => (
                        <ReviewSheet
                            key={i}
                            page={page}
                            pageNo={i + 1}
                            pageCount={reviewLayout.pages.length}
                            volumeNo={detail?.volumeNo ?? ""}
                            kind={kind}
                            gradeText={detail?.gradeSemester ?? undefined}
                            printDate={printDate}
                            pageQr={pageQr[i + 1]}
                            itemByKey={reviewItemByKey}
                            blankValueOf={blankValueOf}
                            onBlankChange={onBlankChange}
                            figureScaleOf={figureScaleOf}
                            onFigureScaleStart={handleFigureDown}
                            onDividerDragStart={handleDividerDown}
                            L={L}
                        />
                    ))}
                </div>
            </div>
        </main>
    );
}
