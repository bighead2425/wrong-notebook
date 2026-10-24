"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import type { CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { House, PanelLeftClose, PanelLeftOpen, Printer } from "lucide-react";
import { cleanMarkdown } from "@/lib/markdown-utils";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
// 【2026-10-12 延伸】离开时"保存 / 不保存 / 取消"三选一（与已有组卷页同一个框、同一套话）
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { shouldWarnBeforeLeaving, unsavedLeaveMessage } from "@/lib/unsaved-guard";
// 【2026-10-12 需求第 2 条延伸】手机端划一下就收 / 叫左栏（与另外三个页面共用这一份）
import { usePanelSwipe } from "@/lib/use-panel-swipe";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { PRINT_PREVIEW_PAGE_SIZE } from "@/lib/constants/pagination";
import {
    getPrintPreviewCountLabel,
    getPrintPreviewEmptyState,
    getSelectedPrintItems,
    getTags,
    normalizeGrade,
} from "@/lib/print-preview";
import { formatIsoDate } from "@/lib/date-format";
import { whenImagesDecoded, whenImagesSettled } from "@/lib/print-image-readiness";
import { makeQrDataUrl } from "@/lib/qr";
import { ErrorCard } from "@/components/print/error-card";
import { DeepDiveCard } from "@/components/print/deep-dive-card";
import { ReviewSheet, ReviewQuestionBlock, pageQrPayload } from "@/components/print/review-card";
import { ImitateSegments, ImitateSheet } from "@/components/print/imitate-card";
import {
    buildImitateSegments,
    paginateImitate,
    readImitateHeights,
    type ImitateLayout,
    type ImitateSegment,
    type ImitateSegmentSpec,
} from "@/lib/imitate-card";
import type { LinkView } from "@/lib/item-link";
import { SheetZoom } from "@/components/print/sheet-zoom";
import {
    blankLinesFromDrag,
    VOLUME_VARIANTS,
    applyGlobalBlankLines,
    effectiveBlankLines,
    figureScaleFromDrag,
    normalizeBlankLines,
    normalizeFigureScale,
    paginateMeasured,
    type MeasuredBlock,
} from "@/lib/review-card";
import type { VolumeKind } from "@/lib/volume-code";
import { parseCropRegions, suspiciousFigureRects } from "@/lib/crop-regions";
import {
    AnswerBody,
    QuestionBody,
    type PrintBodyOptions,
} from "@/components/print/question-bodies";

/* 纸张容器样式见 globals.css 的 .print-sheet：
   国内市售 B5 = 182mm × 257mm（JIS B5），页边距 15mm → 内容区宽 152mm，
   并强制为浅色，保证深色主题下预览与打印都是白纸黑字。 */

/**
 * 【M3】新增 `deep` = **T1 深挖纸**（P5），本轮唯一在做的纸型。
 *
 * 它和另外三种的根本差别：**纸上零 AI 内容**（P3/P19）——
 * 解析 / 错因 / 参考答案一律不印，AI 的活全部挪到回收之后。
 *
 * ⚠️ 为什么没有把 deep 设成默认、也没删掉旧「错题卡」：
 *    回收判定（M5）与回信（M6）还没做。此刻把旧卡的答案撤掉，孩子做完题
 *    **拿不到任何反馈** —— 那不是设计意图，是断档。等 M5/M6 通了，
 *    再把默认切到 deep、旧卡退役（一行改动）。
 */
type PrintMode = "deep" | "review" | "build" | "imitate" | "card" | "practice" | "explain";

/**
 * 【2026-10-12】**"已掌握"的绿** —— 只在这一屏用（模仿纸"收哪些附题"里，已掌握那道题的题号）。
 *
 * ⚠️ 与"附题角标"那个颜色**不是一件事**，别合并：
 *    角标颜色是"这题在从属关系里的角色"（`LINK_CHILD_COLOR`，2026-10-12 起是**黄**），
 *    而这个是"这道题已经会了"。他 2026-10-12 同一天里分别要了这两个颜色
 *    （"已掌握的题号用绿色" / "附题角标改成黄色"）—— 混起来就会把其中一个做错。
 */
const MASTERED_GREEN = "#16a34a";

/** 【2026-10-12 延伸】离开前那个三选一的答案（与已有组卷页同一个形状） */
type LeaveChoice = "save" | "discard" | "cancel";

