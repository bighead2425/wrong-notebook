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
    Eraser,
    House,
    PanelLeftClose,
    PanelLeftOpen,
    Pencil,
    Printer,
    ScanLine,
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
import { ImitateSegments, ImitateSheet } from "@/components/print/imitate-card";
import {
    buildImitateSegments,
    imitateLayoutFromSnapshot,
    readImitateHeights,
    themeRowOfSnapshot,
    type ImitateSegment,
    type ImitateSegmentSpec,
} from "@/lib/imitate-card";
import { SheetZoom } from "@/components/print/sheet-zoom";
import { ScanVolumeView } from "@/components/scan-volume-view";
import { ScanItemPanel } from "@/components/scan-item-panel";
import {
    VOLUME_VARIANTS,
    blankLinesFromDrag,
    figureScaleFromDrag,
    layoutFromSnapshot,
    normalizeBlankLines,
    normalizeFigureScale,
    pageFits,
    pageUsageMM,
    type SnapshotRow,
} from "@/lib/review-card";
import {
    VOLUME_KINDS,
    VOLUME_KIND_LABEL,
    VOLUME_KIND_LABEL_EN,
    buildPageCode,
    type VolumeKind,
} from "@/lib/volume-code";
import { GRADE_TERMS, normalizeTerm, volumeMatchesTerm } from "@/lib/grade-term";
import { SUBJECT_OPTIONS, subjectLabel } from "@/lib/notebook-fields";
import {
    reviewLayoutDirty,
    shouldWarnBeforeLeaving,
    unsavedLeaveMessage,
    type ReviewLayoutBaseline,
} from "@/lib/unsaved-guard";

/**
 * 【2026-10-11 他定】"上次检索的年级/学期留在缓存"——
 * 这个 key 存的是**年级/学期**那一个筛选（学科刻意不存，见下面那两段 effect）。
 */
const GRADE_TERM_CACHE_KEY = "wrong-notebook:review-volumes:term";

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
    /** 【2026-09-30】卷的学科（从题号前缀反推，跨学科组卷会给多个） */
    subjectKeys?: string[];
    /** 【2026-10-03 需求第 10 条】这份卷的随机 emoji 标识（整卷所有页共用） */
    emojiMark?: string | null;
}

/**
 * 【2026-10-09】卷列表接口的返回：多了一个 `nextCursor`。
 * 非 null ⇒ 还有更早的卷，拿它再要一页（滚到底自动加载，也可以点按钮）。
 */
interface VolumeListResponse {
    volumes: VolumeSummary[];
    nextCursor?: string | null;
}

/**
 * 【2026-10-09】一次要多少份卷。
 *
 * 50 是"一屏多一点"的量：既不用等太久，也不至于翻两下就到底。
 * ⚠️ 它是**单次**的批量，不是总量上限 —— 往下翻多少页都行（他要的正是这个）。
 */
const VOLUME_PAGE_SIZE = 50;

interface VolumeItemRow {
    id: string;
    seqInVolume: number;
    pageIndex: number;
    columnIndex: number;
    seqInColumn: number;
    errorItemId: string | null;
    /** 【2026-10-01】积累卷：这一行印的是哪条日积月累（与 errorItemId 互斥） */
    insightId: string | null;
    itemNo: string | null;
    questionText: string | null;
    /** 图快照（JSON 数组字符串）。积累卷里装的是积累条目的配图。 */
    figureUrls: string | null;
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
    // 【2026-10-03】这里原先有 `const router = useRouter()`：只为【扫码图】里"点加号跳 /scan"。
    // 那条路已改成**页内叠一层**（见 `scanItemId`），本页再无跳转需求 ⇒ 一并去掉，免得留个没用的变量。

    // ---------- 左栏：卷列表 ----------
    const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
    const [listLoading, setListLoading] = useState(true);
    const [listError, setListError] = useState("");
    /** 【2026-10-09】还有更早的卷没拿（null = 已经到底了） */
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    /** 【2026-10-09】正在要下一页（防止滚到底时连点、连发请求） */
    const [listLoadingMore, setListLoadingMore] = useState(false);
    /** 列表滚动容器 + 底部哨兵（滚到哨兵露头就自动要下一页） */
    const listScrollRef = useRef<HTMLDivElement | null>(null);
    const listSentinelRef = useRef<HTMLDivElement | null>(null);
    /**
     * 【2026-10-11 他定】检索框改成**回车才搜**（"不设为即时检索……省一点计算资源"）：
     *   `queryDraft` = 输入框里正在打的字，`query` = **已经打给服务端的那一次**。
     *   两者分开，边上那个「清空条件」才是真的清空（否则清了输入框、列表却还是旧结果）。
     */
    const [query, setQuery] = useState("");
    const [queryDraft, setQueryDraft] = useState("");
    /**
     * 【2026-10-11 他定】这一页现在管**两种卷**：复练（RE）与模仿（CO）——
     * 积累纸不进这一页（它单独走「日积月累 → 积累纸·打印」）。
     * ⚠️ 没有"全部"这一档了：他原话是"一个是'全部'改为'复练'，另一个是'复练'改为'模仿'"。
     */
    const [kindFilter, setKindFilter] = useState<VolumeKind>("review");
    /**
     * 【2026-09-30 他拍的板：换成两个筛选】
     *   ① 年级/学期（小一上 … 高三下，18 个）—— 卷快照里有 gradeSemester
     *   ② 学科（9 科 + 其他）—— 卷没存学科，从题号前缀反推（`SX…` → 数学）
     * 原来那个"全部学期"（2026-秋 这种）对管理没用，去掉。
     * 两者可叠加；都能通过 URL 带进来（从错题本页的「复练卷」按钮跳过来时）。
     */
    const [gradeTermFilter, setGradeTermFilter] = useState<string>("");
    const [subjectFilter, setSubjectFilter] = useState<string>("");
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
    const figureDragRef = useRef<{ id: string; startX: number; startY: number; startPx: number } | null>(null);
    const dividerDragRef = useRef<{ id: string; startY: number; startLines: number } | null>(null);
    const [pageQr, setPageQr] = useState<Record<number, string>>({});
    const [printDate] = useState(() => new Date());

