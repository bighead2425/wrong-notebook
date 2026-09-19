"use client";

import { useState, Suspense, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { UploadZone } from "@/components/upload-zone";
import { CorrectionEditor } from "@/components/correction-editor";
import { ImageCropper } from "@/components/image-cropper";
import { BatchPipeline } from "@/components/batch-pipeline";
import { ParsedQuestion } from "@/lib/ai";
import { UserWelcome } from "@/components/user-welcome";
import { apiClient } from "@/lib/api-client";
import { AnalyzeResponse, Notebook, AppConfig } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import { Upload, BookOpen, Tags, LogOut, BarChart3, QrCode } from "lucide-react";
import { SettingsDialog } from "@/components/settings-dialog";
/**
 * 【custom-v24】公告通知按钮按用户要求从首页撤下（功能保留，组件文件不动）。
 * 需要恢复时把 import 与 <BroadcastNotification /> 一起放回图右上角工具条即可。
 */
// import { BroadcastNotification } from "@/components/broadcast-notification";
import { signOut } from "next-auth/react";

import { ProgressFeedback, ProgressStatus } from "@/components/ui/progress-feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { subjectLabel } from "@/lib/notebook-fields";

function HomeContent() {
    const [step, setStep] = useState<"upload" | "review">("upload");
    const [analysisStep, setAnalysisStep] = useState<ProgressStatus>('idle');
    const [progress, setProgress] = useState(0);
    const [parsedData, setParsedData] = useState<ParsedQuestion | null>(null);
    const [currentImage, setCurrentImage] = useState<string | null>(null);
    const { t, language } = useLanguage();
    const searchParams = useSearchParams();
    const router = useRouter();
    const initialNotebookId = searchParams.get("notebook");
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [autoSelectedNotebookId, setAutoSelectedNotebookId] = useState<string | null>(null);

    const [config, setConfig] = useState<AppConfig | null>(null);

    // Cropper state
    const [croppingImage, setCroppingImage] = useState<string | null>(null);
    const [isCropperOpen, setIsCropperOpen] = useState(false);

    /**
     * 【custom-v23 · 蓝图 #5/#6/#7】批量上传（流水线模式）。
     * 原来「上传新题」只做 setStep("upload")，在已经处于上传页时点了毫无反应 ——
     * 空空以为它是个死按钮。现在改成**这一步的入口**：点它进流水线。
     * 流水线自己管一套队列，与下面单题流互不干扰。
     */
    const [batchMode, setBatchMode] = useState(false);

    // Timeout Config
    const aiTimeout = config?.timeouts?.analyze || 180000;
    const safetyTimeout = aiTimeout + 10000;

    // Cleanup Blob URL to prevent memory leak
    useEffect(() => {
        return () => {
            if (croppingImage) {
                URL.revokeObjectURL(croppingImage);
            }
        };
    }, [croppingImage]);

    useEffect(() => {
        // Fetch notebooks for auto-selection
        apiClient.get<Notebook[]>("/api/notebooks")
            .then(data => setNotebooks(data))
            .catch(err => console.error("Failed to fetch notebooks:", err));

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
    }, []);

    // Simulate progress for smoother UX with timeout protection
    useEffect(() => {
        let interval: NodeJS.Timeout;
        let timeout: NodeJS.Timeout;
        if (analysisStep !== 'idle') {
            setProgress(0);
            interval = setInterval(() => {
                setProgress(prev => {
                    if (prev >= 90) return prev; // Cap at 90% until complete
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
        setCroppingImage(imageUrl);
        setIsCropperOpen(true);
    };

    /**
     * 编辑器确认 → 送 AI。
     * 【custom-v20 问题②】不再"先关对话框再分析"：送 AI 是会失败的（网络/超时/模型报错），
     * 原实现先 setIsCropperOpen(false) 再 handleAnalyze，失败后只弹一个 alert，
     * 对话框已经卸载，裁剪/擦除/框选全部随组件消失，用户毫无补救办法，辛苦编辑白费。
     * 现改为"成功才关"：失败时编辑器原地保留，用户可直接再点一次「确定」重试。
     * 编辑状态无需额外保存 —— ImageCropper 的重置 effect 依赖 [open, imageSrc]，
     * 只要 open 一直为 true，画布内容与全部编辑状态就一直在。
     */
    const handleCropComplete = async (croppedBlob: Blob) => {
        // Convert Blob to File
        const file = new File([croppedBlob], "cropped-image.jpg", { type: "image/jpeg" });
        const ok = await handleAnalyze(file);
        if (ok) setIsCropperOpen(false);
    };

    const handleAnalyze = async (file: File): Promise<boolean> => {
        const startTime = Date.now();
        frontendLogger.info('[HomeAnalyze]', 'Starting analysis flow', {
            timeoutSettings: {
                apiTimeout: aiTimeout,
                safetyTimeout
            }
        });

        try {
            frontendLogger.info('[HomeAnalyze]', 'Step 1/5: Compressing image');
            setAnalysisStep('compressing');
            const base64Image = await processImageFile(file);
            setCurrentImage(base64Image);
            frontendLogger.info('[HomeAnalyze]', 'Image compressed successfully', {
                size: base64Image.length
            });

            frontendLogger.info('[HomeAnalyze]', 'Step 2/5: Calling API endpoint /api/analyze');
            setAnalysisStep('analyzing');
            const apiStartTime = Date.now();
            const data = await apiClient.post<AnalyzeResponse>("/api/analyze", {
                imageBase64: base64Image,
                language: language,
                notebookId: initialNotebookId || autoSelectedNotebookId || undefined
            }, { timeout: aiTimeout }); // Use configured timeout
            const apiDuration = Date.now() - apiStartTime;
            frontendLogger.info('[HomeAnalyze]', 'API response received, validating data', {
                apiDuration
            });

            // Validate response data
            if (!data || typeof data !== 'object') {
                frontendLogger.error('[HomeAnalyze]', 'Validation failed - invalid response data', {
                    data
                });
                throw new Error('Invalid API response: data is null or not an object');
            }
            frontendLogger.info('[HomeAnalyze]', 'Response data validated successfully');

            frontendLogger.info('[HomeAnalyze]', 'Step 3/5: Setting processing state and progress to 100%');
            setAnalysisStep('processing');
            setProgress(100);
            frontendLogger.info('[HomeAnalyze]', 'Progress updated to 100%');

            frontendLogger.info('[HomeAnalyze]', 'Step 4/5: Setting parsed data and auto-selecting notebook');
            const dataSize = JSON.stringify(data).length;
            // Auto-select notebook based on subject
            if (data.subject) {
                // 优先按 Notebook.subject 精确匹配学科，其次退回显示名包含匹配
                const matchedNotebook = notebooks.find(n => subjectLabel(n.subject) === data.subject)
                    || notebooks.find(n =>
                        n.displayName.includes(data.subject!) || data.subject!.includes(n.displayName)
                    );
                if (matchedNotebook) {
                    setAutoSelectedNotebookId(matchedNotebook.id);
                    frontendLogger.info('[HomeAnalyze]', 'Auto-selected notebook', {
                        notebook: matchedNotebook.displayName,
                        subject: data.subject
                    });
                }
            }
            const setDataStart = Date.now();
            setParsedData(data);
            const setDataDuration = Date.now() - setDataStart;
            frontendLogger.info('[HomeAnalyze]', 'Parsed data set successfully', {
                dataSize,
                setDataDuration
            });

            frontendLogger.info('[HomeAnalyze]', 'Step 5/5: Switching to review page');
            const setStepStart = Date.now();
            setStep("review");
            const setStepDuration = Date.now() - setStepStart;
            frontendLogger.info('[HomeAnalyze]', 'Step switched to review', {
                setStepDuration
            });
            const totalDuration = Date.now() - startTime;
            frontendLogger.info('[HomeAnalyze]', 'Analysis completed successfully', {
                totalDuration
            });
            return true;
        } catch (error: any) {
            const errorDuration = Date.now() - startTime;
            frontendLogger.error('[HomeError]', 'Analysis failed', {
                errorDuration,
                error: error.message || String(error)
            });

            // 安全的错误处理逻辑，防止在报错时二次报错
            try {
                let errorMessage = t.common?.messages?.analysisFailed || 'Analysis failed, please try again';

                // ApiError 的结构：error.data.message 包含后端返回的错误类型
                const backendErrorType = error?.data?.message;

                if (backendErrorType && typeof backendErrorType === 'string') {
                    // 检查是否是已知的 AI 错误类型
                    if (t.errors && typeof t.errors === 'object' && backendErrorType in t.errors) {
                        const mappedError = (t.errors as any)[backendErrorType];
                        if (typeof mappedError === 'string') {
                            errorMessage = mappedError;
                            frontendLogger.info('[HomeError]', `Matched error type: ${backendErrorType}`, {
                                errorMessage
                            });
                        }
                    } else {
                        // 使用后端返回的具体错误消息
                        errorMessage = backendErrorType;
                        frontendLogger.info('[HomeError]', 'Using backend error message', {
                            errorMessage
                        });
                    }
                } else if (error?.message) {
                    // Fallback：检查 error.message（用于非 API 错误）
                    if (error.message.includes('fetch') || error.message.includes('network')) {
                        errorMessage = t.errors?.AI_CONNECTION_FAILED || '网络连接失败';
                    } else if (typeof error.data === 'string') {
                        frontendLogger.info('[HomeError]', 'Raw error data', {
                            errorDataPreview: error.data.substring(0, 100)
                        });
                        errorMessage += ` (${error.status || 'Error'})`;
                    }
                }

                alert(errorMessage);
            } catch (innerError) {
                frontendLogger.error('[HomeError]', 'Failed to process error message', {
                    innerError: String(innerError)
                });
                alert('Analysis failed. Please try again.');
            }
            // 失败：保持 false，让调用方知道"没成功、别关对话框"
            return false;
        } finally {
            // Always reset analysis state, even if setState throws
            frontendLogger.info('[HomeAnalyze]', 'Finally: Resetting analysis state to idle');
            setAnalysisStep('idle');
            frontendLogger.info('[HomeAnalyze]', 'Analysis state reset complete');
        }
    };

    const handleSave = async (finalData: ParsedQuestion & { notebookId?: string }): Promise<void> => {
        frontendLogger.info('[HomeSave]', 'Starting save process', {
            hasQuestionText: !!finalData.questionText,
            hasAnswerText: !!finalData.answerText,
            notebookId: finalData.notebookId,
            knowledgePointsCount: finalData.knowledgePoints?.length || 0,
            hasImage: !!currentImage,
            imageSize: currentImage?.length || 0,
        });

        try {
            const result = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", {
                ...finalData,
                originalImageUrl: currentImage || "",
            });

            // 检查是否是重复提交（后端去重返回）
            if (result.duplicate) {
                frontendLogger.info('[HomeSave]', 'Duplicate submission detected, using existing record');
            }

            frontendLogger.info('[HomeSave]', 'Save successful');
            setStep("upload");
            setParsedData(null);
            setCurrentImage(null);
            alert(t.common?.messages?.saveSuccess || 'Saved successfully!');

            // Redirect to notebook page if notebookId is present
            if (finalData.notebookId) {
                router.push(`/notebooks/${finalData.notebookId}`);
            }
        } catch (error: any) {
            frontendLogger.error('[HomeSave]', 'Save failed', {
                errorStatus: error?.status,
                errorMessage: error?.data?.message || error?.message || String(error),
                errorData: error?.data,
            });
            alert(t.common?.messages?.saveFailed || 'Failed to save');
        }
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

    return (
        <main className="min-h-screen bg-background">
            <ProgressFeedback
                status={analysisStep}
                progress={progress}
                message={getProgressMessage()}
            />

            <div className="container mx-auto p-4 space-y-8 pb-20">
                {/* Header Section */}
                <div className="flex justify-between items-start gap-4">
                    <UserWelcome />

                    <div className="flex items-center gap-2 bg-card p-2 rounded-lg border shadow-sm shrink-0">
                        {/* #11：主页左上扫描按钮 —— 纸上的二维码扫回来 */}
                        <Link href="/scan">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="rounded-full text-muted-foreground hover:text-primary"
                                title={t.app?.scan || "扫一扫"}
                            >
                                <QrCode className="h-5 w-5" />
                            </Button>
                        </Link>
                        {/* 【custom-v24】公告通知按钮已按用户要求撤下，功能组件保留备用 */}
                        {/* <BroadcastNotification /> */}
                        <SettingsDialog />
                        <Button
                            variant="ghost"
                            size="icon"
                            className="rounded-full text-muted-foreground hover:text-destructive"
                            onClick={() => signOut({ callbackUrl: '/login' })}
                            title={t.app?.logout || 'Logout'}
                        >
                            <LogOut className="h-5 w-5" />
                        </Button>
                    </div>
                </div>

                {/* Action Center
                    【custom-v24】两个改动：
                    ① 按钮宽度统一 —— 由 flex-wrap 换成 grid。flex-wrap 在放不下时换行，
                       最后一行不满的按钮会各自拉伸，宽度就对不齐；grid 强制四列等宽。
                       窄屏退化成 2×2，仍然等宽。
                    ② 「回收箱」入口从这里撤掉 —— 用户要求以后统一从「查看题册」页进。 */}
                <div className={initialNotebookId ? "flex justify-center mb-6" : "grid grid-cols-2 lg:grid-cols-4 gap-3"}>
                    <Button
                        className={`h-11 text-sm shadow-sm hover:shadow-md transition-all ${initialNotebookId ? "w-full max-w-md" : "w-full"}`}
                        variant={batchMode ? "default" : (step === "upload" ? "default" : "secondary")}
                        onClick={() => setBatchMode(true)}
                    >
                        <Upload className="mr-2 h-4 w-4 shrink-0" />
                        <span className="truncate">{t.app.uploadNew}</span>
                    </Button>

                    {!initialNotebookId && (
                        <>
                            <Link href="/notebooks">
                                <Button
                                    variant="outline"
                                    className="w-full h-11 text-sm shadow-sm hover:shadow-md transition-all border hover:border-primary/50 hover:bg-accent/50"
                                >
                                    <BookOpen className="mr-2 h-4 w-4 shrink-0" />
                                    <span className="truncate">{t.app.viewNotebook}</span>
                                </Button>
                            </Link>

                            <Link href="/tags">
                                <Button
                                    variant="outline"
                                    className="w-full h-11 text-sm shadow-sm hover:shadow-md transition-all border hover:border-primary/50 hover:bg-accent/50"
                                >
                                    <Tags className="mr-2 h-4 w-4 shrink-0" />
                                    <span className="truncate">{t.app?.tags || 'Tags'}</span>
                                </Button>
                            </Link>

                            <Link href="/stats">
                                <Button
                                    variant="outline"
                                    className="w-full h-11 text-sm shadow-sm hover:shadow-md transition-all border hover:border-primary/50 hover:bg-accent/50"
                                >
                                    <BarChart3 className="mr-2 h-4 w-4 shrink-0" />
                                    <span className="truncate">{t.app?.stats || 'Stats'}</span>
                                </Button>
                            </Link>
                        </>
                    )}
                </div>

                {batchMode ? (
                    /* 【custom-v23 · 蓝图 #5/#6/#7】流水线：多张收进来 → 逐张加工 → 批量送 AI → 一道道录入 */
                    <BatchPipeline
                        language={language}
                        aiTimeout={aiTimeout}
                        defaultNotebookId={initialNotebookId || autoSelectedNotebookId || undefined}
                        onExit={() => setBatchMode(false)}
                    />
                ) : (
                    <>
                        {step === "upload" && (
                            <UploadZone onImageSelect={onImageSelect} isAnalyzing={analysisStep !== 'idle'} />
                        )}

                        {croppingImage && (
                            <ImageCropper
                                imageSrc={croppingImage}
                                open={isCropperOpen}
                                onClose={() => setIsCropperOpen(false)}
                                onCropComplete={handleCropComplete}
                                analyzing={analysisStep !== 'idle'}
                            />
                        )}


                        {step === "review" && parsedData && (
                            <CorrectionEditor
                                initialData={parsedData}
                                onSave={handleSave}
                                onCancel={() => setStep("upload")}
                                imagePreview={currentImage}
                                initialSubjectId={initialNotebookId || autoSelectedNotebookId || undefined}
                                aiTimeout={aiTimeout}
                            />
                        )}
                    </>
                )}

            </div>
        </main>
    );
}

export default function Home() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <HomeContent />
        </Suspense>
    );
}
