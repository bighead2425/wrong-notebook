"use client";

import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
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
import { makeQrDataUrl } from "@/lib/qr";
import { ErrorCard } from "@/components/print/error-card";
import { DeepDiveCard } from "@/components/print/deep-dive-card";
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
type PrintMode = "deep" | "card" | "practice" | "explain";

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
        if (m === "deep" || m === "card" || m === "practice" || m === "explain") {
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
    const isDeep = mode === "deep";
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
        setTimeout(() => {
            window.print();
            setPrinting(false);
        }, 120);
    }, [selectedItems]);

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
                                ["deep", L("深挖纸 ★", "Deep dive ★")],
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

                        {!isDeep &&
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
                        {!isDeep && (
                            <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                                <span className="whitespace-nowrap">{L("留白高度", "Space")}: {spaceMM}mm</span>
                                <input type="range" min={15} max={80} step={5} value={spaceMM} onChange={(e) => setSpaceMM(Number(e.target.value))} className="w-16 sm:w-20" />
                            </div>
                        )}
                        {!isDeep && (
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

                    <p className="text-xs text-muted-foreground">
                        {isDeep
                            ? L(
                                  "深挖纸（T1，★ 新版）：一道题占一张纸的正反两面。正面=原题照片+反思留白（框只活在软件里，不印到纸上）；反面=干净题面+遮挡线夹出的重做区+页脚三个日期格（打印日 +1/+7/+21）。纸上不印解析、错因、答案——那是回收之后 AI 的活。",
                                  "Deep-dive sheet (T1, new): one question per double-sided sheet.",
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
            </div>

            {/* ===== 打印内容：屏幕预览 = 纸张实际效果 ===== */}
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
