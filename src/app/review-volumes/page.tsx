"use client";

/**
 * 【2026-09-29 新增 / 2026-09-30 大改】**复练卷页**（复练卷管理页）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一页干什么、不干什么
 *   ✅ 列出**已经生成的卷**，点一份看它的纸面，改留白 / 改题图大小，覆盖保存、改名、删除、打印。
 *   ❌ **不在这里生成新卷**：新卷只在打印预览页"选题 → 生成"（凭证该在选完题的地方签发）。
 *
 * ── 与打印预览页最大的不同：**页内锁定**（他 2026-09-30 定的规矩）──────────
 *   打印预览页：还没定稿 ⇒ 调留白/图大小会**重新分页**，题可能在页间挪动（正常）。
 *   复练卷页：卷已经印出去了 ⇒ **页归属只认快照**，调留白/图大小只改**页内**高度。
 *   理由（他的原话）：手机扫这一页的二维码，跳出来的是**这一页**的内容；
 *   题在页之间窜来窜去，扫码就对不上了。
 *   ⇒ 这一页用 `layoutFromSnapshot()`（不重量、不重排），而不是 `paginateMeasured()`。
 *   ⇒ 代价：一页可能被撑爆（纸高是死的），所以下面有个**安全阀**：
 *      量出每页用量，超了就点名叫页、并挡住「更新组卷」。
 *
 * ── 题被删了怎么办（他定的）────────────────────────────────────
 *   就地留"题号 + 此题已无"占位（上下虚线），后面的题往前排，页尾空出来就空着。
 *   **不重排整页**，也不把这道题从页里抹掉 —— 页号与扫码的对应关系不能乱。
 * ══════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Check,
    House,
    PanelLeftClose,
    PanelLeftOpen,
    Pencil,
    Printer,
    RefreshCw,
    Search,
    Trash2,
} from "lucide-react";
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
    VOLUME_VARIANTS,
    blankLinesFromDrag,
    layoutFromSnapshot,
    normalizeBlankLines,
    normalizeFigureScale,
    pageFits,
    pageUsageMM,
    type SnapshotRow,
} from "@/lib/review-card";
import { VOLUME_KINDS, VOLUME_KIND_LABEL, VOLUME_KIND_LABEL_EN, type VolumeKind } from "@/lib/volume-code";

/** 卷列表里一条（GET /api/review-volumes 的返回） */
interface VolumeSummary {
    id: string;
    volumeNo: string;
    title?: string | null;
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

/** 题已不在库里时，用快照行自己的 id 当 key（它必须稳定、且与真题 id 不冲突） */
const missingKeyOf = (rowId: string) => `missing:${rowId}`;

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
    /** 【2026-09-30 他拍的板】按学期筛 —— 数据里本来就存了学期标签，加个下拉就行 */
    const [semesterFilter, setSemesterFilter] = useState<string>("all");
    const [leftHidden, setLeftHidden] = useState(false);

    // ---------- 右栏：选中的那一卷 ----------
    const [selectedId, setSelectedId] = useState<string>("");
    const [detail, setDetail] = useState<VolumeDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    /** 还在库里的题（渲染用） */
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [busy, setBusy] = useState<"" | "saving" | "deleting" | "renaming">("");
    const [notice, setNotice] = useState("");
    /** 卷名（可改，只存库里、不上纸） */
    const [titleDraft, setTitleDraft] = useState("");
    const [editingTitle, setEditingTitle] = useState(false);

    // ---------- 屏幕上可调的两个量 + 安全阀用的实测高度 ----------
    const [blankOverrides, setBlankOverrides] = useState<Record<string, number | null | undefined>>({});
    const [blankDefault, setBlankDefault] = useState<number>(VOLUME_VARIANTS.review.defaultBlankLines);
    const [figureScales, setFigureScales] = useState<Record<string, number | null | undefined>>({});
    const [measuredByKey, setMeasuredByKey] = useState<Record<string, number>>({});
    const measureRef = useRef<HTMLDivElement | null>(null);
    const figureDragRef = useRef<{ id: string; startX: number; startPx: number } | null>(null);
    const dividerDragRef = useRef<{ id: string; startY: number; startLines: number } | null>(null);
    const [pageQr, setPageQr] = useState<Record<number, string>>({});
    const [printDate] = useState(() => new Date());