    /**
     * 【2026-10-03 需求第 4 条】**已保存版面的基线** —— 脏检查拿它和当前草稿比。
     * 打开卷时按快照记下；点【更新组卷】保存成功后，刷新成"刚存下去的那版"。
     * （不复用 `detail.items`：`updateVolume` 的 PATCH 只回 `VolumeSummary`、不带 items，
     *   拿旧快照当基线会让"刚保存完还是脏的" —— 按钮不消失、切卷还弹确认。）
     */
    const [savedBaseline, setSavedBaseline] = useState<ReviewLayoutBaseline | null>(null);

    /**
     * 【2026-10-03 需求第 5 条】【扫码图】：非空 ⇒ 整屏切成"扫到的复练卷"
     * （复用 `ScanVolumeView`，参数是这份卷的**卷号 + 第 1 页**的页二维码内容）。
     */
    const [scanCode, setScanCode] = useState<string | null>(null);

    /**
     * 【2026-10-03 下午·他要求】扫码图那一屏里**再叠的一层**："扫到的这道题"
     * （点题块中间那个蓝底白加号进来）。
     *
     * 为什么放在本页而不是跳 `/scan`：他实测后指出 —— 跳过去之后那页的返回键
     * 一路通向"回到复练卷 → 回到扫一扫"，**那是另一个流程**（真的扫码入口）。
     * 他要在本页内形成闭环：预览 ⇒【扫码图】⇒ 扫到的复练卷 ⇒ 点加号 ⇒ 扫到的这道题
     * ⇒【回到复练卷】**回到本页的扫码图**。
     */
    const [scanItemId, setScanItemId] = useState<string | null>(null);

    /** 退出【扫码图】整组（连里面那层"扫到的这道题"一起清掉） */
    const closeScan = useCallback(() => {
        setScanItemId(null);
        setScanCode(null);
    }, []);

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

    /**
     * 【2026-10-09】列表查询串 —— **筛选一律在服务端**。
     *
     * 为什么必须这样（这是"卷超过 200 份会看不见"那个隐患的修法）：
     * 原来前端写死 `limit=200`，然后在**拿到的那 200 份里**做搜索/学期/学科筛选
     * ⇒ 第 201 份及更早的，在这个页面上既不出现、也搜不到。
     * 现在改成"单次一页 + 滚到底再要下一页"，筛选条件跟着每一次请求一起发上去。
     * ⚠️ 配套条件：**筛选必须在服务端**。只加翻页不改筛选，搜索仍然只搜"已加载的那几页"。
     */
    const buildListQuery = useCallback(
        (cursor: string | null) => {
            const qs = new URLSearchParams();
            qs.set("limit", String(VOLUME_PAGE_SIZE));
            // 没有"全部"这一档了 ⇒ 每次都要带 kind
            qs.set("kind", kindFilter);
            if (gradeTermFilter) qs.set("term", gradeTermFilter);
            if (subjectFilter) qs.set("subject", subjectFilter);
            if (query.trim()) qs.set("q", query.trim());
            if (cursor) qs.set("cursor", cursor);
            return qs.toString();
        },
        [kindFilter, gradeTermFilter, subjectFilter, query],
    );

    const fetchList = useCallback(async () => {
        setListLoading(true);
        setListError("");
        try {
            const res = await apiClient.get<VolumeListResponse>(
                `/api/review-volumes?${buildListQuery(null)}`,
            );
            setVolumes(res.volumes || []);
            setNextCursor(res.nextCursor ?? null);
        } catch (error) {
            console.error("Failed to load volumes:", error);
            setListError(L("加载卷列表失败", "Failed to load volumes"));
        } finally {
            setListLoading(false);
        }
    }, [L, buildListQuery]);

    useEffect(() => {
        fetchList();
    }, [fetchList]);

    /** 【2026-10-09】滚到底／点按钮 ⇒ 再要一页，**追加**在后面（不替换） */
    const loadMoreVolumes = useCallback(async () => {
        if (!nextCursor || listLoadingMore) return;
        setListLoadingMore(true);
        try {
            const res = await apiClient.get<VolumeListResponse>(
                `/api/review-volumes?${buildListQuery(nextCursor)}`,
            );
            setVolumes((prev) => {
                // 去重兜底：翻页期间别的地方新建/删除了卷时，同一条可能被发回来两次
                const seen = new Set(prev.map((v) => v.id));
                return [...prev, ...(res.volumes || []).filter((v) => !seen.has(v.id))];
            });
            setNextCursor(res.nextCursor ?? null);
        } catch (error) {
            console.error("Failed to load more volumes:", error);
            setListError(L("加载更多失败，再点一次试试", "Failed to load more"));
        } finally {
            setListLoadingMore(false);
        }
    }, [nextCursor, listLoadingMore, buildListQuery, L]);

