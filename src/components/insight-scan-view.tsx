"use client";

/**
 * 【2026-10-03 需求第 11 条】扫码结果 · **积累纸浏览**（扫到的是积累纸某一页的二维码时）。
 *
 * 他 2026-10-03 的原话（照做）：
 * > 在主页扫描二维码按钮，点击打开扫描后，**如果扫描到了积累纸**，则与扫描到复练纸类似，
 * > **跳转到这个积累纸的预览页**，所有相关功能**完全抄复练纸的那套**。
 * > ① 每条日积月累条目也都**画框、中间放一个圆圈加号**；
 * > ② 没有关联到错题 ⇒ 框与圆圈 **棕黄**、加号白；关联了错题 ⇒ 框与圆圈 **紫**、加号白；
 * > ③ 点这些圆圈 ⇒ 跳**日积月累页**、显示该条目的右边栏、并**隐藏左边栏**；
 * > ④ 点日积月累页左上角的**返回** ⇒ 回到这个带框框和圆圈加号的积累纸预览页。
 *
 * ── 与 `ScanVolumeView`（复练卷那套）的关系：**同一套做法，各走各的纸** ──────
 * 复练卷那一屏 `ScanVolumeView` 用的是 `ReviewSheet`（题块）——它管"卷上有哪些题"；
 * 积累纸的纸面是 `InsightSheet`（积累条目块）——完全不同的块结构，所以这里单独一个组件。
 * 但**其它全部照抄**：
 *   · 按**快照**还原版面（`layoutFromSnapshot(..., 'build')`，不重量不重排）；
 *   · 页归属只认快照（扫的是**印出去的那张纸**，翻页必须和纸对得上）；
 *   · 页眉有卷号/页码/二维码/emoji 标识（都由 `InsightSheet` / `VolumeHeader` 出）；
 *   · `print-sheet` + `SheetZoom` 那整条包裹链一个不少（少了纸宽会不对）；
 *   · 框与加号画在**块内的 DOM 里**（结构上不可能漂移）、且一律 `no-print`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { InsightSheet, type InsightPrintRow } from "@/components/print/insight-sheet";
import { SheetZoom } from "@/components/print/sheet-zoom";
import { pageQrPayload } from "@/components/print/review-card";
import { layoutFromSnapshot, type SnapshotRow } from "@/lib/review-card";
import { makeQrDataUrl } from "@/lib/qr";

/** 与积累纸打印页同一条约定：条目已被删的行，用快照行自己的 id 当 key */
const missingKeyOf = (rowId: string) => `missing:${rowId}`;

/** 快照里的一行（`ReviewVolumeItem` 里跟积累纸有关的那几列） */
interface VolumeItemRow {
    id: string;
    /** 这条是哪条日积月累（软链接；条目被删则置空，纸面照旧） */
    insightId: string | null;
    /** JL 编号快照（如 JL20261003001） */
    itemNo: string | null;
    /** 积累正文快照（md 源） */
    questionText: string | null;
    /** 积累配图快照（JSON 数组字符串；一条最多一张） */
    figureUrls: string | null;
    figureScale: number;
    seqInVolume: number;
    pageIndex: number;
    columnIndex: number;
    seqInColumn: number;
}

interface VolumeDetail {
    id: string;
    volumeNo: string;
    kind?: string | null;
    defaultBlankLines: number;
    gradeSemester?: string | null;
    /** 【2026-10-03 需求第 10 条】这份积累纸的随机 emoji 标识（整份所有页共用） */
    emojiMark?: string | null;
    items: VolumeItemRow[];
}

/** 快照里的图（JSON 数组字符串）取第一张 —— 一条积累最多一张（他定的规则） */
function firstFigure(raw: string | null): string | null {
    if (!raw) return null;
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) && typeof arr[0] === "string" ? arr[0] : null;
    } catch {
        return null;
    }
}

