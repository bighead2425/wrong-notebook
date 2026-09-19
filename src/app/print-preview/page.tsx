"use client";

import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { House } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { SubjectChip } from "@/components/subject-chip";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { PRINT_PREVIEW_PAGE_SIZE } from "@/lib/constants/pagination";
import { getPrintPreviewCountLabel, getPrintPreviewEmptyState, getSelectedPrintItems } from "@/lib/print-preview";
import { makeQrDataUrl } from "@/lib/qr";

/* 纸张容器样式见 globals.css 的 .print-sheet：
   国内市售 B5 = 182mm × 257mm（JIS B5），页边距 15mm → 内容区宽 152mm，
   并强制为浅色，保证深色主题下预览与打印都是白纸黑字。 */

type PrintMode = "practice" | "explain" | "card";

/** 年级字段归一化：库里混有「五年级」「五年级上」「Grade 6, 1st Semester」等写法 */
function normalizeGrade(raw?: string | null): string {
    if (!raw) return "";
    const en = raw.match(/^\s*grade\s*(\d+)/i);
    if (en) {
        const cn: Record<string, string> = {
            "1": "一年级", "2": "二年级", "3": "三年级",
            "4": "四年级", "5": "五年级", "6": "六年级",
        };
        return cn[en[1]] || raw;
    }
    return raw.replace(/_/g, " ").trim();
}