    /**
     * 【2026-10-09】滚到底自动加载下一页（他说的"上拉显示更多"）。
     *
     * 用 `IntersectionObserver` 盯列表**底部那个哨兵**：它一露头就要下一页。
     * ⚠️ `root` 必须是**列表自己的滚动容器**（不是视口）——列表是
     *    `max-h-[62vh] overflow-y-auto` 的一个框，用默认视口当 root 的话，
     *    这个框永远"在视口里"，哨兵会一直被认为可见 ⇒ 一进页面就把所有页全拉下来。
     * ⚠️ 浏览器不支持 `IntersectionObserver`（老 Safari）也不会出事：
     *    下面那个「加载更多」**按钮一直都在**，手动点一样能用。
     */
    useEffect(() => {
        const root = listScrollRef.current;
        const target = listSentinelRef.current;
        if (!root || !target || !nextCursor) return;
        if (typeof IntersectionObserver === "undefined") return;
        const io = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) void loadMoreVolumes();
            },
            { root, rootMargin: "120px" },
        );
        io.observe(target);
        return () => io.disconnect();
    }, [nextCursor, loadMoreVolumes]);

    /**
     * 【2026-09-30】从错题本页的「复练卷」按钮跳过来时带了 `?grade=…&subject=…`：
     * 直接把这本对应的卷筛出来（他要的"从错题本中可以直接进入复练卷页，
     * 并已经筛选出关于这个错题本的所有复练卷"）。
     * 用 `window.location` 而不是 `useSearchParams`（后者会把页面拖进 Suspense 边界）。
     * 年级/学期走 `normalizeTerm` 归一：`六年级上` / `小六上` 两种写法都认。
     */
    useEffect(() => {
        const qs = new URLSearchParams(window.location.search);
        const grade = qs.get("grade");
        const subject = qs.get("subject");
        if (grade) setGradeTermFilter(normalizeTerm(grade) || grade);
        if (subject) setSubjectFilter(subject);
        /**
         * 【2026-10-03】深链：`?vol=<卷 id>&scan=<第 1 页二维码内容>` ⇒
         * 打开这一卷**并直接进【扫码图】**那一屏。
         * 谁在用：① 扫码图里点【打开详情页】再退回来（`ScanItemPanel` 的 `backTo` 就拼这个地址）；
         *        ② 在扫码图那一屏刷新页面时不丢这一屏。
         */
        const vol = qs.get("vol");
        const scan = qs.get("scan");
        if (vol) {
            setSelectedId(vol);
            void openVolume(vol).then(() => {
                if (scan) setScanCode(scan);
            });
        }
        // `openVolume` 是 useCallback([L, closeScan])：进依赖会随语言切换重建 ⇒ 只在挂载时跑一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
            // 换卷 ⇒ 退出【扫码图】整组，并把旧基线清掉（新数据到了再立）
            closeScan();
            setSavedBaseline(null);
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
                // 基线 = 刚打开时这份卷的版面（脏检查的起跑线）
                setSavedBaseline({
                    defaultBlankLines: volume.defaultBlankLines,
                    blankLines: blanks,
                    figureScale: figures,
                });
            } catch (error) {
                console.error("Failed to open volume:", error);
                setNotice(L("打开这份卷失败", "Failed to open this volume"));
                setDetail(null);
            } finally {
                setDetailLoading(false);
            }
        },
        [L, closeScan],
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

    /* ===== 【T4 · 2026-10-11】模仿卷 =====
       它与复练卷最大的不同：**左栏是"主题"的内容**（题干 → 图 → 遮挡线 → 参考答案 → 解析）。
       待遇两条流不一样（他设计稿里写得很准）：
         · **右栏**（附题）只认快照 —— 页归属锁死，扫码要对得上这一页；
         · **左栏**（主题）按主题**现算**（快照里只存了主题题号，不存分段结果）。
       主题被删 ⇒ 整卷作废（`ImitateSheet` 自己出一张"此卷作废"的白纸）。 */
    const imitateThemeKey = kind === "imitate" ? (themeRowOfSnapshot(snapshotRows)?.key ?? null) : null;
    /** 主题本体（可能是 null：题已被删） */
    const imitateTheme = useMemo(
        () => (imitateThemeKey ? (items.find((i) => i.id === imitateThemeKey) ?? null) : null),
        [imitateThemeKey, items],
    );
    const imitateSpecs = useMemo(
        () => (imitateTheme ? buildImitateSegments(imitateTheme, { hasFigure: true }) : []),
        [imitateTheme],
    );
    const imitateSegmentByKey = useMemo(() => {
        const map: Record<string, ImitateSegmentSpec> = {};
        for (const s of imitateSpecs) map[s.key] = s;
        return map;
    }, [imitateSpecs]);
    /** 右栏那些行（快照里 `columnIndex !== 0` 的），按页序 → 页内序排好 */
    const imitateRightRows = useMemo(
        () =>
            snapshotRows
                .filter((r) => r.columnIndex !== 0)
                .sort((a, b) => a.pageIndex - b.pageIndex || a.seqInColumn - b.seqInColumn),
        [snapshotRows],
    );
    /** 左栏的段（量好高度的那一份）—— `null` = 还没量到 */
    const [imitateSegments, setImitateSegments] = useState<ImitateSegment[] | null>(null);
    const imitateMeasureRef = useRef<HTMLDivElement | null>(null);
    const imitateMeasureKey = useMemo(
        () =>
            [
                imitateThemeKey ?? "",
                imitateSpecs.map((s) => s.key).join("|"),
                JSON.stringify(figureScales),
                imitateRightRows.map((r) => r.key).join("|"),
            ].join("#"),
        [imitateThemeKey, imitateSpecs, figureScales, imitateRightRows],
    );
    useEffect(() => {
        if (kind !== "imitate") {
            setImitateSegments(null);
            return;
        }
        // 主题没了 ⇒ 左栏一个段都没有（"作废"那张白纸不需要量）
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
    }, [kind, imitateMeasureKey]);

    /** 模仿卷的版面：右栏按快照、左栏按现算好的段 */
    const imitateLayout = useMemo(
        () =>
            kind === "imitate" && imitateSegments
                ? imitateLayoutFromSnapshot(imitateRightRows, imitateSegments)
                : null,
        [kind, imitateRightRows, imitateSegments],
    );

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

    /**
     * 【2026-10-03 需求第 4 条】复练卷页原来**没有脏检查**（只有积累纸页有）—— 这里补齐：
     * 当前草稿（留白 / 题图）与已保存基线**逐项比**，改过才 `dirty`。
     * 没改 ⇒ 不显示【更新组卷】；改了才显示。
     */
    const dirty = useMemo(() => {
        if (!detail || !savedBaseline) return false;
        return reviewLayoutDirty(savedBaseline, {
            defaultBlankLines: blankDefault,
            blankOverrides,
            figureScales,
        });
    }, [detail, savedBaseline, blankDefault, blankOverrides, figureScales]);

    /** 会丢改动的动作先问一句；点取消返回 false（停在原地、改动还在） */
    const confirmDiscard = useCallback(
        (actionZh: string, actionEn: string) => {
            if (!shouldWarnBeforeLeaving(dirty)) return true;
            return window.confirm(unsavedLeaveMessage(zh, actionZh, actionEn));
        },
        [dirty, zh],
    );

    /** 切换 / 打开另一卷（左栏列表点击）—— 他最常踩的那条，必须拦 */
    const handleOpenVolume = useCallback(
        (id: string) => {
            // 点的是已经打开的这一卷：重载只会白丢草稿，直接不动
            if (dirty && id === selectedId) return;
            if (!confirmDiscard("切换卷", "Switch volume")) return;
            closeScan();
            void openVolume(id);
        },
        [dirty, selectedId, confirmDiscard, openVolume, closeScan],
    );

    /**
     * 【2026-10-03 需求第 4 条】浏览器**关闭 / 刷新**标签页那一手也拦一下：
     * 仅在 `dirty` 时挂监听（没改就正常关，别无故弹原生框）。
     */
    useEffect(() => {
        if (!dirty) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [dirty]);

    /** 页二维码：内容 = 卷号-页码（与打印预览页一模一样，扫回来才能定位到页） */
    /** 【2026-10-11】页数按**纸别**取：复练看 `layout`、模仿看 `imitateLayout` ——
     * 取错就是"二维码只发了前几页"。 */
    const layoutPageCount = kind === "imitate" ? (imitateLayout?.sheets.length ?? 0) : (layout?.pages.length ?? 0);
    const layoutReady = kind === "imitate" ? !!imitateLayout : !!layout;
    const qrKey = detail ? `${detail.volumeNo}:${layoutPageCount}` : "";

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!detail || layoutPageCount === 0) {
                setPageQr({});
                return;
            }
            const entries: Record<number, string> = {};
            await Promise.all(
                Array.from({ length: layoutPageCount }, async (_x, i) => {
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
                const next = figureScaleFromDrag(fig.startPx, e.clientX - fig.startX, e.clientY - fig.startY);
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
            figureDragRef.current = {
                id,
                startX: e.clientX,
                startY: e.clientY,
                startPx: box ? box.getBoundingClientRect().width : 1,
            };
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
            /**
             * 保存成功 ⇒ 把脏检查基线刷成"刚存下去的那版"。
             * ⚠️ 不能省：PATCH 的返回**不带 items**（只有 VolumeSummary），
             *    不刷基线的话 `dirty` 会一直是 true —— 按钮不消失、切卷还弹确认。
             */
            const savedKeys = new Set<string>([...Object.keys(blankOverrides), ...Object.keys(figureScales)]);
            const savedBlanks: Record<string, number> = {};
            const savedFigures: Record<string, number> = {};
            for (const k of savedKeys) {
                savedBlanks[k] = blankValueOf(k);
                savedFigures[k] = figureScaleOf(k);
            }
            setSavedBaseline({ defaultBlankLines: blankDefault, blankLines: savedBlanks, figureScale: savedFigures });
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
        blankOverrides,
        figureScales,
        kind,
        L,
        fetchList,
    ]);

    /**
     * 打印这一卷：先把"复练纸印刷次数"记上（卷内**所有**还找得到的题各 +1），再调浏览器打印。
     * 口径与打印预览页一致（`kind: "review"`）。
     * ⚠️ 不记那些原题已删的（它们只在快照里，没有可加的题）；也不动 `lastPrintedAt`
     *    —— 那个字段是「本册未打印」那条筛选用的一，别被印卷捎带改了。
     */
    const printVolume = useCallback(async () => {
        if (items.length > 0) {
            try {
                await apiClient.post("/api/error-items/mark-printed", {
                    ids: items.map((i) => i.id),
                    kind: "review",
                });
            } catch (error) {
                console.error("Failed to record review print count:", error);
            }
        }
        window.print();
    }, [items]);

    /** 【2026-10-03 需求第 4 条】打印前先拦一下：改了没保存就打印，印出来的是改动后的版面、库里却还是旧的 */
    const handlePrint = useCallback(() => {
        if (!confirmDiscard("打印", "Print")) return;
        void printVolume();
    }, [confirmDiscard, printVolume]);

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

    const visibleVolumes = useMemo(() => {
        const q = query.trim().toLowerCase();
        return volumes.filter((v) => {
            /**
             * 【2026-10-01 他定】积累纸（build）**不出现在这一页**。
             * 原话："复练卷页就是复练卷的内容，不和积累交互这么深。复练卷页管理复练卷，
             * 那么积累纸·打印就管理积累纸。" ⇒ 各管各的。
             * 【2026-10-11】这一页现在管**复练 + 模仿**两种（见 `kindFilter`），积累纸仍然挡在外面。
             */
            if (v.kind === "build") return false;
            /**
             * 【2026-10-09】下面这几个判断**服务端已经做过了**（见 `/api/review-volumes` 的注释：
             * 筛选必须搬到服务端，翻页才不会"只在已加载的那批里搜"）。
             * 这里留作**兜底**：万一服务端与本地口径有出入，也不会把不该出现的卷摆出来。
             * 谓词与 SQL 那边逐条等价（学期走同一张写法表、关键词走同样的三个字段）。
             */
            if (v.kind !== kindFilter) return false;
            // 年级/学期：卷页眉可能是"六年级上·五年级上"（跨本组卷），**任一部分**命中就算
            if (gradeTermFilter && !volumeMatchesTerm(v.gradeSemester, gradeTermFilter)) return false;
            if (!q) return true;
            return (
                v.volumeNo.toLowerCase().includes(q) ||
                (v.title || "").toLowerCase().includes(q) ||
                (v.gradeSemester || "").toLowerCase().includes(q)
            );
        });
    }, [volumes, kindFilter, gradeTermFilter, query]);

    /**
     * 【2026-10-11 他定】"上次检索的**年级/学期**留在缓存，**学科**不留缓存" ——
     *   · 年级/学期是"她最近在看哪一册"这种稳定偏好 ⇒ 记住；
     *   · 学科是"这次想看哪一科" ⇒ 每次进来从"全部学科"开始，不然会看着列表莫名其妙的少。
     * ⚠️ 在 `useEffect` 里读、**不在 `useState` 初值里读**：那样服务端渲染出空值、
     *    客户端渲染出缓存值 ⇒ React 会报 hydration 不一致。
     */
    useEffect(() => {
        try {
            const cached = window.localStorage.getItem(GRADE_TERM_CACHE_KEY);
            if (cached) setGradeTermFilter(cached);
        } catch {
            // 隐私模式/存不下：不影响功能，就是"记不住上次的年级"
        }
    }, []);
    useEffect(() => {
        try {
            window.localStorage.setItem(GRADE_TERM_CACHE_KEY, gradeTermFilter);
        } catch {
            // 同上：存不下就算了
        }
    }, [gradeTermFilter]);

    /** 「清空条件」：他原话"点击后面的'刷新'意为清空所有检索并执行的意思" */
    const clearFilters = useCallback(() => {
        setQueryDraft("");
        setQuery("");
        setSubjectFilter("");
        setGradeTermFilter("");
        // 不需要手动重取：上面那个 effect 盯着 `fetchList`（依赖筛选）会自动再拉一次
    }, []);

    const formatTime = (iso: string) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    const pageCount = layoutPageCount;

    return (
        <div className="print-preview-shell">
            {/* ===== 顶栏：左＝返回 + 标题；右＝隐藏左栏 / 打印 / 主页 =====
                【2026-09-30 他要求】原来这一排是**整屏宽**（标题贴左边缘、按钮贴右边缘），
                而下面两栏是 `max-w-[1600px]` 居中的 ⇒ 大屏上"上面顶两头、下面缩中间"，
                他原话"实在是太难看了"。修法：顶栏**内容**用与两栏**同一套**包裹
                （同样 max-w + 同样左右内边距 + 居中），这样标题与左栏对齐、按钮与右栏右缘对齐；
                分隔线仍走整屏（`border-b` 在外层），不然会断成一小截。 */}
            <div className="no-print border-b bg-background">
                <div className="mx-auto flex w-full max-w-[1600px] items-center gap-2 px-4 py-2 md:px-8">
                    {/*
                     * 【2026-10-03 需求第 4 条】返回要拦：
                     * `BackButton` 自己不收 onClick（它内部直接 router.push），外面套一层**捕获阶段**
                     * 的点击监听 —— 取消确认时 `stopPropagation` 掉，点事件根本到不了那个按钮，
                     * router.push 自然不会发生（没改时什么也不拦，行为与原样一致）。
                     */}
                    <span
                        className="shrink-0 inline-flex"
                        onClickCapture={(e) => {
                            if (!confirmDiscard("返回", "Go back")) {
                                e.preventDefault();
                                e.stopPropagation();
                            }
                        }}
                    >
                        <BackButton fallbackUrl="/" className="shrink-0" />
                    </span>
                    <h1 className="text-base sm:text-lg font-semibold truncate">{L("已有组卷", "Existing volumes")}</h1>
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
                        title={L("打印这一卷（会把卷内每道题的复练纸次数 +1）", "Print this volume")}
                        disabled={!layoutReady}
                        onClick={handlePrint}
                    >
                        <Printer className="h-4 w-4" />
                    </Button>
                    <Link
                        href="/"
                        onClick={(e) => {
                            if (!confirmDiscard("回主页", "Go home")) e.preventDefault();
                        }}
                    >
                        <Button variant="ghost" size="icon" title={L("返回主页", "Home")}>
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>
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
                                            /* 他 2026-10-11："不设为即时检索，改为输入后回车进行检索" */
                                            placeholder={L("搜卷号 / 名字 / 年级学期，回车检索", "Search, press Enter")}
                                            value={queryDraft}
                                            onChange={(e) => setQueryDraft(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") setQuery(queryDraft);
                                            }}
                                        />
                                    </div>
                                    {/* 他 2026-10-11：这个按钮的意思是**清空所有检索**并执行，不是"按当前条件重查"
                                        ⇒ 名字就照它的意思叫「清空条件」（"刷新"会让人以为只是重查一次）。 */}
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        title={L("清空条件（卷号/名字、年级学期、学科全清掉）", "Clear all filters")}
                                        onClick={clearFilters}
                                    >
                                        <Eraser className="h-4 w-4" />
                                    </Button>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    {/*
                                        卷的两种入口（他 2026-10-11 定的那两条）：
                                          ① 原来那个「全部」改成「复练」；
                                          ② 原来那个「复练」改成「模仿」。
                                        ⇒ 这一页现在**只管复练卷与模仿卷**（积累纸单独走它自己那条路）。
                                    */}
                                    <div className="flex items-center gap-1 bg-muted/50 rounded-md p-0.5 w-fit">
                                        {(["review", "imitate"] as const).map((k) => (
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
                                                {L(VOLUME_KIND_LABEL[k], VOLUME_KIND_LABEL_EN[k])}
                                            </button>
                                        ))}
                                    </div>
                                    {/* 年级/学期（小一上 … 高三下）+ 学科（9 科 + 其他）两个筛选，可叠加 */}
                                    <select
                                        className="rounded-md border bg-background px-2 py-1 text-xs max-w-[110px]"
                                        value={gradeTermFilter}
                                        onChange={(e) => setGradeTermFilter(e.target.value)}
                                        title={L("按年级/学期筛", "Filter by term")}
                                    >
                                        <option value="">{L("全部年级", "All terms")}</option>
                                        {GRADE_TERMS.map((t) => (
                                            <option key={t.key} value={t.key}>
                                                {t.label}
                                            </option>
                                        ))}
                                    </select>
                                    <select
                                        className="rounded-md border bg-background px-2 py-1 text-xs max-w-[100px]"
                                        value={subjectFilter}
                                        onChange={(e) => setSubjectFilter(e.target.value)}
                                        title={L("按学科筛", "Filter by subject")}
                                    >
                                        <option value="">{L("全部学科", "All subjects")}</option>
                                        {SUBJECT_OPTIONS.map((o) => (
                                            <option key={o.key} value={o.key}>
                                                {o.label}
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

                                {/* 【2026-10-05 他要求】卷会越攒越多，左栏会一直长下去 ——
                                    装进一个**自带滚动条**的框里（他建议"能显示 7-8 个卡片的量"）。
                                    写法**照抄日积月累页左栏那套**（`max-h-[62vh] overflow-y-auto
                                    rounded-md border p-2`）—— 他明确说那个设计很好，那就别另发明一套，
                                    两页左栏看起来、用起来都一样。 */}
                                <div
                                    ref={listScrollRef}
                                    className="max-h-[62vh] space-y-1 overflow-y-auto rounded-md border p-2"
                                >
                                    {visibleVolumes.map((v) => {
                                        const active = v.id === selectedId;
                                        return (
                                            <button
                                                key={v.id}
                                                type="button"
                                                onClick={() => handleOpenVolume(v.id)}
                                                className="w-full text-left rounded-md border px-2 py-1.5 transition-colors"
                                                style={{
                                                    borderColor: active ? "var(--primary)" : "var(--border)",
                                                    background: active ? "var(--accent)" : "transparent",
                                                }}
                                            >
                                                {/* 有名字就把名字摆前面（名字是给人认卷用的），卷号退成副标题。
                                                    【2026-10-11】卷别那个小标签**两种分支都要有** ——
                                                    这一页现在同时列复练卷与模仿卷，不标出来分不清。 */}
                                                {v.title ? (
                                                    <>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-sm font-semibold truncate">{v.title}</span>
                                                            <span className="text-[10px] px-1 rounded border whitespace-nowrap">
                                                                {L(
                                                                    VOLUME_KIND_LABEL[v.kind],
                                                                    VOLUME_KIND_LABEL_EN[v.kind],
                                                                )}
                                                            </span>
                                                        </div>
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
                                                    {v.gradeSemester ? `${v.gradeSemester} · ` : ""}
                                                    {(v.subjectKeys || []).map((k) => subjectLabel(k)).join("、")}
                                                </div>
                                                <div className="text-[11px] text-muted-foreground">
                                                    {formatTime(v.createdAt)}
                                                </div>
                                            </button>
                                        );
                                    })}

                                    {/* 【2026-10-09】上拉加载更多：滚到这附近会自动要下一页；
                                        万一浏览器不支持自动触发（或他就是想手动点），这个按钮一直在。 */}
                                    {nextCursor && (
                                        <div ref={listSentinelRef} className="pt-1">
                                            <button
                                                type="button"
                                                onClick={() => void loadMoreVolumes()}
                                                disabled={listLoadingMore}
                                                className="w-full rounded-md border border-dashed px-2 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:opacity-60"
                                            >
                                                {listLoadingMore
                                                    ? L("加载中…", "Loading…")
                                                    : L("上拉显示更早的卷（点这里也行）", "Scroll for older volumes (or click)")}
                                            </button>
                                        </div>
                                    )}
                                    {!nextCursor && volumes.length > VOLUME_PAGE_SIZE && (
                                        <p className="py-1 text-center text-[11px] text-muted-foreground">
                                            {L("已经到底了", "That's all")}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </aside>
                    )}

                    {/* ===== 右栏：选中卷的纸面 ===== */}
                    <main className="print-preview-right">
                        {scanCode ? (
                            /*
                             * 【2026-10-03 需求第 5 条】【扫码图】那一屏：
                             * 整屏切成"扫到的复练卷"——**复用扫码页用的 `ScanVolumeView`**
                             * （只加了个 backLabel，不传时行为一字不变）。
                             * 返回按钮文案改成"回到预览"，点了 `setScanCode(null)` 就回到本页、
                             * 右栏仍是刚才那份卷（本页选中态没动过）。
                             *
                             * 【2026-10-03 下午·他要求】**三层都在本页内**：
                             *   预览 ⇒【扫码图】⇒ 扫到的复练卷 ⇒ 点蓝加号 ⇒ 扫到的这道题
                             *   ⇒【回到复练卷】**回到本页的扫码图**（而不是跳进 `/scan` 那条链）。
                             * 原来点加号是 `router.push('/scan?...')` —— 那是**真的扫码入口**，
                             * 它上面的"返回"一路通向"扫一扫"，成了另一个流程（他实测后指出）。
                             */
                            <div className="mx-auto w-full max-w-6xl px-4 py-6">
                                <h1 className="mb-3 flex items-center gap-2 text-lg font-bold">
                                    <ScanLine className="h-5 w-5" />
                                    {scanItemId
                                        ? L("扫到的这道题", "Scanned question")
                                        : L("扫到的复练卷", "Scanned volume")}
                                </h1>
                                {scanItemId ? (
                                    <ScanItemPanel
                                        itemId={scanItemId}
                                        source="main"
                                        onBack={() => setScanItemId(null)}
                                        backLabel={L("回到复练卷", "Back to volume")}
                                        /**
                                         * 面板里那个【打开详情页】的返回目标：指回**本页 + 扫码图**，
                                         * 这样从详情页退回来时还是这一屏（靠上面读 `?vol=&scan=` 还原）。
                                         */
                                        backTo={`/review-volumes?vol=${encodeURIComponent(selectedId || "")}&scan=${encodeURIComponent(scanCode)}`}
                                    />
                                ) : (
                                    <ScanVolumeView
                                        code={scanCode}
                                        backLabel={L("回到预览", "Back to preview")}
                                        onBack={closeScan}
                                        onPickItem={(item) => setScanItemId(item.id)}
                                    />
                                )}
                            </div>
                        ) : (
                            <>
                        {/* ⚠️ 量尺**必须留在缩放外面**（`SheetZoom` 的外面）：
                            `getBoundingClientRect()` 拿到的是**缩放后**的像素，
                            装进去量出来的 mm 会整体偏小 ⇒ 分页会以为"一页能装更多"，直接印错版面。 */}
                        {items.length > 0 && kind !== "imitate" && (
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

                        {/* 【T4】模仿卷的量尺：左栏的段（主题）+ 右栏的附题，两栏同宽 ⇒ 一个容器够用。
                            与打印预览页**同一套读法**（`readImitateHeights`），
                            而且左栏用的是正式版面上那个 `ImitateSegments` —— 量到的就是印出来的。 */}
                        {kind === "imitate" && imitateTheme && (
                            <div
                                ref={imitateMeasureRef}
                                aria-hidden="true"
                                className="print-review-measure no-print"
                                style={{ width: `${VOLUME_VARIANTS.imitate.columnWidthMM}mm` }}
                            >
                                <ImitateSegments
                                    specs={imitateSpecs}
                                    theme={imitateTheme}
                                    figureScale={figureScaleOf(imitateTheme.id)}
                                    L={L}
                                />
                                {imitateRightRows.map((r) => {
                                    const it = reviewItemByKey[r.key];
                                    if (!it) return null;
                                    return (
                                        <ReviewQuestionBlock
                                            key={r.key}
                                            item={it}
                                            seq={r.seq}
                                            blankLines={blankValueOf(it.id)}
                                            showDivider={false}
                                            figureScale={figureScaleOf(it.id)}
                                            L={L}
                                        />
                                    );
                                })}
                            </div>
                        )}

                        {/* ⚠️ 这两层不能少：`mx-auto max-w-6xl px-4` 负责"不顶边、别太宽"，
                            `print-sheet` 负责把纸定成 **152mm 宽**（纸边靠它撑出来）。
                            少了这层，纸会被拉成整个右栏那么宽 —— 他看到的"横向、不是 B5"就是这个。
                            `SheetZoom` 再包一层：双击纸面空白处切"适应宽度 / 实际大小"。
                            【2026-10-03 他要求】**点开就是"适应大小"**（原来默认实际大小，
                            右栏一窄纸就横向溢出）。 */}
                        <SheetZoom
                            className="mx-auto max-w-6xl px-4 py-6 print:max-w-none print:px-0 print:py-0"
                            defaultFit
                            L={L}
                        >
                            <div className="print-sheet">
                                {!selectedId && (
                                    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground no-print">
                                        {L("左边点一份卷，这里就能看到它的纸面。", "Pick a volume on the left.")}
                                    </div>
                                )}

                                {selectedId && (
                                    <div className="mb-3 flex flex-wrap items-center gap-2 no-print">
                                        {/* 【2026-10-03 需求第 4 条】没改 ⇒ 不显示【更新组卷】；改了才显示 */}
                                        {dirty && (
                                            <Button
                                                size="sm"
                                                onClick={updateVolume}
                                                disabled={busy === "saving" || !layoutReady || overfullPages.length > 0}
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
                                        )}
                                        {/*
                                         * 【2026-10-03 需求第 5 条】【扫码图】：
                                         * 进"扫描这份卷第一页"的预览。**改过版面没保存时不可点** ——
                                         * 不然扫出来的是库里那版、屏上是改过的这版，两边对不上。
                                         * ⚠️【2026-10-11】模仿卷这一屏**还没做**（他设计稿第 8 条：
                                         * 左栏主题一个蓝框、右栏每题一个蓝框加号、灰圈流水号）——
                                         * 现在点进去会是**复练纸那套两栏排题**的错版式。
                                         * 宁可先禁用并说清，也不给一个错的屏（下一版补上）。
                                         */}
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={dirty || !layoutReady || kind === "imitate"}
                                            title={
                                                kind === "imitate"
                                                    ? L(
                                                          "模仿卷的「扫到的模仿卷」那一屏还没做（下一版补）",
                                                          "Scan view for imitate volumes is not built yet",
                                                      )
                                                    : dirty
                                                      ? L("先保存版面（点【更新组卷】）才能进扫码图", "Save the layout first")
                                                      : L("看这份卷第一页的扫码预览", "Scan preview of page 1")
                                            }
                                            onClick={() => {
                                                if (!detail) return;
                                                // 进【扫码图】前先把里面那层清掉，保证看到的是整卷
                                                setScanItemId(null);
                                                setScanCode(buildPageCode(detail.volumeNo, 1));
                                            }}
                                        >
                                            <ScanLine className="mr-1.5 h-4 w-4" />
                                            {L("扫码图", "Scan view")}
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
                                        {kind === "imitate"
                                            ? L(
                                                  "模仿卷是**只读**的：左栏（主题）按主题现算、右栏（附题）按当初印出来的页走。双击纸面空白处可切「适应宽度 / 实际大小」，右上角可打印、可看扫码图。",
                                                  "Imitate volumes are read-only. Double-click the paper to toggle fit/actual size.",
                                              )
                                            : L(
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

                                {/* 隐藏量尺**已移到右栏顶部**（缩放外面）—— 见那里的说明 */}

                                {/*
                                 * 【2026-10-01 收敛】这里**只画复练纸**。
                                 * 加过一版"build 卷用积累纸渲染"的分支，但既然积累纸已经拆去
                                 * 它自己的打印页（`/insights/print`）、且本页列表已不再列出 build 卷
                                 * （他："各管各的"），那个分支就成了死路 —— 删掉，别留在代码里误导人。
                                 *
                                 * 【2026-10-11】模仿卷（CO）做成**只读**：纸面照快照还原、
                                 * 可缩放/可打印/可看扫码图，但**不给"更新组卷"** ——
                                 * 它的左栏是按主题现算的，右栏页归属锁在快照里，
                                 * "页内调留白"这套对它的意义和复练卷不一样，先不做、不做半套。
                                 */}
                                {kind === "imitate"
                                    ? imitateLayout?.sheets.map((sheet, i) => (
                                          <ImitateSheet
                                              key={i}
                                              sheet={sheet}
                                              segmentByKey={imitateSegmentByKey}
                                              theme={imitateTheme}
                                              themeNo={imitateThemeKey ? (rowByKey[imitateThemeKey]?.itemNo ?? null) : null}
                                              pageNo={i + 1}
                                              pageCount={imitateLayout.sheets.length}
                                              volumeNo={detail?.volumeNo ?? ""}
                                              kind="imitate"
                                              gradeText={detail?.gradeSemester ?? undefined}
                                              printDate={printDate}
                                              emojiMark={detail?.emojiMark}
                                              pageQr={pageQr[i + 1]}
                                              itemByKey={reviewItemByKey}
                                              missing={missingMap}
                                              blankValueOf={blankValueOf}
                                              figureScaleOf={figureScaleOf}
                                              L={L}
                                          />
                                      ))
                                    : layout?.pages.map((page, i) => (
                                    <ReviewSheet
                                        key={i}
                                        page={page}
                                        pageNo={i + 1}
                                        pageCount={layout.pages.length}
                                        volumeNo={detail?.volumeNo ?? ""}
                                        kind={kind}
                                        gradeText={detail?.gradeSemester ?? undefined}
                                        printDate={printDate}
                                        emojiMark={detail?.emojiMark}
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
                        </SheetZoom>
                            </>
                        )}
                    </main>
                </div>
            </div>
        </div>
    );
}
