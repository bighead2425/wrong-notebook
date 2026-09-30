"use client";

/**
 * 【2026-10-01 新增】扫码结果 · **复练卷浏览**（扫到的是某一页的二维码时）。
 *
 * 他 2026-10-01 的要求（原话拆解）：
 *   · 扫到卷上某页的二维码 ⇒ **把这份卷的版面显示出来，并自动滚到扫到的那一页**；
 *   · 每道题**罩一个天蓝色方框**（罩住题干 + 留白，两侧离纸面留一点），
 *     方框**中间一个蓝圆白加号**，点它 ⇒ 进入"这道题的错题卡"那一屏；
 *   · 电脑滚轮 / 手机手指上下划 ⇒ 翻页；**框和加号要跟着滚动一起走，不能漂移**；
 *   · 双击纸面 ⇒ 放大到实际大小，再双击 ⇒ 回适应窗口；拖动 ⇒ 页面上下左右移动。
 *
 * ── 三个关键实现选择（都是为了不漂移 / 不出错）─────────────────────
 *  ① **框和加号画在纸的 DOM 里面**（每个题块上的绝对定位元素，见 `ReviewSheet` 的
 *     `onQuestionPlusClick`），不是浮在纸外面的一层透明覆盖。纸一动它们天然跟着走，
 *     **结构上就不可能漂移** —— 这也是他最担心的那条。
 *  ② **页归属只认快照**（`layoutFromSnapshot`，不重量、不重排）：扫的是**印出去的那张纸**，
 *     版面必须和纸上完全一致；重新分页会让"第 2 页"和手上的纸对不上。
 *  ③ 缩放走既有 `SheetZoom`（CSS `zoom`，参与布局），**默认给"适应窗口"** ——
 *     他要的就是"双击放大到应有大小"，说明默认那档是适应窗口（手机上纸比屏宽）。
 *     拖动平移用**滚动**（`overflow: auto`）实现：手机手指是原生滚动，
 *     电脑按住空白处拖也能滚（只在鼠标指针下启用，免得跟触摸滚动打架）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ErrorItem, PaginatedResponse } from "@/types/api";
import {
    ReviewSheet,
    pageQrPayload,
} from "@/components/print/review-card";
import { layoutFromSnapshot, type SnapshotRow } from "@/lib/review-card";
import type { VolumeKind } from "@/lib/volume-code";
import { SheetZoom } from "@/components/print/sheet-zoom";
import { makeQrDataUrl } from "@/lib/qr";

/** 与复练卷页同一条约定：原题已被删的行，用快照行自己的 id 当 key */
const missingKeyOf = (rowId: string) => `missing:${rowId}`;

interface VolumeItemRow {
    id: string;
    errorItemId: string | null;
    itemNo: string | null;
    seqInVolume: number;
    pageIndex: number;
    columnIndex: number;
    seqInColumn: number;
    blankLines: number;
    figureScale: number;
}

interface VolumeDetail {
    id: string;
    volumeNo: string;
    kind?: string | null;
    title?: string | null;
    defaultBlankLines: number;
    items: VolumeItemRow[];
}

