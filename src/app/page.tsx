"use client";

import { useState, Suspense, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { UploadZone } from "@/components/upload-zone";
import { CorrectionEditor } from "@/components/correction-editor";
import { ImageCropper, type CropRegionsPayload } from "@/components/image-cropper";
import { serializeCropRegions } from "@/lib/crop-regions";
import { BatchPipeline } from "@/components/batch-pipeline";
import { ParsedQuestion } from "@/lib/ai";
import { apiClient } from "@/lib/api-client";
import { AnalyzeResponse, Notebook, AppConfig } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import {
    Upload,
    BookOpen,
    QrCode,
    Layers,
    Sprout,
    ScanText,
    Settings,
    Monitor,
    Tags,
    NotebookPen,
    Printer,
    Sparkles,
    ListChecks,
    BarChart3,
    MessageSquare,
    Brain,
    GraduationCap,
    LayoutGrid,
    Copy,
} from "lucide-react";
import { SettingsDialog } from "@/components/settings-dialog";
import { TaskBrief } from "@/components/home/task-brief";
import { WrongAnswerStats } from "@/components/wrong-answer-stats";
import { captureScreen, ScreenshotError, isScreenshotSupported } from "@/lib/screenshot";
/**
 * 【custom-v24】公告通知按钮按用户要求从首页撤下（功能保留，组件文件不动）。
 * 需要恢复时把 import 与 <BroadcastNotification /> 一起放回图右上角工具条即可。
 */
// import { BroadcastNotification } from "@/components/broadcast-notification";
import { useSession } from "next-auth/react";

import { ProgressFeedback, ProgressStatus } from "@/components/ui/progress-feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { subjectLabel } from "@/lib/notebook-fields";
import { GRADE_SEMESTER_OPTIONS } from "@/lib/grade-semester-options";

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

    /**
     * 【2026-10-19 空空第 1、2 条】主页顶栏改成"用户名 + 年级学期 + 扫一扫"。
     * 用户名点开就是设置（齿轮撤掉）；退出搬进设置的「关于」里。
     */
    const { data: session } = useSession();
    const [settingsOpen, setSettingsOpen] = useState(false);
    /**
     * 【2026-10-19 空空第 1 条】**年级 / 学期合成一个下拉**（他给了下拉截图与选项列表：
     * 一年级上 / 一年级下 / … / 六年级下）。
     *
     * 它的作用不只是显示 —— 他原话："如果选定了这里的年级/学期，则录入的新题、
     * 录入的日积月累缺省设置都是这个年级/学期，这样就关联起来了。"
     * ⇒ 存在 localStorage 的 `home.gradeTerm`，录入页/新建题默认读它。
     */
    const [gradeTerm, setGradeTerm] = useState("");
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);
    const userName = session?.user?.name || session?.user?.email || "User";
    const userInitial = userName.slice(0, 1).toUpperCase();

    useEffect(() => {
        /**
         * 从 localStorage 读上次选的年级/学期。
         * ⚠️ 只能在挂载后读（服务端没有 localStorage）⇒ 这里必须 `setState` 一次；
         *    项目的 `react-hooks/set-state-in-effect` 是 error，所以显式豁免并说明理由。
         */
        try {
            const gt = localStorage.getItem("home.gradeTerm");
            if (gt) setGradeTerm(gt);
        } catch {
            // 隐私模式下 localStorage 会抛：当没存过
        }
    }, []);
    useEffect(() => {
        try {
            localStorage.setItem("home.gradeTerm", gradeTerm);
            /**
             * 【第 1 条的核心】"选定之后，新录入的题、录入的日积月累**缺省**就是这个年级/学期。"
             *
             * 两个录入页各自有记忆键（历史原因，没去合并）：
             *   · 错题校对页 `CorrectionEditor` → `wn_default_gradeSemester`
             *   · 日积月累录入页 → `insight.write.gradeSemester`
             * ⇒ 这里把主页这一个值**同步写进那两个键**，它们下次打开就默认成这个。
             * ⚠️ 只在**非空**时写：清空选择不该把她录入页里的旧记忆抹掉。
             */
            if (gradeTerm) {
                localStorage.setItem("wn_default_gradeSemester", gradeTerm);
                localStorage.setItem("insight.write.gradeSemester", gradeTerm);
            }
        } catch {
            // 隐私模式存不了，忽略
        }
    }, [gradeTerm]);
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
    /**
     * 【custom-v25 绿框】单题流的裁剪对话框里画了「区🟩」→ 一图裁出多道，
     * 这不是单题流吃得下的（它的下一步只有一个 CorrectionEditor）。
     * 于是把这批**已经裁好的图**交给流水线去逐道送 AI + 审阅入库。
     * 只在这里中转一次：退出流水线时立刻清空，避免下次进流水线又灌一遍。
     *
     * 【2026-10-19 第 7 条】「批量上传」按钮已经搬到 `/batch` 独立页面，
     * 所以 `batchMode` 这个开关没用了（删掉）。但**绿框多图**这条路还得有落点：
     * `batchFiles` 一非空就在主页下方临时渲染流水线（做完即清空，不算"挤在主页"）。
     */
    const [batchFiles, setBatchFiles] = useState<File[]>([]);

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

    /**
     * 【custom-v25 绿框】编辑器一次交出多张（一区一张）。
     * 单题流只能处理一张，所以直接切到流水线：图已经裁好了，进去点「送 AI」即可。
     */
    const handleCropBatch = (blobs: Blob[]) => {
        if (!blobs.length) return;
        setIsCropperOpen(false);
        // 【M1】切到流水线：坐标改走 `batchCropRegions`（与图片同序），
        // 单张通道的值留着只会污染后面某一道单张录入，就地清掉。
        setPendingCropRegions(null);
        setBatchFiles(blobs.map((b, i) => new File([b], `region-${i + 1}.jpg`, { type: "image/jpeg" })));
    };

    /** 【M1】绿框多图路的框坐标，与 batchFiles 同序（下标一一对应） */
    const [batchCropRegions, setBatchCropRegions] = useState<(string | null)[]>([]);
    const handleCropRegionsMulti = (payloads: (CropRegionsPayload | null)[]) => {
        setBatchCropRegions(payloads.map((p) => (p ? serializeCropRegions(p) : null)));
    };

    /**
     * 【M1 / 2026-09-26 三修】单张录入这一路的框坐标。
     *
     * ⚠️ 之前**首页压根没接 `onCropRegions`** —— 只有"某错题本 → 添加"那条路接了。
     *    后果：从首页单张录入（不画绿框）的题，坐标一路被丢掉
     *    ⇒ 打印时没有净版、反面无题图 ⇒ 用户看到的就是"橙框白画了"。
     *    这是"两条录入路径只改了一条"的典型（本项目历史上踩过好几次）。
     */
    const [pendingCropRegions, setPendingCropRegions] = useState<string | null>(null);
    const handleCropRegions = (payload: CropRegionsPayload | null) => {
        setPendingCropRegions(payload ? serializeCropRegions(payload) : null);
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
                // 【M1】框坐标（已序列化）。没有就不带这个键 —— 后端按"未提供"处理，不写列。
                ...(pendingCropRegions ? { cropRegions: pendingCropRegions } : {}),
            });

            // 检查是否是重复提交（后端去重返回）
            if (result.duplicate) {
                frontendLogger.info('[HomeSave]', 'Duplicate submission detected, using existing record');
            }

            frontendLogger.info('[HomeSave]', 'Save successful');
            setStep("upload");
            setParsedData(null);
            setCurrentImage(null);
            // 【M1】坐标已随上面那次 POST 入库，清掉，免得被下一道捡去用
            setPendingCropRegions(null);
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

            <div className="container mx-auto space-y-4 p-4 pb-20">
                {/**
                 * 【2026-10-19 空空第 1、2 条】顶栏：
                 *   · 左上角 = **用户名**，点它进设置（齿轮撤掉，退出也搬进设置里）
                 *   · 顶端中间 = **年级 / 学期**
                 *   · 右侧 = **扫一扫**（单独一个按钮，不再和设置/退出挤成一小撮）
                 */}
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setSettingsOpen(true)}
                        className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/40"
                        title={L("点这里进设置（退出也在里面）", "Settings — logout is inside too")}
                    >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                            {userInitial}
                        </span>
                        <span className="max-w-[9rem] truncate text-sm font-medium">{userName}</span>
                        <Settings className="h-3.5 w-3.5 opacity-40" />
                    </button>

                    {/* 【2026-10-19 第 1 条】年级 / 学期**合成一个下拉**（选项 = 一年级上 … 六年级下）。
                        【第 3 条】右边的「扫一扫」撤掉了 —— 第一行已经有「扫二维码」，两个功能一模一样。 */}
                    <select
                        value={gradeTerm}
                        onChange={(e) => setGradeTerm(e.target.value)}
                        className="rounded-md border bg-background px-2 py-1.5 text-xs"
                        aria-label={L("年级学期", "Grade and term")}
                        title={L("选定后，新录入的题和日积月累默认用这个年级/学期", "New questions and notes default to this")}
                    >
                        <option value="">{L("年级/学期", "Grade / term")}</option>
                        {GRADE_SEMESTER_OPTIONS.map((g) => (
                            <option key={g} value={g}>
                                {g}
                            </option>
                        ))}
                    </select>

                    <span className="flex-1" />
                </div>

                <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} hideTrigger />

                {/**
                 * 【2026-10-19 空空第 3~5 条】主页入口按**他的设计**重排：
                 *
                 * ② 四个快捷：批量上传 / 屏幕截图 / 标签管理 / 扫二维码
                 * ③ 三块：拍摄习题（大，左）+ 查看题册 / 日积月累（右，上下叠）
                 * ④ 12 个标签（4 列 3 行，图案在上、文字在下）：
                 *    复练纸 / 模仿纸 / 积累管理 / 积累打印
                 *    回录分析 / 举一反三 / 当前任务 / 数据图表
                 *    AI对话 / 分析记忆 / 针对课程 / 全部
                 *
                 * ⚠️ 从错题本"添加错题"进来（`?notebook=`）时**整块不显示** ——
                 *    他是来加题的，不该先看见一屏入口。
                 * ⚠️ 还没做的四个（举一反三 / AI对话 / 分析记忆 / 针对课程 / 全部）画成**灰态**、
                 *    不可点，`title` 写"还没做"。**不装成能点的样子**（那比不做更糟）。
                 */}
                {initialNotebookId ? (
                    <div className="flex justify-center">
                        {/* 【第 7 条】批量上传已经是独立页面 ⇒ 这里也改成跳过去（不再页内插板块） */}
                        <Link href="/batch" className="w-full max-w-md">
                            <Button className="h-11 w-full text-sm">
                                <Upload className="mr-2 h-4 w-4 shrink-0" />
                                <span className="truncate">{t.app.uploadNew}</span>
                            </Button>
                        </Link>
                    </div>
                ) : (
                    <>
                        {/**
                         * ② 四个快捷 —— 【第 2 条】电脑一行、**手机也一行**。
                         * 做法：`grid-cols-4` 四等分 + 手机字号/图标小一号（`text-[11px]` / `h-3.5`），
                         * 不再靠 `sm:grid-cols-4` 在窄屏退回两行。
                         * 【第 7 条】「批量上传」不再是页内板块，改为**跳 `/batch` 独立页面**。
                         */}
                        <div className="grid grid-cols-4 gap-1.5">
                            <Link href="/batch">
                                <Button
                                    variant="outline"
                                    className="h-9 w-full justify-center gap-1 px-1 text-[11px] sm:h-10 sm:text-xs"
                                >
                                    <Upload className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{L("批量上传", "Bulk")}</span>
                                </Button>
                            </Link>
                            <Button
                                variant="outline"
                                className="h-9 justify-center gap-1 px-1 text-[11px] sm:h-10 sm:text-xs"
                                title={
                                    isScreenshotSupported()
                                        ? L("抓取屏幕或某个标签页", "Capture the screen or a tab")
                                        : L("这个浏览器不支持屏幕截图", "This browser cannot capture the screen")
                                }
                                onClick={async () => {
                                    try {
                                        onImageSelect(await captureScreen());
                                    } catch (e) {
                                        // 用户点了「取消」不算错，别弹红字
                                        if (e instanceof ScreenshotError && e.cancelled) return;
                                        alert((e as Error)?.message || L("截图失败", "Screenshot failed"));
                                    }
                                }}
                            >
                                <Monitor className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{L("屏幕截图", "Shot")}</span>
                            </Button>
                            <Link href="/tags">
                                <Button
                                    variant="outline"
                                    className="h-9 w-full justify-center gap-1 px-1 text-[11px] sm:h-10 sm:text-xs"
                                >
                                    <Tags className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{L("标签管理", "Tags")}</span>
                                </Button>
                            </Link>
                            <Link href="/scan">
                                <Button
                                    variant="outline"
                                    className="h-9 w-full justify-center gap-1 px-1 text-[11px] sm:h-10 sm:text-xs"
                                >
                                    <QrCode className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{L("扫二维码", "QR")}</span>
                                </Button>
                            </Link>
                        </div>

                        {/**
                         * ③ 【第 4、5 条】左边「拍摄习题」= 拖拽区 + 拍照（`UploadZone compact`），
                         * 右边上下叠「查看题册」「日积月累」。
                         *
                         * 宽度：`grid-cols-2` ⇒ 左右**各占一半**；
                         * 左边跨两行 ⇒ 与右边两块**合计高度**对齐。
                         * （原来我用的是 3 列、左 2/3，他觉得"拍摄习题太宽、右边两个太窄"。）
                         */}
                        <div className="grid grid-cols-2 gap-2">
                            <div className="row-span-2">
                                <UploadZone
                                    compact
                                    onImageSelect={onImageSelect}
                                    isAnalyzing={analysisStep !== "idle"}
                                />
                            </div>
                            <Link
                                href="/notebooks"
                                className="flex flex-col justify-center rounded-lg border bg-card px-3 py-3 transition-colors hover:bg-accent/40"
                            >
                                <BookOpen className="mb-1 h-4 w-4 text-muted-foreground" />
                                <div className="text-sm font-medium">{L("查看题册", "Notebooks")}</div>
                            </Link>
                            <Link
                                href="/insights/write"
                                className="flex flex-col justify-center rounded-lg border bg-card px-3 py-3 transition-colors hover:bg-accent/40"
                            >
                                <Sprout className="mb-1 h-4 w-4 text-muted-foreground" />
                                <div className="text-sm font-medium">{L("日积月累", "Notes")}</div>
                            </Link>
                        </div>

                        {/* ④ 12 个标签 —— 图案在上、文字在下 */}
                        <div className="grid grid-cols-4 gap-2">
                            {[
                                { zh: "复练纸", en: "Review sheet", Icon: Layers, href: "/review-volumes?kind=review" },
                                { zh: "模仿纸", en: "Imitate sheet", Icon: Copy, href: "/review-volumes?kind=imitate" },
                                { zh: "积累管理", en: "Notes · manage", Icon: NotebookPen, href: "/insights" },
                                { zh: "积累打印", en: "Notes · print", Icon: Printer, href: "/insights/print" },
                                { zh: "回录分析", en: "Recover", Icon: ScanText, href: "/recover" },
                                { zh: "举一反三", en: "Similar", Icon: Sparkles, href: null },
                                { zh: "当前任务", en: "Tasks", Icon: ListChecks, href: "/tasks" },
                                { zh: "数据图表", en: "Charts", Icon: BarChart3, href: "/stats" },
                                { zh: "AI对话", en: "AI chat", Icon: MessageSquare, href: null },
                                { zh: "分析记忆", en: "Memory", Icon: Brain, href: null },
                                { zh: "针对课程", en: "By course", Icon: GraduationCap, href: null },
                                { zh: "全部", en: "All", Icon: LayoutGrid, href: null },
                            ].map(({ zh, en, Icon, href }) =>
                                href ? (
                                    <Link
                                        key={zh}
                                        href={href}
                                        className="flex flex-col items-center gap-1.5 rounded-lg border bg-card px-1 py-3 transition-colors hover:bg-accent/40"
                                    >
                                        <Icon className="h-5 w-5 text-muted-foreground" />
                                        <span className="text-[11px] leading-tight">{L(zh, en)}</span>
                                    </Link>
                                ) : (
                                    <div
                                        key={zh}
                                        className="flex cursor-not-allowed flex-col items-center gap-1.5 rounded-lg border border-dashed px-1 py-3 opacity-45"
                                        title={L("还没做", "Not built yet")}
                                    >
                                        <Icon className="h-5 w-5" />
                                        <span className="text-[11px] leading-tight">{L(zh, en)}</span>
                                    </div>
                                ),
                            )}
                        </div>
                    </>
                )}

                {/**
                 * 【2026-10-19 第 6、7 条】
                 *   · **主页不再内嵌上传区**：那个大框（"AI 智能解析 / 拍照扫描 / 屏幕截图"）
                 *     的功能已经被上面「拍摄习题」和第一行「屏幕截图」接走 ⇒ 删掉。
                 *   · **批量上传搬去 `/batch` 独立页面**（他说"不要再挤在主页中"）⇒ 这里不再有 `batchMode` 分支。
                 *   · 只留下"拍到图之后"的两步：裁剪 → 校对保存。
                 */}
                {/**
                 * 【绿框多图】一图裁出多道时，临时用流水线接手（做完即清空）。
                 * 这是主页上唯一会出现流水线的地方 —— 入口仍是裁剪对话框里的绿框，
                 * 不是按钮，所以不违背"批量上传搬去独立页面"。
                 */}
                {batchFiles.length > 0 && (
                    <BatchPipeline
                        language={language}
                        aiTimeout={aiTimeout}
                        defaultNotebookId={initialNotebookId || autoSelectedNotebookId || undefined}
                        initialFiles={batchFiles}
                        onExit={() => {
                            setBatchFiles([]);
                            setBatchCropRegions([]);
                        }}
                        initialCropRegions={batchCropRegions}
                    />
                )}

                {croppingImage && (
                    <ImageCropper
                        imageSrc={croppingImage}
                        open={isCropperOpen}
                        onClose={() => setIsCropperOpen(false)}
                        onCropComplete={handleCropComplete}
                        onCropBatch={handleCropBatch}
                        onCropRegions={handleCropRegions}
                        onCropRegionsMulti={handleCropRegionsMulti}
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

                {/**
                 * 【2026-10-19 空空第 6、7 条】
                 *   · 任务简报：**手机接在下面、电脑接在右侧**
                 *   · 图表：**两边都在最下端**
                 *
                 * 用一个 grid + order 把两种排法写在一处（不渲染两份，省掉第二次请求）：
                 *   手机（单列）：任务 → 图表
                 *   电脑（两列）：任务在第 2 列、图表在第 1 列（即最下那块的主位）
                 */}
                {!initialNotebookId && (
                    <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
                        <div className="order-1 lg:order-none lg:col-start-2 lg:row-start-1">
                            <TaskBrief />
                        </div>
                        <div className="order-2 lg:order-none lg:col-start-1 lg:row-start-1">
                            <WrongAnswerStats />
                        </div>
                    </div>
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
