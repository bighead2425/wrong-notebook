"use client";

/**
 * 【custom-v23 · 蓝图 #5 #6 #7 #8】流水线模式（批量上传）
 *
 * 与「循环模式」的分工：
 *   循环模式（v22）：一张整页在上面**逐道抠**，抠一道存一道，图不动。
 *   流水线模式（本文件）：**多张图**一次收进来，先逐张加工，再批量送 AI，最后一道道审阅入库。
 *
 * 蓝图 #5 的骨架在这里落地：
 *   - 两文件夹：待处理（刚收进来的原图）/ 预处理（加工好、等送 AI 的图）
 *   - 送 AI 四选项：①当前图 ②所有已预处理 ③所有已预处理+未预处理 ④取消
 *   - #8：集中送 AI 后**一道道审阅**，点录入给下一道
 *
 * 数据全部在前端内存（file + blob URL）。已知取舍：**刷新页面会丢**，
 * 所以界面上明确写了提醒 —— 一批别贪多，加工完就送 AI，入库后才是安全的。
 */

import { useState, useEffect, useRef } from "react";
import { ImageCropper } from "@/components/image-cropper";
import { CorrectionEditor, ParsedQuestionWithSubject } from "@/components/correction-editor";
import { ParsedQuestion } from "@/lib/ai";
import { apiClient } from "@/lib/api-client";
import { AnalyzeResponse } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import { frontendLogger } from "@/lib/frontend-logger";
import { ProgressFeedback, ProgressStatus } from "@/components/ui/progress-feedback";
import {
    Upload, X, Check, Sparkles, ArrowLeft, Trash2, Layers, PenLine,
} from "lucide-react";

/** 一张图在流水线里的状态 */
export type BatchStatus =
    | "pending"   // 待处理：刚收进来，还没加工
    | "processed" // 已预处理：加工过了，等送 AI
    | "ready"     // AI 已返回，等审阅入库
    | "error"     // 送 AI 失败
    | "saved"     // 已入库
    | "skipped";  // 审阅时跳过

export interface BatchItem {
    id: string;
    file: File;
    /** 缩略图用的 blob URL */
    previewUrl: string;
    /** 是否加工过（对应蓝图的「预处理文件夹」） */
    processed: boolean;
    /** 送 AI 时压缩后的图，入库时一并存 */
    base64?: string;
    result?: ParsedQuestion;
    status: BatchStatus;
    error?: string;
}

interface BatchPipelineProps {
    language: string;
    aiTimeout: number;
    /** 从哪个错题本进来的（首页可能带 notebookId 参数） */
    defaultNotebookId?: string;
    onExit: () => void;
}