function fmtDateSlash(d: Date): string {
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 剥离解析里的【错因分析】段落。
 * AI 会把错因同时写进 analysis 和 mistakeAnalysis 两个字段，
 * 全开就会重复印两遍，所以独立错因字段有内容时，从解析里去掉这一段。
 */
function stripMistakeSection(analysis: string): string {
    const start = analysis.indexOf("【错因分析】");
    if (start < 0) return analysis;
    const rest = analysis.slice(start);
    const nextTitle = rest.indexOf("\n【", 1);
    if (nextTitle < 0) return analysis.slice(0, start).trimEnd();
    return (analysis.slice(0, start) + rest.slice(nextTitle + 1)).trim();
}

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

    // 手动双面：家里打印机不支持自动双面，靠爹手动翻
    const [manualDuplex, setManualDuplex] = useState(false);

    useEffect(() => {
        fetchItems();
    }, []);

    // 三级打印按钮通过 URL 传打印意图（?mode=card|practice|explain）。
    // 此前 mode 硬编码为 "practice" 且从不读 URL，导致卡片模板
    // （题号色标 + 二维码 + 正反面/一题两页）在任何入口下都不会渲染。
    // 直接读 window.location 而非 useSearchParams，避免静态渲染下取值为空的时序问题。
    useEffect(() => {
        const m = new URLSearchParams(window.location.search).get("mode");
        if (m === "card" || m === "practice" || m === "explain") {
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
            setItems(response.items);
            setSelectedIds(new Set(response.items.map((item) => item.id)));
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
        setPrinting(true);
        try {
            await apiClient.post("/api/error-items/mark-printed", {
                ids: selectedItems.map((i) => i.id),
            });
        } catch (error) {
            console.error("Failed to record print count:", error);
        }
        // 让 printCount 的新值先渲染到纸上（若纸面要显示次数）
        setTimeout(() => {
            window.print();
            setPrinting(false);
        }, 120);
    }, [selectedItems]);

    const getTags = (item: ErrorItem): string[] => {
        if (item.tags && item.tags.length > 0) return item.tags.map((x) => x.name);
        try {
            const arr = JSON.parse(item.knowledgePoints || "[]");
            return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === "string") : [];
        } catch {
            return [];
        }
    };

    /** 错题所属本 → 用于页头年级学期与学科色标 */
    const nbInfo = (item: ErrorItem) => {
        const nb = item.notebook;
        if (!nb) {
            return { gradeText: normalizeGrade(item.gradeSemester) || L("未分本", "Unfiled"), subjectKey: "other" };
        }
        const grade = nb.grade || normalizeGrade(item.gradeSemester);
        const sem = nb.semester ? (nb.semester === "下" ? "下" : "上") : "";
        const gradeText = [grade, sem ? `${sem}学期` : ""].filter(Boolean).join(" · ")
            || nb.displayName;
        return { gradeText, subjectKey: nb.subject || "other" };
    };

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

    const QuestionBody = ({ item }: { item: ErrorItem }) => {
        const hasText = showQuestionText && !!item.questionText;
        const hasImg = showImage && !!item.originalImageUrl;
        if (!hasText && !hasImg) {
            return <div style={{ color: "#999" }}>{L("（该题没有可打印的题干）", "(nothing to print)")}</div>;
        }
        return (
            <>
                {hasText && (
                    <div style={{ marginBottom: hasImg ? "2mm" : 0 }}>
                        <MarkdownRenderer content={item.questionText as string} />
                    </div>
                )}
                {/* 【custom-v26】题干文字与题目原图之间加一条虚线。
                    两者同处一个方框里，中间不留界的话，长题干下面接着一张图，
                    一眼看过去会以为图也是题干的一部分（尤其图里还带着手写答案时）。
                    用虚线而非实线：它是"同一块内容内部的分隔"，不该抢原题边框的层级。 */}
                {hasText && hasImg && (
                    <div style={{ borderTop: "1px dashed #888", marginBottom: "3mm" }} />
                )}
                {hasImg && (
                    <img
                        src={item.originalImageUrl as string}
                        alt=""
                        style={{ maxWidth: `${imageScale}%`, height: "auto", display: "block" }}
                    />
                )}
            </>
        );
    };

    const AnswerBody = ({ item }: { item: ErrorItem }) => {
        const hasMistakeField = showMistake && !!item.mistakeAnalysis;
        const analysisText = item.analysis
            ? hasMistakeField
                ? stripMistakeSection(item.analysis)
                : item.analysis
            : "";
        return (
            <>
                {showAnswers && item.answerText && (
                    <div style={{ marginBottom: "2mm" }}>
                        <div className="print-sub-title" style={{ fontWeight: 600 }}>
                            {L("参考答案", "Answer")}
                        </div>
                        <MarkdownRenderer content={item.answerText} />
                    </div>
                )}
                {showAnalysis && analysisText && (
                    <div style={{ marginBottom: "2mm" }}>
                        <div className="print-sub-title" style={{ fontWeight: 600 }}>
                            {L("解析", "Analysis")}
                        </div>
                        <MarkdownRenderer content={analysisText} />
                    </div>
                )}
                {hasMistakeField && (
                    <div>
                        <div className="print-sub-title" style={{ fontWeight: 600 }}>
                            {L("错因分析", "Why wrong")}
                        </div>
                        <MarkdownRenderer content={item.mistakeAnalysis as string} />
                    </div>
                )}
            </>
        );
    };

    /** ===== 错题卡（G7 模板）：一道题一张纸的正反两面 ===== */
    const ErrorCard = ({ item, index }: { item: ErrorItem; index: number }) => {
        const tags = getTags(item);
        const { gradeText, subjectKey } = nbInfo(item);
        const questionNo = item.source || `#${index + 1}`;
        const hasCause = showMistake && !!item.mistakeAnalysis;

        return (
            <div className={`print-card ${soloIds.has(item.id) ? "" : ""}`}>
                {/* ---------- 正面：题头 + 原题 + 原图 + 两栏 ---------- */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "3mm", marginBottom: "2mm" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "2mm", minWidth: 0 }}>
                        {/* 【custom-v24】showCode={false}：色块只印「语文」，不再印「语文YW」。
                            紧跟在后面的题号本身就以学科简拼开头（如 YW20260919001），不必印两遍。 */}
                        <SubjectChip subjectKey={subjectKey} variant="print" showCode={false} />
                        <span style={{ fontSize: "12pt", fontWeight: 700, letterSpacing: "0.5px" }}>{questionNo}</span>
                    </div>
                    {qrMap[item.id] ? (
                        <img
                            className="print-qr"
                            src={qrMap[item.id]}
                            alt={questionNo}
                            style={{ width: "18mm", height: "18mm", flexShrink: 0 }}
                        />
                    ) : (
                        <div style={{ width: "18mm", height: "18mm", flexShrink: 0 }} />
                    )}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", gap: "4mm", fontSize: "9pt", color: "#444", marginBottom: "2.5mm" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {L("第", "No.")} {index + 1} {L("题", "")} ｜ {gradeText}
                        {showTags && tags.length > 0 ? ` ｜ ${tags.join("；")}` : ""}
                    </span>
                    <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                        {fmtDateSlash(new Date())}{" "}
                        {typeof item.printCount === "number" && item.printCount > 0
                            ? `｜${L("已打", "Printed")} ${item.printCount}${L("次", "×")}`
                            : ""}
                    </span>
                </div>

                {/* 原题：圆角框 */}
                <div
                    className="print-rounded-box"
                    style={{ border: "1.5px solid #333", borderRadius: "2mm", padding: "2.5mm", marginBottom: "3mm" }}
                >
                    <QuestionBody item={item} />
                </div>

                {/* 解析左 / 空白右（B9），内容延伸到背面 */}
                <div className="print-two-col" style={{ display: "flex", gap: "3mm", alignItems: "flex-start" }}>
                    <div style={{ flex: "1 1 52%", minWidth: 0 }}>
                        {showAnalysis && item.analysis && (
                            <div className="print-sub-title" style={{ fontWeight: 600, fontSize: "10pt", marginBottom: "1mm" }}>
                                {L("解析", "Analysis")}
                            </div>
                        )}
                        {showAnalysis && item.analysis && (
                            <div style={{ fontSize: "10pt" }}>
                                <MarkdownRenderer content={stripMistakeSection(item.analysis)} />
                            </div>
                        )}
                    </div>
                    {/* 【custom-v26】解析区与重做区之间加一条深灰竖线。
                        用 borderLeft 而不是插一个空 div 当线：空 div 在 flex 里高度靠 stretch 撑，
                        一旦这一栏跨页断开就会印出一条断头线；挂在右栏上，线必然与右栏同高。
                        alignSelf:stretch 让竖线跟到两栏中较高的那一栏（通常是重做区）。 */}
                    <div
                        style={{
                            flex: "1 1 48%",
                            minWidth: 0,
                            alignSelf: "stretch",
                            borderLeft: "2px solid #555",
                            paddingLeft: "3mm",
                        }}
                    >
                        <div style={{ fontSize: "9pt", color: "#666", marginBottom: "1mm" }}>
                            {L("重做区", "Redo here")}
                        </div>
                        <div className="print-answer-space" style={{ height: `${Math.max(spaceMM, 30)}mm` }} />
                    </div>
                </div>

                {/* ---------- 背面：继续重做 + 从后往前的错因/答案 ---------- */}
                <div className="print-tail" style={{ marginTop: "6mm" }}>
                    {manualDuplex && (
                        <div
                            className="print-flip-hint"
                            style={{ border: "1px dashed #888", borderRadius: "2mm", padding: "2.5mm", marginBottom: "4mm", fontSize: "9pt", color: "#555" }}
                        >
                            ↩ {L("请在此处翻面", "Flip the page here")} —— {L("下面是本题的背面（把纸按「短边翻转」放回纸盒）", "below is the back side of this question (flip short-edge)")}
                        </div>
                    )}
                    <div style={{ fontSize: "9pt", color: "#666", marginBottom: "1mm" }}>
                        {L("重做区（续）", "More room to redo")}
                    </div>
                    <div className="print-answer-space" style={{ height: `${Math.max(spaceMM, 30)}mm`, marginBottom: "4mm" }} />

                    {hasCause && (
                        <div
                            className="print-rounded-box"
                            style={{ border: "1.5px solid #999", borderRadius: "2mm", padding: "2.5mm", marginBottom: "3mm" }}
                        >
                            <div className="print-sub-title" style={{ fontWeight: 600, fontSize: "10pt", marginBottom: "1mm" }}>
                                {L("错因分析", "Why wrong")}
                            </div>
                            <div style={{ fontSize: "10pt" }}>
                                <MarkdownRenderer content={item.mistakeAnalysis as string} />
                            </div>
                        </div>
                    )}

                    {showAnswers && item.answerText && (
                        <div className="print-faint" style={{ fontSize: "11pt" }}>
                            <div className="print-sub-title" style={{ fontWeight: 700, marginBottom: "1mm" }}>
                                {L("参考答案", "Answer")}
                            </div>
                            <MarkdownRenderer content={item.answerText} />
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <>
            {/* ===== 控制栏（不打印） ===== */}
            <div className="no-print sticky top-0 z-10 bg-background border-b p-3 sm:p-4 shadow-sm">
                <div className="max-w-6xl mx-auto space-y-3">
                    <div className="flex items-center gap-3">
                        <BackButton fallbackUrl="/notebooks" />
                        <h1 className="text-lg sm:text-xl font-bold flex-1">
                            {L("打印预览", "Print preview")} ({countLabel} {L("题", "items")})
                        </h1>
                        <Button onClick={handlePrint} size="sm" className="whitespace-nowrap" disabled={selectedItems.length === 0 || printing}>
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

                    <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                        <div className="flex items-center gap-1 bg-muted/50 rounded-md p-1">
                            {([
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

                        {toggles.map(([label, val, setter]) => (
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
                        <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                            <span className="whitespace-nowrap">{L("留白高度", "Space")}: {spaceMM}mm</span>
                            <input type="range" min={15} max={80} step={5} value={spaceMM} onChange={(e) => setSpaceMM(Number(e.target.value))} className="w-16 sm:w-20" />
                        </div>
                        <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                            <span className="whitespace-nowrap">{L("图片宽度", "Image")}: {imageScale}%</span>
                            <input type="range" min={30} max={100} value={imageScale} onChange={(e) => setImageScale(Number(e.target.value))} className="w-16 sm:w-20" />
                        </div>
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

                    <p className="text-xs text-muted-foreground">
                        {mode === "card"
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
            </div>

            {/* ===== 打印内容：屏幕预览 = 纸张实际效果 ===== */}
            <div className="py-6 px-4 print:p-0 print:py-0">
                <div className="print-sheet">
                    {isCard ? (
                        <>
                            {selectedItems.map((item, index) => (
                                <ErrorCard key={item.id} item={item} index={index} />
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
                                            {L("范围", "Range")}：{fmtDateSlash(sheetInfo.from)}
                                            {fmtDateSlash(sheetInfo.from) !== fmtDateSlash(sheetInfo.to) ? ` ~ ${fmtDateSlash(sheetInfo.to)}` : ""}
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
                                        <QuestionBody item={item} />
                                        {isPractice ? (
                                            <div className="print-answer-space" style={{ height: `${spaceMM}mm`, marginTop: "3mm" }} />
                                        ) : (
                                            <div style={{ marginTop: "3mm" }}>
                                                <AnswerBody item={item} />
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
                                            <AnswerBody item={item} />
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
