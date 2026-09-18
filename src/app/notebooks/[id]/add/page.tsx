"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { UploadZone } from "@/components/upload-zone";
import { CorrectionEditor } from "@/components/correction-editor";
import { ImageCropper, type DoneRect } from "@/components/image-cropper";
import { ParsedQuestion } from "@/lib/ai";
import { apiClient } from "@/lib/api-client";
import { AnalyzeResponse, Notebook, AppConfig } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import { ArrowLeft } from "lucide-react";
import { ProgressFeedback, ProgressStatus } from "@/components/ui/progress-feedback";
import { frontendLogger } from "@/lib/frontend-logger";

export default function AddErrorPage() {
    const params = useParams();
    const router = useRouter();
    const notebookId = params.id as string;
    const [step, setStep] = useState<"upload" | "review">("upload");
    const [analysisStep, setAnalysisStep] = useState<ProgressStatus>('idle');
    const [progress, setProgress] = useState(0);
    const [parsedData, setParsedData] = useState<ParsedQuestion | null>(null);
    const [currentImage, setCurrentImage] = useState<string | null>(null);
    const { t, language } = useLanguage();
    const [notebook, setNotebook] = useState<Notebook | null>(null);
    const [config, setConfig] = useState<AppConfig | null>(null);

    // Cropper state
    // 【custom-v22 循环模式】pageImageUrl = 整页图，循环中**常驻不换**，
    // 每抠完一道回到它重新框下一道。非循环模式下它就是一次性图，语义不变。
    const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
    const [isCropperOpen, setIsCropperOpen] = useState(false);

    // ===== 循环模式状态（custom-v22 · 蓝图 #4 #7）=====
    /** 是否开启「拍整页 → 一道道抠」的循环 */
    const [loopMode, setLoopMode] = useState(false);
    /** 本页已抠走并入库的区域（整页自然坐标），画在编辑器上避免重复抠同一道 */
    const [doneRects, setDoneRects] = useState<DoneRect[]>([]);
    /** 本次框选的区域。等**保存成功后**才并进 doneRects —— 保存失败就不算数，不能占位 */
    const [pendingRect, setPendingRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
    /**
     * 递增以强制重建编辑器实例。
     * 为什么要用 key 而不是再开关一次对话框：编辑器的重置 effect 依赖 [open, imageSrc]，
     * 循环里 imageSrc 恒定是整页图，光靠 open 的 false→true 并不可靠；
     * 换 key 让 React 整棵子树卸载重建，擦除/裁剪/框选全部干净复位到整页。
     */
    const [cropperKey, setCropperKey] = useState(0);

    // Timeout Config
    const aiTimeout = config?.timeouts?.analyze || 180000;
    const safetyTimeout = aiTimeout + 10000;

    // Cleanup Blob URL to prevent memory leak
    useEffect(() => {
        return () => {
            if (pageImageUrl) {
                URL.revokeObjectURL(pageImageUrl);
            }
        };
    }, [pageImageUrl]);

    useEffect(() => {
        // Fetch notebook info
        apiClient.get<Notebook>(`/api/notebooks/${notebookId}`)
            .then(data => setNotebook(data))
            .catch(err => {
                console.error("Failed to fetch notebook:", err);
                router.push("/notebooks");
            });

        // Fetch settings for timeouts
        apiClient.get<AppConfig>("/api/settings")
            .then(data => {
                setConfig(data);
                if (data.timeouts?.analyze) {
                    frontendLogger.info('[Config]', 'Loaded timeout settings', {
                        analyze: data.timeouts.analyze
                    });
                }
            })
            .catch(err => console.error("Failed to fetch config:", err));
    }, [notebookId, router]);

    // Simulate progress for smoother UX with timeout protection
    useEffect(() => {
        let interval: NodeJS.Timeout;
        let timeout: NodeJS.Timeout;
        if (analysisStep !== 'idle') {
            setProgress(0);
            interval = setInterval(() => {
                setProgress(prev => {
                    if (prev >= 90) return prev;
                    return prev + Math.random() * 10;
                });
            }, 500);

            // Safety timeout: auto-reset after configurable time to prevent stuck overlay
            timeout = setTimeout(() => {
                console.warn('[Progress] Safety timeout triggered - resetting analysisStep');
                setAnalysisStep('idle');
            }, safetyTimeout);
        }
        return () => {
            clearInterval(interval);
            clearTimeout(timeout);
        };
    }, [analysisStep, safetyTimeout]);

    const onImageSelect = (file: File) => {
        const imageUrl = URL.createObjectURL(file);
        setPageImageUrl(imageUrl);
        // 新的一页：已抠标记从头开始，编辑器换实例复位
        setDoneRects([]);
        setPendingRect(null);
        setCropperKey((k) => k + 1);
        setIsCropperOpen(true);
    };

    /**
     * 【custom-v22 循环模式】编辑器确认时回传本次框选的整页坐标。
     * 只暂存，不立刻记进 doneRects —— 这道题还没保存成功，
     * 提前标成"已抠"的话，一旦保存失败，用户就再也找不到那块区域了。
     */
    const handleCropRegion = (rect: { x: number; y: number; w: number; h: number } | null) => {
        setPendingRect(rect);
    };

    /**
     * 编辑器确认 → 送 AI。
     * 【custom-v20 问题②】不再"先关对话框再分析"：送 AI 会失败（网络/超时/模型报错），
     * 原实现先 setIsCropperOpen(false) 再 handleAnalyze，失败后只弹一个 alert，
     * 对话框已经卸载，裁剪/擦除/框选全部随组件消失，用户毫无补救办法。
     * 现改为"成功才关"：失败时编辑器原地保留，用户可直接再点一次「确定」重试。
     */
    const handleCropComplete = async (croppedBlob: Blob) => {
        const file = new File([croppedBlob], "cropped-image.jpg", { type: "image/jpeg" });
        const ok = await handleAnalyze(file);
        if (ok) setIsCropperOpen(false);
    };

    const handleAnalyze = async (file: File): Promise<boolean> => {
        const startTime = Date.now();
        frontendLogger.info('[AddAnalyze]', 'Starting analysis flow', {
            timeoutSettings: {
                apiTimeout: aiTimeout,
                safetyTimeout
            }
        });

        try {
            frontendLogger.info('[AddAnalyze]', 'Step 1/5: Compressing image');
            setAnalysisStep('compressing');
            const base64Image = await processImageFile(file);
            setCurrentImage(base64Image);
            frontendLogger.info('[AddAnalyze]', 'Image compressed successfully', {
                size: base64Image.length
            });

            frontendLogger.info('[AddAnalyze]', 'Step 2/5: Calling API endpoint /api/analyze');
            setAnalysisStep('analyzing');
            const apiStartTime = Date.now();
            const data = await apiClient.post<AnalyzeResponse>("/api/analyze", {
                imageBase64: base64Image,
                language: language,
                notebookId: notebookId
            }, { timeout: aiTimeout }); // Use configured timeout
            const apiDuration = Date.now() - apiStartTime;
            frontendLogger.info('[AddAnalyze]', 'API response received, validating data', {
                apiDuration
            });

            // Validate response data
            if (!data || typeof data !== 'object') {
                frontendLogger.error('[AddAnalyze]', 'Validation failed - invalid response data', {
                    data
                });
                throw new Error('Invalid API response: data is null or not an object');
            }
            frontendLogger.info('[AddAnalyze]', 'Response data validated successfully');

            frontendLogger.info('[AddAnalyze]', 'Step 3/5: Setting processing state and progress to 100%');
            setAnalysisStep('processing');
            setProgress(100);
            frontendLogger.info('[AddAnalyze]', 'Progress updated to 100%');

            frontendLogger.info('[AddAnalyze]', 'Step 4/5: Setting parsed data into state');
            const dataSize = JSON.stringify(data).length;
            const setDataStart = Date.now();
            setParsedData(data);
            const setDataDuration = Date.now() - setDataStart;
            frontendLogger.info('[AddAnalyze]', 'Parsed data set successfully', {
                dataSize,
                setDataDuration
            });

            frontendLogger.info('[AddAnalyze]', 'Step 5/5: Switching to review page');
            const setStepStart = Date.now();
            setStep("review");
            const setStepDuration = Date.now() - setStepStart;
            frontendLogger.info('[AddAnalyze]', 'Step switched to review', {
                setStepDuration
            });
            const totalDuration = Date.now() - startTime;
            frontendLogger.info('[AddAnalyze]', 'Analysis completed successfully', {
                totalDuration
            });
            return true;
        } catch (error: any) {
            const errorDuration = Date.now() - startTime;
            frontendLogger.error('[AddError]', 'Analysis failed', {
                errorDuration,
                error: error.message || String(error)
            });

            // 安全的错误处理逻辑，防止在报错时二次报错
            try {
                // 解析详细错误信息
                let errorMessage = t.common.messages?.analysisFailed || 'Analysis failed';

                // ApiError 的结构：error.data.message 包含后端返回的错误类型
                const backendErrorType = error?.data?.message;

                if (backendErrorType && typeof backendErrorType === 'string') {
                    // 检查是否是已知的 AI 错误类型
                    // 使用安全访问
                    if (t.errors && typeof t.errors === 'object' && backendErrorType in t.errors) {
                        const mappedError = (t.errors as any)[backendErrorType];
                        if (typeof mappedError === 'string') {
                            errorMessage = mappedError;
                            frontendLogger.info('[AddError]', `Matched error type: ${backendErrorType}`, {
                                errorMessage
                            });
                        }
                    } else {
                        // 使用后端返回的具体错误消息
                        errorMessage = backendErrorType;
                        frontendLogger.info('[AddError]', 'Using backend error message', {
                            errorMessage
                        });
                    }
                } else if (error?.message) {
                    // Fallback：检查 error.message（用于非 API 错误）
                    if (error.message.includes('fetch') || error.message.includes('network')) {
                        errorMessage = t.errors?.AI_CONNECTION_FAILED || '网络连接失败';
                    } else if (typeof error.data === 'string') {
                        // 如果 data 是字符串（例如 HTML 错误页），可能包含提示
                        frontendLogger.info('[AddError]', 'Raw error data', {
                            errorDataPreview: error.data.substring(0, 100)
                        });
                        errorMessage += ` (${error.status || 'Error'})`;
                    }
                }

                alert(errorMessage);
            } catch (innerError) {
                frontendLogger.error('[AddError]', 'Failed to process error message', {
                    innerError: String(innerError)
                });
                // 确保至少弹出一个提示
                alert('Analysis failed. Please try again.');
            }
            // 失败：保持 false，让调用方知道"没成功、别关对话框"
            return false;
        } finally {
            // Always reset analysis state, even if setState throws
            frontendLogger.info('[AddAnalyze]', 'Finally: Resetting analysis state to idle');
            setAnalysisStep('idle');
            frontendLogger.info('[AddAnalyze]', 'Analysis state reset complete');
        }
    };

    const handleSave = async (finalData: ParsedQuestion & { notebookId?: string; gradeSemester?: string; paperLevel?: string }): Promise<void> => {
        // H4：不再强制要求图片 —— 手动输入的题没有原图，originalImageUrl 传空串
        // （该列在 schema 里非空，空串是合法值；纸面缺原图时只印题干）
        try {
            const result = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", {
                ...finalData,
                originalImageUrl: currentImage || "",
                inputMethod: currentImage ? undefined : "manual",
                notebookId: notebookId,
            });

            // 检查是否是重复提交（后端去重返回）
            if (result.duplicate) {
                frontendLogger.info('[AddSave]', 'Duplicate submission detected, using existing record');
            }

            // 【custom-v22 循环模式 · 蓝图 #4】保存成功后**不跳转、不弹窗**：
            // 把这一道的区域记进已抠标记，回到整页继续抠下一道。
            // 弹 alert 在这里会打断节奏（每道题都要点一次确定），
            // 进度改由编辑器标题的「本页已录 N 道」承担。
            if (loopMode) {
                if (pendingRect) {
                    setDoneRects((prev) => [
                        ...prev,
                        { ...pendingRect, index: prev.length + 1 },
                    ]);
                }
                setPendingRect(null);
                setParsedData(null);
                setStep("upload");
                setCropperKey((k) => k + 1);
                setIsCropperOpen(true);
                return;
            }

            alert(t.common.messages?.saveSuccess || 'Saved!');
            router.push(`/notebooks/${notebookId}`);
        } catch (error) {
            console.error(error);
            alert(t.common.messages?.saveFailed || 'Save failed');
        }
    };

    /** H4：手动输入 —— 不拍照直接进编辑页；题号仍由后端按 Notebook.subject 自动生成 */
    const handleManualInput = () => {
        // 【custom-v22 循环模式】手动输入没有"从整页抠下的区域"这一说，
        // 必须清掉上一道残留的框选坐标 —— 否则保存时会把它记成已抠区域，
        // 于是在整页上凭空多出一个根本没录过的绿框。
        setPendingRect(null);
        setParsedData({
            questionText: "",
            answerText: "",
            analysis: "",
            wrongAnswerText: "",
            mistakeAnalysis: "",
            mistakeStatus: "unknown",
            subject: "其他",
            knowledgePoints: [],
            requiresImage: false,
        });
        setCurrentImage(null);
        setStep("review");
    };

    const getProgressMessage = () => {
        switch (analysisStep) {
            case 'compressing': return t.common.progress?.compressing || "Compressing...";
            case 'uploading': return t.common.progress?.uploading || "Uploading...";
            case 'analyzing': return t.common.progress?.analyzing || "Analyzing...";
            case 'processing': return t.common.progress?.processing || "Processing...";
            default: return "";
        }
    };

    if (!notebook) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    return (
        <main className="min-h-screen bg-background">
            <ProgressFeedback
                status={analysisStep}
                progress={progress}
                message={getProgressMessage()}
            />

            <div className="container mx-auto p-4 space-y-8 pb-20">
                {/* Header Section */}
                <div className="flex items-center gap-4">
                    <Link href={`/notebooks/${notebookId}`}>
                        <Button variant="ghost" size="icon">
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                    </Link>
                    <h1 className="text-2xl font-bold">{t.app.addError}</h1>
                </div>

                {/* Main Content */}
                {step === "upload" && (
                    <div className="space-y-4">
                        {/* ===== 循环模式开关（custom-v22 · 蓝图 #4 #7）=====
                            一整页上有多道错题时开启：抠一道 → 保存 → 自动回到整页抠下一道，
                            已抠的题会标成绿框，直到你点「结束」。 */}
                        <label className="flex items-start gap-2 p-3 rounded-lg border bg-muted/30 cursor-pointer">
                            <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4"
                                checked={loopMode}
                                onChange={(e) => setLoopMode(e.target.checked)}
                            />
                            <span className="text-sm">
                                <span className="font-medium">
                                    {t.common.cropper?.loopMode || "循环模式（一页多道）"}
                                </span>
                                <span className="block text-xs text-muted-foreground mt-0.5">
                                    {t.common.cropper?.loopModeHint
                                        || "拍一整页，抠完一道保存后自动回到本页继续抠下一道，适合一页上有好几道错题"}
                                </span>
                            </span>
                        </label>

                        {/* 循环中的出口（蓝图：循环至某次保存后取消才结束）。
                            只要本页已经开抠就给出口，一道都没录成也能退出，不至于被卡在循环里。 */}
                        {loopMode && pageImageUrl && (
                            <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-green-500/40 bg-green-500/5">
                                {doneRects.length > 0 && (
                                    <span className="text-sm font-medium">
                                        {t.common.cropper?.loopDoneCount
                                            ? t.common.cropper.loopDoneCount.replace("{n}", String(doneRects.length))
                                            : `本页已录 ${doneRects.length} 道`}
                                    </span>
                                )}
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        setCropperKey((k) => k + 1);
                                        setIsCropperOpen(true);
                                    }}
                                >
                                    {t.common.cropper?.loopContinue || "继续抠下一道"}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => router.push(`/notebooks/${notebookId}`)}
                                >
                                    {t.common.cropper?.loopFinish || "结束并查看错题本"}
                                </Button>
                            </div>
                        )}

                        <UploadZone
                            onImageSelect={onImageSelect}
                            isAnalyzing={analysisStep !== 'idle'}
                            onManualInput={handleManualInput}
                        />
                    </div>
                )}

                {step === "review" && parsedData && (
                    <CorrectionEditor
                        initialData={parsedData}
                        imagePreview={currentImage}
                        onSave={handleSave}
                        onCancel={() => setStep("upload")}
                        initialSubjectId={notebookId}
                        aiTimeout={aiTimeout}
                    />
                )}
            </div>

            <ImageCropper
                key={cropperKey}
                imageSrc={pageImageUrl || ""}
                open={isCropperOpen}
                onClose={() => setIsCropperOpen(false)}
                onCropComplete={handleCropComplete}
                analyzing={analysisStep !== 'idle'}
                doneRects={loopMode ? doneRects : undefined}
                onCropRegion={handleCropRegion}
                loopCount={loopMode ? doneRects.length : undefined}
            />
        </main>
    );
}
