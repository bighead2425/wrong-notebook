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
import type { ManageType, PromoteDirection } from "@/lib/manage-type";
import {
    markForItem,
    nextReviewMark,
    nextReviewOutcomes,
    promoteToggleFor,
    type ReviewMark,
} from "@/lib/scan-marking";
import { normalizeReviewOutcomes, serializeReviewOutcomes, type ReviewOutcomes } from "@/lib/review-outcomes";
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
    /** 【2026-10-02】**这份卷上**这道题的标记（`right`/`wrong`/null）—— 见 `markOfItem` */
    markState?: string | null;
}

interface VolumeDetail {
    id: string;
    volumeNo: string;
    kind?: string | null;
    title?: string | null;
    defaultBlankLines: number;
    items: VolumeItemRow[];
    /**
     * 【2026-10-03 他要求】这份卷的随机 emoji 标识 —— **扫码预览页也要显示**，
     * 因为它就是"查对"用的：拿手里这张纸和屏幕上这份卷，看 emoji 一样就是同一份。
     * （由 `lookup` 接口给；老卷它会惰性补一个再返回。）
     */
    emojiMark?: string | null;
}

export function ScanVolumeView({
    code,
    onPickItem,
    onBack,
    backLabel,
}: {
    /** 扫到的页二维码内容（`RE20260930001-02` 这种） */
    code: string;
    /** 点了某道题中间的加号 ⇒ 交给上层打开"这道题的错题卡" */
    onPickItem: (item: ErrorItem) => void;
    onBack: () => void;
    /**
     * 【2026-10-03 需求第 5 条】左上角返回按钮的文案。
     * 不传 ⇒ 维持原样（`回到扫码`）—— 扫码入口那一屏的行为**一字不变**；
     * 从复练卷页/积累纸打印页的【扫码图】进来时传 `回到预览`（点了回预览那一屏）。
     */
    backLabel?: string;
}) {
    const { language } = useLanguage();
    // 稳定引用：下面几个录入回调把它放进依赖，若每次渲染都换新函数会让回调反复重建
    const L = useCallback(
        (zh: string, en: string) => (language === "zh" ? zh : en),
        [language],
    );
    /** 返回按钮上那行字：默认"回到扫码"，【扫码图】那条路传 backLabel 覆盖 */
    const backText = backLabel ?? L("回到扫码", "Back to scanner");

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

    /* ══════════════════════════════════════════════════════════════════
     * 【2026-10-02 他要求】扫到的卷页上**直接录入**：
     *   一、点升降框 ⇒ 改类型；再点 ⇒ 改回来；
     *   二、点右侧灰圆 ⇒ 灰数字 → 绿对号 → 粉错号 → 灰数字，同步写复习结果。
     *
     * 现在这屏是**扫码只读页**，所以一律**乐观更新**：界面先变、后台再写，
     * 写失败就回滚并把原状态摆回去 + 提示（他明确要求"点了界面要立刻反映状态"）。
     * ══════════════════════════════════════════════════════════════════ */

    /** 乐观改一道题的字段（写库失败时用它回滚） */
    const patchItem = useCallback((id: string, patch: Partial<ErrorItem>) => {
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
    }, []);

    /**
     * 升降框的勾选态：记住"点之前是什么"以便**原样还原** ——
     * 原来的类型可能是**未定（null）**，还原时就得写回 null，不能猜成复练。
     */
    const [promoteState, setPromoteState] = useState<
        Record<string, { direction: PromoteDirection; originalType: ManageType | null }>
    >({});

    /**
     * 灰圆的**当前态**（本屏的一条会话状态）。
     *
     * 为什么不直接拿库里的 `last` 当显示：他定的三态循环最后一步是"回到灰底白数字"，
     * 而这一步按"不删历史、只撤销这次标记"落库（库里 `last` 会退回**这次标记之前**那个值）。
     * 若直接看 `last`，点回灰色之后圆会仍显示上一轮的对号 —— 与他要的循环不符。
     * 所以圆画什么由这里决定：**这道题这次抽到之后我把它标成了什么**；没标过才回落到库里。
     * ⚠️ 重新进这一屏（marks 清空）时回落到库里 `last`：那时灰圆可能显示成绿/粉
     *    （因为"最近一次"记录仍在）—— 这是"清空不删历史"的必然结果，已在交付说明里标明。
     */
    const [marks, setMarks] = useState<Record<string, ReviewMark>>({});

    /**
     * 这道题此刻的灰圆态：**本地这一会儿的覆盖** → **这一卷的行上记的** → 灰。
     *
     * ⚠️【2026-10-02 他定的】兜底**不能**再回落到题目的 `last`（那是跨卷的复习历史）。
     * 他原话："如果扫的是另外一个**没有扫描过**的新卷，即使有这道题**还是应该给灰圈**。"
     * 所以判据是"**这张纸上**我标过没有"（`ReviewVolumeItem.markState`），
     * 而不是"这道题历史上复习过什么"。
     * （同一份卷重扫时两者一致 —— 因为标的时候两边是同时写的。）
     */
    const markOfItem = useCallback(
        (item: ErrorItem): ReviewMark => markForItem(item.id, marks, volume?.items || []),
        [marks, volume],
    );

    /**
     * 灰圆写入前的**快照**（同时也是"这一轮标记还活着"的凭据）：
     *   · 有它 ⇒ 还在同一轮里，绿⇄粉是**修正同一格**（不新增记录）；
     *   · 点回灰数字 ⇒ 用它**撤销这一轮**（更早的历史记录一个字不动），然后删掉它。
     */
    const markUndoRef = useRef<Record<string, string | null>>({});
    /** 同一道题正在写库时不重复受理（乐观更新下避免连点把顺序打乱） */
    const busyRef = useRef<Set<string>>(new Set());
    const [saveError, setSaveError] = useState<string | null>(null);

    /** 把一份复习结果写库（乐观更新 → 失败回滚 + 提示） */
    const saveReviewOutcomes = useCallback(
        async (item: ErrorItem, next: ReviewOutcomes, prevRaw: string | null) => {
            patchItem(item.id, { reviewOutcomes: serializeReviewOutcomes(next) });
            setSaveError(null);
            try {
                const updated = await apiClient.put<{ attention?: number }>(`/api/error-items/${item.id}`, {
                    reviewOutcomes: next,
                });
                /**
                 * 【2026-10-03】复习结果会**联动等级**（见 `lib/level-linkage.ts`）⇒
                 * 用服务器算完的值刷新（这一屏不显示奖牌，但列表/详情页可能正开着同一道题）。
                 */
                if (typeof updated?.attention === 'number') {
                    patchItem(item.id, { attention: updated.attention });
                }
            } catch (err) {
                console.error(err);
                patchItem(item.id, { reviewOutcomes: prevRaw });
                setSaveError(
                    L("这道题的复习结果没存上，已还原，请再试一次", "Failed to save the result; reverted"),
                );
            }
        },
        [L, patchItem],
    );

    /**
     * 【2026-10-02】把"**这一卷某行**的标记"写库（决定圆画成哪一态）。
     *
     * 与 `saveReviewOutcomes` 是**两件事、都要写**：
     *   · 这里 ⇒ "**这张纸上**我标了什么"（按卷，`ReviewVolumeItem.markState`）；
     *   · 那里 ⇒ "**这道题**复习过几次、结果如何"（跨卷的复习历史，`ErrorItem.reviewOutcomes`）。
     * 他既要"同步到复习结果"、又要"换新卷时给灰圈"，所以两个存储各司其职、同时写。
     *
     * 失败只提示、不把界面弹回去：圆态有本地的 `marks` 顶着，下次点击还会重写一次 ——
     * 这是"标记"不是"录入"，容错空间比弹回去让人重来更划算。
     */
    const saveItemMark = useCallback(
        async (item: ErrorItem, next: ReviewMark) => {
            if (!volume) return;
            const row = (volume.items || []).find((r) => r.errorItemId === item.id);
            if (!row) return;
            try {
                await apiClient.patch(`/api/review-volumes/${volume.id}`, {
                    markItemId: row.id,
                    markState: next === 'none' ? null : next,
                });
                setVolume((prev) =>
                    prev
                        ? {
                              ...prev,
                              items: prev.items.map((r) =>
                                  r.id === row.id
                                      ? { ...r, markState: next === 'none' ? null : next }
                                      : r,
                              ),
                          }
                        : prev,
                );
            } catch (err) {
                console.error(err);
                setSaveError(
                    L(
                        '这一笔标记没存上（题目的复习结果照常记了），再点一次就行',
                        'The on-paper mark did not save; tap it again',
                    ),
                );
            }
        },
        [volume, L],
    );

    /** 点右侧灰圆：灰数字 → 绿对号 → 粉错号 → 灰数字 */
    const onReviewMarkTap = useCallback(
        (item: ErrorItem) => {
            if (busyRef.current.has(item.id)) return;
            const next = nextReviewMark(markOfItem(item));
            const prevRaw = item.reviewOutcomes ?? null;
            setMarks((prev) => ({ ...prev, [item.id]: next }));
            // 卷上的那一笔标记（按卷记）——无论哪种态都要落一次
            void saveItemMark(item, next);

            if (next === "none") {
                // 清空 = 撤销这一轮标记：把写入前的快照摆回库里；这轮没写过就不动库
                if (!(item.id in markUndoRef.current)) return;
                const undoRaw = markUndoRef.current[item.id];
                delete markUndoRef.current[item.id];
                if (undoRaw === null || undoRaw === undefined) return;
                busyRef.current.add(item.id);
                void saveReviewOutcomes(item, normalizeReviewOutcomes(undoRaw), prevRaw).finally(() =>
                    busyRef.current.delete(item.id),
                );
                return;
            }

            /**
             * 关键：绿⇄粉是**修正同一格**，不是又占一个新格。
             * 起手那一下把"写入前的快照"记下来；之后每次改对错都从**同一份快照**重算
             * ⇒ `nextReviewOutcomes` 每次都填到**同一个空位**（它找的是快照里第一个空格），
             * 与"按顺序填第一个空位"完全一致，又不会把一轮标记记成两条。
             */
            const hasActiveMark = item.id in markUndoRef.current;
            const baseRaw = hasActiveMark ? markUndoRef.current[item.id] : prevRaw;
            if (!hasActiveMark) markUndoRef.current[item.id] = prevRaw;

            const { outcomes } = nextReviewOutcomes(baseRaw, next);
            busyRef.current.add(item.id);
            void saveReviewOutcomes(item, outcomes, prevRaw).finally(() => busyRef.current.delete(item.id));
        },
        [markOfItem, saveReviewOutcomes, saveItemMark],
    );

    /** 点升降框：第一次改类型、第二次改回来（都乐观 + 失败回滚） */
    const onPromoteToggle = useCallback(
        (item: ErrorItem) => {
            if (busyRef.current.has(item.id)) return;
            const existing = promoteState[item.id];
            busyRef.current.add(item.id);

            if (!existing) {
                const { direction, nextType, originalType } = promoteToggleFor(item.manageType);
                setSaveError(null);
                setPromoteState((prev) => ({ ...prev, [item.id]: { direction, originalType } }));
                patchItem(item.id, { manageType: nextType });
                void apiClient
                    .put(`/api/error-items/${item.id}`, { manageType: nextType })
                    .catch((err) => {
                        console.error(err);
                        patchItem(item.id, { manageType: originalType });
                        setPromoteState((prev) => {
                            const n = { ...prev };
                            delete n[item.id];
                            return n;
                        });
                        setSaveError(L("类型没改上，已还原，请再试一次", "Failed to change the type; reverted"));
                    })
                    .finally(() => busyRef.current.delete(item.id));
                return;
            }

            // 再点一次 ⇒ 还原成点之前的样子
            const revertType = existing.originalType;
            const redoType: ManageType = existing.direction === "demote" ? "review" : "deep";
            setSaveError(null);
            setPromoteState((prev) => {
                const n = { ...prev };
                delete n[item.id];
                return n;
            });
            patchItem(item.id, { manageType: revertType });
            void apiClient
                .put(`/api/error-items/${item.id}`, { manageType: revertType })
                .catch((err) => {
                    console.error(err);
                    patchItem(item.id, { manageType: redoType });
                    setPromoteState((prev) => ({ ...prev, [item.id]: existing }));
                    setSaveError(L("类型没改回来，已还原，请再试一次", "Failed to revert the type"));
                })
                .finally(() => busyRef.current.delete(item.id));
        },
        [L, patchItem, promoteState],
    );

    const promoteOverrideOf = useCallback(
        (item: ErrorItem) => {
            const p = promoteState[item.id];
            return p ? { direction: p.direction, checked: true as const } : undefined;
        },
        [promoteState],
    );

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
    /**
     * ⚠️【2026-10-03 修他报的 bug】**只许滚一次**。
     *
     * 现象（他的原话）："无论我点击哪一题的灰色圆圈流水号……整个卷都跳回到进入扫到的
     * 复练卷一开始那一页的页首处，就像刚刚又扫描了一次这一页的二维码一般"。
     * 根因：这个 effect 的依赖里有 `layout`，而**点一下圆就会更新卷数据
     * （写 `markState`）⇒ `layout` 重算 ⇒ effect 重跑 ⇒ 又 scrollIntoView 一次**。
     * （之前没事，是因为点圆以前不写卷、只写题，`layout` 不会动。）
     *
     * 修法：记"已经为哪一份卷的哪一页跳过了"，同一个目标不跳第二次。
     * 换卷（`volume.id` 变）或换页（`pageNo` 变）时才算新目标 —— 那时该跳。
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
                    {backText}
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
                    {backText}
                </Button>
                <span className="font-mono text-sm font-semibold">{volume.volumeNo}</span>
                <span className="text-sm text-muted-foreground">
                    {L(`第 ${Math.min(pageNo, layout.pages.length)} 页 / 共 ${layout.pages.length} 页`, `Page ${Math.min(pageNo, layout.pages.length)} of ${layout.pages.length}`)}
                </span>
                <span className="flex-1" />
                <span className="text-xs text-muted-foreground">
                    {L(
                        "点加号进这道题；点框里的升降、点右侧圆记对错",
                        "Tap + for the card; tap the box / circle to record",
                    )}
                </span>
            </div>

            {/* 写库失败提示：乐观更新已回滚，这里只告诉他一声音（下次操作会自动清掉） */}
            {saveError ? (
                <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
                    {saveError}
                </div>
            ) : null}

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
                                /* 【2026-10-03 他要求】扫码预览页也显示 emoji 标识 —— 它是"查对"用的：
                                   手里这张纸和屏幕上这份卷，emoji 相同即同一份（积累纸那边同理）。 */
                                emojiMark={volume.emojiMark}
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
                                /* 【2026-10-02 他要求】纸面上**直接录入**：
                                   点左下的升降框改类型、点右侧灰圆记对错 —— 都是屏幕控件，not printed。 */
                                onPromoteToggle={onPromoteToggle}
                                promoteOverrideOf={promoteOverrideOf}
                                onReviewMarkTap={onReviewMarkTap}
                                reviewMarkOf={markOfItem}
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
