"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { House } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
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
import {
    BUILD_DEFAULT_BLANK_LINES,
    REVIEW_DEFAULT_BLANK_LINES,
    VOLUME_VARIANTS,
    applyGlobalBlankLines,
    effectiveBlankLines,
    normalizeBlankLines,
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
type PrintMode = "deep" | "review" | "build" | "card" | "practice" | "explain";

function PrintPreviewContent() {
    const searchParams = useSearchParams();
    const { t, language } = useLanguage();
    const zh = language === "zh";
    const L = (a: string, b: string) => (zh ? a : b);

    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [printing, setPrinting] = useState(false);

    /**
     * 【custom-v25】默认进**错题卡**，不再是练习卷。
     * 家里日常就是把「一道题一张卡（正面重做、背面错因+答案）」打出来做复做，
     * 练习卷/讲解卷是偶尔才用的另一种排版，默认值应当给常用的那个。
     * 下面那段读 URL 的 effect 仍会覆盖它（三级打印入口带 ?mode=xxx 时以入口为准）。
     */
    const [mode, setMode] = useState<PrintMode>("card");
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

    /* ===== 【T2/T3 · 2026-09-28】卷的状态 =====
       · blankDefault  整卷的缺省留白行数（复练 5 行、积累 1 行）
       · blankOverrides 逐题微调过的值（没调过的题不在表里 ⇒ 跟着缺省走）
       · volume        已**落库**的那份卷（没落库就没有卷号、也不印二维码）
                       —— 卷页眉的码内容是"卷号-页码"，扫回这份卷要它真实存在，
                          所以"组卷"是一次真实的写操作，不是预览的副作用。 */
    const [blankDefault, setBlankDefault] = useState<number>(REVIEW_DEFAULT_BLANK_LINES);
    const [blankOverrides, setBlankOverrides] = useState<Record<string, number | null | undefined>>({});
    const [volume, setVolume] = useState<{ id: string; volumeNo: string; pageCount: number } | null>(null);
    const [volumeSignature, setVolumeSignature] = useState<string>("");
    const [volumeCreating, setVolumeCreating] = useState(false);
    const [volumeError, setVolumeError] = useState<string>("");

    /** 复练纸这一页每一页的二维码（key = 页码） */
    const [volumePageQr, setVolumePageQr] = useState<Record<number, string>>({});

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
    useEffect(() => {
        const m = new URLSearchParams(window.location.search).get("mode");
        if (m === "deep" || m === "review" || m === "build" || m === "card" || m === "practice" || m === "explain") {
            setMode(m);
        }
    }, []);

    const fetchItems = async () => {
        try {
            const params = new URLSearchParams(searchParams.toString());
            params.set("pageSize", String(PRINT_PREVIEW_PAGE_SIZE));
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
    const countLabel = getPrintPreviewCountLabel(items.length, selectedItems.length);
    const emptyState = getPrintPreviewEmptyState(items.length, selectedItems.length);
    const isDeep = mode === "deep";
    const isReview = mode === "review";
    const isBuild = mode === "build";
    /** 【T2/T3】"卷"两种模式（复练 / 积累）——它们走同一套组件，只是版面参数不同 */
    const isVolume = isReview || isBuild;
    const volumeKind: VolumeKind = isBuild ? "build" : "review";

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

    /** 量尺指纹：题 / 卷别 / 留白任一变了，就得重量一遍 */
    const measureKey = useMemo(
        () =>
            [volumeKind, selectedItems.map((i) => i.id).join("|"), JSON.stringify(blankOverrides)].join("#"),
        [volumeKind, selectedItems, blankOverrides],
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
     */
    const volumeGradeText = useMemo(() => {
        const grades = [
            ...new Set(selectedItems.map((i) => normalizeGrade(i.gradeSemester)).filter(Boolean) as string[]),
        ];
        return grades.slice(0, 2).join(" · ");
    }, [selectedItems]);

    /**
     * 卷的指纹：选择、卷别、留白任一变了，已组的卷就**过期**了 ——
     * 提示重新组卷，而不是悄悄印出一份"纸面与库里的卷对不上"的卷。
     */
    const volumeSig = useMemo(
        () =>
            [
                volumeKind,
                selectedItems.map((i) => i.id).join("|"),
                String(blankDefault),
                JSON.stringify(blankOverrides),
            ].join("#"),
        [volumeKind, selectedItems, blankDefault, blankOverrides],
    );
    const volumeStale = !!volume && volumeSignature !== volumeSig;

    /** 复练纸：key（题目 id）→ 题目本体，供卡片取用 */
    const reviewItemByKey = useMemo(() => {
        const map: Record<string, ErrorItem> = {};
        for (const item of selectedItems) map[item.id] = item;
        return map;
    }, [selectedItems]);
    const isCard = mode === "card";
    const isPractice = mode === "practice";

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
        if (isVolume && !volume) {
            setVolumeError(L("请先点「生成复练卷」再打印", "Build the volume first"));
            return;
        }
        setPrinting(true);
        // 【M3】把"打印日"刷成此刻：页面跨天开着时，纸面日期/三个日期格必须是今天
        setPrintDate(new Date());
        try {
            await apiClient.post("/api/error-items/mark-printed", {
                ids: selectedItems.map((i) => i.id),
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
    }, [selectedItems, isVolume, volume?.volumeNo, zh]);

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
    const createVolume = useCallback(async () => {
        if (!reviewLayout || selectedItems.length === 0) return;
        setVolumeCreating(true);
        setVolumeError("");
        try {
            const items = reviewLayout.pages.flatMap((page, pi) =>
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
                        };
                    }),
                ),
            );
            const res = await apiClient.post<{
                volume: { id: string; volumeNo: string; pageCount: number };
            }>("/api/review-volumes", {
                kind: volumeKind,
                gradeSemester: volumeGradeText || null,
                defaultBlankLines: blankDefault,
                pageCount: reviewLayout.pages.length,
                items,
            });
            setVolume(res.volume);
            setVolumeSignature(volumeSig);
        } catch (error) {
            console.error("Failed to create review volume:", error);
            setVolumeError(L("组卷失败，请重试", "Failed to build the volume"));
        } finally {
            setVolumeCreating(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reviewLayout, selectedItems, reviewItemByKey, volumeKind, volumeGradeText, blankDefault, volumeSig, zh]);

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
        (id: string) => effectiveBlankLines(blankOverrides, id, volumeKind),
        [blankOverrides, volumeKind],
    );

    /** 逐题微调（只在打印阅览页能点；打印时那枚控件被 CSS 隐藏） */
    const onBlankChange = useCallback(
        (id: string, next: number) => {
            setBlankOverrides((prev) => ({
                ...prev,
                [id]: normalizeBlankLines(next, VOLUME_VARIANTS[volumeKind].defaultBlankLines),
            }));
        },
        [volumeKind],
    );

    /**
     * 换卷别（复练 ⇄ 积累）时：留白缺省与逐题设置**都重来**，已组的卷作废。
     * 理由：两种纸的缺省行数本就不同（5 vs 1），沿用上一张纸的微调值没有意义。
     */
    useEffect(() => {
        if (!isVolume) return;
        setBlankDefault(volumeKind === "build" ? BUILD_DEFAULT_BLANK_LINES : REVIEW_DEFAULT_BLANK_LINES);
        setBlankOverrides({});
        setVolume(null);
        setVolumeSignature("");
        // 只在"卷别"变化时重置
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volumeKind]);

    /** 卷页眉的二维码：一页一个，内容 = 卷号-页码 */
    const volumeQrKey = volume ? `${volume.volumeNo}:${reviewLayout?.pages.length ?? 0}` : "";
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!volume || !reviewLayout) {
                setVolumePageQr({});
                return;
            }
            const entries: Record<number, string> = {};
            await Promise.all(
                reviewLayout.pages.map(async (_page, i) => {
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
        <>
            {/* ===== 控制栏（不打印） ===== */}
            <div className="no-print sticky top-0 z-10 bg-background border-b p-3 sm:p-4 shadow-sm">
                <div className="space-y-3">
                    <div className="flex items-center gap-3">
                        <BackButton fallbackUrl="/notebooks" />
                        <h1 className="text-lg sm:text-xl font-bold flex-1">
                            {L("打印预览", "Print preview")} ({countLabel} {L("题", "items")})
                        </h1>
                        {/* 左栏显隐 —— 他要求这个键也在**上面**：不进左栏、也不进右栏 */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="whitespace-nowrap"
                            onClick={() => setLeftHidden((v) => !v)}
                        >
                            {leftHidden ? L("显示左栏", "Show panel") : L("隐藏左栏", "Hide panel")}
                        </Button>
                        <Button
                            onClick={handlePrint}
                            size="sm"
                            className="whitespace-nowrap"
                            disabled={selectedItems.length === 0 || printing || (isVolume && !volume)}
                            title={isVolume && !volume ? L("请先「生成复练卷」再打印", "Build the volume first") : undefined}
                        >
                            {printing ? L("准备中…", "Preparing…") : L("打印 / 存为 PDF", "Print / Save PDF")}
                        </Button>
                        {/* 【custom-v24】右上角补一个主页按钮，和其他页面右上角的小房子统一。
                            控制栏整体是 no-print，所以它只会出现在屏幕上，不会被印到纸上。 */}
                        <Link href="/">
                            <Button variant="ghost" size="icon" title={L("回到主页", "Home")}>
                                <House className="h-5 w-5" />
                            </Button>
                        </Link>
                    </div>
                </div>
            </div>

            {/* ===== 左栏（控制）+ 右栏（排版预览）=====
                顶栏（标题 / 打印 / 回主页 / 左栏显隐）**不进任何一栏**，始终在最上面。
                左栏隐藏 ⇒ 这一整块不渲染，右栏自然占满。 */}
            <div className="print-preview-body" style={{ "--left-w": `${leftWidth}px` } as CSSProperties}>
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
                                L={L}
                            />
                        ))}
                    </div>
                )}
                {!leftHidden && (
                    <>
                    <aside className="print-preview-left no-print">
                    <div className="space-y-3">

                            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                                <div className="flex items-center gap-1 bg-muted/50 rounded-md p-1">
                                    {([
                                        ["deep", L("深挖纸 ★", "Deep dive ★")],
                                        ["review", L("复练纸 T2", "Review T2")],
                                        ["build", L("积累纸 T3", "Build T3")],
                                        ["card", L("错题卡", "Error card")],
                                        ["practice", L("练习卷", "Practice")],
                                        ["explain", L("讲解卷", "Study")],
                                    ] as [PrintMode, string][]).map(([key, label]) => (
                                        <button
                                            key={key}
                                            type="button"
                                            onClick={() => setMode(key)}
                                            className="px-3 py-1 rounded text-xs sm:text-sm"
                                            style={{ background: mode === key ? "var(--primary)" : "transparent", color: mode === key ? "var(--primary-foreground)" : "inherit" }}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>

                                {!isDeep && !isVolume &&
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
                                {!isDeep && !isVolume && (
                                    <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                                        <span className="whitespace-nowrap">{L("留白高度", "Space")}: {spaceMM}mm</span>
                                        <input type="range" min={15} max={80} step={5} value={spaceMM} onChange={(e) => setSpaceMM(Number(e.target.value))} className="w-16 sm:w-20" />
                                    </div>
                                )}
                                {!isDeep && !isVolume && (
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

                            {/* 【T2/T3】卷的设置：整体留白 + 组卷（只在复练/积累纸下出现） */}
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
                                    <Button size="sm" onClick={createVolume} disabled={volumeCreating || !reviewLayout || selectedItems.length === 0}>
                                        {volumeCreating || !reviewLayout
                                            ? L("排版中…", "Laying out…")
                                            : volume
                                              ? L("重新组卷", "Rebuild")
                                              : volumeKind === "build"
                                                ? L("生成积累卷", "Build volume")
                                                : L("生成复练卷", "Build volume")}
                                    </Button>
                                    {volume && (
                                        <span className="text-xs sm:text-sm">
                                            {L("卷号", "No.")} <b>{volume.volumeNo}</b>
                                            {" · "}
                                            {L("共", "total")} {reviewLayout?.pages.length ?? volume.pageCount} {L("页", "pages")}
                                        </span>
                                    )}
                                    {volumeStale && (
                                        <span className="text-xs text-amber-700">
                                            {L("选择或留白改过了 —— 请点「重新组卷」，否则纸面与库里的卷对不上", "Selection changed — rebuild the volume")}
                                        </span>
                                    )}
                                    {volumeError && <span className="text-xs text-red-600">{volumeError}</span>}
                                </div>
                            )}

                            <p className="text-xs text-muted-foreground">
                                {isDeep
                                    ? L(
                                          "深挖纸（T1，★ 新版）：一道题占一张纸的正反两面。正面=原题照片+反思留白（框只活在软件里，不印到纸上）；反面=干净题面+遮挡线夹出的重做区+页脚三个日期格（打印日 +1/+7/+21）。纸上不印解析、错因、答案——那是回收之后 AI 的活。",
                                          "Deep-dive sheet (T1, new): one question per double-sided sheet.",
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
                                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-44 overflow-y-auto pr-1">
                                    {items.map((item, index) => (
                                        <div key={item.id} className="flex items-start gap-2 rounded border bg-background p-2 text-xs">
                                            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)} className="mt-0.5 rounded border-gray-300" />
                                            <span className="line-clamp-2 flex-1">
                                                <span className="font-semibold">{index + 1}.</span>
                                                {item.questionText ? ` ${item.questionText}` : ""}
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

                <main className="print-preview-right">
                    <div className="py-6 px-4 print:p-0 print:py-0">
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
                                    manualDuplex={manualDuplex}
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
                                    {L(
                                        `题目、留白或卷别改过了，纸上现在是**新的**排版，而库里的还是 ${volume?.volumeNo ?? ""}。上纸之前请点一次「重新组卷」。`,
                                        `Layout changed since ${volume?.volumeNo ?? ""} was built — rebuild before printing.`,
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
                                    pageQr={volumePageQr[i + 1]}
                                    itemByKey={reviewItemByKey}
                                    blankValueOf={blankValueOf}
                                    onBlankChange={onBlankChange}
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
                    </div>
                </main>
            </div>
        </>
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
