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
import { cleanMarkdown } from "@/lib/markdown-utils";

/** 与复练卷页同一条约定：原题已被删的行，用快照行自己的 id 当 key */
const missingKeyOf = (rowId: string) => `missing:${rowId}`;

/**
 * 【2026-10-01 他定的规则】扫复练卷**对答案**：把这道题的正确答案做成一个灰底灰字的小标签。
 *
 * 两条处理规则（**他原话照做**）：
 *  ① 答案分了几行写 ⇒ **先并成一行**，行与行之间用 `§` 连接
 *     （`§` 的含义就是"后面的内容是下一行"），然后再塞进标签；
 *  ② 合并后还是太长、标签放不下 ⇒ 交给 CSS 末尾省略（她也真看不全的那种长答案，
 *     点题目中间的加号进详情页看完整解答 —— 这正是那个加号存在的理由）。
 *
 * 顺带过一遍 `cleanMarkdown`：答案是 md（可能带 `$…$` 公式、`**粗体**`），
 * 而这个标签是**一行纯文本**、渲染不了 md ⇒ 把标记转成对应符号（`\times`⇒×、`\frac{a}{b}`⇒a/b…）。
 * 复用既有工具，不新写一套（免得"标签里的答案"和别处显示的对不上）。
 */
function answerLabelOf(item: ErrorItem): string | null {
    const raw = item.answerText;
    if (!raw || !raw.trim()) return null;
    const merged = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' § ');
    const text = cleanMarkdown(merged).replace(/\s+/g, ' ').trim();
    return text || null;
}

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

    /**
     * 【2026-10-01 补】每题在**这一卷里**的题图缩放（卷内快照的 `figureScale`）。
     *
     * 复练卷页能用是因为它整卷可选可存；扫码这屏是**只读看印出去的那张纸** ——
     * 更要按卷里的值渲染，否则"手上纸的图小、屏上图的图大"，就对不上了。
     */
    const figureScaleOf = useMemo(() => {
        const map: Record<string, number> = {};
        for (const r of volume?.items || []) {
            if (r.errorItemId) map[r.errorItemId] = r.figureScale ?? 100;
        }
        return (id: string) => map[id] ?? 100;
    }, [volume]);

    /**
     * 【2026-10-01】**每题答案文本**（多行已用 `§` 并成一行、md 已清成纯文本）。
     * 先算成一张表：`cleanMarkdown` 内部要跑 remark，放在渲染里每题每帧算一次太亏
     * （一页 5 道题就是 5 次解析，且每次滚动重渲都会重算）。
     */
    const answerOf = useMemo(() => {
        const map: Record<string, string> = {};
        for (const it of items) {
            const label = answerLabelOf(it);
            if (label) map[it.id] = label;
        }
        return (it: ErrorItem) => map[it.id] ?? null;
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
                {/*
                 * ⚠️【2026-10-01 修】**`print-sheet` 这层不能少**。
                 *   它负责把纸定成 **152mm 宽**。少了它，纸就被拉成整个容器的宽度 ——
                 *   他实测的原话正是"渲染的纸张似乎不像是 B5 纸张版面"。
                 *   这与复练卷页当初那个坑是同一个（见 globals.css 的 `.print-sheet`），
                 *   也是同一条规矩：**新页面要照抄老页面的整条包裹链**，只抄顶层不够。
                 *   （`mx-auto max-w-6xl` 也没有意义了 —— 定宽交给 print-sheet。）
                 */}
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
                                /* 【2026-10-01 修】题图必须用**卷里调过的那个缩放**。
                                   不传就一律按 100（原大小）—— 他实测："题图大小和复练卷
                                   设计好的大小似乎不同…在这里看到的总觉得是原大小"。 */
                                figureScaleOf={figureScaleOf}
                                /* 【2026-10-01 新加】**扫复练卷也能对答案** ——
                                   每题右下角升降框左边一个小灰标签，灰底灰白字、刻意难辨
                                   （他："不是来查答案的也不耽误，想看的话仔细分辨也能看见"）。 */
                                answerOf={answerOf}
                                onQuestionPlusClick={onPickItem}
                                plusTitle={L("点这里 → 打开这道题的错题卡", "Open this question's card")}
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