    const kind: VolumeKind = detail?.kind && VOLUME_KINDS.includes(detail.kind) ? detail.kind : "review";

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
     * 打开一份卷：读快照（页归属 / 顺序 / 留白 / 图大小）+ 按 id 拉现库里的题。
     * 顺序、页归属**一律以快照为准**（那才是当初印出来的样子）。
     */
    const openVolume = useCallback(
        async (id: string) => {
            setSelectedId(id);
            setDetailLoading(true);
            setNotice("");
            setPageQr({});
            setEditingTitle(false);
            try {
                const { volume } = await apiClient.get<{ volume: VolumeDetail }>(`/api/review-volumes/${id}`);
                setDetail(volume);
                setTitleDraft(volume.title || "");

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
                setItems(live);

                // 初始留白 / 图大小：从快照来（打开就是当初印出来的样子）
                const blanks: Record<string, number> = {};
                const figures: Record<string, number> = {};
                for (const row of rows) {
                    const key = row.errorItemId ?? missingKeyOf(row.id);
                    blanks[key] = row.blankLines;
                    figures[key] = row.figureScale;
                }
                setBlankDefault(volume.defaultBlankLines);
                setBlankOverrides(blanks);
                setFigureScales(figures);
                setMeasuredByKey({});
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

    /** 快照行 → 版面行（key：有题用题 id，没题用快照行自己的 id） */
    const snapshotRows = useMemo<SnapshotRow[]>(() => {
        if (!detail) return [];
        return [...(detail.items || [])]
            .sort((a, b) => a.seqInVolume - b.seqInVolume)
            .map((r) => ({
                key: r.errorItemId ?? missingKeyOf(r.id),
                seq: r.seqInVolume,
                pageIndex: r.pageIndex,
                columnIndex: r.columnIndex,
                seqInColumn: r.seqInColumn,
            }));
    }, [detail]);

    /** 快照行按 key 取用（更新组卷时要拿原题号/题干一起回写，占位行不能被丢掉） */
    const rowByKey = useMemo(() => {
        const map: Record<string, VolumeItemRow> = {};
        for (const r of detail?.items || []) map[r.errorItemId ?? missingKeyOf(r.id)] = r;
        return map;
    }, [detail]);

    /** 原题已被删的：key → 题号（`ReviewSheet` 靠它画"此题已无"占位） */
    const missingMap = useMemo(() => {
        const map: Record<string, string | null> = {};
        for (const r of detail?.items || []) {
            if (!r.errorItemId) map[missingKeyOf(r.id)] = r.itemNo;
        }
        return map;
    }, [detail]);

    /** ★ 页内锁定：页归属只认快照（不重量、不重排） */
    const layout = useMemo(() => {
        if (!detail) return null;
        return layoutFromSnapshot(snapshotRows, kind);
    }, [detail, snapshotRows, kind]);

    const reviewItemByKey = useMemo(() => {
        const map: Record<string, ErrorItem> = {};
        for (const it of items) map[it.id] = it;
        return map;
    }, [items]);

    // ================= 量高度（只为"这一页被撑爆了没有"这个安全阀） =================

    const measureKey = useMemo(
        () =>
            [items.map((i) => i.id).join("|"), JSON.stringify(blankOverrides), JSON.stringify(figureScales)].join("#"),
        [items, blankOverrides, figureScales],
    );

    useEffect(() => {
        if (items.length === 0) {
            setMeasuredByKey({});
            return;
        }
        let cancelled = false;
        (async () => {
            await whenImagesSettled();
            await whenImagesDecoded(measureRef.current);
            if (cancelled) return;
            const el = measureRef.current;
            if (!el) return;
            const out: Record<string, number> = {};
            el.querySelectorAll<HTMLElement>("[data-review-block]").forEach((node) => {
                const key = node.dataset.reviewBlock;
                if (!key) return;
                out[key] = (node.getBoundingClientRect().height * 25.4) / 96;
            });
            if (!cancelled) setMeasuredByKey(out);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [measureKey]);

    /**
     * 安全阀：**页内锁定**之后，放大留白/题图不再自动分页 ⇒ 得自己盯着"别把一页撑爆"。
     * 用与 `paginateMeasured` 同一口径的 `pageUsageMM` 算每页用量，超了就把页号点出来。
     */
    const overfullPages = useMemo(() => {
        if (!layout) return [] as number[];
        // 还没量到高度时先不判（否则每页用量都是 0，看着像没问题；量完自然出结果）
        if (Object.keys(measuredByKey).length === 0) return [] as number[];
        const out: number[] = [];
        layout.pages.forEach((page, i) => {
            const keys = page.columns.flatMap((c) => c.blocks.map((b) => b.key)).filter((k) => k in measuredByKey);
            if (keys.length === 0) return;
            const used = pageUsageMM(keys, (k) => measuredByKey[k] ?? 0);
            if (!pageFits(used)) out.push(i + 1);
        });
        return out;
    }, [layout, measuredByKey]);

    /** 页二维码：内容 = 卷号-页码（与打印预览页一模一样，扫回来才能定位到页） */
    const qrKey = detail ? `${detail.volumeNo}:${layout?.pages.length ?? 0}` : "";
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!detail || !layout) {
                setPageQr({});
                return;
            }
            const entries: Record<number, string> = {};
            await Promise.all(
                layout.pages.map(async (_page, i) => {
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
                const next = normalizeFigureScale(((fig.startPx + (e.clientX - fig.startX)) / fig.startPx) * 100);
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

    // ================= 更新组卷 / 改名 / 删除 =================

    /**
     * 「更新组卷」= 把**当前纸面**覆盖回这一份卷（**卷号、页归属都不变**）。
     * ⚠️ 占位行（原题已删）也要原样回写：不然这次保存会把"此题已无"那格从卷里抹掉。
     */
    const updateVolume = useCallback(async () => {
        if (!detail || !layout || overfullPages.length > 0) return;
        setBusy("saving");
        setNotice("");
        try {
            const payload = layout.pages.flatMap((page, pi) =>
                page.columns.flatMap((col, ci) =>
                    col.blocks.map((b, bi) => {
                        const item = reviewItemByKey[b.key];
                        const row = rowByKey[b.key];
                        return {
                            errorItemId: item?.id ?? null,
                            seqInVolume: b.seq,
                            pageIndex: pi + 1,
                            columnIndex: ci,
                            seqInColumn: bi + 1,
                            itemNo: item?.source ?? row?.itemNo ?? null,
                            questionText: (item?.questionText || item?.ocrText || row?.questionText) ?? null,
                            manageType: item?.manageType ?? row?.manageType ?? null,
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
                pageCount: layout.pages.length,
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
    }, [
        detail,
        layout,
        overfullPages.length,
        reviewItemByKey,
        rowByKey,
        blankValueOf,
        figureScaleOf,
        blankDefault,
        kind,
        L,
        fetchList,
    ]);

    /** 改名（只存库里、不上纸）：走 PATCH 的"只带 title"那条路 */
    const saveTitle = useCallback(async () => {
        if (!detail) return;
        setBusy("renaming");
        setNotice("");
        try {
            const res = await apiClient.patch<{ volume: VolumeSummary }>(`/api/review-volumes/${detail.id}`, {
                title: titleDraft,
            });
            setDetail((prev) => (prev ? { ...prev, ...res.volume } : prev));
            setEditingTitle(false);
            setNotice(L("名字已保存（只在软件里，不印到纸上）", "Name saved (software only)"));
            fetchList();
        } catch (error) {
            console.error("Failed to rename volume:", error);
            setNotice(L("改名失败，请重试", "Failed to rename"));
        } finally {
            setBusy("");
        }
    }, [detail, titleDraft, L, fetchList]);

    /** 删除整卷（连条目一起删，服务端 Cascade）。删之前必须确认。 */
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

    // ================= 左栏：搜索 / 类型 / 学期 =================

    /** 学期下拉的选项：从已有卷里现取（不硬编码"2026-秋"这种） */
    const semesters = useMemo(
        () => [...new Set(volumes.map((v) => v.semester).filter(Boolean))].sort().reverse(),
        [volumes],
    );

    const visibleVolumes = useMemo(() => {
        const q = query.trim().toLowerCase();
        return volumes.filter((v) => {
            if (kindFilter !== "all" && v.kind !== kindFilter) return false;
            if (semesterFilter !== "all" && v.semester !== semesterFilter) return false;
            if (!q) return true;
            return (
                v.volumeNo.toLowerCase().includes(q) ||
                (v.title || "").toLowerCase().includes(q) ||
                (v.gradeSemester || "").toLowerCase().includes(q)
            );
        });
    }, [volumes, kindFilter, semesterFilter, query]);

    const formatTime = (iso: string) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    const pageCount = layout?.pages.length ?? 0;

    return (
        <div className="print-preview-shell">
            {/* ===== 顶栏：左＝返回 + 标题；右＝隐藏左栏 / 打印 / 主页 ===== */}
            <div className="no-print flex items-center gap-2 border-b bg-background px-3 py-2">
                <BackButton fallbackUrl="/" className="shrink-0" />
                <h1 className="text-base sm:text-lg font-semibold truncate">{L("复练卷页", "Review volumes")}</h1>
                <span className="text-xs text-muted-foreground hidden lg:inline">
                    {L("已生成的卷都在这里（新卷请到打印预览页组）", "All built volumes live here")}
                </span>
                <span className="flex-1" />
                <Button
                    variant="outline"
                    size="icon"
                    title={L("隐藏 / 显示左栏", "Toggle list")}
                    onClick={() => setLeftHidden((v) => !v)}
                >
                    {leftHidden ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
                <Button
                    variant="outline"
                    size="icon"
                    title={L("打印这一卷", "Print this volume")}
                    disabled={!layout}
                    onClick={() => window.print()}
                >
                    <Printer className="h-4 w-4" />
                </Button>
                <Link href="/">
                    <Button variant="ghost" size="icon" title={L("返回主页", "Home")}>
                        <House className="h-5 w-5" />
                    </Button>
                </Link>
            </div>

            {/* 两栏作为整体居中、不顶到浏览器两侧 —— 与打印预览页同一个口径（他 2026-09-30 提的） */}
            <div
                className="print-preview-body flex-1 min-h-0"
                style={{ "--left-w": "380px" } as React.CSSProperties}
            >
                <div className="print-preview-frame mx-auto w-full max-w-[1600px] px-4 md:px-8">
                    {/* ===== 左栏：卷列表 ===== */}
                    {!leftHidden && (
                        <aside className="print-preview-left no-print">
                            <div className="space-y-3">
                                <div className="flex items-center gap-2">
                                    <div className="relative flex-1">
                                        <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                                        <input
                                            className="w-full rounded-md border bg-background pl-7 pr-2 py-1.5 text-sm"
                                            placeholder={L("搜卷号 / 名字 / 年级学期", "Search no. or name")}
                                            value={query}
                                            onChange={(e) => setQuery(e.target.value)}
                                        />
                                    </div>
                                    <Button variant="ghost" size="icon" title={L("刷新", "Refresh")} onClick={fetchList}>
                                        <RefreshCw className="h-4 w-4" />
                                    </Button>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
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
                                                {k === "all"
                                                    ? L("全部", "All")
                                                    : L(VOLUME_KIND_LABEL[k], VOLUME_KIND_LABEL_EN[k])}
                                            </button>
                                        ))}
                                    </div>
                                    {/* 学期筛选（他 2026-09-30 拍板要的） */}
                                    <select
                                        className="rounded-md border bg-background px-2 py-1 text-xs"
                                        value={semesterFilter}
                                        onChange={(e) => setSemesterFilter(e.target.value)}
                                        title={L("按学期筛", "Filter by term")}
                                    >
                                        <option value="all">{L("全部学期", "All terms")}</option>
                                        {semesters.map((s) => (
                                            <option key={s} value={s}>
                                                {s}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {listLoading && (
                                    <p className="text-xs text-muted-foreground">{L("加载中…", "Loading…")}</p>
                                )}
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
                                                {/* 有名字就把名字摆前面（名字是给人认卷用的），卷号退成副标题 */}
                                                {v.title ? (
                                                    <>
                                                        <div className="text-sm font-semibold truncate">{v.title}</div>
                                                        <div className="text-[11px] text-muted-foreground truncate">
                                                            {v.volumeNo} · {v.itemCount} {L("题", "q")} · {v.pageCount}{" "}
                                                            {L("页", "p")}
                                                        </div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-sm font-semibold whitespace-nowrap">
                                                                {v.volumeNo}
                                                            </span>
                                                            <span className="text-[10px] px-1 rounded border whitespace-nowrap">
                                                                {L(
                                                                    VOLUME_KIND_LABEL[v.kind],
                                                                    VOLUME_KIND_LABEL_EN[v.kind],
                                                                )}
                                                            </span>
                                                        </div>
                                                        <div className="text-[11px] text-muted-foreground">
                                                            {v.itemCount} {L("题", "q")} · {v.pageCount} {L("页", "p")}
                                                        </div>
                                                    </>
                                                )}
                                                <div className="text-[11px] text-muted-foreground">
                                                    {v.semester}
                                                    {v.gradeSemester ? ` · ${v.gradeSemester}` : ""}
                                                </div>
                                                <div className="text-[11px] text-muted-foreground">
                                                    {formatTime(v.createdAt)}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </aside>
                    )}

                    {/* ===== 右栏：选中卷的纸面 ===== */}
                    <main className="print-preview-right">
                        {/* ⚠️ 这两层不能少：`mx-auto max-w-6xl px-4` 负责"不顶边、别太宽"，
                            `print-sheet` 负责把纸定成 **152mm 宽**（纸边靠它撑出来）。
                            少了这层，纸会被拉成整个右栏那么宽 —— 他看到的"横向、不是 B5"就是这个。 */}
                        <div className="mx-auto max-w-6xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
                            <div className="print-sheet">
                                {!selectedId && (
                                    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground no-print">
                                        {L("左边点一份卷，这里就能看到它的纸面。", "Pick a volume on the left.")}
                                    </div>
                                )}

                                {selectedId && (
                                    <div className="mb-3 flex flex-wrap items-center gap-2 no-print">
                                        <Button
                                            size="sm"
                                            onClick={updateVolume}
                                            disabled={busy === "saving" || !layout || overfullPages.length > 0}
                                            title={
                                                overfullPages.length > 0
                                                    ? L("有页面装不下了，先把那几页调小", "Some page is overfull")
                                                    : undefined
                                            }
                                        >
                                            {busy === "saving"
                                                ? L("保存中…", "Saving…")
                                                : L("更新组卷", "Update volume")}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="destructive"
                                            onClick={deleteVolume}
                                            disabled={busy === "deleting"}
                                        >
                                            <Trash2 className="mr-1.5 h-4 w-4" />
                                            {busy === "deleting"
                                                ? L("删除中…", "Deleting…")
                                                : L("删除组卷", "Delete volume")}
                                        </Button>

                                        {/* 卷名：只存库里、**不上纸**（纸的身份是卷号） */}
                                        {editingTitle ? (
                                            <span className="flex items-center gap-1">
                                                <input
                                                    className="rounded-md border bg-background px-2 py-1 text-sm w-56"
                                                    placeholder={L("比如：第五单元 复练", "e.g. Unit 5 review")}
                                                    value={titleDraft}
                                                    onChange={(e) => setTitleDraft(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter") saveTitle();
                                                        if (e.key === "Escape") setEditingTitle(false);
                                                    }}
                                                    autoFocus
                                                />
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    title={L("保存名字", "Save name")}
                                                    onClick={saveTitle}
                                                    disabled={busy === "renaming"}
                                                >
                                                    <Check className="h-4 w-4" />
                                                </Button>
                                            </span>
                                        ) : (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => setEditingTitle(true)}
                                                title={L("给这份卷起个名字（只在软件里）", "Name this volume")}
                                            >
                                                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                                                {detail?.title || L("起名", "Name")}
                                            </Button>
                                        )}

                                        {detail && (
                                            <span className="text-xs sm:text-sm">
                                                {L("卷号", "No.")} <b>{detail.volumeNo}</b>
                                                {" · "}
                                                {L("共", "total")} {pageCount} {L("页", "pages")}
                                            </span>
                                        )}
                                        {notice && <span className="text-xs text-emerald-700">{notice}</span>}
                                    </div>
                                )}

                                {selectedId && (
                                    <p className="mb-3 text-xs text-muted-foreground no-print">
                                        {L(
                                            "可以调留白、拖题图右下角把手改大小、拖两道题之间的虚线 —— 但题不会再在页之间移动（卷已定稿，页号要跟纸走）。改完点「更新组卷」覆盖保存。",
                                            "Adjust spacing / figure size. Questions stay on their page. Press Update volume to save.",
                                        )}
                                    </p>
                                )}

                                {detailLoading && (
                                    <p className="text-sm text-muted-foreground no-print">
                                        {L("载入中…", "Loading…")}
                                    </p>
                                )}

                                {/* 安全阀：页内锁定之后没人替你分页了，撑爆必须点名 */}
                                {overfullPages.length > 0 && (
                                    <div className="mb-3 rounded-md border border-red-500/50 bg-red-50 p-2 text-xs text-red-800 no-print">
                                        {L(
                                            `第 ${overfullPages.join("、")} 页装不下了（页内锁定后题不会自动挪到下一页）—— 请把这几页里的留白行数或题图调小，然后才能「更新组卷」。`,
                                            `Page(s) ${overfullPages.join(", ")} overflow — reduce spacing or figure size first.`,
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
                                        {items.map((item) => (
                                            <ReviewQuestionBlock
                                                key={item.id}
                                                item={item}
                                                seq={snapshotRows.find((r) => r.key === item.id)?.seq ?? 1}
                                                blankLines={blankValueOf(item.id)}
                                                showDivider={false}
                                                figureScale={figureScaleOf(item.id)}
                                                L={L}
                                            />
                                        ))}
                                    </div>
                                )}

                                {layout?.pages.map((page, i) => (
                                    <ReviewSheet
                                        key={i}
                                        page={page}
                                        pageNo={i + 1}
                                        pageCount={layout.pages.length}
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
                                        missing={missingMap}
                                        L={L}
                                    />
                                ))}
                            </div>
                        </div>
                    </main>
                </div>
            </div>
        </div>
    );
}