export function BatchPipeline({ language, aiTimeout, defaultNotebookId, onExit }: BatchPipelineProps) {
    const { t } = useLanguage();

    const [items, setItems] = useState<BatchItem[]>([]);
    /** 最后操作/选中的那张 —— 四选项里的「①当前图」就是它 */
    const [activeId, setActiveId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [stage, setStage] = useState<"queue" | "review">("queue");
    const [reviewIdx, setReviewIdx] = useState(0);
    const [sendOpen, setSendOpen] = useState(false);

    const [analysisStep, setAnalysisStep] = useState<ProgressStatus>("idle");
    const [progress, setProgress] = useState(0);
    const [run, setRun] = useState<{ i: number; n: number } | null>(null);
    const [savedCount, setSavedCount] = useState(0);

    const fileInputRef = useRef<HTMLInputElement>(null);

    // 卸载时统一回收 blob URL，避免内存泄漏
    const itemsRef = useRef<BatchItem[]>([]);
    useEffect(() => { itemsRef.current = items; }, [items]);
    useEffect(() => () => {
        itemsRef.current.forEach(it => URL.revokeObjectURL(it.previewUrl));
    }, []);

    const editingItem = items.find(i => i.id === editingId) || null;
    const pendingItems = items.filter(i => !i.processed);
    const processedItems = items.filter(i => i.processed);
    const readyItems = items.filter(i => i.status === "ready");
    const activeItem = items.find(i => i.id === activeId) || null;

    /**
     * 能送 AI 的范围要**排除已入库的**。
     * 否则：一批图审阅完一半、回到队列再点「③全部」，会把刚存进库的题重新分析一遍，
     * 白烧 token 不说，还会把已入库的题又塞回审阅队列。
     */
    const sendableProcessed = processedItems.filter(i => i.status !== "saved");
    const sendableAll = items.filter(i => i.status !== "saved");

    /** 收图：一次可以选多张（连拍的那批） */
    const addFiles = (files: File[]) => {
        if (!files.length) return;
        const added: BatchItem[] = files.map((f, k) => ({
            id: `b${Date.now()}-${k}-${Math.random().toString(36).slice(2, 7)}`,
            file: f,
            previewUrl: URL.createObjectURL(f),
            processed: false,
            status: "pending",
        }));
        setItems(prev => [...prev, ...added]);
        setActiveId(added[added.length - 1].id);
        setStage("queue");
    };

    const removeItem = (id: string) => {
        const it = items.find(i => i.id === id);
        if (it) URL.revokeObjectURL(it.previewUrl);
        setItems(prev => prev.filter(i => i.id !== id));
        if (activeId === id) setActiveId(null);
    };

    /**
     * 编辑器确认 → **只加工，不送 AI**（这是与单题流最大的差别）。
     * 加工完回到队列，该张从「待处理」移进「预处理」。
     */
    const handleCropComplete = async (blob: Blob) => {
        if (!editingId) return;
        const id = editingId;
        const target = items.find(i => i.id === id);
        const url = URL.createObjectURL(blob);
        if (target) URL.revokeObjectURL(target.previewUrl);
        setItems(prev => prev.map(it => it.id === id ? {
            ...it,
            file: new File([blob], `batch-${id}.jpg`, { type: "image/jpeg" }),
            previewUrl: url,
            processed: true,
            status: "processed",
            // 换过图之后，旧的 AI 结果与压缩图都作废
            base64: undefined,
            result: undefined,
            error: undefined,
        } : it));
        setEditingId(null);
    };

    /** 蓝图 #5 送 AI 四选项 → 串行分析 */
    const analyzeTargets = async (targets: BatchItem[]) => {
        if (!targets.length) return;
        setSendOpen(false);
        setRun({ i: 0, n: targets.length });

        let okCount = 0;
        for (let k = 0; k < targets.length; k++) {
            const it = targets[k];
            setRun({ i: k + 1, n: targets.length });
            try {
                setAnalysisStep("compressing");
                const b64 = await processImageFile(it.file);

                setAnalysisStep("analyzing");
                const data = await apiClient.post<AnalyzeResponse>("/api/analyze", {
                    imageBase64: b64,
                    language,
                    notebookId: defaultNotebookId || undefined,
                }, { timeout: aiTimeout });

                setItems(prev => prev.map(x => x.id === it.id ? {
                    ...x,
                    base64: b64,
                    result: data as unknown as ParsedQuestion,
                    status: "ready" as BatchStatus,
                    error: undefined,
                } : x));
                okCount++;
            } catch (e: any) {
                frontendLogger.error('[BatchAnalyze]', 'One image failed', {
                    id: it.id,
                    error: e?.message || String(e),
                });
                setItems(prev => prev.map(x => x.id === it.id ? {
                    ...x,
                    status: "error" as BatchStatus,
                    error: e?.message || String(e),
                } : x));
            }
        }

        setAnalysisStep("idle");
        setProgress(100);
        setRun(null);
        frontendLogger.info('[BatchAnalyze]', 'Batch finished', {
            total: targets.length, ok: okCount,
        });
        setReviewIdx(0);
        setStage("review");
    };

    /** 保存当前这道 → 自动落到下一道（蓝图 #8） */
    const handleSaveCurrent = async (data: ParsedQuestionWithSubject) => {
        const cur = readyItems[reviewIdx];
        if (!cur) return;
        try {
            await apiClient.post<{ id: string }>("/api/error-items", {
                ...data,
                originalImageUrl: cur.base64 || "",
            });
            setItems(prev => prev.map(x => x.id === cur.id ? { ...x, status: "saved" } : x));
            setSavedCount(c => c + 1);
            // 不递增索引：当前项已变 saved，会从 readyItems 里移除，
            // 原索引位置自然就是下一道。
        } catch (e: any) {
            frontendLogger.error('[BatchSave]', 'Save failed', { error: e?.message || String(e) });
            alert(t.common?.messages?.saveFailed || "保存失败");
        }
    };

    const skipCurrent = () => {
        const cur = readyItems[reviewIdx];
        if (!cur) return;
        setItems(prev => prev.map(x => x.id === cur.id ? { ...x, status: "skipped" } : x));
    };

    const progressMessage = () => {
        const prefix = run ? `${run.i}/${run.n} ` : "";
        switch (analysisStep) {
            case "compressing": return prefix + (t.common.progress?.compressing || "压缩图片…");
            case "analyzing": return prefix + (t.common.progress?.analyzing || "AI 分析中…");
            case "processing": return prefix + (t.common.progress?.processing || "处理结果…");
            default: return "";
        }
    };

    const current = readyItems[reviewIdx];

    // ===== 审阅阶段：一道道看 =====
    if (stage === "review") {
        // 全看完了：给个汇总
        if (!current) {
            const errCount = items.filter(i => i.status === "error").length;
            return (
                <div className="space-y-6">
                    <ProgressFeedback status={analysisStep} progress={progress} message={progressMessage()} />
                    <div className="rounded-xl border p-6 text-center space-y-4">
                        <div className="text-4xl">🎉</div>
                        <h2 className="text-xl font-bold">
                            {t.common.batch?.allDone || "本批处理完"}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                            {(t.common.batch?.doneSummary || "已录入 {n} 道")
                                .replace("{n}", String(savedCount))}
                            {errCount > 0 && (
                                <span className="text-destructive">
                                    ，{(t.common.batch?.errorSummary || "{n} 道 AI 失败")
                                        .replace("{n}", String(errCount))}
                                </span>
                            )}
                        </p>
                        <div className="flex flex-wrap justify-center gap-3">
                            <Button variant="outline" onClick={() => { setStage("queue"); setReviewIdx(0); }}>
                                <ArrowLeft className="mr-2 h-4 w-4" />
                                {t.common.batch?.backToQueue || "回到队列"}
                            </Button>
                            <Button onClick={onExit}>
                                {t.common.batch?.finish || "结束批量"}
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div className="space-y-4">
                <ProgressFeedback status={analysisStep} progress={progress} message={progressMessage()} />
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Layers className="h-4 w-4" />
                        {(t.common.batch?.reviewProgress || "第 {i} / {n} 道")
                            .replace("{i}", String(reviewIdx + 1))
                            .replace("{n}", String(readyItems.length))}
                        <span className="text-muted-foreground font-normal">
                            ，{t.common.batch?.savedCount ? t.common.batch.savedCount.replace("{n}", String(savedCount)) : `已录入 ${savedCount} 道`}
                        </span>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={skipCurrent}>
                            {t.common.batch?.skip || "跳过这道"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setStage("queue")}>
                            <ArrowLeft className="mr-1 h-4 w-4" />
                            {t.common.batch?.backToQueue || "回到队列"}
                        </Button>
                    </div>
                </div>
                <CorrectionEditor
                    key={current.id}
                    initialData={current.result as ParsedQuestion}
                    onSave={handleSaveCurrent}
                    onCancel={() => setStage("queue")}
                    imagePreview={current.base64}
                    initialSubjectId={defaultNotebookId}
                    aiTimeout={aiTimeout}
                />
            </div>
        );
    }

    // ===== 队列阶段：收图 + 逐张加工 =====
    return (
        <div className="space-y-5">
            <ProgressFeedback status={analysisStep} progress={progress} message={progressMessage()} />

            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-xl font-bold">{t.common.batch?.title || "批量上传"}</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        {t.common.batch?.subtitle || "一次收多张 → 逐张加工 → 批量送 AI → 一道道录入"}
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={onExit}>
                    <X className="mr-1 h-4 w-4" />
                    {t.common.batch?.exit || "退出批量"}
                </Button>
            </div>

            {/* 收图区 */}
            <div
                className="border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:border-primary/60 hover:bg-accent/30 transition-colors"
                onClick={() => fileInputRef.current?.click()}
            >
                <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm font-medium">
                    {t.common.batch?.pickHint || "点击选择多张图片（可一次选一批连拍的）"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                    {t.common.batch?.pickSub || "支持 JPG / PNG"}
                </p>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        addFiles(files);
                        e.target.value = ""; // 允许重复选同一批
                    }}
                />
            </div>

            {items.length > 0 && (
                <>
                    <div className="flex items-center gap-4 text-sm flex-wrap">
                        <span>{t.common.batch?.total ? t.common.batch.total.replace("{n}", String(items.length)) : `共 ${items.length} 张`}</span>
                        <span className="text-muted-foreground">
                            {t.common.batch?.pendingCount ? t.common.batch.pendingCount.replace("{n}", String(pendingItems.length)) : `待处理 ${pendingItems.length}`}
                        </span>
                        <span className="text-green-600">
                            {t.common.batch?.processedCount ? t.common.batch.processedCount.replace("{n}", String(processedItems.length)) : `已预处理 ${processedItems.length}`}
                        </span>
                        <span className="text-xs text-amber-600">
                            {t.common.batch?.noRefresh || "⚠️ 处理中请勿刷新页面（图片暂存在当前页面）"}
                        </span>
                    </div>

                    {/* 两个文件夹：待处理 / 预处理（蓝图 #5） */}
                    <FolderGrid
                        title={t.common.batch?.pendingFolder || "待处理"}
                        hint={t.common.batch?.pendingHint || "刚收进来的原图，点一下进编辑器加工"}
                        items={pendingItems}
                        activeId={activeId}
                        onPick={(id) => { setActiveId(id); setEditingId(id); }}
                        onRemove={removeItem}
                        actionIcon={<PenLine className="h-3.5 w-3.5" />}
                    />
                    <FolderGrid
                        title={t.common.batch?.processedFolder || "预处理"}
                        hint={t.common.batch?.processedHint || "加工好了，等着送 AI"}
                        items={processedItems}
                        activeId={activeId}
                        onPick={(id) => { setActiveId(id); setEditingId(id); }}
                        onRemove={removeItem}
                        actionIcon={<PenLine className="h-3.5 w-3.5" />}
                    />

                    <div className="flex flex-wrap gap-3">
                        <Button onClick={() => setSendOpen(true)} disabled={!items.length}>
                            <Sparkles className="mr-2 h-4 w-4" />
                            {t.common.batch?.sendAI || "送 AI 分析"}
                        </Button>
                        {readyItems.length > 0 && (
                            <Button variant="secondary" onClick={() => { setReviewIdx(0); setStage("review"); }}>
                                {t.common.batch?.gotoReview || `继续审阅（${readyItems.length} 道待录）`}
                            </Button>
                        )}
                    </div>
                </>
            )}

            {/* 蓝图 #5 送 AI 四选项 */}
            <Dialog open={sendOpen} onOpenChange={setSendOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t.common.batch?.sendTitle || "送 AI 分析哪些图？"}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-2">
                        <SendOption
                            disabled={!activeItem}
                            label={t.common.batch?.optCurrent || "① 只分析当前这张"}
                            desc={activeItem ? undefined : (t.common.batch?.noCurrent || "（还没选中任何一张）")}
                            onClick={() => activeItem && analyzeTargets([activeItem])}
                        />
                        <SendOption
                            disabled={sendableProcessed.length === 0}
                            label={(t.common.batch?.optProcessed || "② 所有已预处理（{n} 张）").replace("{n}", String(sendableProcessed.length))}
                            onClick={() => analyzeTargets(sendableProcessed)}
                        />
                        <SendOption
                            disabled={sendableAll.length === 0}
                            label={(t.common.batch?.optAll || "③ 已预处理 + 未预处理（{n} 张）").replace("{n}", String(sendableAll.length))}
                            onClick={() => analyzeTargets(sendableAll)}
                        />
                        <SendOption
                            variant="ghost"
                            label={t.common.batch?.optCancel || "④ 取消"}
                            onClick={() => setSendOpen(false)}
                        />
                    </div>
                </DialogContent>
            </Dialog>

            {editingItem && (
                <ImageCropper
                    imageSrc={editingItem.previewUrl}
                    open={!!editingId}
                    onClose={() => setEditingId(null)}
                    onCropComplete={handleCropComplete}
                    analyzing={analysisStep !== "idle"}
                />
            )}
        </div>
    );
}

/** 一个「文件夹」的缩略图网格 */
function FolderGrid({
    title, hint, items, activeId, onPick, onRemove, actionIcon,
}: {
    title: string;
    hint: string;
    items: BatchItem[];
    activeId: string | null;
    onPick: (id: string) => void;
    onRemove: (id: string) => void;
    actionIcon: React.ReactNode;
}) {
    if (!items.length) return null;
    return (
        <div className="space-y-2">
            <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-semibold">{title}</h3>
                <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {items.map(it => (
                    <div
                        key={it.id}
                        className={`relative group rounded-lg overflow-hidden border-2 bg-muted cursor-pointer transition-all ${
                            activeId === it.id ? "border-primary" : "border-transparent hover:border-primary/40"
                        }`}
                        onClick={() => onPick(it.id)}
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={it.previewUrl} alt="" className="w-full aspect-[3/4] object-cover" />
                        <button
                            className="absolute top-1 right-1 bg-black/60 text-white rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); onRemove(it.id); }}
                            title="移除"
                        >
                            <Trash2 className="h-3 w-3" />
                        </button>
                        {it.status === "ready" && (
                            <span className="absolute bottom-1 left-1 bg-blue-600 text-white text-[10px] rounded px-1">
                                待录
                            </span>
                        )}
                        {it.status === "saved" && (
                            <span className="absolute bottom-1 left-1 bg-green-600 text-white text-[10px] rounded px-1 flex items-center gap-0.5">
                                <Check className="h-2.5 w-2.5" />已录
                            </span>
                        )}
                        {it.status === "error" && (
                            <span className="absolute bottom-1 left-1 bg-destructive text-white text-[10px] rounded px-1">
                                AI 失败
                            </span>
                        )}
                        <span className="absolute bottom-1 right-1 bg-black/50 text-white rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            {actionIcon}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SendOption({
    label, desc, disabled, onClick, variant = "outline",
}: {
    label: string;
    desc?: string;
    disabled?: boolean;
    onClick: () => void;
    variant?: "outline" | "ghost";
}) {
    return (
        <Button
            variant={variant}
            className="w-full justify-start h-auto py-3 text-left"
            disabled={disabled}
            onClick={onClick}
        >
            <span>
                <span className="block">{label}</span>
                {desc && <span className="block text-xs text-muted-foreground mt-0.5">{desc}</span>}
            </span>
        </Button>
    );
}
