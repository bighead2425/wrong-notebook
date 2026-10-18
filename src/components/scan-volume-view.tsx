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
    ReviewQuestionBlock,
    pageQrPayload,
} from "@/components/print/review-card";
import { ImitateSegments, ImitateSheet } from "@/components/print/imitate-card";
import {
    buildImitateSegments,
    imitateLayoutFromSnapshot,
    readImitateHeights,
    themeRowOfSnapshot,
    type ImitateSegment,
    type ImitateSegmentSpec,
} from "@/lib/imitate-card";
import { layoutFromSnapshot, VOLUME_VARIANTS, type SnapshotRow } from "@/lib/review-card";
import { whenImagesDecoded, whenImagesSettled } from "@/lib/print-image-readiness";
import type { VolumeKind } from "@/lib/volume-code";
import type { ManageType, PromoteDirection } from "@/lib/manage-type";
import {
    EMPTY_VOLUME_MARK,
    REVIEW_MARK_COLORS,
    nextReviewMark,
    promoteToggleFor,
    volumeMarkMap,
    volumeMarkOf,
    type ReviewMark,
    type VolumeMark,
} from "@/lib/scan-marking";
import {
    reviewEventDeleteDraft,
    reviewEventDraft,
    reviewEventUpdateDraft,
    type ReviewEventDraft,
    type ReviewEventPatchDraft,
} from "@/lib/review-event-draft";
// 【2026-10-16】来源：卷页记的流水是"复练纸/模仿纸 + 卷号"（由卷的 kind 定，见该文件头）
import { paperSourceForKind } from "@/lib/review-event-source";
// 【2026-10-17】掌握开关的下一档 —— 唯一实现（别自己写 `> 0 ? 0 : 1`）
import { nextMasteryLevel } from "@/lib/level-settle";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { SheetZoom } from "@/components/print/sheet-zoom";
// 【2026-10-17 空空第 3 条】答案对话框里的 md 编辑框（与详情页同一个组件，橙边脏标记也同源）
import { MdEditor } from "@/components/md-editor";
import { dayKey } from "@/lib/calendar-grid";
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
    highlightItemId,
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
    /**
     * 【2026-10-18 空空第 2 条】要**凸显**的那道题（从错题详情页二维码 → 相关卷 → 预览里点【扫码图】）。
     * 不传 ⇒ 这一屏与以前一模一样（扫码入口那条路不传它）。
     */
    highlightItemId?: string | null;
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
                    /**
                     * ⚠️⚠️【2026-10-18 如如】与组卷页同一个病：**不带 `withImages=1` 就没有题图**。
                     * 2026-10-16 的性能修复让列表接口默认不返回 `originalImageUrl`；
                     * 这一屏要把"这张纸"按原样画出来（题图是纸的一部分）⇒ 必须带。
                     * 详情见 `app/review-volumes/page.tsx` 里同一段注释。
                     */
                    params.set("withImages", "1");
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

    /**
     * 【2026-10-11】模仿卷（CO）也要能扫进来 —— 他设计稿第 8 条：
     * "我们在主页上如果扫描二维码，是也是可以扫描到这个'模仿卷'的，
     *  这一点和扫描到复练卷的是一致的。"
     */
    const kind: VolumeKind =
        volume?.kind === "build" ? "build" : volume?.kind === "imitate" ? "imitate" : "review";
    const isImitate = kind === "imitate";

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
        () => (volume && !isImitate ? layoutFromSnapshot(snapshotRows, kind) : null),
        [volume, snapshotRows, kind, isImitate],
    );

    const itemByKey = useMemo(() => {
        const map: Record<string, ErrorItem> = {};
        for (const it of items) map[it.id] = it;
        return map;
    }, [items]);

    /* ===== 【T4】模仿卷：左栏（主题）按主题现算、右栏（附题）只认快照 =====
       与卷管理页同一套读法（`readImitateHeights` / `imitateLayoutFromSnapshot`），
       差别只在"要不要罩蓝框加号"（这一屏要，见下面的渲染）。 */
    const imitateThemeKey = isImitate ? (themeRowOfSnapshot(snapshotRows)?.key ?? null) : null;
    const imitateTheme = useMemo(
        () => (imitateThemeKey ? (itemByKey[imitateThemeKey] ?? null) : null),
        [imitateThemeKey, itemByKey],
    );
    /** 主题的题号（只给"主题已删 ⇒ 此卷作废"那张白纸用） */
    const imitateThemeNo = useMemo(() => {
        if (!imitateThemeKey) return null;
        const row = (volume?.items || []).find(
            (r) => (r.errorItemId ?? missingKeyOf(r.id)) === imitateThemeKey,
        );
        return row?.itemNo ?? null;
    }, [imitateThemeKey, volume]);
    const imitateSpecs = useMemo(
        () => (imitateTheme ? buildImitateSegments(imitateTheme, { hasFigure: true }) : []),
        [imitateTheme],
    );
    const imitateSegmentByKey = useMemo(() => {
        const map: Record<string, ImitateSegmentSpec> = {};
        for (const s of imitateSpecs) map[s.key] = s;
        return map;
    }, [imitateSpecs]);
    const imitateRightRows = useMemo(
        () =>
            snapshotRows
                .filter((r) => r.columnIndex !== 0)
                .sort((a, b) => a.pageIndex - b.pageIndex || a.seqInColumn - b.seqInColumn),
        [snapshotRows],
    );
    const [imitateSegments, setImitateSegments] = useState<ImitateSegment[] | null>(null);
    const imitateMeasureRef = useRef<HTMLDivElement | null>(null);
    const imitateMeasureKey = useMemo(
        () =>
            [
                imitateThemeKey ?? "",
                imitateSpecs.map((s) => s.key).join("|"),
                imitateRightRows.map((r) => r.key).join("|"),
            ].join("#"),
        [imitateThemeKey, imitateSpecs, imitateRightRows],
    );
    useEffect(() => {
        if (!isImitate) {
            setImitateSegments(null);
            return;
        }
        if (!imitateTheme) {
            setImitateSegments([]);
            return;
        }
        let cancelled = false;
        (async () => {
            await whenImagesSettled();
            await whenImagesDecoded(imitateMeasureRef.current);
            if (cancelled) return;
            const el = imitateMeasureRef.current;
            if (!el) return;
            const { segments } = readImitateHeights(
                el,
                imitateSpecs,
                imitateRightRows.map((r) => r.key),
            );
            if (!cancelled) setImitateSegments(segments);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isImitate, imitateMeasureKey]);

    const imitateLayout = useMemo(
        () =>
            isImitate && imitateSegments ? imitateLayoutFromSnapshot(imitateRightRows, imitateSegments) : null,
        [isImitate, imitateRightRows, imitateSegments],
    );

    /**
     * 本屏要渲染几页、以及"排版算好没"。
     * ⚠️【2026-10-11】按**纸别**取：复练/积累看 `layout`、模仿看 `imitateLayout` ——
     *    取错就是页码写着"共 3 页"而实际只画了两页。
     */
    const pageTotal = isImitate ? (imitateLayout?.sheets.length ?? 0) : (layout?.pages.length ?? 0);
    const layoutReady = isImitate ? !!imitateLayout : !!layout;

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
     * 【2026-10-02 立 · 2026-10-16 换读源】**这一卷上每道题的记录**。
     *
     * 以前读的是卷行上的 `markState`（"这张纸上我标了什么"），
     * 现在读**这条题在这张卷上的最近一条流水**（`ReviewEvent`）—— 因为流水才是复习结果的真相。
     * `markState` 仍然照写（回录页拿它做校对），但**不再拿它画圆**。
     *
     * ⚠️ 本地这一份同时充当**乐观更新**的落点（点完先改画面、写完用服务端结果覆盖）。
     */
    const [volMarks, setVolMarks] = useState<Record<string, VolumeMark>>({});

    /**
     * 这道题此刻的圆态 / 最近那条的 id / 录过几轮 —— 全部取自 `volMarks` 那一张表。
     *
     * ⚠️ `volMarks` 里可能暂时是**乐观值**（点完先改画面），服务器一回来就被真值覆盖
     *    （见 `writeMark`）⇒ 外面不用再分一层"本地覆盖"。
     *
     * ⚠️【2026-10-02 他定的】它**不能**回落到题目的复习历史。
     * 他原话："如果扫的是另外一个**没有扫描过**的新卷，即使有这道题**还是应该给灰圈**。"
     * —— 判据是"**这张纸上**有没有记过"，不是"这道题历史上复习过什么"。
     */
    const markOfItem = useCallback(
        (item: ErrorItem): VolumeMark => volumeMarkOf(item.id, {}, volMarks),
        [volMarks],
    );

    /** 同一道题正在写库时不重复受理（乐观更新下避免连点把顺序打乱） */
    const busyRef = useRef<Set<string>>(new Set());
    const [saveError, setSaveError] = useState<string | null>(null);

    /**
     * 【2026-10-16 如如】拉这一卷上所有题的复习记录（**一次查完**，`docs\18` §4.3）。
     *
     * ⚠️ 失败**不弹窗**（它是纸面上的一层只读信息）：只把提示挂在下面那个琥珀条上，
     *    因为他此刻正对着纸在核对，弹窗会打断。
     */
    const fetchVolumeMarks = useCallback(
        async (volumeId: string) => {
            try {
                const res = await apiClient.get<{ marks: unknown[] }>(
                    `/api/review-volumes/${volumeId}/review-marks`,
                );
                setVolMarks(volumeMarkMap(res?.marks ?? []));
            } catch (err) {
                console.error(err);
                setSaveError(
                    L("这张卷上的录入记录没读上，圆可能是旧的", "Failed to read this volume's marks"),
                );
            }
        },
        [L],
    );

    /** 卷行上的"纸面标记"（`ReviewVolumeItem.markState`）—— 与流水**同时**维护 */
    const saveItemMark = useCallback(
        async (rowId: string, next: ReviewMark) => {
            if (!volume) return;
            try {
                await apiClient.patch(`/api/review-volumes/${volume.id}`, {
                    markItemId: rowId,
                    markState: next === 'none' ? null : next,
                });
                setVolume((prev) =>
                    prev
                        ? {
                              ...prev,
                              items: prev.items.map((r) =>
                                  r.id === rowId ? { ...r, markState: next === 'none' ? null : next } : r,
                              ),
                          }
                        : prev,
                );
            } catch (err) {
                // 这笔只是"纸面标记"，流水已经写进去了 ⇒ 只提示、不把界面弹回去
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

    /**
     * 【2026-10-16 如如】把一次录入写进库 —— **唯一路径是流水**（`reviewEvent`）。
     *
     * 三种动作（`docs\18` §4.3 + §六）：
     *   · `add`    —— 点灰圆 / 长按"再录一次"
     *   · `update` —— 点圈在"对 ⇄ 错"之间换（**改这一轮这题的结果**，不是新增一条）
     *   · `delete` —— 长按菜单"删除这一条"
     * 全部**逐题即时**（不再有"离开页面时统一落定"那回事）。
     *
     * ⚠️ 写成功后**重拉这一卷的记录**当真相，并顺手把卷行上的 `markState` 同步过去
     *    （那是"这张纸上的标记"，回录页要用）。
     */
    const writeMark = useCallback(
        async (item: ErrorItem, body: ReviewEventDraft | ReviewEventPatchDraft, optimistic: VolumeMark) => {
            if (!volume || busyRef.current.has(item.id)) return;
            busyRef.current.add(item.id);
            setSaveError(null);
            setVolMarks((prev) => ({ ...prev, [item.id]: optimistic }));
            try {
                /**
                 * 【2026-10-18 如如】接住服务端那句"这次录入被挡下了"。
                 *
                 * 之前这里是"发了 PUT 就当成了"，可服务端对**已掌握**的题会**忽略**流水
                 * （`docs\18` 决策 ⑧：冻住就真冻住）⇒ 然后 `fetchVolumeMarks` 拉回旧值
                 * ⇒ 他看到的是"点了对号，圈自己跳回来"，且没有任何解释
                 * （空空 2026-10-18 报的第 3 条，他因此不敢确认是不是 bug）。
                 *
                 * ⇒ 现在服务端会回 `reviewEventIgnored: 'mastered'`：
                 *   ① 提示他"先去把「会」点掉"；② **不再同步卷行的 markState**
                 *      （记录都没写进去，卷行就不该记成"对/错"，否则纸面标记与流水打架）。
                 */
                const res = await apiClient.put<{ reviewEventIgnored?: 'mastered' }>(
                    `/api/error-items/${item.id}`,
                    { reviewEvent: body },
                );
                await fetchVolumeMarks(volume.id);
                if (res?.reviewEventIgnored === 'mastered') {
                    setSaveError(
                        L(
                            '这道题标着「已掌握」，所以这次对错没记上 —— 想录，先点左边的「会」取消已掌握',
                            'This question is marked as mastered, so the result was not saved. Tap "会" to unmark it first.',
                        ),
                    );
                    return;
                }
                const row = (volume.items || []).find((r) => r.errorItemId === item.id);
                if (row) void saveItemMark(row.id, optimistic.mark);
            } catch (err) {
                console.error(err);
                // 失败**拉回真实数据**（宁可显示服务端的旧值，也不留一个只在屏幕上的假态）
                await fetchVolumeMarks(volume.id);
                setSaveError(
                    L("这道题的复习结果没存上，已还原，请再试一次", "Failed to save the result; reverted"),
                );
            } finally {
                busyRef.current.delete(item.id);
            }
        },
        [volume, fetchVolumeMarks, saveItemMark, L],
    );

    /** 这一卷专用的来源值（复练纸 / 模仿纸）—— 由卷的 `kind` 定 */
    const markSource = useMemo(() => paperSourceForKind(volume?.kind), [volume?.kind]);

    /**
     * 【2026-10-17 空空第 2 条】点题框左边那个「会」字方框 ⇒ 切换"已掌握 / 未掌握"，**即时入库**。
     *
     * ⚠️ 下一档**只许用 `nextMasteryLevel()`**（唯一实现 `lib/level-settle.ts`）——
     *    详情页曾自己写 `> 0 ? 0 : 1`，把"已掌握"写成了 1，卡片一直显示"待复习"（10-17 修）。
     *    📌 有看门测试盯着（`unit/mastery-toggle-guard.test.ts`）。
     * ⚠️ 走的是 `PATCH /mastery`（不是 PUT）—— 那条路由里带着**题间从属关系**的规则
     *    （人工标附题 ⇒ 断开；标主题 ⇒ 附题跟着标），PUT 那条不管这件事。
     */
    /** 同一道题的"掌握状态"正在写 —— 防连点把两次相反的操作发成一对（返回顺序不定 ⇒ 最终状态随机） */
    const masteryBusyRef = useRef<Set<string>>(new Set());

    /**
     * 点「会」字方框 ⇒ **即时**切换"已掌握 / 未掌握"。
     *
     * ⚠️⚠️【2026-10-18 如如】这个函数按"防连点 + 以服务端为准"重写了。
     *
     * 空空 2026-10-18 报的第 3 条（*"有时候好像没有落定……又不确定是不是我眼花了"*）
     * 是典型的**竞态**特征，而原来这里恰好有两个口子：
     *   ① **没有防连点**：手指连点两下 ⇒ 两个方向相反的 PATCH 同时在飞，
     *      谁后返回谁赢 ⇒ 最终是"绿"还是"灰"**全看运气**（这就是"有时候对有时候不对"）；
     *   ② **只信本地算的 `next`**，不看服务端回了什么 ⇒ 一旦服务端因为题间从属规则
     *      （主题会向附题传播）算出别的值，界面就与库里分叉，而且再点一次会"反向抵消"。
     *
     * ⇒ 现在：同一道题同一时间只发一次请求；写成功后**用服务端返回的 `masteryLevel` 对齐**。
     *   失败才回滚，并给出可见提示（不再静默）。
     */
    const onMasteryToggle = useCallback(
        async (item: ErrorItem) => {
            if (masteryBusyRef.current.has(item.id)) return;
            const next = nextMasteryLevel(item.masteryLevel);
            const before = item.masteryLevel;
            masteryBusyRef.current.add(item.id);
            setSaveError(null);
            patchItem(item.id, { masteryLevel: next });
            try {
                const saved = await apiClient.patch<{ masteryLevel?: number }>(
                    `/api/error-items/${item.id}/mastery`,
                    { masteryLevel: next },
                );
                /** 以服务端为准：它可能因为题间从属规则改了别的题，而本题一定回的是真值 */
                if (typeof saved?.masteryLevel === 'number' && saved.masteryLevel !== next) {
                    patchItem(item.id, { masteryLevel: saved.masteryLevel });
                }
            } catch (err) {
                console.error(err);
                patchItem(item.id, { masteryLevel: before });
                setSaveError(
                    L('这道题的掌握状态没存上，已还原，请再试一次', 'Failed to save mastery; reverted'),
                );
            } finally {
                masteryBusyRef.current.delete(item.id);
            }
        },
        [patchItem, L],
    );

    /**
     * 【2026-10-16 如如】卷拉回来之后，再拉**这一卷上每道题的复习记录**
     * （决定那圈绿/粉 + 轮次角标，`docs\18` §4.3）。
     *
     * ⚠️ 单独一次请求（不塞进 lookup）：lookup 每次扫页都要跑，而"记录"只有这一屏需要；
     *    而且写完一条之后要能**只重拉这一小块**（见 `writeMark`）。
     * ⚠️ 这个 effect 必须放在 `fetchVolumeMarks` **之后** ——
     *    依赖数组是**当场求值**的，放前面会撞上 `const` 的暂时性死区（真会抛错）。
     */
    useEffect(() => {
        if (volume?.id) void fetchVolumeMarks(volume.id);
    }, [volume?.id, fetchVolumeMarks]);

    /** 点圈：对 ⇄ 错（两态，他 2026-10-16 改定的）。
     *   · 这张卷上还没有记录 ⇒ 新增一条（`add`）
     *   · 已经有记录 ⇒ **改那一条**（`update`）—— "修正这一轮的结果"，不是又录一轮
     *     （要"再录一轮"就走**长按菜单**，这是两态循环与"再录一次"的分工）
     * ⚠️ 点圈**永远不经过"清空"** —— 撤销走长按菜单的"删除这一条"。
     */
    const onReviewMarkTap = useCallback(
        (item: ErrorItem) => {
            if (busyRef.current.has(item.id)) return;
            const cur = markOfItem(item);
            const next = nextReviewMark(cur.mark);
            const optimistic: VolumeMark = cur.eventId
                ? { ...cur, mark: next }
                : { mark: next, eventId: null, rounds: cur.rounds + 1 };
            void writeMark(
                item,
                cur.eventId
                    ? reviewEventUpdateDraft(cur.eventId, next)
                    : reviewEventDraft({
                          outcome: next,
                          plannedIndex: null,
                          volumeId: volume?.id ?? null,
                          source: markSource,
                      }),
                optimistic,
            );
        },
        [markOfItem, writeMark, volume, markSource],
    );

    /**
     * **长按圈 ⇒ 菜单**（他 2026-10-16 定的三项）。
     *
     * ⚠️ 为什么要有这个菜单：两态循环把"撤销"从点击路径里挤出去了
     *    （旧的三态是"再点一下回灰"，而那个中间态还会落库）⇒ 撤销必须另给一个入口。
     */
    const [markMenuItem, setMarkMenuItem] = useState<ErrorItem | null>(null);

    const onReviewMarkLongPress = useCallback((item: ErrorItem) => setMarkMenuItem(item), []);

    /** 菜单里的三个动作 */
    const recordAgain = useCallback(
        (item: ErrorItem, outcome: 'right' | 'wrong') => {
            const cur = markOfItem(item);
            setMarkMenuItem(null);
            void writeMark(
                item,
                reviewEventDraft({
                    outcome,
                    plannedIndex: null,
                    volumeId: volume?.id ?? null,
                    source: markSource,
                }),
                { mark: outcome, eventId: null, rounds: cur.rounds + 1 },
            );
        },
        [markOfItem, writeMark, volume, markSource],
    );

    const deleteLatestMark = useCallback(
        (item: ErrorItem) => {
            const cur = markOfItem(item);
            setMarkMenuItem(null);
            if (!cur.eventId) return;
            /**
             * 删掉最近这一条之后圆该回到什么？
             * **不猜** —— 让服务端重算（`fetchVolumeMarks` 会给出上一轮的结果）；
             * 乐观值先按"没有记录"画，宁可闪一下也不显示一个可能错的颜色。
             */
            void writeMark(item, reviewEventDeleteDraft(cur.eventId), EMPTY_VOLUME_MARK);
        },
        [markOfItem, writeMark],
    );

    /* ══════════════════════════════════════════════════════════════════════
     * 【2026-10-17 空空第 3 条】点**灰色答案框** ⇒ 对话框里看/改**完整答案**
     *
     * 他的原话（改章程）：*"有些答案比较长，可能不容易对答案……尽管看住了孩子不直接抄答案，
     *   但事实上也限制住了家长对答案，而且限制孩子抄答案这个过程本身也是掩耳盗铃的。"*
     * ⇒ 点灰框弹出：上面三个按钮【积累 / 保存 / 关闭】+ 左边写"N题"（这道题在这张卷的流水号），
     *   下面一个 md 编辑框（**内部滚动**，所以按钮永远看得见）。
     * ⚠️ 遮罩用 Radix Dialog 自带的半透明层 ⇒ 看长答案时后面的卷面**不会跟着滚**。
     * ══════════════════════════════════════════════════════════════════════ */

    /** 正在看答案的那道题（null = 对话框关着） */
    const [answerItem, setAnswerItem] = useState<ErrorItem | null>(null);
    const [answerDraft, setAnswerDraft] = useState("");
    const [answerBusy, setAnswerBusy] = useState(false);
    /** 答案改过没有 —— 两个用途：关闭时问"保存吗"、md 框外边框变橙 */
    const answerDirty = !!answerItem && answerDraft !== (answerItem.answerText ?? "");

    /** 这道题在**这张卷**上的流水号（对话框标题左边那个"1题"） */
    const seqOfItem = useCallback(
        (itemId: string) => (volume?.items || []).find((r) => r.errorItemId === itemId)?.seqInVolume ?? null,
        [volume],
    );

    const openAnswer = useCallback((item: ErrorItem) => {
        setAnswerItem(item);
        setAnswerDraft(item.answerText ?? "");
        setInsightOpen(false);
    }, []);

    /** 保存答案（只改 `answerText`，别的一个字不动） */
    const saveAnswer = useCallback(async (): Promise<boolean> => {
        if (!answerItem) return false;
        setAnswerBusy(true);
        try {
            await apiClient.put(`/api/error-items/${answerItem.id}`, { answerText: answerDraft });
            patchItem(answerItem.id, { answerText: answerDraft });
            /**
             * ⚠️ 本地那份 `answerItem` 也要更新 —— 否则"改过没有"一直为真（橙边不消失），
             *    而且下次打开会读到旧答案。
             */
            setAnswerItem((prev) => (prev ? { ...prev, answerText: answerDraft } : prev));
            setItems((prev) => prev.map((it) => (it.id === answerItem.id ? { ...it, answerText: answerDraft } : it)));
            return true;
        } catch (err) {
            console.error(err);
            setSaveError(L("答案没存上，请再试一次", "Failed to save the answer"));
            return false;
        } finally {
            setAnswerBusy(false);
        }
    }, [answerItem, answerDraft, patchItem, L]);

    /**
     * 关闭：**改过就问一句**（他明确要的）。
     * `confirm` 的 OK = 保存并关闭，Cancel = 不保存直接关闭 —— 两选项正好对上他说的那两句。
     */
    const closeAnswer = useCallback(async () => {
        if (answerBusy) return;
        if (answerDirty) {
            const save = window.confirm(
                L("答案改过了，保存吗？\n\n确定 = 保存后关闭\n取消 = 不保存，直接关闭", "Save the edited answer?"),
            );
            if (save) {
                const ok = await saveAnswer();
                if (!ok) return; // 存失败就**别关**（否则改动白丢）
            }
        }
        setAnswerItem(null);
        setAnswerDraft("");
    }, [answerBusy, answerDirty, saveAnswer, L]);

    /* ── 嵌套的"这道题的积累"（点【积累】打开；关掉就回到答案对话框）─────────────────
     * 用的是详情页那套接口：`GET /api/insights?errorItemNo=…` + `POST /api/insights`
     * （服务端按**题号**当钥匙：有就覆盖、没有才新建）。 */
    const [insightOpen, setInsightOpen] = useState(false);
    const [insightDraft, setInsightDraft] = useState("");
    const [insightBusy, setInsightBusy] = useState(false);

    const openInsight = useCallback(async () => {
        if (!answerItem?.source) return;
        setInsightOpen(true);
        setInsightDraft("");
        try {
            const res = await apiClient.get<{ insights: Array<{ content: string | null }> }>(
                `/api/insights?errorItemNo=${encodeURIComponent(answerItem.source)}`,
            );
            setInsightDraft(res?.insights?.[0]?.content ?? "");
        } catch (err) {
            console.error(err);
            setSaveError(L("这道题的积累没读上来", "Failed to load the notes"));
        }
    }, [answerItem, L]);

    const saveInsight = useCallback(async () => {
        if (!answerItem?.source) return;
        setInsightBusy(true);
        try {
            await apiClient.post("/api/insights", {
                dateKey: dayKey(new Date()),
                gradeSemester: answerItem.gradeSemester || null,
                subject: answerItem.notebook?.subject || null,
                content: insightDraft,
                errorItemNo: answerItem.source,
                source: "question",
            });
            setInsightOpen(false); // 存完回到答案对话框
        } catch (err) {
            console.error(err);
            setSaveError(L("积累没存上，请再试一次", "Failed to save the notes"));
        } finally {
            setInsightBusy(false);
        }
    }, [answerItem, insightDraft, L]);

    /** 点升降框：第一次改类型、第二次改回来（都乐观 + 失败回滚） */    const onPromoteToggle = useCallback(
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
     * 【2026-10-11】每题在**这一卷里**的留白行数（卷内快照的 `blankLines`）。
     *
     * 与上面 `figureScaleOf` 同一个道理：扫码这屏是**看印出去的那张纸**，
     * 留白也得按卷里记的值渲染，否则"纸上题与题之间空 5 行、屏上却挤在一起"，对不上。
     * ⚠️ 2026-10-01 起**只给模仿卷用**（模仿纸右栏的"每题留白 5 行"是他明确要的），
     *    复练卷那条路一直按 0 行渲染，差异当时单独提给他确认过。
     *    【2026-10-12 需求第 4 条·他回了】原话："目前是都不显示留白了，现在我有点后悔，
     *    还是把留白给显示出来吧。我了解到，至少现在复练卷是没有留白的。"
     *    ⇒ 复练卷那一路现在也传 `blankValueOf`（见下面 `ReviewSheet` 那里）。
     */
    const blankOf = useMemo(() => {
        const map: Record<string, number> = {};
        for (const r of volume?.items || []) {
            if (r.errorItemId) map[r.errorItemId] = r.blankLines ?? 0;
        }
        return (id: string) => map[id] ?? 0;
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
        // 【2026-10-11】条件改成 `layoutReady`（两个纸别都认）——
        // 原来写 `!layout`，模仿卷那条路上它是 null，会直接 return（永远不滚到那一页）。
        if (!layoutReady || loading) return;
        const key = `${volume?.id ?? ""}#${pageNo}`;
        if (jumpedKeyRef.current === key) return;
        const el = pageRefs.current[Math.min(pageNo, pageTotal)];
        if (!el) return;
        jumpedKeyRef.current = key;
        const raf = requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
        return () => cancelAnimationFrame(raf);
    }, [layoutReady, pageTotal, loading, pageNo, volume?.id]);

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

    if (error || !volume || !layoutReady) {
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
                    {L(`第 ${Math.min(pageNo, pageTotal)} 页 / 共 ${pageTotal} 页`, `Page ${Math.min(pageNo, pageTotal)} of ${pageTotal}`)}
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

            {/* ===== 【2026-10-16 如如】长按那颗圆 ⇒ 菜单（他定的三项）=====
                出处：`docs\18` §4.3。为什么要有它：**两态循环把"撤销"挤出了点击路径**
                （旧的三态是"再点一下回灰"，中间态还会落库）⇒ 撤销得另给一个入口。

                ⚠️ 实现选择：用**对话框**（`Dialog`）而不是贴着圈的浮层 ——
                   纸面是**缩放过的**、外面还套着滚动容器，浮层要处理缩放/裁剪/定位三件事；
                   这里是"三个动作"，用对话框在手机上和电脑上**手感一致**、也不会被裁掉。
                   （这一条是我定的，规格只说"弹菜单"，**留给空空/下一棒复核**。） */}
            <Dialog
                open={!!markMenuItem}
                onOpenChange={(open) => {
                    if (!open) setMarkMenuItem(null);
                }}
            >
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>{L("这道题的复习结果", "This question's review result")}</DialogTitle>
                        <DialogDescription>
                            {markMenuItem
                                ? L(
                                      `「${markMenuItem.source || markMenuItem.id}」在这张卷上已录 ${markOfItem(markMenuItem).rounds} 轮。`,
                                      `${markOfItem(markMenuItem).rounds} round(s) recorded on this paper.`,
                                  )
                                : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Button
                            variant="outline"
                            className="w-full justify-start"
                            onClick={() => markMenuItem && recordAgain(markMenuItem, 'right')}
                        >
                            <span style={{ color: REVIEW_MARK_COLORS.right.bg }} className="mr-2 font-bold">
                                ✓
                            </span>
                            {L("再录一次：对", "Record again: correct")}
                        </Button>
                        <Button
                            variant="outline"
                            className="w-full justify-start"
                            onClick={() => markMenuItem && recordAgain(markMenuItem, 'wrong')}
                        >
                            <span style={{ color: REVIEW_MARK_COLORS.wrong.fg }} className="mr-2 font-bold">
                                ✗
                            </span>
                            {L("再录一次：错", "Record again: wrong")}
                        </Button>
                        <Button
                            variant="outline"
                            className="w-full justify-start text-rose-600"
                            /* 这张卷上还没有记录 ⇒ 没有"这一条"可删（按钮灰着，而不是点了没反应） */
                            disabled={!markMenuItem || !markOfItem(markMenuItem).eventId}
                            onClick={() => markMenuItem && deleteLatestMark(markMenuItem)}
                        >
                            {L("删除这一条", "Delete the latest record")}
                        </Button>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setMarkMenuItem(null)}>
                            {L("取消", "Cancel")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ══════════════════════════════════════════════════════════════
                【2026-10-17 空空第 3 条】点灰色答案框 ⇒ **看 / 改完整答案**
                · 上面一行：左边"N题"（这道题在这张卷的流水号），右边三个按钮【积累】【保存】【关闭】
                · 下面：md 编辑框，**框内滚动**（所以按钮永远看得见，看长答案也能随时操作）
                · md 框改过 ⇒ 外边框变橙（`dirty` 那个现成的机制，与详情页同一个编辑器）
                · 遮罩是 Radix Dialog 自带的半透明层 ⇒ 后面卷面不会跟着滚
                ══════════════════════════════════════════════════════════════ */}
            <Dialog
                open={!!answerItem}
                onOpenChange={(open) => {
                    if (!open) void closeAnswer();
                }}
            >
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <div className="flex flex-wrap items-center gap-2">
                            <DialogTitle className="mr-auto font-mono text-base">
                                {answerItem
                                    ? `${seqOfItem(answerItem.id) ?? "?"}题`
                                    : L("答案", "Answer")}
                            </DialogTitle>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!answerItem?.source}
                                title={
                                    answerItem?.source
                                        ? L("管理这道题的积累内容", "Manage this question's notes")
                                        : L("这道题还没有题号，没法关联积累", "No question number, cannot link notes")
                                }
                                onClick={() => void openInsight()}
                            >
                                {L("积累", "Notes")}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={answerBusy || !answerDirty}
                                onClick={() => void saveAnswer()}
                            >
                                {answerBusy ? L("保存中…", "Saving…") : L("保存", "Save")}
                            </Button>
                            <Button type="button" size="sm" onClick={() => void closeAnswer()}>
                                {L("关闭", "Close")}
                            </Button>
                        </div>
                    </DialogHeader>
                    {/* `max-h` + `overflow-y-auto`：**框里滚**，不靠对话框长高 */}
                    <div className="max-h-[62vh] overflow-y-auto rounded-md">
                        <MdEditor
                            value={answerDraft}
                            onChange={setAnswerDraft}
                            placeholder={L("这道题的答案（可编辑）", "This question's answer (editable)")}
                            minHeightPx={240}
                            dirty={answerDirty}
                        />
                    </div>
                </DialogContent>
            </Dialog>

            {/* 【2026-10-17 第 3 条】嵌套的"这道题的积累" —— 关掉回到上面的答案对话框 */}
            <Dialog
                open={insightOpen}
                onOpenChange={(open) => {
                    if (!open) setInsightOpen(false);
                }}
            >
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>
                            {L("这道题的积累", "Notes for this question")}
                            {answerItem?.source ? (
                                <span className="ml-2 font-mono text-xs text-muted-foreground">
                                    {answerItem.source}
                                </span>
                            ) : null}
                        </DialogTitle>
                        <DialogDescription>
                            {L(
                                "写这道题的理解、易错点、一句话要点都行；保存后与「日积月累」里那条是同一个。",
                                "Saved into the same note as the Insights page.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="max-h-[55vh] overflow-y-auto rounded-md">
                        <MdEditor
                            value={insightDraft}
                            onChange={setInsightDraft}
                            placeholder={L("写点什么…", "Write something…")}
                            minHeightPx={200}
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setInsightOpen(false)}>
                            {L("返回", "Back")}
                        </Button>
                        <Button disabled={insightBusy} onClick={() => void saveInsight()}>
                            {insightBusy ? L("保存中…", "Saving…") : L("保存并返回", "Save & back")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <div
                ref={scrollRef}
                className="max-h-[78vh] overflow-auto rounded-md border bg-zinc-100 p-3 dark:bg-zinc-900"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerLeave={endDrag}
            >
                {/* 【T4】模仿卷的隐藏量尺 —— **必须在 `SheetZoom` 外面**：
                    缩放会让 `getBoundingClientRect()` 拿到缩放后的像素，量出来的 mm 整体偏小，
                    左栏分页就会以为"一页能装更多"。左栏用的是正式版面那个 `ImitateSegments`。 */}
                {isImitate && imitateTheme && (
                    <div
                        ref={imitateMeasureRef}
                        aria-hidden="true"
                        className="print-review-measure no-print"
                        style={{ width: `${VOLUME_VARIANTS.imitate.columnWidthMM}mm` }}
                    >
                        <ImitateSegments specs={imitateSpecs} theme={imitateTheme} L={L} />
                        {imitateRightRows.map((r) => {
                            const it = itemByKey[r.key];
                            if (!it) return null;
                            return (
                                <ReviewQuestionBlock
                                    key={r.key}
                                    item={it}
                                    seq={r.seq}
                                    blankLines={blankOf(it.id)}
                                    showDivider={false}
                                    figureScale={figureScaleOf(it.id)}
                                    L={L}
                                />
                            );
                        })}
                    </div>
                )}
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
                    {isImitate
                        ? imitateLayout?.sheets.map((sheet, i) => (
                              <div
                                  key={i}
                                  ref={(el) => {
                                      pageRefs.current[i + 1] = el;
                                  }}
                                  className="mb-4"
                              >
                                  <ImitateSheet
                                      sheet={sheet}
                                      segmentByKey={imitateSegmentByKey}
                                      theme={imitateTheme}
                                      themeNo={imitateThemeNo}
                                      pageNo={i + 1}
                                      pageCount={imitateLayout.sheets.length}
                                      volumeNo={volume.volumeNo}
                                      kind="imitate"
                                      printDate={new Date()}
                                      emojiMark={volume.emojiMark}
                                      pageQr={pageQr[i + 1]}
                                      itemByKey={itemByKey}
                                      missing={missingMap}
                                      blankValueOf={blankOf}
                                      figureScaleOf={figureScaleOf}
                                      /* 他设计稿第 8 条：右栏每道附题一个蓝框加号；
                                         左栏的主题**只有第 1 页**有 —— 由组件自己判（见 `themeOverlay`）。 */
                                      onQuestionPlusClick={onPickItem}
                                      onThemePlusClick={onPickItem}
                                      plusTitle={L("点这里 → 打开这道题的错题卡", "Open this question's card")}
                                      answerOf={answerOf}
                                      onPromoteToggle={onPromoteToggle}
                                      promoteOverrideOf={promoteOverrideOf}
                                      onReviewMarkTap={onReviewMarkTap}
                                      reviewMarkOf={(it) => markOfItem(it).mark}
                                      onReviewMarkLongPress={onReviewMarkLongPress}
                                      reviewRoundsOf={(it) => markOfItem(it).rounds}
                                      reviewMarkDisabledOf={(it) => Number(it.masteryLevel) >= 2}
                                      masteryOf={(it) => Number(it.masteryLevel) >= 2}
                                      onMasteryToggle={onMasteryToggle}
                                      onAnswerClick={openAnswer}
                                      highlightItemId={highlightItemId ?? null}
                                      L={L}
                                  />
                              </div>
                          ))
                        : layout?.pages.map((page, i) => (
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
                                /* 【2026-10-12 需求第 4 条】**复练卷也要把留白显出来**。
                                   他原话："手机端扫描浏览的卷……显示的卷上有方框和中间加号，
                                   目前是都不显示留白了，现在我有点后悔，还是把留白给显示出来吧。
                                   我了解到，至少现在复练卷是没有留白的。"
                                   成因就是这一行原来**没传** `blankValueOf`（模仿卷那一路传了）——
                                   于是复练卷的每一道题都按 0 行留白画，孩子拿它对着纸根本对不上。
                                   留白值取自卷快照（`blankOf` 走 `volume.items`），与印出去的那张纸一致。 */
                                blankValueOf={blankOf}
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
                                reviewMarkOf={(it) => markOfItem(it).mark}
                                onReviewMarkLongPress={onReviewMarkLongPress}
                                reviewRoundsOf={(it) => markOfItem(it).rounds}
                                reviewMarkDisabledOf={(it) => Number(it.masteryLevel) >= 2}
                                masteryOf={(it) => Number(it.masteryLevel) >= 2}
                                onMasteryToggle={onMasteryToggle}
                                onAnswerClick={openAnswer}
                                highlightItemId={highlightItemId ?? null}
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