export function ScanVolumeView({
    code,
    onPickItem,
    onBack,
}: {
    /** 扫到的页二维码内容（`RE20260930001-02` 这种） */
    code: string;
    /** 点了某道题中间的加号 ⇒ 交给上层打开"这道题的错题卡" */
    onPickItem: (item: ErrorItem) => void;
    onBack: () => void;
}) {
    const { language } = useLanguage();
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);

    const [volume, setVolume] = useState<VolumeDetail | null>(null);
    const [pageNo, setPageNo] = useState(1);
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [pageQr, setPageQr] = useState<Record<number, string>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

    /** 拉卷（按**纸上的卷号**，不是内部 id）+ 卷内题的现状 */
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await apiClient.get<{ volume: VolumeDetail; pageNo: number }>(
                    `/api/review-volumes/lookup?code=${encodeURIComponent(code)}`,
                );
                if (cancelled) return;
                setVolume(res.volume);
                setPageNo(res.pageNo || 1);

                const ids = (res.volume.items || [])
                    .map((r) => r.errorItemId)
                    .filter((v): v is string => !!v);
                if (ids.length > 0) {
                    const params = new URLSearchParams();
                    params.set("ids", ids.join(","));
                    params.set("pageSize", String(Math.max(50, ids.length)));
                    const list = await apiClient.get<PaginatedResponse<ErrorItem>>(
                        `/api/error-items/list?${params.toString()}`,
                    );
                    if (!cancelled) setItems(list.items || []);
                } else if (!cancelled) {
                    setItems([]);
                }
            } catch (e) {
                console.error(e);
                if (!cancelled) setError(L("没找到这份卷（纸上的卷号在库里查不到）", "Volume not found"));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code]);

    const kind: VolumeKind = volume?.kind === "build" ? "build" : "review";

    /** 快照行（页归属的**唯一依据**） */
    const snapshotRows = useMemo<SnapshotRow[]>(() => {
        if (!volume) return [];
        return [...(volume.items || [])]
            .sort((a, b) => a.seqInVolume - b.seqInVolume)
            .map((r) => ({
                key: r.errorItemId ?? missingKeyOf(r.id),
                seq: r.seqInVolume,
                pageIndex: r.pageIndex,
                columnIndex: r.columnIndex,
                seqInColumn: r.seqInColumn,
            }));
    }, [volume]);

    const layout = useMemo(
        () => (volume ? layoutFromSnapshot(snapshotRows, kind) : null),
        [volume, snapshotRows, kind],
    );

    const itemByKey = useMemo(() => {
        const map: Record<string, ErrorItem> = {};
        for (const it of items) map[it.id] = it;
        return map;
    }, [items]);

    const missingMap = useMemo(() => {
        const map: Record<string, string | null> = {};
        for (const r of volume?.items || []) {
            if (!r.errorItemId) map[missingKeyOf(r.id)] = r.itemNo;
        }
        return map;
    }, [volume]);

    /** 每页的二维码（页眉上那个小方块）——与复练卷页同一个内容与尺寸 */
    useEffect(() => {
        let cancelled = false;
        if (!volume || !layout) return;
        (async () => {
            const entries: Record<number, string> = {};
            await Promise.all(
                layout.pages.map(async (_p, i) => {
                    try {
                        entries[i + 1] = await makeQrDataUrl(pageQrPayload(volume.volumeNo, i + 1), {
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
    }, [volume, layout]);

    /**
     * 打开就**滚到扫到的那一页**（他明确要求）。
     * 用 `scrollIntoView` 而不是手算 offsetTop：纸里有 zoom，手算要把缩放考虑进去，
     * 容易算错；`scrollIntoView` 直接用浏览器的真实几何。
     */
    useEffect(() => {
        if (!layout || loading) return;
        const el = pageRefs.current[Math.min(pageNo, layout.pages.length)];
        if (!el) return;
        const raf = requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
        return () => cancelAnimationFrame(raf);
    }, [layout, loading, pageNo]);

    /**
     * 电脑端"按住空白处拖动 = 平移"。
     * ⚠️ 只用**鼠标指针**启用（`pointerType === 'mouse'`）：触摸设备本来就是原生滚动，
     *    再插一手拖拽会打架（手指一划就被我们接管、惯性滚动没了）。
     * ⚠️ 点在按钮/加号上不启动拖拽，否则"想点加号"会变成"拖了一下"。
     */
    const dragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        const target = e.target as HTMLElement | null;
        if (target?.closest("button, a, input, select, textarea")) return;
        const sc = scrollRef.current;
        if (!sc) return;
        dragRef.current = { x: e.clientX, y: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop };
    }, []);
    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        const sc = scrollRef.current;
        if (!d || !sc) return;
        sc.scrollLeft = d.sl - (e.clientX - d.x);
        sc.scrollTop = d.st - (e.clientY - d.y);
        e.preventDefault();
    }, []);
    const endDrag = useCallback(() => {
        dragRef.current = null;
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {L("正在打开这份卷…", "Opening the volume…")}
            </div>
        );
    }

    if (error || !volume || !layout) {
        return (
            <div className="space-y-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">{error || L("打开失败", "Failed to open")}</p>
                <Button variant="outline" onClick={onBack}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    {L("回到扫码", "Back to scanner")}
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {/* 顶条：卷号 + 当前页 + 提示（三件事都是看清"我在哪儿"要用的） */}
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={onBack}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    {L("回到扫码", "Back to scanner")}
                </Button>
                <span className="font-mono text-sm font-semibold">{volume.volumeNo}</span>
                <span className="text-sm text-muted-foreground">
                    {L(`第 ${Math.min(pageNo, layout.pages.length)} 页 / 共 ${layout.pages.length} 页`, `Page ${Math.min(pageNo, layout.pages.length)} of ${layout.pages.length}`)}
                </span>
                <span className="flex-1" />
                <span className="text-xs text-muted-foreground">
                    {L("点题目中间的蓝色加号 → 进这道题", "Tap the blue + on a question")}
                </span>
            </div>

            <div
                ref={scrollRef}
                className="max-h-[78vh] overflow-auto rounded-md border bg-zinc-100 p-3 dark:bg-zinc-900"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerLeave={endDrag}
            >
                <SheetZoom className="mx-auto max-w-[900px]" defaultFit L={L}>
                    {layout.pages.map((page, i) => (
                        <div
                            key={i}
                            ref={(el) => {
                                pageRefs.current[i + 1] = el;
                            }}
                            className="mb-4"
                        >
                            <ReviewSheet
                                page={page}
                                pageNo={i + 1}
                                pageCount={layout.pages.length}
                                volumeNo={volume.volumeNo}
                                kind={kind}
                                printDate={new Date()}
                                pageQr={pageQr[i + 1]}
                                itemByKey={itemByKey}
                                missing={missingMap}
                                onQuestionPlusClick={onPickItem}
                                plusTitle={L("点这里 → 打开这道题的错题卡", "Open this question's card")}
                                L={L}
                            />
                        </div>
                    ))}
                </SheetZoom>
            </div>
        </div>
    );
}