function PrintPreviewContent() {
    const searchParams = useSearchParams();
    const { t, language } = useLanguage();
    const zh = language === "zh";
    const L = (a: string, b: string) => (zh ? a : b);
    /**
     * 【2026-10-12】又需要 `router` 了：离开时的三选一弹框是**异步**的，
     * 返回 / 回主页不能靠 `<a href>` 自己跳（这一下必须在弹框出来之前就拦掉），
     * 只能问完他、再由我们**自己** `router.push`。与已有组卷页同一套理由。
     */
    const router = useRouter();

    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [printing, setPrinting] = useState(false);

    /**
     * 【custom-v25】默认进**错题卡**，不再是练习卷。
     * 家里日常就是把「一道题一张卡（正面重做、背面错因+答案）」打出来做复做，
     * 练习卷/讲解卷是偶尔才用的另一种排版，默认值应当给常用的那个。
     * 下面那段读 URL 的 effect 仍会覆盖它（三级打印入口带 ?mode=xxx 时以入口为准）。
     */
    const [mode, setMode] = useState<PrintMode>("deep");
    const [showQuestionText, setShowQuestionText] = useState(true);
    const [showImage, setShowImage] = useState(true);
    const [showAnswers, setShowAnswers] = useState(true);
    const [showAnalysis, setShowAnalysis] = useState(true);
    const [showMistake, setShowMistake] = useState(true);
    // 【custom-v24】「知识点」默认勾选（用户指定）——打出来能直接看到这题考什么，
    // 不必每次进打印页再补勾一次。
    const [showTags, setShowTags] = useState(true);
    const [spaceMM, setSpaceMM] = useState(35);
    const [imageScale, setImageScale] = useState(70);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [soloIds, setSoloIds] = useState<Set<string>>(new Set());
    const [qrMap, setQrMap] = useState<Record<string, string>>({});
    /**
     * 【2026-10-03 需求第 10 条】深挖纸的随机 emoji 标识（题 id → 符号）。
     * 打开深挖纸预览时向服务端要一次：老数据为空会**当场生成并写回**，之后重印不变。
     */
    const [emojiMarks, setEmojiMarks] = useState<Record<string, string>>({});

    /* ===== 【T2/T3 · 2026-09-28】卷的状态 =====
       · blankDefault  整卷的缺省留白行数（复练 5 行、积累 1 行）
       · blankOverrides 逐题微调过的值（没调过的题不在表里 ⇒ 跟着缺省走）
       · volume        已**落库**的那份卷（没落库就没有卷号、也不印二维码）
                       —— 卷页眉的码内容是"卷号-页码"，扫回这份卷要它真实存在，
                          所以"组卷"是一次真实的写操作，不是预览的副作用。 */
    const [blankDefault, setBlankDefault] = useState<number>(VOLUME_VARIANTS.review.defaultBlankLines);
    const [blankOverrides, setBlankOverrides] = useState<Record<string, number | null | undefined>>({});
    const [volume, setVolume] = useState<{
        id: string;
        volumeNo: string;
        pageCount: number;
        /** 【2026-10-03 需求第 10 条】这份卷的随机 emoji 标识（整卷共用一个） */
        emojiMark?: string | null;
    } | null>(null);
    const [volumeSignature, setVolumeSignature] = useState<string>("");
    const [volumeCreating, setVolumeCreating] = useState(false);
    const [volumeError, setVolumeError] = useState<string>("");

    /** 复练纸这一页每一页的二维码（key = 页码） */
    const [volumePageQr, setVolumePageQr] = useState<Record<number, string>>({});

    /* ===== 【T4 · 2026-10-11】模仿纸 =====
       与复练纸最大的不同：**左栏是"主题"的内容**（题干 → 图 → 遮挡线 → 参考答案 → 解析），
       右栏是挂在主题下的**附题**。所以这一屏多两样东西：
         · `imitateTree`  —— 当前这棵树（主题 + 名下附题），由链接关系反查得来；
         · `pickedChildren` —— 这一份模仿纸**收了哪几道附题**（他界面上一个个勾）。
       ⚠️ 左栏是**贯通**的（放不下顺延下一页），所以分页走 `paginateImitate` 这条单独的流，
          不能复用复练纸那套"整块绝不跨页"的 `paginateMeasured`。 */
    const [imitateTree, setImitateTree] = useState<{ theme: ErrorItem; children: ErrorItem[] } | null>(null);
    const [imitateLoading, setImitateLoading] = useState(false);
    const [imitateError, setImitateError] = useState("");
    const [pickedChildren, setPickedChildren] = useState<Set<string>>(new Set());
    /** 左栏的段 + 右栏附题块（高度都来自隐藏量尺的真实测量） */
    const [imitateMeasured, setImitateMeasured] = useState<{
        segments: ImitateSegment[];
        blocks: MeasuredBlock[];
    } | null>(null);

    /* ===== 【2026-09-28】打印预览页改成左右两栏 =====
       · 左栏 = 控制区（选纸型 / 勾选项 / 留白 / 组卷 / 挑题）
       · 右栏 = 排版预览（屏幕预览 = 纸张实际效果）
       他要求：左栏可隐藏、可拖拽调宽；隐藏后右栏自动占满。
       ⚠️ 宽度只写进 CSS 变量（`--left-w`），**不在行内写死 px** ——
          窄屏要靠 CSS 变成上下堆叠，写死就会把预览挤没。 */
    const [leftWidth, setLeftWidth] = useState(380);
    const [leftHidden, setLeftHidden] = useState(false);
    /** 拖拽中记住"起点鼠标 x"与"起点左栏宽"，移动时只做差值 */
    const splitterDragRef = useRef<{ startX: number; startW: number } | null>(null);

    /**
     * 【2026-09-28】每道题**题图**的大小（百分比，100 = 版面默认）。
     *
     * 为什么要有：有的图上纸后偏大、有的偏小，版面给的那个 55% 不是对每张图都合适。
     * 调法是他定的：**左上角固定、拖右下角、等比缩放**。
     * 存法和留白一样是"逐题覆盖"：没拖过的题不在表里 ⇒ 用版面默认值。
     * ⚠️ 拖完必须**重新量高度**（图变了块就高了），所以 `measureKey` 里要带上它。
     */
    const [figureScales, setFigureScales] = useState<Record<string, number | null | undefined>>({});
    const figureScaleOf = useCallback(
        (id: string) => normalizeFigureScale(figureScales?.[id]),
        [figureScales],
    );
    /** 拖拽题图：记住"起点鼠标 x / 起点宽度px"，移动时按比例换算成新的百分比 */
    const figureDragRef = useRef<{ id: string; startX: number; startY: number; startPx: number } | null>(null);

    /**
     * 【2026-09-29】深挖纸**正面原题照片**的缩放 —— 与反面题图**各算各的**
     * （正面那张是整页照片、反面那些是橙框裁出来的题图，不共用同一个百分比）。
     * 机制完全照抄上面那套（他原话："类似与深挖纸背面原题中的图片能拖把手调大小"）。
     */
    const [photoScales, setPhotoScales] = useState<Record<string, number | null | undefined>>({});
    const photoScaleOf = useCallback(
        (id: string) => normalizeFigureScale(photoScales?.[id]),
        [photoScales],
    );
    const photoDragRef = useRef<{ id: string; startX: number; startY: number; startPx: number } | null>(null);

    // 手动双面：家里打印机不支持自动双面，靠爹手动翻
    const [manualDuplex, setManualDuplex] = useState(false);

    /**
     * 【M3】打印日 —— 深挖纸反面三个日期格（+1 / +7 / +21）以它为基准。
     * 一次打印里所有题共用同一个值，免得跨越午夜时同一批纸印出两个基准日。
     * `handlePrint` 里会**再刷一次**：页面跨天开着时，"印于"必须是今天。
     */
    const [printDate, setPrintDate] = useState(() => new Date());

    useEffect(() => {
        fetchItems();
    }, []);

    // 三级打印按钮通过 URL 传打印意图（?mode=card|practice|explain）。
    // 此前 mode 硬编码为 "practice" 且从不读 URL，导致卡片模板
    // （题号色标 + 二维码 + 正反面/一题两页）在任何入口下都不会渲染。
    // 直接读 window.location 而非 useSearchParams，避免静态渲染下取值为空的时序问题。
    /** 入口有没有**明确指定**过纸型（指定了就一切以它为准，不许被"按题数推断"覆盖） */
    const modePinnedRef = useRef(false);
    useEffect(() => {
        const m = new URLSearchParams(window.location.search).get("mode");
        // 【2026-10-24】card / practice / explain 三个签已摘掉，URL 不再接受 ——
        // 否则会出现"进入了错题卡模式、但界面上没有对应按钮"的死状态。
        if (m === "deep" || m === "review" || m === "build" || m === "imitate") {
            modePinnedRef.current = true;
            setMode(m);
        }
    }, []);

    /**
     * 【2026-10-03 他定的】**没指定纸型时的默认值**：
     *   · 带进来的只有**一道题** ⇒ 默认【深挖纸】；
     *   · 带进来**多于一道** ⇒ 默认【复练纸】。
     *
     * 原话："一进入打印预览页，目前缺省是打开'错题卡'页面，这个要改。"
     * 这与他的实际用法一致：单题就是打深挖纸、成组就是打复练纸。
     * ⚠️ 只在**第一次**题目加载完时定一次（`decidedRef`）——
     *    之后他手动切过标签，不许再被这个规则拽回去。
     */
    const modeDecidedRef = useRef(false);
    useEffect(() => {
        if (loading || modeDecidedRef.current) return;
        modeDecidedRef.current = true;
        if (modePinnedRef.current) return; // 入口指定过，听入口的
        setMode(items.length > 1 ? "review" : "deep");
    }, [loading, items.length]);

    const fetchItems = async () => {
        try {
            const params = new URLSearchParams(searchParams.toString());
            params.set("pageSize", String(PRINT_PREVIEW_PAGE_SIZE));
            /**
             * ⚠️【2026-10-16 真真】**打印预览是唯一需要题图的调用方** ⇒ 显式要。
             *
             * 列表接口从今天起**默认不返回 `originalImageUrl`**（题图 base64、单张最大约 1.37MB）——
             * 因为另外 5 个调用方（错题卡列表 / 卷页 / 回收箱 / 详情页导航）**一个字段都不用**，
             * 白传 20 多 MB 正是"打开错题本要 10 秒"的根因。
             * 而这一屏要**印题图**（`components/print/question-bodies.tsx`）⇒ 必须显式要回来。
             */
            params.set("withImages", "1");
            const response = await apiClient.get<PaginatedResponse<ErrorItem>>(
                `/api/error-items/list?${params.toString()}`,
            );
            /**
             * 【2026-09-28】带了 `ids`（详情页多选导出 / 扫码跳单题）时，
             * **按 ids 给的顺序排** —— 那是她勾选的先后，也就是她要的卷内顺序。
             * Prisma 没法按任意列表排序，所以在客户端排一次。
             */
            const idsOrder = (searchParams.get("ids") || "")
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean);
            const ordered = idsOrder.length
                ? [...response.items].sort((a, b) => idsOrder.indexOf(a.id) - idsOrder.indexOf(b.id))
                : response.items;
            setItems(ordered);
            setSelectedIds(new Set(ordered.map((item) => item.id)));
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const toggle = (setter: (fn: (p: Set<string>) => Set<string>) => void) => (id: string) => {
        setter((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
    const toggleSelected = toggle(setSelectedIds);
    const toggleSolo = toggle(setSoloIds);

    const selectedItems = getSelectedPrintItems(items, selectedIds);

    /**
     * 【2026-10-12】**卷内顺序 = `items` 的数组顺序**（不是另开一份 order 状态）。
     * 卷里那道题的流水号、右栏能不能上移/下移、左栏"选择题目"列表的次序，
     * 全都从这一份顺序推出来 —— 一份顺序，三处显示自然一致。
     */
    const volumeSerialOf = useMemo(() => {
        const map: Record<string, number> = {};
        let n = 0;
        for (const it of items) if (selectedIds.has(it.id)) map[it.id] = (n += 1);
        return map;
    }, [items, selectedIds]);

    /**
     * 把某道题**上移 / 下移一位**：和"卷里相邻的那一道"交换位置。
     *
     * ⚠️ 邻居要从**被选中的那些**里找（没勾的题不在这份卷里，不该被当成邻居）——
     *    所以是"跨过没勾的、找到最近的那道被选中的题"再交换。
     * ⚠️ 交换的是**数组里的位置**（不是另存一份序），所以左栏列表、量尺顺序、
     *    分页结果**下一次渲染就全都跟着变了**，不用三处各维护一遍。
     */
    const moveReviewItem = useCallback(
        (item: ErrorItem, dir: -1 | 1) => {
            setItems((prev) => {
                const i = prev.findIndex((x) => x.id === item.id);
                if (i < 0) return prev;
                let j = -1;
                for (let k = i + dir; k >= 0 && k < prev.length; k += dir) {
                    if (selectedIds.has(prev[k].id)) {
                        j = k;
                        break;
                    }
                }
                if (j < 0) return prev;
                const next = [...prev];
                [next[i], next[j]] = [next[j], next[i]];
                return next;
            });
        },
        [selectedIds],
    );
    const countLabel = getPrintPreviewCountLabel(items.length, selectedItems.length);
    const emptyState = getPrintPreviewEmptyState(items.length, selectedItems.length);
    const isDeep = mode === "deep";
    const isReview = mode === "review";
    const isBuild = mode === "build";
    /** 【T4】模仿纸：**单独一条排版流**（左栏贯通、右栏附题），不并入下面那套"卷" */
    const isImitate = mode === "imitate";
    /** 【T2/T3】"卷"两种模式（复练 / 积累）——它们走同一套组件，只是版面参数不同 */
    const isVolume = isReview || isBuild;
    const volumeKind: VolumeKind = isBuild ? "build" : "review";
    /**
     * 「纸别」= 决定缺省留白行数与卷别的那一个值（复练 / 积累 / 模仿）。
     * 复练与积累共用同一套排版组件，模仿纸走它自己那条流，但**留白规则是同一套** ——
     * 所以调留白的地方一律看这个 `blankKind`，不看 `mode`。
     */
    const blankKind: VolumeKind = isImitate ? "imitate" : volumeKind;

    /**
     * 【2026-09-28 第三次改版】卷的排版不再"估算高度"，改成**先量真实高度、再分栏分页**。
     *
     * 为什么（这条改了三轮才找对地方）：
     *   估算 = 字符数 ÷ 每行字数 × 行高。题干里一旦有表格 / 选项列表 / 内嵌图，
     *   实际高度就和估出来的不一样 ⇒ 块被撑破 ⇒ `overflow: hidden` 把下半截切掉
     *   （他看到的"升降级只剩半个"就是这个），而且**不报错**。
     *
     * 现在的三步：
     *   ① 把每道题按**真实栏宽**渲染进一个隐藏量尺容器（同一个 `ReviewQuestionBlock`）；
     *   ② 等题图裁完、解码完（高度才稳），读每块的真实高度（px → mm）；
     *   ③ 交给纯函数 `paginateMeasured` 分栏分页 —— 布局交给浏览器，分页交给它。
     */
    const [measuredBlocks, setMeasuredBlocks] = useState<MeasuredBlock[] | null>(null);
    const measureRef = useRef<HTMLDivElement | null>(null);
    /** 【T4】模仿纸的量尺容器（左栏的段 + 右栏的附题都量它这一份） */
    const imitateMeasureRef = useRef<HTMLDivElement | null>(null);

    /** 量尺指纹：题 / 卷别 / 留白 / 题图大小任一变了，就得重量一遍 */
    const measureKey = useMemo(
        () =>
            [
                volumeKind,
                selectedItems.map((i) => i.id).join("|"),
                JSON.stringify(blankOverrides),
                JSON.stringify(figureScales),
                // 深挖纸正面照片的缩放也要重量（图变了块就高了）
                JSON.stringify(photoScales),
            ].join("#"),
        [volumeKind, selectedItems, blankOverrides, figureScales, photoScales],
    );

    useEffect(() => {
        if (!isVolume) {
            setMeasuredBlocks(null);
            return;
        }
        if (selectedItems.length === 0) {
            setMeasuredBlocks([]);
            return;
        }
        let cancelled = false;
        (async () => {
            // ⚠️ 两把锁都要等：题图是**现裁**的（图还没出来时量出来偏矮），
            //    图出来了还得**解码完**高度才定型。少等一把就是"量到的不是印出来的"。
            await whenImagesSettled();
            await whenImagesDecoded(measureRef.current);
            if (cancelled) return;
            const el = measureRef.current;
            if (!el) return;
            const out: MeasuredBlock[] = [];
            el.querySelectorAll<HTMLElement>("[data-review-block]").forEach((node) => {
                const key = node.dataset.reviewBlock;
                if (!key) return;
                // px → mm：CSS 规定 1in = 96px，1in = 25.4mm
                out.push({ key, heightMM: (node.getBoundingClientRect().height * 25.4) / 96 });
            });
            if (!cancelled && out.length > 0) setMeasuredBlocks(out);
        })();
        return () => {
            cancelled = true;
        };
        // 只在"题 / 卷别 / 留白"变化时重量
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVolume, measureKey]);

    /**
     * 分栏分页：**只吃真实高度**，不做任何估算。
     * ⚠️ 保留上一次的结果直到新的量完（`setMeasuredBlocks` 只在量到时更新）——
     *    否则每改一次留白，预览都会先空一下，看着像卡了。
     */
    const reviewLayout = useMemo(() => {
        if (!isVolume || !measuredBlocks) return null;
        return paginateMeasured(measuredBlocks, volumeKind);
    }, [isVolume, measuredBlocks, volumeKind]);

    /**
     * 【组卷体检】哪几道题的**题图疑似框歪了**（裁出来只是一条边、或小得不像题图）。
     * 只看框坐标就够了（不用等图加载），所以是一段纯计算。
     * 有货就在预览页顶上报出来 —— 排版本轮已经"永不裁图"了，
     * 但**框本身歪**这件事只能靠人重录，必须让他看见。
     */
    const suspiciousFigureItems = useMemo(() => {
        if (!isVolume) return [];
        return selectedItems.filter((item) => {
            const regions = parseCropRegions(item.cropRegions);
            return suspiciousFigureRects(regions).length > 0;
        });
    }, [isVolume, selectedItems]);

    /**
     * 整卷的"年级·学期"（页眉那一句）。
     * ⚠️ 这里**现算**，不要引用 `sheetInfo` —— 它声明在本段之后，
     *    在渲染顺序里会被"先用后声明"打中（TDZ）。跨本组卷时可能不止一个，取前两个。
     * 【2026-10-11】模仿纸看的是**主题**那道题的年级（不是"选中的那一道"）——
     * 从附题进来看的这一屏，选中的是附题，而纸上是主题。
     */
    const volumeGradeText = useMemo(() => {
        const src = isImitate && imitateTree ? [imitateTree.theme] : selectedItems;
        const grades = [...new Set(src.map((i) => normalizeGrade(i.gradeSemester)).filter(Boolean) as string[])];
        return grades.slice(0, 2).join(" · ");
    }, [isImitate, imitateTree, selectedItems]);

    /**
     * 复练纸：key（题目 id）→ 题目本体，供卡片取用
     */
    const reviewItemByKey = useMemo(() => {
        const map: Record<string, ErrorItem> = {};
        for (const item of selectedItems) map[item.id] = item;
        return map;
    }, [selectedItems]);
    const isCard = mode === "card";
    const isPractice = mode === "practice";

    /* ===== 【T4 · 2026-10-11】模仿纸：先认树（主题 + 名下附题），再量、再分页 ===== */

    /**
     * 这一屏的"主题"是谁 —— 由**题间从属关系**决定（他 2026-10-10 定的口径）：
     *   · 选中的是**主题** ⇒ 它就是主题，附题 = 它名下那些；
     *   · 选中的是**附题** ⇒ 主题是它所属的那道题，附题 = **那道题**名下的全部；
     *   · 选中多道 / 选中的是**孤题** ⇒ 生成不了模仿纸
     *     （他原话："则打印预览页的「模仿纸」无法点击，即无法生成模仿纸"）。
     */
    const imitateSourceId = useMemo(() => {
        if (selectedItems.length !== 1) return null;
        const cur = selectedItems[0];
        return cur.linkRole === "root" || cur.linkRole === "child" ? cur.id : null;
    }, [selectedItems]);

    /** 这一屏能不能用模仿纸（不能就在标签上禁用，并说清为什么） */
    const imitateAvailable = !!imitateSourceId;

    useEffect(() => {
        if (!isImitate) return;
        if (!imitateSourceId) {
            setImitateTree(null);
            setImitateError("");
            return;
        }
        let cancelled = false;
        setImitateLoading(true);
        setImitateError("");
        (async () => {
            try {
                const detail = await apiClient.get<{ link?: LinkView }>(`/api/error-items/${imitateSourceId}`);
                const link = detail.link;
                if (!link || link.role === "lone") {
                    if (!cancelled) setImitateError(L("这道题现在没有关联题，生成不了模仿纸。", "No linked questions"));
                    return;
                }
                /** 先定"主题是哪道题" —— 选中附题时要往上走一层（与规则里的 `rootOf` 同一口径） */
                let themeId = imitateSourceId;
                let childCards = link.children ?? [];
                if (link.role === "child" && link.parent) {
                    themeId = link.parent.id;
                    const parentDetail = await apiClient.get<{ link?: LinkView }>(`/api/error-items/${themeId}`);
                    childCards = parentDetail.link?.children ?? [];
                }
                /**
                 * 关系视图里给的是**精简卡片**（刻意不带题图 data URL，避免几百 KB 一条）。
                 * 但纸上要印题图与答案解析 ⇒ 必须按 id 取回**完整**的题。
                 */
                const needIds = [themeId, ...childCards.map((c) => c.id)];
                const full = await apiClient.get<PaginatedResponse<ErrorItem>>(
                    // ⚠️【2026-10-16】这里正是"必须取回完整题（含题图）"的场景 ⇒ 显式 `withImages=1`。
                    `/api/error-items/list?pageSize=200&withImages=1&ids=${encodeURIComponent(needIds.join(","))}`,
                );
                const byId = new Map(full.items.map((i) => [i.id, i]));
                const theme = byId.get(themeId);
                if (!theme) {
                    if (!cancelled) setImitateError(L("读不到主题那道题（可能已被删除）。", "Theme item missing"));
                    return;
                }
                const children = childCards
                    .map((c) => byId.get(c.id))
                    .filter((x): x is ErrorItem => !!x);
                if (cancelled) return;
                setImitateTree({ theme, children });
                /** 默认勾选**未掌握**的（与复练纸同一个口径 `masteryLevel < 2`）：已掌握的仍可手动勾上 */
                setPickedChildren(new Set(children.filter((c) => (c.masteryLevel ?? 0) < 2).map((c) => c.id)));
            } catch (error) {
                console.error("Failed to load imitate tree:", error);
                if (!cancelled) setImitateError(L("读关联题失败，请重试", "Failed to load"));
            } finally {
                if (!cancelled) setImitateLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // L 只随语言变，故依赖里放 zh —— 不放 L（inline 箭头函数，每渲染都是新身份 ⇒ 会无限重取）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isImitate, imitateSourceId, zh]);

    /** 左栏的段规格（内容；高度靠量尺）—— 主题换了就重算 */
    const imitateSpecs = useMemo<ImitateSegmentSpec[]>(
        () => (imitateTree ? buildImitateSegments(imitateTree.theme, { hasFigure: true }) : []),
        [imitateTree],
    );
    const imitateSegmentByKey = useMemo(() => {
        const map: Record<string, ImitateSegmentSpec> = {};
        for (const s of imitateSpecs) map[s.key] = s;
        return map;
    }, [imitateSpecs]);

    /** 这一份模仿纸要收的附题（按树上原顺序，勾掉的不要） */
    const pickedChildItems = useMemo(
        () => (imitateTree ? imitateTree.children.filter((c) => pickedChildren.has(c.id)) : []),
        [imitateTree, pickedChildren],
    );

    /**
     * 【2026-10-12】附题的**卷内流水号**（只有勾上的才有）—— 左栏"收哪些附题"列表照它显示，
     * 他挪完一眼就能看出顺序变没变。与复练纸那套同源（顺序就是 `imitateTree.children` 的顺序）。
     */
    const childSerialOf = useMemo(() => {
        const map: Record<string, number> = {};
        if (imitateTree) {
            let n = 0;
            for (const c of imitateTree.children) if (pickedChildren.has(c.id)) map[c.id] = (n += 1);
        }
        return map;
    }, [imitateTree, pickedChildren]);

    /**
     * 附题上移 / 下移一位 —— 与复练纸那一套同一个做法（邻居只从**勾上的那些**里找）。
     * ⚠️ 直接改 `imitateTree.children` 的顺序：`pickedChildItems`、量尺、分页
     *    都是从这个数组推出来的，改这一处就全都跟着动了。
     */
    const moveImitateChild = useCallback(
        (item: ErrorItem, dir: -1 | 1) => {
            setImitateTree((prev) => {
                if (!prev) return prev;
                const list = prev.children;
                const i = list.findIndex((x) => x.id === item.id);
                if (i < 0) return prev;
                let j = -1;
                for (let k = i + dir; k >= 0 && k < list.length; k += dir) {
                    if (pickedChildren.has(list[k].id)) {
                        j = k;
                        break;
                    }
                }
                if (j < 0) return prev;
                const next = [...list];
                [next[i], next[j]] = [next[j], next[i]];
                return { ...prev, children: next };
            });
        },
        [pickedChildren],
    );

    /**
     * 模仿纸的量尺指纹：主题 / 收哪些附题 / 题图大小 / **留白** 任一变了都得重量。
     *
     * ⚠️【2026-10-12 他报的 bug①】原来这里**漏了 `blankOverrides`** ——
     *    于是他在右栏给某道附题加了留白行数，量尺不重量、分页不重算，
     *    版面**冻在**上一次的样子里：把后面的题顶出纸外也**不会**挪到下一页、
     *    把留白改小腾出地方了后面的题也**不会**补上来。
     *    他的描述一字不差："似乎一旦模仿纸排好后交给用户编辑时，就已经将每道题在哪一页锁定了"。
     *    复练纸那一路的 `measureKey` 一直带着留白（所以它没这个毛病），
     *    这里补上就与它对齐了 —— 打印预览本来就是"还没定稿、随便调随便重排"的地方。
     */
    const imitateMeasureKey = useMemo(
        () =>
            [
                imitateTree?.theme.id ?? "",
                pickedChildItems.map((i) => i.id).join("|"),
                JSON.stringify(figureScales),
                JSON.stringify(blankOverrides),
            ].join("#"),
        [imitateTree, pickedChildItems, figureScales, blankOverrides],
    );

    useEffect(() => {
        if (!isImitate) {
            setImitateMeasured(null);
            return;
        }
        if (!imitateTree) {
            setImitateMeasured(null);
            return;
        }
        let cancelled = false;
        (async () => {
            // 与复练纸同一条规矩：先等题图裁完、再等解码完，否则"量到的不是印出来的"
            await whenImagesSettled();
            await whenImagesDecoded(imitateMeasureRef.current);
            if (cancelled) return;
            const el = imitateMeasureRef.current;
            if (!el) return;
            /**
             * 读高度这件事**只有一处实现**（`readImitateHeights`）：
             * 卷管理页也要量同样一份东西，两处各写一遍迟早有一处把 px 当 mm 用。
             */
            const measured = readImitateHeights(
                el,
                imitateSpecs,
                pickedChildItems.map((i) => i.id),
            );
            if (cancelled) return;
            setImitateMeasured(measured);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isImitate, imitateMeasureKey, imitateSpecs]);

    /** 模仿纸的排版：**两条独立的流**（左栏可顺延、右栏整块不跨页） */
    const imitateLayout = useMemo<ImitateLayout | null>(() => {
        if (!isImitate || !imitateMeasured) return null;
        return paginateImitate(imitateMeasured.segments, imitateMeasured.blocks);
    }, [isImitate, imitateMeasured]);

    /**
     * 当前纸别要落库的**页数** —— 复练/积累看 `reviewLayout`，
     * 模仿纸走它自己那条流（`imitateLayout.sheets`）。
     * ⚠️ 两处都要用（组卷落库 + 页二维码一页一个），所以声明一次、别各算各的。
     */
    const volumePageCount = isImitate ? (imitateLayout?.sheets.length ?? 0) : (reviewLayout?.pages.length ?? 0);

    /** 模仿纸：key → 题目本体（主题 + 收进来的附题）—— 纸面组件按 key 取题 */
    const imitateItemByKey = useMemo(() => {
        const map: Record<string, ErrorItem> = {};
        if (imitateTree) {
            map[imitateTree.theme.id] = imitateTree.theme;
            for (const c of pickedChildItems) map[c.id] = c;
        }
        return map;
    }, [imitateTree, pickedChildItems]);

    /**
     * 排版算好了没 —— 「生成 / 更新组卷」按钮的可用条件，也是"能不能打印"的前置。
     * 复练/积累看 `reviewLayout`，模仿纸看它自己那条流。
     */
    const volumeLayoutReady = isImitate ? !!imitateLayout : !!reviewLayout;

    /**
     * 卷的指纹：选择、卷别、留白任一变了，已组的卷就**过期**了 ——
     * 提示重新组卷，而不是悄悄印出一份"纸面与库里的卷对不上"的卷。
     *
     * ⚠️【2026-10-11】声明位置**下移到这里**（原来是"选题"那段之后）：
     *    模仿纸的"选题"是**收哪几道附题**（要等关系查回来才知道），
     *    所以这三个指纹必须等它算完才能定义 —— 早一步就是 TDZ。
     */
    const volumeSig = useMemo(
        () =>
            [
                blankKind,
                isImitate
                    ? `${imitateTree?.theme.id ?? ""}#${pickedChildItems.map((i) => i.id).join("|")}`
                    : selectedItems.map((i) => i.id).join("|"),
                String(blankDefault),
                JSON.stringify(blankOverrides),
                // 【2026-09-29】题图大小也进指纹：改了图就该能用「更新组卷」把新图存回去
                JSON.stringify(figureScales),
            ].join("#"),
        [blankKind, isImitate, imitateTree, pickedChildItems, selectedItems, blankDefault, blankOverrides, figureScales],
    );
    const volumeStale = !!volume && volumeSignature !== volumeSig;

    /**
     * 【2026-09-29】"**选题有没有变**"的指纹（纸别 + 题目 id 顺序）——
     * "要不要换卷号"这一件事，只由它决定。他定的规则：
     *   · 选题**没变**（只调了留白 / 题图大小）⇒ 按钮「更新组卷」，点击**原地覆盖**，卷号不动；
     *   · 选题**变了**（增 / 减 / 换题）⇒ 按钮变回「新生成…卷」，点击生成新卷号、存成新数据。
     * 为什么卷号不能随便换：卷号是**已经印在纸上的那个身份**（页眉＋页二维码都是它），
     * 换了号，先前印出去的纸就再也对不回库里的卷了。
     */
    const selectionSig = useMemo(
        () =>
            [
                blankKind,
                isImitate
                    ? `${imitateTree?.theme.id ?? ""}#${pickedChildItems.map((i) => i.id).join("|")}`
                    : selectedItems.map((i) => i.id).join("|"),
            ].join("#"),
        [blankKind, isImitate, imitateTree, pickedChildItems, selectedItems],
    );
    const [volumeSelectionSig, setVolumeSelectionSig] = useState<string>("");
    /** 库里的卷与当前选题对不上 ⇒ 该走"新生成"（新卷号） */
    const volumeSelectionChanged = !!volume && volumeSelectionSig !== selectionSig;

    // 给选中的题生成二维码（内容是题号，扫码后由 /api/scan 反查）
    const selectedKey = selectedIds.size + ":" + selectedItems.map((i) => i.source || i.id).join("|");
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const entries: Record<string, string> = {};
            await Promise.all(
                selectedItems.map(async (item) => {
                    const no = item.source || item.id;
                    try {
                        entries[item.id] = await makeQrDataUrl(no, { width: 120, margin: 1 });
                    } catch {
                        entries[item.id] = "";
                    }
                }),
            );
            if (!cancelled) setQrMap(entries);
        })();
        return () => { cancelled = true; };
        // 只在选中集合变化时重算，避免每次渲染都重刷二维码
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedKey]);

    /**
     * 【2026-10-03 需求第 10 条】深挖纸的**随机 emoji 标识**：选中题一变就去要一次。
     * 服务端只在列空时随机一个并写回（已有值原样返回）⇒ 重印同一道题符号不变。
     * ⚠️ 只有深挖纸用得上；切到别的纸型不必打这个接口。
     */
    useEffect(() => {
        if (!isDeep || selectedItems.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiClient.post<{ emojiMarks: Record<string, string> }>(
                    "/api/error-items/emoji-marks",
                    { ids: selectedItems.map((i) => i.id) },
                );
                if (!cancelled) setEmojiMarks(res.emojiMarks || {});
            } catch (error) {
                console.error("Failed to load print emoji marks:", error);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isDeep, selectedKey]);

    /**
     * 打印触发：先落 printCount（#10 / T4），再调浏览器打印。
     *
     * 【custom-v25：为什么不改成"真打印了才计数"】
     * `window.print()` 背后是浏览器自带的打印对话框，它**不回传任何结果**：
     * 既没有"用户点了打印"的回调，也没有"取消"的回调。唯一能监听的
     * beforeprint / afterprint 在"点了取消"时同样会触发，拿它计数会变成
     * "取消也记一次"，比现在还差。所以在浏览器给出可用的回传通道之前，
     * 保持"点打印按钮即计数"—— 用户已确认这条路走不通就维持原样。
     */
    const handlePrint = useCallback(async () => {
        if (selectedItems.length === 0) return;
        /**
         * 【T2/T3】卷必须先组好再印。
         * 理由：卷页眉的二维码内容就是"卷号-页码"，没组卷就没有卷号 ——
         * 印出去就是一张**码扫不回来**的纸（面标记规范要求有角标就该有码）。
         * 宁可拦住这一次，也不要印出一张事后查无此卷的纸。
         */
        if ((isVolume || isImitate) && !volume) {
            setVolumeError(
                isImitate
                    ? L("请先点「生成模仿卷」再打印", "Build the imitate volume first")
                    : L("请先点「生成复练卷」再打印", "Build the volume first"),
            );
            return;
        }
        setPrinting(true);
        // 【M3】把"打印日"刷成此刻：页面跨天开着时，纸面日期/三个日期格必须是今天
        setPrintDate(new Date());
        try {
            await apiClient.post("/api/error-items/mark-printed", {
                ids: selectedItems.map((i) => i.id),
                // 【2026-09-30】印的是**卷**（复练/积累/模仿）就记"复练纸印刷次数"；
                // 其余（深挖纸/错题卡/练习卷）沿用深挖口径的 printCount。
                kind: isVolume || isImitate ? "review" : "deep",
            });
        } catch (error) {
            console.error("Failed to record print count:", error);
        }
        // 让 printCount / 打印日的新值先渲染到纸上（若纸面要显示次数）
        // 【M1 / 2026-09-26 三修 + 四修】打印前必须等两件事，缺一件就是"概率性少图"：
        //   ① 题图**生成完**（它是打印时才从原图现裁的，见 use-print-images）
        //   ② 纸面上**所有 img 解码完** —— 图上其实有三个异步来源：
        //      正面原题照片、反面题图、以及 `makeQrDataUrl()` 现生成的二维码。
        //      dataURL 不走网络但**要解码**，解码没完成时 Chrome 的快照会印成空白。
        //      一次选 4 道就是十几个 img，这个窗口比选 1 道明显得多。
        // 两道门都有超时兜底：宁可少一张图，也不能把打印卡住。
        await whenImagesSettled();
        await whenImagesDecoded(document.querySelector('.print-sheet'));
        setTimeout(() => {
            window.print();
            setPrinting(false);
        }, 120);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedItems, isVolume, isImitate, volume?.volumeNo, zh]);

    /**
     * 【T2/T3 · 2026-09-28】**组建一份卷** —— 落库，拿到卷号（如 `RE20260926001`）。
     *
     * 为什么必须落库：卷页眉的二维码内容是 **卷号-页码**，
     * 扫任何一页都要能打开这一整卷并定位到那一页 —— 所以这份卷得先**真实存在**，
     * "组卷"是一次真实的写操作，不是预览的副作用。
     *
     * ⚠️ 存的是**快照**（题号 / 题干 / 等级 / 留白行数），不是只存外键：
     *    卷是印出去的凭证，原题后来被改、被删、被合并，都不该改变它。
     *    `errorItemId` 只是"还能点回去看看"的软链接（题删了它就为空）。
     */
    /**
     * 把当前排版结果拍成"卷内条目" —— **建卷（POST）与更新组卷（PATCH）共用这一处**。
     * 两边各写一遍迟早分叉（"新建的卷有题图、更新过的没有"这种最难查）。
     *
     * 用**函数声明**（不是 useCallback）是有意的：它被上面 `createVolume` 的闭包引用，
     * 声明式能提升，不会踩"先用后声明"的 TDZ。
     */
    /**
     * 模仿卷的**右栏**行（一页里第几道、第几页）—— 单独抽出来，好让左栏那一行拼在它前面。
     * 用**函数声明**（可提升）：上面 `buildVolumeItems` 里先用后声明，声明式不会踩 TDZ。
     */
    function imitateRightRows(sheets: ImitateLayout["sheets"]) {
        return sheets.flatMap((sheet, pi) =>
            sheet.right.map((b, bi) => {
                const item = imitateItemByKey[b.key];
                return {
                    errorItemId: item?.id ?? null,
                    seqInVolume: b.seq,
                    pageIndex: pi + 1,
                    /** 模仿纸恒为右栏（左栏归主题，见下面那条 `columnIndex: 0`） */
                    columnIndex: 1,
                    seqInColumn: bi + 1,
                    itemNo: item?.source ?? null,
                    questionText: (item?.questionText || item?.ocrText) ?? null,
                    manageType: item?.manageType ?? null,
                    blankLines: blankValueOf(b.key),
                    figureScale: figureScaleOf(b.key),
                };
            }),
        );
    }

    function buildVolumeItems() {
        /* ---- 【T4】模仿卷：左栏存**主题那一行**，右栏按页存附题 ---- */
        if (isImitate) {
            if (!imitateLayout || !imitateTree) return [];
            const theme = imitateTree.theme;
            /**
             * 左栏那一行（`columnIndex: 0`、`seqInVolume: 0`）：
             * 记的是**主题题号**（他 2026-10-10 的原话："主要要记的就是左边栏题的题号"）。
             * 他定的规矩里还有一条靠它实现 —— "如果主题已经删除了，那么整个卷都不用生成了"：
             * `errorItemId` 是软链接，题没了这一行就断链，卷页据此判"此卷作废"。
             * ⚠️ 左栏**不存分段结果**（哪几段落在哪一页）：他说了"日后也可以重新生成了"，
             *    重新生成时按主题现算即可；存下来反而会跟"主题被改了"打架。
             */
            const themeRow = {
                errorItemId: theme.id,
                seqInVolume: 0,
                pageIndex: 1,
                columnIndex: 0,
                seqInColumn: 1,
                itemNo: theme.source ?? null,
                questionText: (theme.questionText || theme.ocrText) ?? null,
                manageType: theme.manageType ?? null,
                blankLines: 0,
                figureScale: figureScaleOf(theme.id),
            };
            return [themeRow, ...imitateRightRows(imitateLayout.sheets)];
        }

        if (!reviewLayout) return [];

        return reviewLayout.pages.flatMap((page, pi) =>
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
                        // 留白行数不再存在排版结果里（那是"量出来的高度"），现取
                        blankLines: blankValueOf(b.key),
                        // 题图大小（2026-09-29 起进快照）：不存的话「更新组卷」存完图又回默认
                        figureScale: figureScaleOf(b.key),
                    };
                }),
            ),
        );
    }

    const createVolume = useCallback(async (): Promise<boolean> => {
        /**
         * ⚠️【2026-10-12】返回 `boolean`：离开时的"保存并跳转"必须先知道**存成功没**再决定跳不跳
         *    （没存成还照跳 = 骗他"存过了"）。原来这里只 `return;`，调用方只能靠猜。
         */
        if (!volumeLayoutReady) return false;
        setVolumeCreating(true);
        setVolumeError("");
        try {
            const items = buildVolumeItems();
            const res = await apiClient.post<{
                volume: { id: string; volumeNo: string; pageCount: number; emojiMark?: string | null };
            }>("/api/review-volumes", {
                kind: blankKind,
                gradeSemester: volumeGradeText || null,
                defaultBlankLines: blankDefault,
                pageCount: volumePageCount,
                items,
            });
            setVolume(res.volume);
            setVolumeSignature(volumeSig);
            // 记下"这份卷是按哪套选题组的" ⇒ 之后选题没变就只给「更新组卷」，不再换号
            setVolumeSelectionSig(selectionSig);
            return true;
        } catch (error) {
            console.error("Failed to create review volume:", error);
            setVolumeError(L("组卷失败，请重试", "Failed to build the volume"));
            return false;
        } finally {
            setVolumeCreating(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volumeLayoutReady, volumePageCount, blankKind, volumeGradeText, blankDefault, volumeSig, selectionSig, zh]);

    /**
     * 【2026-09-29】「**更新组卷**」= 原地覆盖，**不换卷号**（他定的规则）。
     * 只在"选题前后没变、只调了留白 / 题图大小"时出现；选题一变，按钮就变回「新生成复练卷」。
     * 走 PATCH：条目整批替换 + 页数刷新，卷号与学期保持不动。
     */
    const updateVolume = useCallback(async (): Promise<boolean> => {
        /** ⚠️ 同上：返回 `boolean`（离开时的"保存并跳转"要靠它决定跳不跳） */
        if (!volume || !volumeLayoutReady) return false;
        setVolumeCreating(true);
        setVolumeError("");
        try {
            const items = buildVolumeItems();
            const res = await apiClient.patch<{
                volume: { id: string; volumeNo: string; pageCount: number; emojiMark?: string | null };
            }>(`/api/review-volumes/${volume.id}`, {
                kind: blankKind,
                gradeSemester: volumeGradeText || null,
                defaultBlankLines: blankDefault,
                pageCount: volumePageCount,
                items,
            });
            setVolume(res.volume);
            setVolumeSignature(volumeSig);
            setVolumeSelectionSig(selectionSig);
            return true;
        } catch (error) {
            console.error("Failed to update review volume:", error);
            setVolumeError(L("更新组卷失败，请重试", "Failed to update the volume"));
            return false;
        } finally {
            setVolumeCreating(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volume, volumeLayoutReady, volumePageCount, blankKind, volumeGradeText, blankDefault, volumeSig, selectionSig, zh]);

    // ============ 【2026-10-12 延伸】手机划栏 + 离开前的三选一 ============

    /** 手机端：左栏上向左划 ⇒ 收起；右栏上向右划 ⇒ 叫回来（判据见 `lib/use-panel-swipe.ts`） */
    const leftSwipe = usePanelSwipe({ onSwipeLeft: () => setLeftHidden(true) });
    const rightSwipe = usePanelSwipe({ onSwipeRight: () => setLeftHidden(false) });

    /**
     * "改过但没更新组卷" —— 判据**刻意与那颗按钮完全一致**（`volumeStale`）：
     * 按钮出现就意味着"纸面已经和库里的卷对不上了"，此刻离开就是丢改动。
     *
     * ⚠️ 范围**只到这儿**：不把"还没生成过卷"（`!volume`）也算脏。
     *    那只是选了几道题、还没签发任何凭证；每次都拦只会让他烦
     *    —— 他这条要求本来就是围着「更新组卷」那颗按钮说的。
     */
    const leaveDirty = volumeStale;

    const [leaveAsk, setLeaveAsk] = useState<{
        /** 这次要去做的事（如"返回"），嵌进那句话里 */
        action: string;
        resolve: (choice: LeaveChoice) => void;
    } | null>(null);

    const askLeave = useCallback(
        (action: string) => new Promise<LeaveChoice>((resolve) => setLeaveAsk({ action, resolve })),
        [],
    );

    const answerLeave = useCallback(
        (choice: LeaveChoice) => {
            const pending = leaveAsk;
            setLeaveAsk(null);
            pending?.resolve(choice);
        },
        [leaveAsk],
    );

    /**
     * 【保存】= **点一下他本该点的那颗按钮**（与按钮的 onClick 同一行逻辑）：
     *   选题没变 ⇒ 「更新组卷」（卷号不动）；选题变了 ⇒ 「新生成…卷」（新卷号）。
     * ⚠️ 存成了才放行；没存成（网络错 / 版面没准备好）就**停在原地**，改动还在。
     */
    const confirmDiscard = useCallback(
        async (actionZh: string, actionEn: string): Promise<boolean> => {
            if (!shouldWarnBeforeLeaving(leaveDirty)) return true;
            const choice = await askLeave(zh ? actionZh : actionEn);
            if (choice === "cancel") return false;
            if (choice === "save") {
                return volume && !volumeSelectionChanged ? await updateVolume() : await createVolume();
            }
            return true; // 「不保存」= 原样走，改动丢掉
        },
        [leaveDirty, zh, askLeave, volume, volumeSelectionChanged, updateVolume, createVolume],
    );

    /** 先问、放行才跳（所有"离开这一屏"的出口都走它，免得有的拦有的不拦） */
    const leaveThen = useCallback(
        async (actionZh: string, actionEn: string, go: () => void) => {
            if (await confirmDiscard(actionZh, actionEn)) go();
        },
        [confirmDiscard],
    );

    /**
     * 浏览器**关闭 / 刷新**标签页那一手也拦一下（与已有组卷页同一套）：
     * 原生框给不了三个键，只能问"真要离开吗"；至少别让他无声无息丢掉改动。
     */
    useEffect(() => {
        if (!leaveDirty) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [leaveDirty]);

    /**
     * 按下分隔条：开始拖。
     * ⚠️ 真正的 mousemove/mouseup 挂在 **window** 上，不是挂在条子自己身上 ——
     *    否则鼠标一拖快、离开那 6px 宽的条子，就断线了（"拖到一半不动了"）。
     */
    const handleSplitterDown = useCallback(
        (e: React.MouseEvent) => {
            splitterDragRef.current = { startX: e.clientX, startW: leftWidth };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        },
        [leftWidth],
    );

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            const drag = splitterDragRef.current;
            if (!drag) return;
            const next = drag.startW + (e.clientX - drag.startX);
            // 夹在 240–760：太窄按钮会挤成一列，太宽预览就没地方了
            setLeftWidth(Math.min(760, Math.max(240, next)));
        };
        const onUp = () => {
            if (!splitterDragRef.current) return;
            splitterDragRef.current = null;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, []);

    /**
     * 拖题图：横向位移 → 等比的新百分比（左上角固定）。
     * ⚠️ 用 **Pointer** 事件（不是 mouse）：同一套代码，手机上手指也能拖 ——
     *    他实测过，鼠标的小把手在手机上根本点不中，只能"按住图左右拖"。
     */
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const drag = figureDragRef.current;
            if (!drag) return;
            const next = figureScaleFromDrag(drag.startPx, e.clientX - drag.startX, e.clientY - drag.startY);
            setFigureScales((prev) => ({ ...prev, [drag.id]: next }));
        };
        const onUp = () => {
            if (!figureDragRef.current) return;
            figureDragRef.current = null;
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

    /**
     * 拖**深挖纸正面原题照片**：与拖题图同一套算法（横向位移 → 等比的新百分比）。
     */
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const drag = photoDragRef.current;
            if (!drag) return;
            const next = figureScaleFromDrag(drag.startPx, e.clientX - drag.startX, e.clientY - drag.startY);
            setPhotoScales((prev) => ({ ...prev, [drag.id]: next }));
        };
        const onUp = () => {
            if (!photoDragRef.current) return;
            photoDragRef.current = null;
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

    /**
     * 【2026-09-28】拖两道题之间的**虚线** ⇒ 调**上面那道题**的留白行数。
     * 他定的规则：向上拖 = 留白按**整行**减少、向下拖 = 整行增加，
     * 调节器上的数字跟着变到虚线所在的位置。
     *
     * 实现是"增量式"的：每凑满一行的像素就**记一次账**（起点跟着挪），
     * 手停在哪就是几行，跟手、不跳。
     */
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const drag = dividerDragRef.current;
            if (!drag) return;
            // ⚠️ 方向：往下拖 = 留白变大（见 blankLinesFromDrag 的说明，2026-09-29 他纠正过）
            const next = blankLinesFromDrag(drag.startLines, e.clientY - drag.startY, drag.startLines);
            if (next === drag.startLines) return;
            drag.startLines = next;
            drag.startY = e.clientY;
            setBlankOverrides((prev) => ({ ...prev, [drag.id]: next }));
        };
        const onUp = () => {
            if (!dividerDragRef.current) return;
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

    /** 按下题图（手机按在图上 / 电脑按右下角把手）：记住起点，之后一动就按比例缩放 */
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

    /** 按住深挖纸正面的原题照片：开始缩放（与拖题图同一套） */
    const handlePhotoDown = useCallback(
        (id: string) => (e: React.PointerEvent) => {
            const box = (e.currentTarget as HTMLElement).parentElement;
            photoDragRef.current = {
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

    /** 按住两道题之间的虚线：开始调上面那道题的留白行数 */
    const handleDividerDown = useCallback(
        (aboveItemId: string, startLines: number) => (e: React.PointerEvent) => {
            dividerDragRef.current = { id: aboveItemId, startY: e.clientY, startLines };
            document.body.style.cursor = "ns-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        },
        [],
    );
    const dividerDragRef = useRef<{ id: string; startY: number; startLines: number } | null>(null);

    /**
     * 整体调整留白行数（设置区那个「− N ＋」）。
     * 规则（他定的）：**只有当前等于旧缺省值的题**跟着变；
     * 已经被单独调过、值不等于旧缺省的那些题**原样保留**。
     * 一处实现：`applyGlobalBlankLines`。
     */
    const changeGlobalBlank = useCallback(
        (next: number) => {
            const clamped = normalizeBlankLines(next, blankDefault);
            if (clamped === blankDefault) return;
            setBlankOverrides((prev) => applyGlobalBlankLines(prev, blankDefault, clamped));
            setBlankDefault(clamped);
        },
        [blankDefault],
    );

    /** 某道题当前生效的留白行数（题干旁边那个小胶囊显示的就是它） */
    const blankValueOf = useCallback(
        (id: string) => effectiveBlankLines(blankOverrides, id, blankKind),
        [blankOverrides, blankKind],
    );

    /** 逐题微调（只在打印阅览页能点；打印时那枚控件被 CSS 隐藏） */
    const onBlankChange = useCallback(
        (id: string, next: number) => {
            setBlankOverrides((prev) => ({
                ...prev,
                [id]: normalizeBlankLines(next, VOLUME_VARIANTS[blankKind].defaultBlankLines),
            }));
        },
        [blankKind],
    );

    /**
     * 换**纸别**（复练 ⇄ 积累 ⇄ 模仿）时：留白缺省与逐题设置**都重来**，已组的卷作废。
     * 理由：三种纸的缺省行数本就不同（复练 5 / 积累 1 / 模仿 5），沿用上一张纸的微调值没有意义；
     * 更要紧的是**卷号绝不能串用** —— 模仿卷是 `CO…`、复练卷是 `RE…`，
     * 拿模仿卷的号去印复练纸，扫出来的码就指到另一份卷上了。
     */
    useEffect(() => {
        setBlankDefault(VOLUME_VARIANTS[blankKind].defaultBlankLines);
        setBlankOverrides({});
        setVolume(null);
        setVolumeSignature("");
        setVolumeSelectionSig("");
    }, [blankKind]);

    /**
     * 卷页眉的二维码：一页一个，内容 = 卷号-页码。
     * （页数取 `volumePageCount` —— 上面已经按纸别算好了，这里不再判断一次。）
     */
    const volumeQrKey = volume ? `${volume.volumeNo}:${volumePageCount}` : "";
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!volume || volumePageCount === 0) {
                setVolumePageQr({});
                return;
            }
            const entries: Record<number, string> = {};
            await Promise.all(
                Array.from({ length: volumePageCount }, async (_x, i) => {
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
            if (!cancelled) setVolumePageQr(entries);
        })();
        return () => {
            cancelled = true;
        };
        // 只在"卷号 + 页数"变化时重刷二维码
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volumeQrKey]);

    /** 错题所属本 → 用于页头年级学期与学科色标 */
    const sheetInfo = useMemo(() => {
        const subjects = [...new Set(selectedItems.map((i) => i.notebook?.displayName).filter(Boolean) as string[])];
        const grades = [...new Set(selectedItems.map((i) => normalizeGrade(i.gradeSemester)).filter(Boolean))];
        const times = selectedItems.map((i) => new Date(i.createdAt).getTime()).filter((n) => !Number.isNaN(n));
        return {
            subjects,
            grades,
            from: times.length ? new Date(Math.min(...times)) : null,
            to: times.length ? new Date(Math.max(...times)) : null,
        };
    }, [selectedItems]);

    /** 练习卷 / 讲解卷共用的正文渲染参数（错题卡与深挖纸各有自己的取法） */
    const bodyOptions: PrintBodyOptions = useMemo(
        () => ({ showQuestionText, showImage, showAnswers, showAnalysis, showMistake, imageScale, L }),
        // L 随语言变化，zh 已覆盖；其余是原始值
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [showQuestionText, showImage, showAnswers, showAnalysis, showMistake, imageScale, zh],
    );

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    const toggles: [string, boolean, (v: boolean) => void][] = [
        [L("题干文字", "Text"), showQuestionText, setShowQuestionText],
        [L("题目原图", "Image"), showImage, setShowImage],
        [L("参考答案", "Answer"), showAnswers, setShowAnswers],
        [L("解析", "Analysis"), showAnalysis, setShowAnalysis],
        [L("错因分析", "Mistake"), showMistake, setShowMistake],
        [L("知识点", "Tags"), showTags, setShowTags],
    ];

    return (
        <div className="print-preview-shell">
            {/* ===== 顶栏（不打印）=====                他要求：这一排**不进左栏也不进右栏**，始终在最上面；
                窄屏时标题放不下就出省略号（不折行），按钮整组折到下一行。 */}
            {/* 【2026-10-03 他要求】顶栏内容也**居中限宽** —— 原来它铺满整宽
                （标题顶左、按钮顶右，"不好看"），而下面两栏是居中的 ⇒ 上下不齐。
                现在与左右两栏（以及复练卷页、日积月累页）用**同一个**包裹规格。 */}
            <div className="no-print shrink-0 z-10 bg-background border-b shadow-sm">
                <div className="mx-auto w-full max-w-[1600px] px-4 py-3 sm:px-8 sm:py-4">
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                        {/**
                          * 【2026-10-12 延伸】返回也要拦：改过卷没更新就走，先问那三选一。
                          * ⚠️ 必须**先拦、再问**：弹框是异步的，没办法"问完了再决定要不要
                          * `preventDefault`"（那时候事件早就发完了）。所以没改就原样放行；
                          * 改过就先把这一下吃掉，再按他的选择决定要不要自己 `router.push`。
                          * `BackButton` 自己内部就是 `router.push(fallbackUrl)` ⇒ 照抄那个落点。
                          */}
                        <span
                            className="shrink-0 inline-flex"
                            onClickCapture={(e) => {
                                if (!leaveDirty) return;
                                e.preventDefault();
                                e.stopPropagation();
                                void leaveThen("返回", "Go back", () => router.push("/notebooks"));
                            }}
                        >
                            <BackButton fallbackUrl="/notebooks" />
                        </span>
                        {/* min-w-0 + truncate：窄屏放不下就省略号，**不折行**。
                            【2026-10-12 他要的】左栏显隐那颗按钮**挪到标题右边**，而且
                            **只留图标**（"去挑'隐藏左栏'（或显示左栏）的文字，就用图标标识即可"）——
                            挪了之后它离"被它控制的那一栏"更近，含义反而更清楚。 */}
                        <div className="flex min-w-0 items-center gap-1">
                            <h1 className="text-lg sm:text-xl font-bold min-w-0 truncate">
                                {L("打印预览", "Print preview")} ({countLabel} {L("题", "items")})
                            </h1>
                            {/* 左栏显隐 —— 图标是他指定的那种"侧栏"样子 */}
                            <Button
                                variant="ghost"
                                size="icon"
                                className="shrink-0"
                                title={leftHidden ? L("显示左栏", "Show panel") : L("隐藏左栏", "Hide panel")}
                                onClick={() => setLeftHidden((v) => !v)}
                            >
                                {leftHidden ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                            </Button>
                        </div>
                        <div className="flex-1" />
                        <div className="flex items-center gap-2">
                            <Button
                                onClick={handlePrint}
                                size="sm"
                                className="whitespace-nowrap"
                                disabled={selectedItems.length === 0 || printing || ((isVolume || isImitate) && !volume)}
                                title={
                                    (isVolume || isImitate) && !volume
                                        ? isImitate
                                            ? L("请先「生成模仿卷」再打印", "Build the imitate volume first")
                                            : L("请先「生成复练卷」再打印", "Build the volume first")
                                        : undefined
                                }
                            >
                                {/* 打印机图标本身就看得懂，窄屏只留图标 */}
                                <Printer className="h-4 w-4" />
                                {/* 【2026-10-12 他要的】文案从「打印 / 存为 PDF」改成**「打印」** */}
                                <span className="hidden sm:inline sm:ml-2">
                                    {printing ? L("准备中…", "Preparing…") : L("打印", "Print")}
                                </span>
                            </Button>
                            <Link
                                href="/"
                                onClick={(e) => {
                                    // 【2026-10-12 延伸】同上：改过就先吃掉这一下，再按他的选择决定跳不跳
                                    if (!leaveDirty) return;
                                    e.preventDefault();
                                    void leaveThen("回主页", "Go home", () => router.push("/"));
                                }}
                            >
                                <Button variant="ghost" size="icon" title={L("回到主页", "Home")}>
                                    <House className="h-5 w-5" />
                                </Button>
                            </Link>
                        </div>
                    </div>
                </div>
                </div>
            </div>

            {/* ===== 左栏（控制）+ 右栏（排版预览）=====
                顶栏（标题 / 打印 / 回主页 / 左栏显隐）**不进任何一栏**，始终在最上面。
                左栏隐藏 ⇒ 这一整块不渲染，右栏自然占满。 */}
            <div className="print-preview-body flex-1 min-h-0" style={{ "--left-w": `${leftWidth}px` } as CSSProperties}>
              {/* 【2026-09-28】左右两栏是一个**整体**：像主页那样居中、随浏览器宽窄一起伸缩。
                  之前只有右栏居中，左栏死死抵住浏览器左边 —— 他一眼就看出不对称。 */}
              <div className="print-preview-frame mx-auto w-full max-w-[1600px] px-4 md:px-8">
                {/* ===== 量尺：不显示、不打印 =====
                    把每道题按**真实栏宽**先排一遍，量出真实高度交给分页纯函数。
                    用的是同一个 `ReviewQuestionBlock`，所以"量到的"就是"印出来的"。
                    ⚠️ 必须是 `visibility: hidden`（**不是 display:none**）：
                       display:none 的元素不参与布局，量出来全是 0。 */}
                {isVolume && selectedItems.length > 0 && (
                    <div
                        ref={measureRef}
                        aria-hidden="true"
                        className="print-review-measure no-print"
                        style={{ width: `${VOLUME_VARIANTS[volumeKind].columnWidthMM}mm` }}
                    >
                        {selectedItems.map((item, i) => (
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
                {/* ===== 【T4】模仿纸的量尺 =====
                    左右两栏**同宽**（各半页），所以一个量尺容器就够了：
                    先量左栏那些"段"（题干/图/遮挡线/答案/解析），再量右栏的附题。
                    左栏用的就是正式版面上那个 `ImitateSegments` —— 两处必然一致。 */}
                {isImitate && imitateTree && (
                    <div
                        ref={imitateMeasureRef}
                        aria-hidden="true"
                        className="print-review-measure no-print"
                        style={{ width: `${VOLUME_VARIANTS.imitate.columnWidthMM}mm` }}
                    >
                        <ImitateSegments
                            specs={imitateSpecs}
                            theme={imitateTree.theme}
                            figureScale={figureScaleOf(imitateTree.theme.id)}
                            L={L}
                        />
                        {pickedChildItems.map((item, i) => (
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
                {!leftHidden && (
                    <>
                    <aside className="print-preview-left no-print" {...leftSwipe}>
                    <div className="space-y-3">

                            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                                <div className="flex items-center gap-1 bg-muted/50 rounded-md p-1">
                                    {/*
                                        纸型标签（他 2026-10-10 定的）：
                                          · **去掉「积累纸 T3」** —— 它单独走「日积月累 → 积累纸·打印」那条路，
                                            不和习题管理混在一块；
                                          · **加上「模仿纸」** —— 只有当前这一道是主题/附题时才点得动
                                            （孤题、或选中多道 ⇒ 没有"主题"可用，禁用并说明原因）。
                                    */}
                                    {/*
                                        【2026-10-24 空空】**「错题卡 / 练习卷 / 讲解卷」三个签先摘掉。**
                                        原话："既然已经开发了就开发了，但暂时不用在这个页面上继续显示了。"
                                        ⇒ 只摘入口，`PrintMode` 的取值、下面的渲染分支、
                                          `components/print/question-bodies.tsx` 全部保留 ——
                                          要恢复只需把这三行加回来。
                                    */}
                                    {([
                                        ["deep", L("深挖纸 ★", "Deep dive ★")],
                                        ["review", L("复练纸 T2", "Review T2")],
                                        ["imitate", L("模仿纸", "Imitate")],
                                    ] as [PrintMode, string][]).map(([key, label]) => {
                                        const disabled = key === "imitate" && !imitateAvailable;
                                        return (
                                            <button
                                                key={key}
                                                type="button"
                                                disabled={disabled}
                                                title={
                                                    disabled
                                                        ? L(
                                                              "模仿纸要有「主题 + 附题」才做得出来：请只选**一道**已经是主题（或附题）的题。",
                                                              "Imitate sheets need a main question with attached ones.",
                                                          )
                                                        : undefined
                                                }
                                                onClick={() => setMode(key)}
                                                className="px-3 py-1 rounded text-xs sm:text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                                                style={{ background: mode === key ? "var(--primary)" : "transparent", color: mode === key ? "var(--primary-foreground)" : "inherit" }}
                                            >
                                                {label}
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* 这几个勾选项与下面两个滑块只对**错题卡 / 练习卷 / 讲解卷**有意义；
                                    卷（复练/积累）与**模仿纸**的版面由它们自己那套参数定 ⇒ 不显示。 */}
                                {!isDeep && !isVolume && !isImitate &&
                                    toggles.map(([label, val, setter]) => (
                                        <label key={label} className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap">
                                            <input
                                                type="checkbox"
                                                checked={val}
                                                onChange={(e) => setter(e.target.checked)}
                                                className="rounded border-gray-300 w-3.5 h-3.5 sm:w-4 sm:h-4"
                                            />
                                            {label}
                                        </label>
                                    ))}
                            </div>

                            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                                {/* 深挖纸的留白与图片宽度由版面自己定，不给滑块 ——
                                    一律按 P9 的尺寸算，免得手一滑把"装得下"调坏了 */}
                                {!isDeep && !isVolume && !isImitate && (
                                    <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                                        <span className="whitespace-nowrap">{L("留白高度", "Space")}: {spaceMM}mm</span>
                                        <input type="range" min={15} max={80} step={5} value={spaceMM} onChange={(e) => setSpaceMM(Number(e.target.value))} className="w-16 sm:w-20" />
                                    </div>
                                )}
                                {!isDeep && !isVolume && !isImitate && (
                                    <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                                        <span className="whitespace-nowrap">{L("图片宽度", "Image")}: {imageScale}%</span>
                                        <input type="range" min={30} max={100} value={imageScale} onChange={(e) => setImageScale(Number(e.target.value))} className="w-16 sm:w-20" />
                                    </div>
                                )}
                                <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap">
                                    <input
                                        type="checkbox"
                                        checked={manualDuplex}
                                        onChange={(e) => setManualDuplex(e.target.checked)}
                                        className="rounded border-gray-300 w-3.5 h-3.5 sm:w-4 sm:h-4"
                                    />
                                    {L("手动双面（翻面提示）", "Manual duplex hint")}
                                </label>
                            </div>

                            {/* 【T2/T3】卷的「整体留白」加减（只在复练/积累纸下出现）。
                                组卷那颗按钮 2026-10-12 已搬到右栏（见 `<main>` 顶部那个工具条）。 */}
                            {isVolume && (
                                <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                                    <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                                        <span className="whitespace-nowrap">
                                            {L("整体留白", "Default space")}: {blankDefault} {L("行", "lines")}
                                        </span>
                                        <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => changeGlobalBlank(blankDefault - 1)}>
                                            −
                                        </Button>
                                        <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => changeGlobalBlank(blankDefault + 1)}>
                                            ＋
                                        </Button>
                                    </div>
                                    {/* 【2026-10-12 他要求】「生成复练卷」那颗按钮**搬到右栏**去了
                                        （挨着纸面，点完一眼就能看到纸变了）。
                                        这一行只留"整体留白"的加减。 */}
                                </div>
                            )}

                            {/* 【T4】模仿纸：主题 + 收哪几道附题 + 组卷（他 2026-10-11 那版设计稿） */}
                            {isImitate && (
                                <div className="space-y-2">
                                    {imitateLoading && (
                                        <p className="text-xs text-muted-foreground">{L("正在读关联题…", "Loading…")}</p>
                                    )}
                                    {!imitateAvailable && (
                                        <div className="rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900">
                                            {L(
                                                "模仿纸要有「主题 + 附题」才做得出来：请只选**一道**已经是主题（或附题）的题。",
                                                "Imitate sheets need a main question with attached questions.",
                                            )}
                                        </div>
                                    )}
                                    {imitateError && (
                                        <div className="rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900">
                                            {imitateError}
                                        </div>
                                    )}

                                    {imitateTree && (
                                        <>
                                            <div className="rounded-md border bg-muted/40 px-2 py-1.5 text-xs sm:text-sm">
                                                <div className="font-medium">
                                                    {L("主题", "Main")}：{imitateTree.theme.source || imitateTree.theme.id}
                                                </div>
                                                <p className="mt-0.5 line-clamp-2 text-muted-foreground">
                                                    {(imitateTree.theme.questionText || imitateTree.theme.ocrText || "").slice(0, 60)}
                                                </p>
                                                <p className="mt-1 text-[11px] text-muted-foreground">
                                                    {L(
                                                        "左栏印这道题的题干 / 题图 / 遮挡线 / 参考答案 / 解析（模仿纸是唯一印答案的纸）。",
                                                        "Left column prints this question's stem, figure, cut line, answer and explanation.",
                                                    )}
                                                </p>
                                            </div>

                                            <div className="flex items-center gap-2 text-xs sm:text-sm">
                                                <span className="whitespace-nowrap">
                                                    {L("收哪些附题", "Attached")}：{pickedChildren.size}/{imitateTree.children.length}
                                                </span>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-6 px-2"
                                                    onClick={() => setPickedChildren(new Set(imitateTree.children.map((c) => c.id)))}
                                                >
                                                    {L("全选", "All")}
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-6 px-2"
                                                    onClick={() => setPickedChildren(new Set())}
                                                >
                                                    {L("清空", "None")}
                                                </Button>
                                            </div>

                                            <div className="max-h-[38vh] space-y-1 overflow-y-auto rounded-md border p-1.5">
                                                {imitateTree.children.length === 0 && (
                                                    <p className="px-1 py-2 text-xs text-muted-foreground">
                                                        {L("这道主题名下还没有附题。", "No attached questions yet.")}
                                                    </p>
                                                )}
                                                {imitateTree.children.map((c) => {
                                                    /** 已掌握的画绿边框（他定的），默认不勾 —— 但仍可手动勾上 */
                                                    const mastered = (c.masteryLevel ?? 0) >= 2;
                                                    const on = pickedChildren.has(c.id);
                                                    return (
                                                        <label
                                                            key={c.id}
                                                            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
                                                            style={
                                                                mastered
                                                                    ? { border: `0.4mm solid ${MASTERED_GREEN}`, borderRadius: "2mm" }
                                                                    : undefined
                                                            }
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                className="mt-0.5"
                                                                checked={on}
                                                                onChange={() =>
                                                                    setPickedChildren((prev) => {
                                                                        const next = new Set(prev);
                                                                        if (next.has(c.id)) next.delete(c.id);
                                                                        else next.add(c.id);
                                                                        return next;
                                                                    })
                                                                }
                                                            />
                                                            {/* 【2026-10-12 他要的】这道附题在**这一卷**里的流水号 ——
                                                                右栏用箭头挪完，这里跟着挪、跟着改号（与复练纸那条同一个做法）。 */}
                                                            <span
                                                                className={`mt-0.5 w-4 shrink-0 text-right tabular-nums ${
                                                                    on ? "font-semibold" : "text-muted-foreground"
                                                                }`}
                                                            >
                                                                {on ? `${childSerialOf[c.id]}.` : "—"}
                                                            </span>
                                                            <span className="min-w-0 flex-1">
                                                                {/* 【2026-10-12 他要的】已掌握的附题：**题号本身**用绿色
                                                                    （绿 = "已经会了"；与上面那道题的绿边框、右边那枚
                                                                     "已掌握"小徽章是同一件事的三种说法）。 */}
                                                                <span
                                                                    className="font-medium"
                                                                    style={mastered ? { color: MASTERED_GREEN } : undefined}
                                                                >
                                                                    {c.source || c.id}
                                                                </span>
                                                                {mastered && (
                                                                    <span className="ml-1.5 rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] text-emerald-700">
                                                                        {L("已掌握", "mastered")}
                                                                    </span>
                                                                )}
                                                                <span className="mt-0.5 line-clamp-2 block text-muted-foreground">
                                                                    {(c.questionText || c.ocrText || "").slice(0, 50)}
                                                                </span>
                                                            </span>
                                                        </label>
                                                    );
                                                })}
                                            </div>

                                            {/* 【2026-10-12 他要求】「生成模仿纸」那颗按钮**搬到右栏**去了
                                                （与复练纸那一处同一条改动）。这一行只留"附题留白"的加减。 */}
                                            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                                                <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                                                    <span className="whitespace-nowrap">
                                                        {L("附题留白", "Space")}: {blankDefault} {L("行", "lines")}
                                                    </span>
                                                    <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => changeGlobalBlank(blankDefault - 1)}>
                                                        −
                                                    </Button>
                                                    <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => changeGlobalBlank(blankDefault + 1)}>
                                                        ＋
                                                    </Button>
                                                </div>
                                            </div>

                                            {/* 太多/太长那两条提示（附题装不下、主题某段超高）都挪到**右栏纸面上方**了
                                                —— 与那颗"生成模仿卷"按钮同一趟搬过去的，
                                                这样"看警告"和"改组卷"在同一个地方，不用左右来回看。 */}
                                        </>
                                    )}
                                </div>
                            )}

                            <p className="text-xs text-muted-foreground">
                                {isDeep
                                    ? L(
                                          "深挖纸（T1，★ 新版）：一道题占一张纸的正反两面。正面=原题照片+反思留白（框只活在软件里，不印到纸上）；反面=干净题面+遮挡线夹出的重做区+页脚三个日期格（打印日 +1/+7/+21）。纸上不印解析、错因、答案——那是回收之后 AI 的活。",
                                          "Deep-dive sheet (T1, new): one question per double-sided sheet.",
                                      )
                                    : isImitate
                                      ? L(
                                            "模仿纸 T4 —— 给还没学明白的孩子：**左栏**把主题整个摊开（题干 → 题图 → 遮挡线 → 参考答案 → 解析，一页放不下就顺延下一页），**右栏**放挂在它名下的附题（与复练纸同一套排版，一道题绝不跨页），让孩子照着例题做。它是四种纸里**唯一印答案与解析**的（不印错因）；其余三种仍然纸上零 AI 内容。",
                                            "Imitate sheet (T4): left column = the main question with its answer and explanation; right column = attached questions to copy-practice.",
                                        )
                                      : isVolume
                                        ? L(
                                              "复练纸 T2 / 积累纸 T3 —— 这是一「卷」：页眉是卷头（阳文框 + 卷号 + 第X/Y页 + 页二维码），题从前往后逐题排，每题 = 流水号 + 题干（+ 题干左下角题图）+ 答题留白，题与题之间一条浅灰虚线。留白按「行」算（复练缺省 5 行、积累缺省 1 行），可整卷调、也可逐题微调（微调的小胶囊只在屏幕上，不会印到纸上）。题绝不跨页/跨栏：放不下就整块顺延。纸上零 AI 内容：不印答案 / 解析 / 错因。",
                                              "Review/Build volume: a real volume with a header (badge + volume no. + page x/y + QR); questions laid out in order, space measured in lines.",
                                          )
                                        : mode === "card"
                                            ? L(
                                                  "错题卡：一道题占一张纸的正反两面——正面重做、背面给错因和答案（灰淡字）。打印那一刻会计一次数。",
                                                  "Error card: one question per sheet — front for redoing, back for cause & answer.",
                                              )
                                            : isPractice
                                                ? L("练习卷：答案与解析统一排在最后，从新的一页开始", "Answers start on a new page")
                                                : L("讲解卷：答案与解析紧跟每题", "Answers follow each question")}
                                {manualDuplex && " · " + L(
                                    "打印机不支持自动双面：打印对话框里先填奇数页 1,3,5…，打完后把纸按「短边翻转」放回纸盒，再填偶数页 2,4,6…",
                                    "No auto duplex: print odd pages 1,3,5… first, flip short-edge, then print even pages 2,4,6…",
                                )}
                            </p>

                            <div className="rounded-md border bg-muted/20 p-3 space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="text-sm font-medium">
                                        {L("选择题目", "Select")} ({selectedItems.length}/{items.length})
                                    </div>
                                    <div className="flex gap-2">
                                        <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set(items.map((i) => i.id)))}>
                                            {L("全选", "All")}
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())}>
                                            {L("清空", "Clear")}
                                        </Button>
                                    </div>
                                </div>
                                <div className="grid gap-2 max-h-80 overflow-y-auto pr-1">
                                    {items.map((item) => (
                                        <div key={item.id} className="flex items-start gap-2 rounded border bg-background p-2 text-xs">
                                            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)} className="mt-0.5 rounded border-gray-300" />
                                            {/* 一道题一行；题干最多两行（清掉 markdown/LaTeX 记号，不然全是 $ 和 \quad）。
                                                【2026-10-12 他要的】行首那个数字是**这一卷里的流水号**（不是"列表里的第几行"）——
                                                他在右栏用箭头挪题之后，这里必须**跟着挪、跟着改号**，
                                                否则"最上面那道是 3 号"这种状态在左栏里根本看不出来。
                                                没勾上的题不在这份卷里 ⇒ 不给号（一个灰短横，免得看起来像"第 0 题"）。 */}
                                            <span className="line-clamp-2 flex-1 min-w-0 break-words">
                                                <span className={`font-semibold ${volumeSerialOf[item.id] ? "" : "text-muted-foreground"}`}>
                                                    {volumeSerialOf[item.id] ? `${volumeSerialOf[item.id]}.` : "—"}
                                                </span>
                                                {item.questionText ? ` ${cleanMarkdown(item.questionText)}` : ""}
                                            </span>
                                            {isCard && (
                                                <label className="flex items-center gap-1 whitespace-nowrap text-muted-foreground cursor-pointer">
                                                    <input type="checkbox" checked={soloIds.has(item.id)} onChange={() => toggleSolo(item.id)} className="rounded border-gray-300" />
                                                    {L("独占页", "Solo")}
                                                </label>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            </div>
                    </aside>
                    <div
                        className="print-preview-splitter no-print"
                        role="separator"
                        aria-orientation="vertical"
                        title={L("拖动调整左右宽度", "Drag to resize")}
                        onMouseDown={handleSplitterDown}
                    />
                    </>
                )}

                <main className="print-preview-right" {...rightSwipe}>
                    {/* ===== 【2026-10-12 他要求】「生成复练卷 / 生成模仿纸」搬到**右栏**（纸面上方）=====
                        他的原话："……无论复练纸页左边栏的『生成复练卷』按钮，还是模仿纸左边栏的
                        『生成模仿纸』按钮，都移到右边栏中去。"
                        搬过来的好处很直接：**按钮挨着它要改变的东西**（纸面），点完不用来回看。
                        ⚠️ `no-print`：它是操作，不是纸上的内容。 */}
                    {(isVolume || isImitate) && (
                        <div className="no-print mx-auto w-full max-w-[1600px] px-4 md:px-8">
                            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background/95 px-3 py-2 shadow-sm">
                                <Button
                                    size="sm"
                                    onClick={volume && !volumeSelectionChanged ? updateVolume : createVolume}
                                    disabled={volumeCreating || !volumeLayoutReady}
                                >
                                    {volumeCreating || !volumeLayoutReady
                                        ? L("保存中…", "Saving…")
                                        : volume
                                          ? volumeSelectionChanged
                                              ? isImitate
                                                  ? L("新生成模仿卷", "Build as new volume")
                                                  : L("新生成复练卷", "Build as new volume")
                                              : L("更新组卷", "Update volume")
                                          : isImitate
                                            ? L("生成模仿卷", "Build volume")
                                            : volumeKind === "build"
                                              ? L("生成积累卷", "Build volume")
                                              : L("生成复练卷", "Build volume")}
                                </Button>
                                {volume && (
                                    <span className="text-xs sm:text-sm">
                                        {L("卷号", "No.")} <b>{volume.volumeNo}</b>
                                        {" · "}
                                        {L("共", "total")} {volumePageCount || volume.pageCount} {L("页", "pages")}
                                    </span>
                                )}
                                {volumeStale && (
                                    <span className="text-xs text-amber-700">
                                        {volumeSelectionChanged
                                            ? isImitate
                                                ? L("收的附题变过了 —— 点「新生成模仿卷」会得到新卷号。", "Selection changed — build as a new volume.")
                                                : L("选题变了 —— 点「新生成复练卷」会得到新卷号；现在纸面与库里的卷对不上。", "Selection changed — build as a new volume.")
                                            : L("留白或题图大小改过了 —— 点「更新组卷」存回去（卷号不变）。", "Spacing or figure size changed — press Update volume.")}
                                    </span>
                                )}
                                {volumeError && <span className="text-xs text-red-600">{volumeError}</span>}
                            </div>
                        </div>
                    )}
                    {/* 跟主页一个口径：居中 + 最大宽 + 左右留白，别顶进浏览器边上。
                        `SheetZoom` 再包一层：双击纸面空白处可在**适应宽度 / 实际大小**两档之间切。
                        【2026-10-03 他要求】**打开就是"适应大小"** —— 原来默认实际大小，
                        右栏一窄（左栏展开时）纸就横向溢出、"得左右拉着才看得全一行"。 */}
                    <SheetZoom
                        className="mx-auto max-w-6xl px-4 py-6 print:max-w-none print:px-0 print:py-0"
                        defaultFit
                        L={L}
                    >
                        <div className="print-sheet">
                    {isDeep ? (
                        <>
                            {selectedItems.map((item, index) => (
                                <DeepDiveCard
                                    key={item.id}
                                    item={item}
                                    index={index}
                                    qrMap={qrMap}
                                    printDate={printDate}
                                    emojiMark={emojiMarks[item.id]}
                                    manualDuplex={manualDuplex}
                                    // 题图缩放与复练纸同一套（电脑拖把手 / 手机按住图左右拖）
                                    figureScaleOf={figureScaleOf}
                                    onFigureScaleStart={handleFigureDown}
                                    // 正面原题照片也能拖把手（2026-09-29 他要求，与反面同一套机制）
                                    photoScaleOf={photoScaleOf}
                                    onPhotoScaleStart={handlePhotoDown}
                                    L={L}
                                />
                            ))}
                        </>
                    ) : isVolume ? (
                        <>
                            {/* 还没组卷：卷号与页二维码都还没有 —— 说清楚"为什么纸上暂时没有码" */}
                            {!volume && (
                                <div className="mb-4 rounded-md border border-sky-500/40 bg-sky-50 p-3 text-sm text-sky-900 print:hidden">
                                    {L(
                                        "还没组卷：卷页眉上的二维码内容是「卷号-页码」，所以要扫得回来，得先把这份卷存下来。点上面「生成复练卷 / 生成积累卷」之后，卷号与页二维码就会出现。",
                                        "Not built yet — press “Build volume” to assign a volume number and page QR codes.",
                                    )}
                                </div>
                            )}
                            {volumeStale && (
                                <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
                                    {volumeSelectionChanged
                                        ? L(
                                              `选题变过了，纸上现在是**新的**排版，而库里的还是 ${volume?.volumeNo ?? ""}。上纸之前请点一次「新生成复练卷」（会得到新卷号，旧卷原样留着）。`,
                                              `Selection changed since ${volume?.volumeNo ?? ""} — build as a new volume before printing.`,
                                          )
                                        : L(
                                              `留白或题图大小改过了，而库里的 ${volume?.volumeNo ?? ""} 还是旧的。上纸之前请点一次「更新组卷」（卷号不变，覆盖保存）。`,
                                              `Spacing or figure size changed — press Update volume before printing.`,
                                          )}
                                </div>
                            )}
                            {/* 组卷体检：题图疑似框歪 —— 排版本轮已经"永不裁图"，
                                但框本身歪只能靠重录，必须让他看见 */}
                            {suspiciousFigureItems.length > 0 && (
                                <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
                                    {L(
                                        `有 ${suspiciousFigureItems.length} 道题的题图可能没框好（框太大/太小/只框到边）：${suspiciousFigureItems
                                            .map((i) => i.source || i.id)
                                            .join('、')}。这几道需要**重新框一次橙框**，图上才能看清。`,
                                        `${suspiciousFigureItems.length} question(s) may have a badly drawn figure box — re-crop them.`,
                                    )}
                                </div>
                            )}
                            {/* 装不下的题（题干太长）：明确提示改用深挖纸 —— 不静默丢题 */}
                            {reviewLayout && reviewLayout.overflow.length > 0 && (
                                <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
                                    {L(
                                        `有 ${reviewLayout.overflow.length} 道题太长，一栏都装不下：${reviewLayout.overflow
                                            .map((o) => reviewItemByKey[o.key]?.source || o.key)
                                            .join('、')}。建议这几道改用「深挖纸」。`,
                                        `${reviewLayout.overflow.length} question(s) too long for this volume — use the deep-dive sheet instead.`,
                                    )}
                                </div>
                            )}
                            {reviewLayout?.pages.map((page, i) => (
                                <ReviewSheet
                                    key={i}
                                    page={page}
                                    pageNo={i + 1}
                                    pageCount={reviewLayout.pages.length}
                                    volumeNo={volume ? volume.volumeNo : L("（尚未组卷）", "(not built yet)")}
                                    kind={volumeKind}
                                    gradeText={volumeGradeText || undefined}
                                    printDate={printDate}
                                    emojiMark={volume?.emojiMark}
                                    pageQr={volumePageQr[i + 1]}
                                    itemByKey={reviewItemByKey}
                                    blankValueOf={blankValueOf}
                                    onBlankChange={onBlankChange}
                                    figureScaleOf={figureScaleOf}
                                    onFigureScaleStart={handleFigureDown}
                                    onDividerDragStart={handleDividerDown}
                                    /* 【2026-10-12】右上角那对"上移/下移"（跨页也能挪，范围是整卷） */
                                    onMoveQuestion={moveReviewItem}
                                    totalSeq={selectedItems.length}
                                    L={L}
                                />
                            ))}
                        </>
                    ) : isImitate ? (
                        <>
                            {!imitateAvailable && (
                                <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
                                    {L(
                                        "模仿纸要有「主题 + 附题」才做得出来：请只选**一道**已经是主题（或附题）的题（在错题本页多选「建立关联」之后，题卡左上角会有角标）。",
                                        "Imitate sheets need a main question with attached questions.",
                                    )}
                                </div>
                            )}
                            {imitateAvailable && !imitateTree && (
                                <div className="mb-4 rounded-md border border-sky-500/40 bg-sky-50 p-3 text-sm text-sky-900 print:hidden">
                                    {imitateLoading ? L("正在读关联题…", "Loading…") : imitateError || L("读不出关联题。", "Cannot load")}
                                </div>
                            )}
                            {!volume && imitateTree && (
                                <div className="mb-4 rounded-md border border-sky-500/40 bg-sky-50 p-3 text-sm text-sky-900 print:hidden">
                                    {L(
                                        "还没组卷：卷页眉上的二维码内容是「卷号-页码」，所以要扫得回来，得先把这份卷存下来。点左上「生成模仿卷」之后，卷号与页二维码就会出现。",
                                        "Not built yet — press “Build volume” to assign a volume number and page QR codes.",
                                    )}
                                </div>
                            )}
                            {volumeStale && (
                                <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
                                    {volumeSelectionChanged
                                        ? L(
                                              `收的附题变过了，纸上现在是**新的**排版，而库里的还是 ${volume?.volumeNo ?? ""}。上纸之前请点一次「新生成模仿卷」。`,
                                              `Selection changed since ${volume?.volumeNo ?? ""} — build as a new volume before printing.`,
                                          )
                                        : L(
                                              `留白或题图大小改过了，而库里的 ${volume?.volumeNo ?? ""} 还是旧的。上纸之前请点一次「更新组卷」（卷号不变）。`,
                                              "Spacing or figure size changed — press Update volume before printing.",
                                          )}
                                </div>
                            )}
                            {/* 半页都装不下的附题：明确提示改用深挖纸 —— **不静默丢题**
                                （原来这条在左栏，2026-10-12 生成按钮搬过来时一并挪到纸面上方）。 */}
                            {imitateLayout && imitateLayout.overflowRight.length > 0 && (
                                <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
                                    {L(
                                        `有 ${imitateLayout.overflowRight.length} 道附题太长，半页都装不下：${imitateLayout.overflowRight
                                            .map((o) => imitateItemByKey[o.key]?.source || o.key)
                                            .join("、")}。建议这几道改用「深挖纸」。`,
                                        "Some attached questions are too long for half a page — use the deep-dive sheet.",
                                    )}
                                </div>
                            )}
                            {/* 主题里有一段比一整栏还高 ⇒ 纸上看不全。
                                **绝不静默少印**：说清是哪一段、怎么改（空一行 / 加个【小标题】就行）。 */}
                            {imitateLayout && imitateLayout.overflowLeft.length > 0 && (
                                <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
                                    {L(
                                        `主题里有 ${imitateLayout.overflowLeft.length} 段太长，一整栏都放不下（${imitateLayout.overflowLeft
                                            .map((o) => {
                                                const role = o.key.includes(':analysis')
                                                    ? "解析"
                                                    : o.key.includes(':answer')
                                                      ? "参考答案"
                                                      : "题干";
                                                return role;
                                            })
                                            .join("、")}）—— 纸上看不全。把这一段拆开就好：在要断的地方**空一行**，或者加一行**【小节标题】**。`,
                                        "A section of the main question is taller than a full column — split it into paragraphs (blank line) or add 【section】 headings.",
                                    )}
                                </div>
                            )}
                            {imitateLayout?.sheets.map((sheet, i) => (
                                <ImitateSheet
                                    key={i}
                                    sheet={sheet}
                                    segmentByKey={imitateSegmentByKey}
                                    theme={imitateTree?.theme ?? null}
                                    themeNo={imitateTree?.theme.source ?? null}
                                    pageNo={i + 1}
                                    pageCount={imitateLayout.sheets.length}
                                    volumeNo={volume ? volume.volumeNo : L("（尚未组卷）", "(not built yet)")}
                                    kind="imitate"
                                    gradeText={volumeGradeText || undefined}
                                    printDate={printDate}
                                    emojiMark={volume?.emojiMark}
                                    pageQr={volumePageQr[i + 1]}
                                    itemByKey={imitateItemByKey}
                                    blankValueOf={blankValueOf}
                                    onBlankChange={onBlankChange}
                                    figureScaleOf={figureScaleOf}
                                    onFigureScaleStart={handleFigureDown}
                                    onDividerDragStart={handleDividerDown}
                                    /* 【2026-10-12】右栏附题的"上移/下移"（与复练纸同一套） */
                                    onMoveQuestion={moveImitateChild}
                                    totalSeq={pickedChildItems.length}
                                    L={L}
                                />
                            ))}
                        </>
                    ) : isCard ? (
                        <>
                            {selectedItems.map((item, index) => (
                                <ErrorCard
                                    key={item.id}
                                    item={item}
                                    index={index}
                                    qrMap={qrMap}
                                    soloIds={soloIds}
                                    showTags={showTags}
                                    spaceMM={spaceMM}
                                    manualDuplex={manualDuplex}
                                    options={bodyOptions}
                                />
                            ))}
                        </>
                    ) : (
                        <>
                            <div className="print-sheet-head" style={{ borderBottom: "2px solid #111", paddingBottom: "3mm", marginBottom: "5mm" }}>
                                <div style={{ fontSize: "16pt", fontWeight: 700, letterSpacing: "2px" }}>
                                    {isPractice ? L("错题练习卷", "Practice sheet") : L("错题讲解卷", "Study sheet")}
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "0 8mm", marginTop: "1mm", fontSize: "10pt", color: "#444" }}>
                                    {sheetInfo.subjects.length > 0 && <span>{L("学科", "Subject")}：{sheetInfo.subjects.join("/")}</span>}
                                    {sheetInfo.grades.length > 0 && <span>{L("年级", "Grade")}：{sheetInfo.grades.join("/")}</span>}
                                    {sheetInfo.from && sheetInfo.to && (
                                        <span>
                                            {L("范围", "Range")}：{formatIsoDate(sheetInfo.from)}
                                            {formatIsoDate(sheetInfo.from) !== formatIsoDate(sheetInfo.to) ? ` ~ ${formatIsoDate(sheetInfo.to)}` : ""}
                                        </span>
                                    )}
                                    <span>{L("共", "Total")} {selectedItems.length} {L("题", "Q")}</span>
                                </div>
                                <div style={{ display: "flex", gap: "8mm", marginTop: "2mm", fontSize: "10pt" }}>
                                    <span>{L("姓名", "Name")}：__________</span>
                                    <span>{L("用时", "Time")}：__________</span>
                                    <span>{L("得分", "Score")}：__________</span>
                                </div>
                            </div>

                            {selectedItems.map((item, index) => {
                                const tags = getTags(item);
                                return (
                                    <div
                                        key={item.id}
                                        className={`print-question ${soloIds.has(item.id) ? "print-question--solo" : ""}`}
                                        style={{ marginBottom: "5mm", paddingBottom: "3mm", borderBottom: "1px dashed #ddd" }}
                                    >
                                        <div style={{ display: "flex", alignItems: "baseline", gap: "2mm", marginBottom: "1mm" }}>
                                            <span style={{ fontWeight: 700, fontSize: "12pt" }}>{index + 1}.</span>
                                            <span style={{ fontSize: "9pt", color: "#666" }}>{item.source}</span>
                                            {showTags && tags.length > 0 && <span style={{ fontSize: "9pt", color: "#666" }}>[{tags.join(" / ")}]</span>}
                                        </div>
                                        <QuestionBody item={item} options={bodyOptions} />
                                        {isPractice ? (
                                            <div className="print-answer-space" style={{ height: `${spaceMM}mm`, marginTop: "3mm" }} />
                                        ) : (
                                            <div style={{ marginTop: "3mm" }}>
                                                <AnswerBody item={item} options={bodyOptions} />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {isPractice && (showAnswers || showAnalysis || showMistake) && (
                                <div className="print-answers">
                                    <div
                                        className="print-sheet-head"
                                        style={{ borderBottom: "2px solid #111", paddingBottom: "2mm", marginBottom: "4mm", fontSize: "14pt", fontWeight: 700 }}
                                    >
                                        {L("参考答案与解析", "Answers & explanations")}
                                    </div>
                                    {selectedItems.map((item, index) => (
                                        <div
                                            key={item.id}
                                            className="print-answer-item"
                                            style={{ marginBottom: "4mm", paddingBottom: "3mm", borderBottom: "1px dashed #ddd" }}
                                        >
                                            <div className="print-sub-title" style={{ fontWeight: 700, marginBottom: "1mm" }}>
                                                {L("第", "Q")} {index + 1} {L("题", "")}
                                            </div>
                                            <AnswerBody item={item} options={bodyOptions} />
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    {emptyState && (
                        <div style={{ textAlign: "center", padding: "20mm 0", color: "#999" }}>
                            {emptyState === "noSelection"
                                ? L("没有选中任何题目", "No items selected")
                                : L("没有符合条件的错题", "No matching error items")}
                        </div>
                    )}
                        </div>
                    </SheetZoom>
                </main>
              </div>
            </div>

            {/* 【2026-10-12 延伸】离开这一屏（返回 / 回主页）时的三选一。
                判据与那颗「更新组卷」按钮**完全一致**（`volumeStale`）——
                按钮出现就说明"纸面已经和库里的卷对不上"，此刻走就是丢改动。
                三个键的顺序照已有组卷页来：**保存 → 不保存 → 取消**；主按钮是「保存」。
                ⚠️ Esc / 点遮罩 = 取消（Radix 的默认关闭回调落到 `answerLeave("cancel")`）。 */}
            <Dialog open={!!leaveAsk} onOpenChange={(open) => { if (!open) answerLeave("cancel"); }}>
                <DialogContent className="no-print">
                    <DialogHeader>
                        <DialogTitle>{L("修改组卷未更新", "Unsaved volume changes")}</DialogTitle>
                        <DialogDescription>{L("是否保存更新？", "Save the changes before leaving?")}</DialogDescription>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        {leaveAsk ? unsavedLeaveMessage(zh, leaveAsk.action, leaveAsk.action) : ""}
                    </p>
                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button onClick={() => answerLeave("save")}>{L("保存", "Save")}</Button>
                        <Button variant="outline" onClick={() => answerLeave("discard")}>
                            {L("不保存", "Don't save")}
                        </Button>
                        <Button variant="ghost" onClick={() => answerLeave("cancel")}>
                            {L("取消", "Cancel")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

export default function PrintPreviewPage() {
    const { t } = useLanguage();
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center">{t.common.loading}</div>}>
            <PrintPreviewContent />
        </Suspense>
    );
}
