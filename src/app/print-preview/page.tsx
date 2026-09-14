"use client";

import { useEffect, useState, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { PRINT_PREVIEW_PAGE_SIZE } from "@/lib/constants/pagination";
import { getPrintPreviewCountLabel, getPrintPreviewEmptyState, getSelectedPrintItems } from "@/lib/print-preview";

/* 纸张容器样式见 globals.css 的 .print-sheet：
   国内市售 B5 = 182mm × 257mm（JIS B5），页边距 15mm → 内容区宽 152mm，
   并强制为浅色，保证深色主题下预览与打印都是白纸黑字。 */

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

function fmtDate(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

    const [mode, setMode] = useState<"practice" | "explain">("practice");
    const [showQuestionText, setShowQuestionText] = useState(true);
    const [showImage, setShowImage] = useState(true);
    const [showAnswers, setShowAnswers] = useState(true);
    const [showAnalysis, setShowAnalysis] = useState(true);
    const [showMistake, setShowMistake] = useState(true);
    const [showTags, setShowTags] = useState(false);
    const [spaceMM, setSpaceMM] = useState(35);
    const [imageScale, setImageScale] = useState(70);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [soloIds, setSoloIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        fetchItems();
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

    const handlePrint = () => window.print();
    const selectedItems = getSelectedPrintItems(items, selectedIds);
    const countLabel = getPrintPreviewCountLabel(items.length, selectedItems.length);
    const emptyState = getPrintPreviewEmptyState(items.length, selectedItems.length);

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

    const sheetInfo = useMemo(() => {
        const subjects = [...new Set(selectedItems.map((i) => i.subject?.name).filter(Boolean) as string[])];
        const grades = [...new Set(selectedItems.map((i) => normalizeGrade(i.gradeSemester)).filter(Boolean))];
        const times = selectedItems.map((i) => new Date(i.createdAt).getTime()).filter((n) => !Number.isNaN(n));
        return {
            subjects,
            grades,
            from: times.length ? new Date(Math.min(...times)) : null,
            to: times.length ? new Date(Math.max(...times)) : null,
        };
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

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    const isPractice = mode === "practice";

    const QuestionBody = ({ item }: { item: ErrorItem }) => {
        const hasText = showQuestionText && !!item.questionText;
        const hasImg = showImage && !!item.originalImageUrl;
        if (!hasText && !hasImg) {
            return <div style={{ color: "#999" }}>{L("（该题没有可打印的题干）", "(nothing to print)")}</div>;
        }
        return (
            <>
                {hasText && (
                    <div style={{ marginBottom: hasImg ? "3mm" : 0 }}>
                        <MarkdownRenderer content={item.questionText as string} />
                    </div>
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
                        <Button onClick={handlePrint} size="sm" className="whitespace-nowrap" disabled={selectedItems.length === 0}>
                            {L("打印 / 存为 PDF", "Print / Save PDF")}
                        </Button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                        <div className="flex items-center gap-1 bg-muted/50 rounded-md p-1">
                            <button
                                type="button"
                                onClick={() => setMode("practice")}
                                className="px-3 py-1 rounded text-xs sm:text-sm"
                                style={{ background: isPractice ? "var(--primary)" : "transparent", color: isPractice ? "var(--primary-foreground)" : "inherit" }}
                            >
                                {L("练习卷", "Practice")}
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode("explain")}
                                className="px-3 py-1 rounded text-xs sm:text-sm"
                                style={{ background: !isPractice ? "var(--primary)" : "transparent", color: !isPractice ? "var(--primary-foreground)" : "inherit" }}
                            >
                                {L("讲解卷", "Study")}
                            </button>
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
                        {isPractice && (
                            <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                                <span className="whitespace-nowrap">{L("留白高度", "Space")}: {spaceMM}mm</span>
                                <input type="range" min={15} max={80} step={5} value={spaceMM} onChange={(e) => setSpaceMM(Number(e.target.value))} className="w-16 sm:w-20" />
                            </div>
                        )}
                        <div className="flex items-center gap-2 text-xs sm:text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                            <span className="whitespace-nowrap">{L("图片宽度", "Image")}: {imageScale}%</span>
                            <input type="range" min={30} max={100} value={imageScale} onChange={(e) => setImageScale(Number(e.target.value))} className="w-16 sm:w-20" />
                        </div>
                        <span className="text-xs text-muted-foreground">
                            {isPractice
                                ? L("练习卷：答案与解析统一排在最后，从新的一页开始", "Answers start on a new page")
                                : L("讲解卷：答案与解析紧跟每题", "Answers follow each question")}
                        </span>
                    </div>

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
                                    <label className="flex items-center gap-1 whitespace-nowrap text-muted-foreground cursor-pointer">
                                        <input type="checkbox" checked={soloIds.has(item.id)} onChange={() => toggleSolo(item.id)} className="rounded border-gray-300" />
                                        {L("独占页", "Solo")}
                                    </label>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* ===== 打印内容：屏幕预览 = 纸张实际效果 ===== */}
            <div className="py-6 px-4 print:p-0 print:py-0">
                <div className="print-sheet">
                    <div className="print-sheet-head" style={{ borderBottom: "2px solid #111", paddingBottom: "3mm", marginBottom: "5mm" }}>
                        <div style={{ fontSize: "16pt", fontWeight: 700, letterSpacing: "2px" }}>
                            {isPractice ? L("错题练习卷", "Practice sheet") : L("错题讲解卷", "Study sheet")}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0 8mm", marginTop: "1mm", fontSize: "10pt", color: "#444" }}>
                            {sheetInfo.subjects.length > 0 && <span>{L("学科", "Subject")}：{sheetInfo.subjects.join("/")}</span>}
                            {sheetInfo.grades.length > 0 && <span>{L("年级", "Grade")}：{sheetInfo.grades.join("/")}</span>}
                            {sheetInfo.from && sheetInfo.to && (
                                <span>
                                    {L("范围", "Range")}：{fmtDate(sheetInfo.from)}
                                    {fmtDate(sheetInfo.from) !== fmtDate(sheetInfo.to) ? ` ~ ${fmtDate(sheetInfo.to)}` : ""}
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