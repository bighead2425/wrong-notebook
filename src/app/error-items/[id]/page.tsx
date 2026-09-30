"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle, XCircle, RefreshCw, Trash2, Edit, Save, X, Sparkles, Loader2, Printer } from "lucide-react";
import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";
import { MdEditor } from "@/components/md-editor";
import { TagInput } from "@/components/tag-input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";
import {
    MISTAKE_CATEGORY_DESC_ZH,
    MISTAKE_GROUPS,
    getMistakeCategoryLabel,
    normalizeMistakeCategory,
} from "@/lib/mistake-category";
import {
    DEEP_NUDGE_BG,
    MANAGE_TYPES,
    MANAGE_TYPE_LABEL,
    MANAGE_TYPE_SCREEN_COLOR,
    MANAGE_TYPE_UNDECIDED,
    MANAGE_TYPE_UNDECIDED_COLOR,
    needsDeepPrintNudge,
} from "@/lib/manage-type";
import { UserProfile } from "@/types/api";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { NotebookSelector } from "@/components/notebook-selector";
import { CorrectionEditor, ParsedQuestionWithSubject } from "@/components/correction-editor";
import { ParsedQuestion } from "@/lib/ai";
import { PrintCounts } from "@/components/print-counts";
import { attentionLevelOf, ATTENTION_LEVELS } from "@/lib/attention-level";
import { GRADE_SEMESTER_OPTIONS as GRADE_SEMESTER_OPTIONS_SHARED } from "@/lib/grade-semester-options";
import { ReviewOutcomeEditor } from "@/components/review-outcome-editor";
import { serializeReviewOutcomes, type ReviewOutcomes } from "@/lib/review-outcomes";

interface KnowledgeTag {
    id: string;
    name: string;
}

interface ErrorItemDetail {
    id: string;
    questionText: string;
    answerText: string;
    analysis: string;
    wrongAnswerText?: string | null;
    mistakeAnalysis?: string | null;
    mistakeStatus?: string | null;
    knowledgePoints: string; // 保留兼容旧数据
    tags: KnowledgeTag[]; // 新的标签关联
    masteryLevel: number;
    originalImageUrl: string;
    userNotes: string | null;
    /** 录入时间（ISO）—— 复习结果那三行的日期 = 它 +1 / +7 / +21 天 */
    createdAt?: string;
    notebookId?: string | null;
    notebook?: {
        id: string;
        displayName: string;
        subject: string;
    } | null;
    gradeSemester?: string | null;
    paperLevel?: string | null;
    /** 【2026-09-28】错题等级：deep / review / null（未定） */
    manageType?: string | null;
    /** 等级来源：default / derived / ai / manual / upgrade */
    manageTypeSource?: string | null;
    /** 错因（受控枚举，见 lib/mistake-category.ts）——错题等级由它派生 */
    mistakeCategory?: string | null;
    source?: string | null;
    /** #10 / T4：打印次数，只显不改 */
    printCount?: number | null;
    /** 【2026-09-30】复练纸印刷次数（印一次复练卷，卷内每道题 +1） */
    reviewPrintCount?: number | null;
    /** G8 / T5：关注档（难度）1-5 */
    attention?: number | null;
    /**
     * 【2026-09-30】复习结果四圆点的原材料（JSON 字符串）：
     * `{"planned":["right",null,null],"last":"wrong"}`
     * 规则全在 `lib/review-outcomes.ts`（计划内同步 last、计划外只动 last）。
     */
    reviewOutcomes?: string | null;
}

/**
 * 【2026-09-29】年级/学期的固定选项 —— 他定的：试题信息里直接下拉，不再自由输入。
 * 覆盖小学（一~六）× 上下学期 + 初中（七~九）+ 高中（高一~高三）× 上下学期。
 * ⚠️ 数据库里已有的旧值如果不在清单里（如"三年级"），会作为「原值」补在最后，不会丢。
 * 【2026-10-01】清单已抽到 `lib/grade-semester-options.ts`（日积月累页要用同一份，别抄第二份）。
 */
const GRADE_SEMESTER_OPTIONS: string[] = [
    ...GRADE_SEMESTER_OPTIONS_SHARED,
];