export function InsightScanView({
    code,
    onPickItem,
    onBack,
    backLabel,
}: {
    /** 扫到的页二维码内容（`BU20261003001-02` 这种） */
    code: string;
    /** 点了某条中间的圆圈加号 ⇒ 交给上层去日积月累页看这一条（传 JL 编号） */
    onPickItem: (insightCode: string) => void;
    onBack: () => void;
    /**
     * 【2026-10-03 需求第 5 条】左上角返回按钮的文案。
     * 不传 ⇒ 维持原样（`回到扫码`）—— 扫码入口那一屏的行为**一字不变**；
     * 从积累纸打印页的【扫码图】进来时传 `回到预览`（点了回预览那一屏）。
     */
    backLabel?: string;
}) {
    const { language } = useLanguage();
    const L = useCallback(
        (zh: string, en: string) => (language === "zh" ? zh : en),
        [language],
    );
    /** 返回按钮上那行字：默认"回到扫码"，【扫码图】那条路传 backLabel 覆盖 */
    const backText = backLabel ?? L("回到扫码", "Back to scanner");

    const [volume, setVolume] = useState<VolumeDetail | null>(null);
    const [pageNo, setPageNo] = useState(1);
    /** JL 编号 → 有没有关联错题（决定框与圆颜色）。取不到就按"未关联"处理 */
    const [linkedMap, setLinkedMap] = useState<Record<string, boolean>>({});
    const [pageQr, setPageQr] = useState<Record<number, string>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

    /** 拉卷（按**纸上的卷号**，不是内部 id）+ 卷内条目的现状 */
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

                /**
                 * 颜色判据（他第 ② 条）来自**条目自己的** `errorItemNo`，而快照行上没有它
                 * （构建卷的行只挂 insightId）。这里取一次日积月累清单，把"编号 → 有没有关联错题"
                 * 记成一张表；清单不含图片本体，很轻。
                 * ⚠️ 取失败不报错也不挡路：颜色一律按"未关联（棕黄）"走 —— 纸照样能看、能点。
                 *
                 * 【2026-10-09 改法】**只问这张纸上出现的那些编号**。
                 * 原来是无条件取一遍**全部**日积月累，在这里现建"编号 → 有没有关联错题"的表。
                 * 那条接口现在改成"一次只给一页"了（默认 50 条）——继续那样取会**悄悄取不全**，
                 * 后果是纸上的老条目全被画成"未关联（棕黄）"，而且看不出来是错的。
                 * 现在按需要问：本卷里出现的 JL 编号一次问完（一页纸几十条，远小于上限）。
                 */
                try {
                    const codes = [
                        ...new Set((res.volume.items || []).map((r) => r.itemNo || "").filter(Boolean)),
                    ];
                    const list = await apiClient.get<{
                        insights: Array<{ code: string; errorItemNo: string | null }>;
                    }>(
                        `/api/insights?limit=${Math.min(200, Math.max(1, codes.length))}` +
                        (codes.length ? `&codes=${encodeURIComponent(codes.join(","))}` : ""),
                    );
                    if (cancelled) return;
                    const map: Record<string, boolean> = {};
                    for (const it of list.insights || []) map[it.code] = !!it.errorItemNo;
                    setLinkedMap(map);
                } catch (e) {
                    console.error(e);
                    if (!cancelled) setLinkedMap({});
                }
            } catch (e) {
                console.error(e);
                if (!cancelled) setError(L("没找到这份积累纸（纸上的卷号在库里查不到）", "Sheet not found"));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code]);

    /** 快照行（页归属的**唯一依据**） */
    const snapshotRows = useMemo<SnapshotRow[]>(() => {
        if (!volume) return [];
        return [...(volume.items || [])]
            .sort((a, b) => a.seqInVolume - b.seqInVolume)
            .map((r) => ({
                key: r.insightId ?? missingKeyOf(r.id),
                seq: r.seqInVolume,
                pageIndex: r.pageIndex,
                columnIndex: r.columnIndex,
                seqInColumn: r.seqInColumn,
            }));
    }, [volume]);

    const layout = useMemo(
        () => (volume ? layoutFromSnapshot(snapshotRows, "build") : null),
        [volume, snapshotRows],
    );

    /** key(卷内行 key) → 纸面内容（**全部来自快照**，与印出去的那张纸一致） */
    const rowByKey = useMemo(() => {
        const map: Record<string, InsightPrintRow> = {};
        for (const r of volume?.items || []) {
            const key = r.insightId ?? missingKeyOf(r.id);
            map[key] = {
                id: key,
                code: r.itemNo || "",
                content: r.questionText || "",
                photoUrl: firstFigure(r.figureUrls),
            };
        }
        return map;
    }, [volume]);

    /** 每题（行）在这一卷里的图缩放 —— 按快照渲染，和纸上的图大小一致 */
    const figureScaleOf = useMemo(() => {
        const map: Record<string, number> = {};
        for (const r of volume?.items || []) {
            map[r.insightId ?? missingKeyOf(r.id)] = r.figureScale ?? 100;
        }
        return (key: string) => map[key] ?? 100;
    }, [volume]);

    /** 这条 JL 编号有没有关联错题 —— 缺数据时按"未关联"（棕黄） */
    const linkedOf = useCallback((code2: string) => !!linkedMap[code2], [linkedMap]);

    /** 每页的二维码（页眉上那个小方块）——与积累纸打印页同一个内容与尺寸 */
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
     * 打开就**滚到扫到的那一页**（与复练卷那一屏同一条要求）。
     * ⚠️ **只滚一次**：点加号不写库、`layout` 不会重算，这里仍照抄复练卷那个防重跳的写法，
     *    免得日后加了写库动作又出现"点一下跳回页首"的老毛病。
     */
    const jumpedKeyRef = useRef<string | null>(null);
    useEffect(() => {
        if (!layout || loading) return;
        const key = `${volume?.id ?? ""}#${pageNo}`;
        if (jumpedKeyRef.current === key) return;
        const el = pageRefs.current[Math.min(pageNo, layout.pages.length)];
        if (!el) return;
        jumpedKeyRef.current = key;
        const raf = requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
        return () => cancelAnimationFrame(raf);
    }, [layout, loading, pageNo, volume?.id]);

    /**
     * 电脑端"按住空白处拖动 = 平移"——与复练卷那一屏完全同一套
     * （只看鼠标指针；点在按钮上不启动拖拽）。
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
                {L("正在打开这份积累纸…", "Opening the sheet…")}
            </div>
        );
    }

    if (error || !volume || !layout) {
        return (
            <div className="space-y-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">{error || L("打开失败", "Failed to open")}</p>
                <Button variant="outline" onClick={onBack}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    {backText}
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {/* 顶条：卷号 + 当前页 + 提示 */}
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={onBack}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    {backText}
                </Button>
                <span className="font-mono text-sm font-semibold">{volume.volumeNo}</span>
                <span className="text-sm text-muted-foreground">
                    {L(
                        `第 ${Math.min(pageNo, layout.pages.length)} 页 / 共 ${layout.pages.length} 页`,
                        `Page ${Math.min(pageNo, layout.pages.length)} of ${layout.pages.length}`,
                    )}
                </span>
                <span className="flex-1" />
                <span className="text-xs text-muted-foreground">
                    {L("点条目中间的加号 → 去日积月累页看这条", "Tap + to open this takeaway")}
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
                {/* ⚠️ `print-sheet` 这层不能少：它把纸定成 152mm 宽（与复练卷那一屏同一个坑） */}
                <SheetZoom
                    className="mx-auto max-w-6xl px-4 py-6 print:max-w-none print:px-0 print:py-0"
                    defaultFit
                    L={L}
                >
                    <div className="print-sheet">
                        {layout.pages.map((page, i) => (
                            <div
                                key={i}
                                ref={(el) => {
                                    pageRefs.current[i + 1] = el;
                                }}
                                className="mb-4"
                            >
                                <InsightSheet
                                    page={page}
                                    pageNo={i + 1}
                                    pageCount={layout.pages.length}
                                    volumeNo={volume.volumeNo}
                                    gradeText={volume.gradeSemester ?? null}
                                    emojiMark={volume.emojiMark}
                                    rowByKey={rowByKey}
                                    blankLines={volume.defaultBlankLines ?? 1}
                                    figureScaleOf={figureScaleOf}
                                    pageQr={pageQr[i + 1]}
                                    /* 圆圈加号（只在这屏画）+ 颜色判据（有没有关联错题） */
                                    onItemPlusClick={(row) => onPickItem(row.code)}
                                    linkedOf={linkedOf}
                                    L={L}
                                />
                            </div>
                        ))}
                    </div>
                </SheetZoom>
            </div>
        </div>
    );
}