export default function ErrorDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { t, language } = useLanguage();
    /** 本页新文案的双语助手（与列表页/复练卷页同一写法） */
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);
    const [item, setItem] = useState<ErrorItemDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [notesInput, setNotesInput] = useState("");
    const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
    const [isEditingTags, setIsEditingTags] = useState(false);
    const [tagsInput, setTagsInput] = useState<string[]>([]);
    const [exportState, setExportState] = useState<"idle" | "doing" | "ok" | "err">("idle");
    // 需求六：「AI 重新分析」——用原图重跑 AI，进审核页，确认保存才覆盖
    const [reanalyzeData, setReanalyzeData] = useState<ParsedQuestion | null>(null);
    const [isReanalyzing, setIsReanalyzing] = useState(false);

    const [educationStage, setEducationStage] = useState<string | undefined>(undefined);

    useEffect(() => {
        // Fetch user info for education stage
        apiClient.get<UserProfile>("/api/user")
            .then(user => {
                if (user && user.educationStage) {
                    setEducationStage(user.educationStage);
                }
            })
            .catch(err => console.error("Failed to fetch user info:", err));

        if (params.id) {
            fetchItem(params.id as string);
        }
    }, [params.id]);

    /**
     * 【2026-09-29】这些 md 字段改成**一直可编辑**（不再点"编辑"）⇒ 输入状态必须在
     * 题目载入时初始化一次。
     * ⚠️ 依赖只写 `item?.id`：改试题信息（错题本/年级/等级/错因）会重新拉整条 item，
     *    但**不能**顺手把正在编辑的正文覆盖掉（那会把没保存的改动洗没）。
     */
    useEffect(() => {
        if (!item) return;
        setQuestionInput(item.questionText ?? "");
        setAnswerInput(item.answerText ?? "");
        setAnalysisInput(item.analysis ?? "");
        setWrongAnswerInput(item.wrongAnswerText ?? "");
        setMistakeAnalysisInput(item.mistakeAnalysis ?? "");
        setMistakeStatusInput(item.mistakeStatus || "unknown");
        setNotesInput(item.userNotes ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换题时初始化，见上
    }, [item?.id]);

    const fetchItem = async (id: string) => {
        try {
            const data = await apiClient.get<ErrorItemDetail>(`/api/error-items/${id}`);
            setItem(data);
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.loadFailed || 'Failed to load item');
            router.push("/notebooks");
        } finally {
            setLoading(false);
        }
    };

    const toggleMastery = async () => {
        if (!item) return;

        const newLevel = item.masteryLevel > 0 ? 0 : 1;

        try {
            await apiClient.patch(`/api/error-items/${item.id}/mastery`, { masteryLevel: newLevel });
            setItem({ ...item, masteryLevel: newLevel });
            alert(newLevel > 0 ? (t.common?.messages?.markMastered || 'Marked as mastered') : (t.common?.messages?.unmarkMastered || 'Unmarked'));
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.updateFailed || 'Update failed');
        }
    };

    /**
     * 【custom-v24】删除 = 移入回收箱，不再是真删。
     *
     * 原实现打的是 `/api/error-items/[id]/delete`，那条路由里写的是 `prisma.errorItem.delete()`，
     * 是**物理删除**：记录直接从库里消失，回收箱 (`deletedAt != null`) 自然也查不到，
     * 与「所有删除都先进回收箱」的既定口径正好相反（用户反馈的正是这条）。
     *
     * 现改打 `/api/error-items/[id]` 的 DELETE：该路由默认**软删**（写 deletedAt），
     * 只有显式带 `?hard=1` 才彻底删除，而 `hard=1` 只由回收箱页的「彻底删除」使用。
     * 这样：详情页删 → 进回收箱 → 可还原；回收箱里再删 → 才真删。
     */
    const deleteItem = async () => {
        if (!item) return;

        const confirmMessage = t.common?.messages?.confirmMoveToTrash
            || 'Move this question to the trash? You can restore it from the trash later.';
        if (!confirm(confirmMessage)) return;

        try {
            await apiClient.delete(`/api/error-items/${item.id}`);
            alert(t.common?.messages?.moveToTrashSuccess || 'Moved to trash');
            if (item.notebookId) {
                router.push(`/notebooks/${item.notebookId}`);
            } else {
                router.push('/notebooks');
            }
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.deleteFailed || 'Delete failed');
        }
    };

    const exportToObsidian = async () => {
        if (!item) return;
        if (!item.source) {
            setExportState("err");
            setTimeout(() => setExportState("idle"), 4000);
            return;
        }
        setExportState("doing");
        try {
            await apiClient.post(`/api/error-items/${item.id}/export-obsidian`, {});
            setExportState("ok");
            setTimeout(() => setExportState("idle"), 3000);
        } catch (error) {
            console.error(error);
            setExportState("err");
            setTimeout(() => setExportState("idle"), 4000);
        }
    };

    /**
     * 需求六：用原始图片重新跑一次 AI 分析（换 API / 换模型后想重跑也走这里）。
     * 只更新「知识点 / 题目 / 参考答案 / 解析 / 错因」，保存时不传
     * 错题本、年级学期、题号、打印次数，因此这些字段保持不变。
     */
    const handleReanalyze = async () => {
        if (!item) return;
        if (!item.originalImageUrl) {
            alert(t.detail?.aiReanalyzeNoImage || "这道题没有原始图片，无法用 AI 分析。");
            return;
        }
        setIsReanalyzing(true);
        try {
            const data = await apiClient.post<ParsedQuestion>("/api/analyze", {
                imageBase64: item.originalImageUrl,
                language,
                notebookId: item.notebookId || undefined,
            });
            setReanalyzeData(data);
        } catch (error) {
            console.error(error);
            alert(t.detail?.aiReanalyzeFailed || "AI 分析失败，请重试。");
        } finally {
            setIsReanalyzing(false);
        }
    };

    /** 审核页点「保存」：只覆盖分析类字段，题号/打印次数/所属本不动 */
    const handleReanalyzeSave = async (data: ParsedQuestionWithSubject) => {
        if (!item) return;
        await apiClient.put(`/api/error-items/${item.id}`, {
            questionText: data.questionText,
            answerText: data.answerText,
            analysis: data.analysis,
            knowledgePoints: data.knowledgePoints,
            wrongAnswerText: data.wrongAnswerText,
            mistakeAnalysis: data.mistakeAnalysis,
            mistakeStatus: data.mistakeStatus,
        });
        setReanalyzeData(null);
        await fetchItem(item.id);
        // 【2026-09-29】成功不再弹窗（同上）：审核页会关闭、列表会刷新，本身就是反馈
    };

    const startEditingTags = () => {
        if (item) {
            // 优先使用新的 tags 关联
            if (item.tags && item.tags.length > 0) {
                setTagsInput(item.tags.map(t => t.name));
            } else if (item.knowledgePoints) {
                // 回退到旧的 knowledgePoints 字段
                try {
                    const tags = JSON.parse(item.knowledgePoints);
                    setTagsInput(tags);
                } catch (e) {
                    setTagsInput([]);
                }
            } else {
                setTagsInput([]);
            }
            setIsEditingTags(true);
        }
    };

    const saveTagsHandler = async () => {
        try {
            // 直接传递标签名称数组，后端会处理关联
            await apiClient.put(`/api/error-items/${item?.id}`, {
                knowledgePoints: tagsInput, // 后端接收数组
            });

            setIsEditingTags(false);
            await fetchItem(params.id as string);
            // 【2026-09-29】成功不再弹窗（同上）：编辑态关闭、标签即刷新，本身就是反馈
        } catch (error) {
            console.error("[Frontend] Error updating:", error);
            alert(t.common?.messages?.updateFailed || 'Update failed');
        }
    };

    const cancelEditingTags = () => {
        setIsEditingTags(false);
        setTagsInput([]);
    };

    /**
     * 【2026-09-29】试题信息的可改项（错题本/年级学期/错题等级/错因）**直接摆成下拉**，
     * 改即存 —— 他定的："不用点击编辑再修改"。
     *
     * 每次只送改的那一个字段（服务端 PUT 本来就是逐字段校验、逐字段留痕）。
     * ⚠️ 成功后**必须整条刷新**：改「错因」可能让服务端自动派生「错题等级」，
     *    本地 setItem 对不齐 —— 这正是"派生+落定快照"的规矩，要以服务端为准。
     */
    const patchMetadata = async (patch: Record<string, unknown>) => {
        if (!item) return;
        try {
            await apiClient.put(`/api/error-items/${item.id}`, patch);
            fetchItem(params.id as string);
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.updateFailed || 'Update failed');
        }
    };

    /**
     * 【2026-09-30】复习结果四圆点：改一格即存。
     *
     * ⚠️ 与 `patchMetadata` **故意不同**：这里**不重新拉整条 item**，只做乐观更新。
     *    原因：重新拉 item 会触发上面那个"初始化输入状态"的 effect 之外的连带刷新，
     *    而四圆点是高频连点的地方（点三下 = 三次请求），每次重拉整页会闪。
     *    失败时再拉真实数据回正（**失败提示一律保留**）。
     */
    const saveReviewOutcomes = async (next: ReviewOutcomes) => {
        if (!item) return;
        const serialized = serializeReviewOutcomes(next);
        setItem({ ...item, reviewOutcomes: serialized });
        try {
            await apiClient.put(`/api/error-items/${item.id}`, { reviewOutcomes: serialized });
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.updateFailed || 'Update failed');
            fetchItem(item.id);
        }
    };

    const [questionInput, setQuestionInput] = useState("");

    const [answerInput, setAnswerInput] = useState("");

    const [analysisInput, setAnalysisInput] = useState("");

    const [wrongAnswerInput, setWrongAnswerInput] = useState("");
    const [mistakeAnalysisInput, setMistakeAnalysisInput] = useState("");
    const [mistakeStatusInput, setMistakeStatusInput] = useState("unknown");

    /**
     * 【2026-09-29】"有未保存改动"的统一判定 —— **一处算、两处用**：
     *   ① 决定框下面那份「保存 / 取消」出不出来；
     *   ② 决定框的边框要不要变橙黄（作为 `dirty` 传给 MdEditor）。
     * 两处共用一个判断，才不会出现"按钮冒出来了、框却没变色"这种不一致。
     * 保存成功（item 被更新 / 重新拉取）或取消（输入归位）后，这里自然变回 false ⇒ 颜色复原。
     */
    const dirtyQuestion = questionInput !== (item?.questionText ?? "");
    const dirtyAnswer = answerInput !== (item?.answerText ?? "");
    const dirtyAnalysis = analysisInput !== (item?.analysis ?? "");
    const dirtyWrongAnswer = wrongAnswerInput !== (item?.wrongAnswerText ?? "");
    const dirtyMistakeAnalysis = mistakeAnalysisInput !== (item?.mistakeAnalysis ?? "");
    const dirtyNotes = notesInput !== (item?.userNotes ?? "");

    // --- Question Handlers ---
    const saveQuestionHandler = async () => {
        try {
            await apiClient.put(`/api/error-items/${item?.id}`, { questionText: questionInput });
            if (item) setItem({ ...item, questionText: questionInput });
            // 【2026-09-29】成功不再弹窗（他实测："每次保存都跳确认，太啰嗦"）：
            // 反馈改由界面承担 —— 框的橙黄边框复位、「保存 / 取消」按钮消失。
            // ⚠️ **失败提示一律保留**：静默失败比啰嗦更糟。
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.saveFailed || 'Save failed');
        }
    };

    const saveAnswerHandler = async () => {
        try {
            await apiClient.put(`/api/error-items/${item?.id}`, { answerText: answerInput });
            if (item) setItem({ ...item, answerText: answerInput });
            // 【2026-09-29】成功不再弹窗（他实测："每次保存都跳确认，太啰嗦"）：
            // 反馈改由界面承担 —— 框的橙黄边框复位、「保存 / 取消」按钮消失。
            // ⚠️ **失败提示一律保留**：静默失败比啰嗦更糟。
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.saveFailed || 'Save failed');
        }
    };

    const saveAnalysisHandler = async () => {
        try {
            await apiClient.put(`/api/error-items/${item?.id}`, { analysis: analysisInput });
            if (item) setItem({ ...item, analysis: analysisInput });
            // 【2026-09-29】成功不再弹窗（他实测："每次保存都跳确认，太啰嗦"）：
            // 反馈改由界面承担 —— 框的橙黄边框复位、「保存 / 取消」按钮消失。
            // ⚠️ **失败提示一律保留**：静默失败比啰嗦更糟。
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.saveFailed || 'Save failed');
        }
    };

    const saveMistakeHandler = async () => {
        try {
            const normalizedStatus = normalizeMistakeStatusForSave(
                mistakeStatusInput,
                wrongAnswerInput
            );
            await apiClient.put(`/api/error-items/${item?.id}`, {
                wrongAnswerText: wrongAnswerInput,
                mistakeAnalysis: mistakeAnalysisInput,
                mistakeStatus: normalizedStatus,
            });
            if (item) {
                setItem({
                    ...item,
                    wrongAnswerText: wrongAnswerInput,
                    mistakeAnalysis: mistakeAnalysisInput,
                    mistakeStatus: normalizedStatus,
                });
            }
            // 【2026-09-29】成功不再弹窗（他实测："每次保存都跳确认，太啰嗦"）：
            // 反馈改由界面承担 —— 框的橙黄边框复位、「保存 / 取消」按钮消失。
            // ⚠️ **失败提示一律保留**：静默失败比啰嗦更糟。
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.saveFailed || 'Save failed');
        }
    };

    const saveNotes = async () => {
        if (!item) return;

        try {
            await apiClient.patch(`/api/error-items/${item.id}/notes`, { userNotes: notesInput });
            setItem({ ...item, userNotes: notesInput });
            // 【2026-09-29】成功不再弹窗（就是他在截图里报的那条"笔记保存成功"）：
            // 橙黄边框复位 + 保存/取消按钮消失，已经够明确了
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.saveFailed || 'Save failed');
        }
    };

    if (loading) return <div className="p-8 text-center">{t.common.loading}</div>;
    if (!item) return <div className="p-8 text-center">{t.detail.notFound || "Item not found"}</div>;

    /** 【2026-10-01】"深挖了还没印"要不要提醒（题号右边那个计数要不要黄底）—— 判定只有一处 */
    const deepNudge = needsDeepPrintNudge(item);

    // 需求六：AI 重新分析 → 先过审核页，点保存才写回
    if (reanalyzeData) {
        return (
            <main className="min-h-screen bg-background">
                <div className="container mx-auto p-4 space-y-6 pb-20">
                    <CorrectionEditor
                        initialData={reanalyzeData}
                        onSave={handleReanalyzeSave}
                        onCancel={() => setReanalyzeData(null)}
                        imagePreview={item.originalImageUrl || null}
                        initialSubjectId={item.notebookId || undefined}
                    />
                </div>
            </main>
        );
    }

    // 优先从 tags 关联获取，回退到 knowledgePoints
    let tags: string[] = [];
    if (item.tags && item.tags.length > 0) {
        tags = item.tags.map(t => t.name);
    } else if (item.knowledgePoints) {
        try {
            const parsed = JSON.parse(item.knowledgePoints);
            tags = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            tags = [];
        }
    }

    return (
        <main className="min-h-screen bg-background">
            <div className="container mx-auto p-4 space-y-6 pb-20">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div className="flex items-center gap-4">
                        <Link href={item.notebookId ? `/notebooks/${item.notebookId}` : "/notebooks"}>
                            <Button variant="ghost" size="icon">
                                <ArrowLeft className="w-4 h-4" />
                            </Button>
                        </Link>
                        <h1 className="text-2xl font-bold">{t.detail.title}</h1>
                    </div>

                    <div className="flex flex-wrap gap-2 justify-end">
                        {/* 需求六：用原图重新跑 AI，只更新分析类字段 */}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleReanalyze}
                            disabled={isReanalyzing}
                            title={t.detail?.aiReanalyzeHint || ""}
                        >
                            {isReanalyzing ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <Sparkles className="mr-2 h-4 w-4" />
                            )}
                            {isReanalyzing
                                ? (t.detail?.aiReanalyzing || "AI 分析中…")
                                : (t.detail?.aiReanalyze || "AI 重新分析")}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={exportToObsidian}
                            disabled={exportState === "doing"}
                            title="导出到 Obsidian 仓库"
                        >
                            {exportState === "doing" ? "导出中…" : "导出到ob"}
                        </Button>
                        {/* 【custom-v26】单题直通打印：只带这一道的 id 进打印预览（默认错题卡排版）。
                            ⚠️ 必须走 ?ids= 而不是 ?notebookId=：列表接口对 ids 分支不强制 deletedAt，
                            所以回收箱里的题也能单独打出来（扫码跳单题打印走的是同一条路）。 */}
                        <Link href={`/print-preview?ids=${item.id}&mode=card`}>
                            <Button variant="outline" size="sm" title="只打印这一道题">
                                <Printer className="mr-2 h-4 w-4" />
                                打印本题
                            </Button>
                        </Link>
                        {exportState === "ok" && (
                            <span className="self-center text-green-600 text-sm">已导出</span>
                        )}
                        {exportState === "err" && (
                            <span className="self-center text-red-600 text-sm">导出失败</span>
                        )}
                        <Link href={`/practice?id=${item.id}`}>
                            <Button variant="outline" size="sm">
                                <RefreshCw className="mr-2 h-4 w-4" />
                                {t.detail.practice}
                            </Button>
                        </Link>
                        <Button
                            size="sm"
                            variant={item.masteryLevel > 0 ? "default" : "default"}
                            className={item.masteryLevel > 0 ? "bg-green-600 hover:bg-green-700 text-white" : ""}
                            onClick={toggleMastery}
                        >
                            {item.masteryLevel > 0 ? (
                                <>
                                    <CheckCircle className="mr-2 h-4 w-4" />
                                    {t.detail.mastered}
                                </>
                            ) : (
                                <>
                                    <XCircle className="mr-2 h-4 w-4" />
                                    {t.detail.markMastered}
                                </>
                            )}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={deleteItem}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t.detail.delete || "Delete"}
                        </Button>
                    </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                    {/* Left Column: Question & Image */}
                    <div className="space-y-6 min-w-0">
                        <Card>
                            <CardHeader>
                                {/* 【2026-09-30 他要求】原来写「题目」，现在直接写**这道题的题号**
                                    （"反正也知道这是题目，还不如把题号放到上面去 —— 既有科目分类又有录入时间"）。
                                    题号是二维码的锚点，只读。右侧放两个打印次数（只读计数，放这儿正好）。 */}
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <CardTitle className="font-mono text-base">
                                        {item.source || t.detail.question}
                                    </CardTitle>
                                    {/* 【2026-10-01 他要求】「深挖 X | 复练 Y」——
                                        当"类型=深挖 且 深挖打印次数=0"时**底色转黄**（提醒该去印深挖纸了）；
                                        **双击它**表示『这次我知道了』，提醒解除（写 deepNudgeDismissed）。
                                        判定与列表卡片上那个上色的打印机图标**共用同一个函数**。 */}
                                    <span
                                        className={`text-sm font-medium whitespace-nowrap rounded px-1.5 py-0.5 ${deepNudge ? "cursor-pointer" : ""}`}
                                        style={deepNudge ? { background: DEEP_NUDGE_BG } : undefined}
                                        title={deepNudge
                                            ? L(
                                                  "这是深挖题、还没印过深挖纸。去打印一次，或双击这里表示『这次我知道了』。",
                                                  "Deep-dive item not printed yet. Print it, or double-click here to dismiss.",
                                              )
                                            : undefined}
                                        onDoubleClick={() => {
                                            if (!deepNudge) return;
                                            patchMetadata({ deepNudgeDismissed: true });
                                        }}
                                    >
                                        <PrintCounts
                                            deep={item.printCount}
                                            review={item.reviewPrintCount}
                                            compact
                                        />
                                    </span>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {item.originalImageUrl && (
                                    <div
                                        className="cursor-pointer hover:opacity-90 transition-opacity"
                                        onClick={() => setIsImageViewerOpen(true)}
                                        title={t.detail?.clickToView || 'Click to view full image'}
                                    >
                                        <p className="text-sm font-medium mb-2 text-muted-foreground">
                                            {t.detail.originalProblem || "Original Problem"}
                                        </p>
                                        <img
                                            src={item.originalImageUrl}
                                            alt={t.detail.originalProblem || "Original Problem"}
                                            className="w-full rounded-lg border hover:border-primary/50 transition-colors"
                                        />
                                        <p className="text-xs text-muted-foreground mt-1 text-center">
                                            💡 {t.detail?.clickToEnlarge || 'Click to enlarge'}
                                        </p>
                                    </div>
                                )}

                                {/* 【2026-09-29 二次修正】**一直可编辑**（他明确要求不再点"编辑"）：
                                    打开就是渲染好的样子，直接改；**改动后才出现保存/取消**。 */}
                                <MdEditor
                                    value={questionInput}
                                    onChange={setQuestionInput}
                                    placeholder="Enter question text..."
                                    minHeightPx={180}
                                    dirty={dirtyQuestion}
                                />
                                {dirtyQuestion && (
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={saveQuestionHandler}>
                                            <Save className="h-4 w-4 mr-1" />
                                            {t.common?.save || 'Save'}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => setQuestionInput(item?.questionText ?? "")}
                                        >
                                            <X className="h-4 w-4 mr-1" />
                                            {t.common?.cancel || 'Cancel'}
                                        </Button>
                                    </div>
                                )}

                                {/* 知识点标签 */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <h4 className="text-sm font-semibold">{t.editor?.tags || 'Knowledge Tags'}</h4>
                                        {!isEditingTags && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={startEditingTags}
                                            >
                                                <Edit className="h-4 w-4 mr-1" />
                                                {t.common?.edit || 'Edit'}
                                            </Button>
                                        )}
                                    </div>

                                    {isEditingTags ? (
                                        <div className="space-y-3">
                                            <TagInput
                                                value={tagsInput}
                                                onChange={setTagsInput}
                                                placeholder={t.editor?.tagsPlaceholder || 'Enter or select knowledge tags...'}
                                                subject={item.notebook?.subject || undefined}
                                                gradeStage={educationStage}
                                            />
                                            <p className="text-xs text-muted-foreground">
                                                {t.editor?.tagsHint || '💡 Select from standard or custom tags'}
                                            </p>
                                            <div className="flex gap-2">
                                                <Button size="sm" onClick={saveTagsHandler}>
                                                    <Save className="h-4 w-4 mr-1" />
                                                    {t.common?.save || 'Save'}
                                                </Button>
                                                <Button size="sm" variant="outline" onClick={cancelEditingTags}>
                                                    <X className="h-4 w-4 mr-1" />
                                                    {t.common?.cancel || 'Cancel'}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex flex-wrap gap-2">
                                            {tags.map((tag) => (
                                                <Badge key={tag} variant="secondary">
                                                    {tag}
                                                </Badge>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* 试题信息 —— 【2026-09-29】四个可改项（错题本/年级学期/错题等级/错因）
                                    **直接摆成下拉，改即保存**（他定的："不用点击编辑再修改"）。
                                    题号 / 打印次数 / 关注档**只读不改**（题号是二维码的锚，
                                    打印次数由打印动作 +1，关注档暂不开放手改）。
                                    知识点在上一节，仍走"点编辑再改"（他要求不动）。 */}
                                <div className="space-y-2 pt-4 border-t">
                                    <h4 className="text-sm font-semibold">
                                        {t.detail?.questionInfo || 'Question Info'}
                                    </h4>

                                    <div className="space-y-2.5 text-sm">
                                        {/* 我的错题本：改即存（挪本） */}
                                        <div className="flex justify-between items-center gap-3">
                                            <span className="text-muted-foreground whitespace-nowrap">
                                                {t.notebooks?.title || 'Notebook'}:
                                            </span>
                                            <div className="w-[200px] shrink-0">
                                                <NotebookSelector
                                                    value={item.notebookId || undefined}
                                                    onChange={(val) => patchMetadata({ notebookId: val || null })}
                                                />
                                            </div>
                                        </div>

                                        {/* 年级/学期：固定清单下拉；旧数据里清单外的值会作为「原值」补在最后 */}
                                        <div className="flex justify-between items-center gap-3">
                                            <span className="text-muted-foreground whitespace-nowrap">
                                                {t.filter.grade}:
                                            </span>
                                            <Select
                                                value={item.gradeSemester || "__none__"}
                                                onValueChange={(v) =>
                                                    patchMetadata({ gradeSemester: v === "__none__" ? null : v })
                                                }
                                            >
                                                <SelectTrigger className="w-[160px] h-8">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="__none__">
                                                        {t.common?.notSet || 'Not set'}
                                                    </SelectItem>
                                                    {GRADE_SEMESTER_OPTIONS.map((g) => (
                                                        <SelectItem key={g} value={g}>
                                                            {g}
                                                        </SelectItem>
                                                    ))}
                                                    {item.gradeSemester && !GRADE_SEMESTER_OPTIONS.includes(item.gradeSemester) && (
                                                        <SelectItem value={item.gradeSemester}>
                                                            {item.gradeSemester}（原值）
                                                        </SelectItem>
                                                    )}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        {/* 【2026-09-30 换新】错因：**三组八项**（不掌握 / 没做对 / 其他）。
                                            一题只留一个 —— 多个原因同时存在时按优先级取（顺序见 lib/mistake-category）。
                                            改即存；类型还没落定时服务端会按"组 → 类型"派生一次（留痕）。
                                            ⚠️ **删掉了"没打"这一项**（他 2026-09-30 要求："这个'没打'不再作为一个错因了"）
                                              ⇒ 没打错因时下拉显示的是占位文案（灰字），不是一个可选项。
                                            ⚠️ 三个**组标题**改成黑体、**顶格**（他说的是"改黑体字顶格"）：
                                              SelectLabel 默认有缩进（pl-8），这里 pl-0 顶到最左。 */}
                                        <div className="flex justify-between items-center gap-3">
                                            <span className="text-muted-foreground whitespace-nowrap">错因:</span>
                                            <Select
                                                value={normalizeMistakeCategory(item.mistakeCategory) ?? ""}
                                                onValueChange={(v) => patchMetadata({ mistakeCategory: v })}
                                            >
                                                <SelectTrigger className="w-[160px] h-8">
                                                    <SelectValue placeholder="未打错因" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {MISTAKE_GROUPS.map((g) => (
                                                        <SelectGroup key={g.key}>
                                                            <SelectLabel className="pl-0 text-xs font-semibold text-foreground">
                                                                {g.zh}
                                                                {/* 组名后面直接写出它派生出的类型 —— 他定的规则，
                                                                    摆在这儿就不用另开文档解释 */}
                                                                {g.key === "not_mastered"
                                                                    ? " → 深挖"
                                                                    : g.key === "not_right"
                                                                      ? " → 复练"
                                                                      : " → 先不定"}
                                                            </SelectLabel>
                                                            {g.items.map((c) => (
                                                                <SelectItem
                                                                    key={c}
                                                                    value={c}
                                                                    title={MISTAKE_CATEGORY_DESC_ZH[c]}
                                                                >
                                                                    {getMistakeCategoryLabel(c)}
                                                                </SelectItem>
                                                            ))}
                                                        </SelectGroup>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        {/* 【2026-09-30 他要求】「复习类型」→「**类型**」：
                                            "在找到错因的基础上才定类型" ⇒ 所以它排在**错因后面**。
                                            选项顺序 = 深挖 → 复练 → 未定（未定挪到最后），
                                            并且**深挖暗红、复练深绿**（色值取自 MANAGE_TYPE_SCREEN_COLOR，
                                            与列表卡片右下角那个小标签同一处取色）。改即落定（manual），服务端留痕。 */}
                                        <div className="flex justify-between items-center gap-3">
                                            <span className="text-muted-foreground whitespace-nowrap">类型:</span>
                                            <Select
                                                value={item.manageType || "__undecided__"}
                                                onValueChange={(v) =>
                                                    patchMetadata({ manageType: v === "__undecided__" ? null : v })
                                                }
                                            >
                                                <SelectTrigger className="w-[160px] h-8">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {MANAGE_TYPES.map((tp) => (
                                                        <SelectItem
                                                            key={tp}
                                                            value={tp}
                                                            style={{ color: MANAGE_TYPE_SCREEN_COLOR[tp] }}
                                                            className="font-medium"
                                                        >
                                                            {MANAGE_TYPE_LABEL[tp]}
                                                        </SelectItem>
                                                    ))}
                                                    <SelectItem
                                                        value="__undecided__"
                                                        style={{ color: MANAGE_TYPE_UNDECIDED_COLOR }}
                                                    >
                                                        {MANAGE_TYPE_UNDECIDED}
                                                    </SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        {/* 【2026-09-30 他要求】等级也给下拉：🥉青铜 … 👑王者，**选中即存** */}
                                        <div className="flex justify-between items-center gap-3">
                                            <span className="text-muted-foreground whitespace-nowrap">{t.detail.attention}:</span>
                                            <Select
                                                value={String(attentionLevelOf(item.attention).value)}
                                                onValueChange={(v) => patchMetadata({ attention: Number(v) })}
                                            >
                                                <SelectTrigger className="w-[160px] h-8">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {ATTENTION_LEVELS.map((lv) => (
                                                        <SelectItem key={lv.value} value={String(lv.value)}>
                                                            {lv.medal} {lv.zh}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        {/* 【2026-09-30 他要求】把卡片上那**四个复习结果圆圈**纳进详情页，
                                            摆在试题信息栏的最后（等级后面）。
                                            前三行 = 录入日 +1 / +7 / +21 天（写具体日期），最后一行 = 最近一次情况。 */}
                                        <div className="pt-2 border-t">
                                            <ReviewOutcomeEditor
                                                value={item.reviewOutcomes}
                                                createdAt={item.createdAt}
                                                onChange={saveReviewOutcomes}
                                                L={L}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <div className="flex justify-between items-center">
                                    <CardTitle>{t.detail.yourNotes}</CardTitle>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                {/* 一直可编辑（去掉了"编辑"这一步）；改动了才出现保存/取消 */}
                                <MdEditor
                                    value={notesInput}
                                    onChange={setNotesInput}
                                    placeholder={t.detail.notesPlaceholder || "Enter your notes..."}
                                    minHeightPx={110}
                                    dirty={dirtyNotes}
                                />
                                {dirtyNotes && (
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={saveNotes}>
                                            <Save className="h-4 w-4 mr-1" />
                                                    {t.common.save || "Save"}
                                                </Button>
                                                <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => setNotesInput(item?.userNotes ?? "")}
                                        >
                                            <X className="h-4 w-4 mr-1" />
                                            {t.common.cancel || "Cancel"}
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* 【2026-09-30 他要求】**新增「日积月累」栏**，并**挪到「你的笔记/答案」下面**
                            （先留口子，暂不接数据）。将来的用法（他描述的）：孩子的**深挖纸回录**后，
                              ① AI 识别出她具体写了什么 ⇒ 进「错误解答原文 / 你的笔记」那一栏；
                              ② 在这基础上对她这道题与她的分析做总结，形成几句话 ⇒ 进「日积月累」，
                                 并送往**日积月累库**（那张表还没建，等他定了内容再开发）。
                            ⚠️ 所以这一栏现在**刻意不做可编辑输入框** —— 假输入框比空栏更误导人：
                               敲进去的字没地方存。等库定了再接。
                            📌 与「错因分析」的区别一句话：错因分析=AI 讲这题错在哪；
                               日积月累=**从这道题攒下的一句人话**（她的收获）。 */}
                        <Card>
                            <CardHeader>
                                <div className="flex justify-between items-center">
                                    <CardTitle>{language === "zh" ? "日积月累" : "Takeaways"}</CardTitle>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
                                    {language === "zh"
                                        ? "还没有内容。等深挖纸回录接上后，AI 会把她这道题的收获总结成几句话放在这里，并归入「日积月累」。"
                                        : "Nothing yet. Once the deep-dive sheet is scanned back, a few lines summarizing what she learned will appear here."}
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Right Column: Analysis & Answer */}
                    <div className="space-y-6 min-w-0">
                        <Card className="border-primary/20">
                            <CardHeader>
                                <div className="flex justify-between items-center">
                                    <CardTitle className="text-primary">{t.detail.correctAnswer}</CardTitle>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <MdEditor
                                    value={answerInput}
                                    onChange={setAnswerInput}
                                    placeholder="Enter answer..."
                                    minHeightPx={120}
                                    dirty={dirtyAnswer}
                                />
                                {dirtyAnswer && (
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={saveAnswerHandler}>
                                            <Save className="h-4 w-4 mr-1" />
                                            {t.common?.save || 'Save'}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => setAnswerInput(item?.answerText ?? "")}
                                        >
                                            <X className="h-4 w-4 mr-1" />
                                            {t.common?.cancel || 'Cancel'}
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <div className="flex justify-between items-center">
                                    <CardTitle>{t.detail.analysis}</CardTitle>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <MdEditor
                                    value={analysisInput}
                                    onChange={setAnalysisInput}
                                    placeholder="Enter analysis..."
                                    minHeightPx={260}
                                    dirty={dirtyAnalysis}
                                />
                                {dirtyAnalysis && (
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={saveAnalysisHandler}>
                                            <Save className="h-4 w-4 mr-1" />
                                            {t.common?.save || 'Save'}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => setAnalysisInput(item?.analysis ?? "")}
                                        >
                                            <X className="h-4 w-4 mr-1" />
                                            {t.common?.cancel || 'Cancel'}
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <div className="flex justify-between items-center">
                                    <CardTitle>{t.detail?.mistakeAnalysis || '错因分析'}</CardTitle>
                                </div>
                            </CardHeader>
                            {/* 【2026-09-30 他要求】这一栏**去掉「作答状态」**（那张截图里的下拉），
                                并且错因已经挪到上面的「试题信息」栏里按三组八项选。
                                这里只留：错误解答原文 + 错因分析。 */}
                            <CardContent className="space-y-4">
                                <div className="space-y-4">
                                        <div className="space-y-2">
                                            <label className="text-sm text-muted-foreground">{t.editor?.wrongAnswerText || '错误解答原文'}</label>
                                            <MdEditor
                                                value={wrongAnswerInput}
                                                onChange={setWrongAnswerInput}
                                                minHeightPx={110}
                                                dirty={dirtyWrongAnswer}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm text-muted-foreground">{t.editor?.mistakeAnalysis || '错因分析'}</label>
                                            <MdEditor
                                                value={mistakeAnalysisInput}
                                                onChange={setMistakeAnalysisInput}
                                                minHeightPx={170}
                                                dirty={dirtyMistakeAnalysis}
                                            />
                                        </div>
                                        {(dirtyWrongAnswer || dirtyMistakeAnalysis) && (
                                            <div className="flex gap-2">
                                                <Button size="sm" onClick={saveMistakeHandler}>
                                                    <Save className="h-4 w-4 mr-1" />
                                                    {t.common?.save || 'Save'}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => {
                                                        setWrongAnswerInput(item?.wrongAnswerText ?? "");
                                                        setMistakeAnalysisInput(item?.mistakeAnalysis ?? "");
                                                        setMistakeStatusInput(item?.mistakeStatus || "unknown");
                                                    }}
                                                >
                                                    <X className="h-4 w-4 mr-1" />
                                                    {t.common?.cancel || 'Cancel'}
                                                </Button>
                                            </div>
                                        )}
                                </div>
                            </CardContent>
                        </Card>
                        {/* 操作按钮 */}

                    </div>
                </div>
            </div>

            {/* Image Viewer Modal */}
            {
                isImageViewerOpen && item?.originalImageUrl && (
                    <div
                        className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
                        onClick={() => setIsImageViewerOpen(false)}
                    >
                        <div className="relative max-w-7xl max-h-full">
                            <button
                                className="absolute -top-12 right-0 text-white hover:text-gray-300 text-lg font-semibold bg-black/50 px-4 py-2 rounded"
                                onClick={() => setIsImageViewerOpen(false)}
                            >
                                {t.detail?.close || '✕ Close'}
                            </button>
                            <img
                                src={item.originalImageUrl}
                                alt="Full size"
                                className="max-w-full max-h-[90vh] object-contain rounded-lg"
                                onClick={(e) => e.stopPropagation()}
                            />
                            <p className="text-center text-white/70 text-sm mt-4">
                                {t.detail?.clickOutside || 'Click outside to close'}
                            </p>
                        </div>
                    </div>
                )
            }
        </main >
    );
}
