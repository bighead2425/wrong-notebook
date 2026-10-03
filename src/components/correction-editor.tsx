"use client";

import { useState, useEffect, useRef } from "react";
import { ParsedQuestion } from "@/lib/ai";
import { calculateGrade } from "@/lib/grade-calculator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Save, RefreshCw, Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { frontendLogger } from "@/lib/frontend-logger";
import { MdEditor } from "@/components/md-editor";
import { TagInput } from "@/components/tag-input";
import { NotebookSelector } from "@/components/notebook-selector";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";
import { UserProfile, Notebook } from "@/types/api";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { normalizeMistakeStatusForSave, type MistakeStatus } from "@/lib/mistake-status";
import {
    MANAGE_TYPES,
    MANAGE_TYPE_DEFAULT,
    MANAGE_TYPE_LABEL,
    MANAGE_TYPE_SCREEN_COLOR,
    MANAGE_TYPE_UNDECIDED,
    MANAGE_TYPE_UNDECIDED_COLOR,
    type ManageType,
} from "@/lib/manage-type";
import type { ReanswerQuestionResult } from "@/lib/ai/types";
import { buildReanswerRequestBody } from "@/lib/reanswer-request";

export interface ParsedQuestionWithSubject extends ParsedQuestion {
    notebookId?: string;
    gradeSemester?: string;
    /** 【2026-10-03】错题等级：deep 深挖 / review 复练 / null 未定（对应后端 manageType 字段） */
    manageType?: ManageType | null;
    source?: string;
}

interface CorrectionEditorProps {
    initialData: ParsedQuestion;
    onSave: (data: ParsedQuestionWithSubject) => Promise<void>;
    onCancel: () => void;
    imagePreview?: string | null;
    initialSubjectId?: string;
    aiTimeout?: number;
}

type ReanswerErrorMessages = {
    default?: string;
    authError?: string;
    connectionFailed?: string;
    responseError?: string;
};

export function CorrectionEditor({ initialData, onSave, onCancel, imagePreview, initialSubjectId, aiTimeout }: CorrectionEditorProps) {
    const [data, setData] = useState<ParsedQuestionWithSubject>({
        ...initialData,
        wrongAnswerText: initialData.wrongAnswerText || "",
        mistakeAnalysis: initialData.mistakeAnalysis || "",
        mistakeStatus: initialData.mistakeStatus || "unknown",
        notebookId: initialSubjectId,
        gradeSemester: "",
        /**
         * 【2026-10-03】下拉默认显示 **复练**（项目里"录入默认 = 复练"这条 L0 规则）。
         * ⚠️ 只是**显示**默认：用户没动过就不把这个字段提交出去，
         *    让后端照旧走"录入默认（复练）/ 来源 = default"——这样以后在详情页打错因时，
         *    等级还能按错因自动派生。用户一旦动过，才算"手动定级"提交。
         *    （见下方 manageTypeTouchedRef）
         */
        manageType: MANAGE_TYPE_DEFAULT,
        source: ""
    });
    const { t, language } = useLanguage();
    /** 本页新文案的双语助手（与列表页 / 详情页同一写法，不再往 translations 里塞碎键） */
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);
    const [isReanswering, setIsReanswering] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    /**
     * 【2026-10-03】用户是否**主动改过**错题等级。
     * 没改 ⇒ 提交时不带 manageType（保持后端 default 语义，将来可被错因派生改写）；
     * 改过 ⇒ 带上（含"未定"= null），后端记为手动落定。
     */
    const manageTypeTouchedRef = useRef(false);

    const [educationStage, setEducationStage] = useState<string | undefined>(undefined);
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);

    // 标记题号是否被用户手动改过；手动改过则不再自动覆盖（即使切换学科）
    const sourceEditedRef = useRef(false);



    // Fetch user info and calculate grade on mount
    useEffect(() => {
        // Fetch notebooks for mapping
        apiClient.get<Notebook[]>("/api/notebooks")
            .then(setNotebooks)
            .catch(err => console.error("Failed to fetch notebooks:", err));

        apiClient.get<UserProfile>("/api/user")
            .then(user => {
                // 年级学期缺省：优先用 localStorage 记忆值（填一次后续自动沿用），
                // 否则回退到根据教育阶段/入学年份自动推算
                const savedGrade = typeof window !== 'undefined'
                    ? localStorage.getItem('wn_default_gradeSemester')
                    : null;
                if (savedGrade) {
                    setData(prev => ({ ...prev, gradeSemester: savedGrade }));
                } else if (user && user.educationStage && user.enrollmentYear) {
                    const grade = calculateGrade(user.educationStage, user.enrollmentYear, new Date(), language);
                    setData(prev => ({ ...prev, gradeSemester: grade }));
                }
                if (user?.educationStage) setEducationStage(user.educationStage);
            })
            .catch(err => console.error("Failed to fetch user info for grade calculation:", err));
    }, [language]);

    // 题号自动填充：学科(notebookId)确定且用户未手动改过时，向后台取下一个题号预览
    useEffect(() => {
        if (!data.notebookId) return;
        if (sourceEditedRef.current) return; // 用户已手动填写则不覆盖
        const notebook = notebooks.find(n => n.id === data.notebookId);
        // 5.5：学科码直接读 Notebook.subject（subjectKey），不再从显示名反推
        // data.subject 是 AI 给的中文名（如"数学"），仅在本未指定时兜底
        const subjectKey = notebook?.subject
            || inferSubjectFromName(data.subject || null)
            || undefined;
        const subjectName = notebook?.displayName || undefined;
        const qs = new URLSearchParams();
        if (subjectKey) qs.set("subjectKey", subjectKey);
        if (subjectName) qs.set("subjectName", subjectName);
        apiClient.get<{ questionNo: string }>(`/api/error-items/next-question-no?${qs.toString()}`)
            .then(res => {
                if (res?.questionNo) setData(prev => ({ ...prev, source: res.questionNo }));
            })
            .catch(() => { /* 预览失败不影响保存，后端会兜底生成 */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data.notebookId, notebooks]);

    // 重新解题函数
    const handleReanswer = async () => {
        if (!data.questionText.trim()) {
            alert(t.editor.enterQuestionFirst || 'Please enter question text first');
            return;
        }

        setIsReanswering(true);
        try {
            const requestBody = buildReanswerRequestBody({
                questionText: data.questionText,
                language,
                subject: data.subject,
                imagePreview,
                gradeSemester: data.gradeSemester,
            });

            if (requestBody.imageBase64) {
                console.log("[Reanswer] Sending image + text (Image available for mistake analysis)");
            } else {
                console.log("[Reanswer] Sending text only (No image available)");
            }

            frontendLogger.info('[Reanswer]', 'Sending request', { timeout: aiTimeout });

            const result = await apiClient.post<ReanswerQuestionResult>("/api/reanswer", requestBody, { timeout: aiTimeout || 180000 });

            setData(prev => ({
                ...prev,
                answerText: result.answerText,
                analysis: result.analysis,
                knowledgePoints: result.knowledgePoints,
                wrongAnswerText: result.wrongAnswerText || "",
                mistakeAnalysis: result.mistakeAnalysis || "",
                mistakeStatus: normalizeMistakeStatusForSave(
                    result.mistakeStatus,
                    result.wrongAnswerText
                ),
            }));

            alert(t.editor.reanswerSuccess || '✅ Answer and analysis updated!');
        } catch (error: unknown) {
            console.error("Reanswer failed:", error);
            const apiError = error as { data?: { message?: string } };
            const msg = apiError.data?.message || '';

            const reanswerErrors: ReanswerErrorMessages = t.errors?.reanswer || {};
            let errorText = reanswerErrors.default || 'Reanswer failed';

            if (msg.includes('AI_AUTH_ERROR')) {
                errorText = reanswerErrors.authError || t.errors?.AI_AUTH_ERROR || errorText;
            } else if (msg.includes('AI_CONNECTION_FAILED')) {
                errorText = reanswerErrors.connectionFailed || t.errors?.AI_CONNECTION_FAILED || errorText;
            } else if (msg.includes('AI_RESPONSE_ERROR')) {
                errorText = reanswerErrors.responseError || t.errors?.AI_RESPONSE_ERROR || errorText;
            }

            alert(errorText);

        } finally {
            setIsReanswering(false);
        }
    };


    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold">{t.editor.title}</h2>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={onCancel}>
                        {t.editor.cancel}
                    </Button>
                    <Button
                        onClick={async () => {
                            if (!data.notebookId) {
                                alert(t.editor.messages?.selectNotebook || "Please select a notebook");
                                return;
                            }
                            if (isSaving) return; // 防止重复点击
                            setIsSaving(true);
                            try {
                                // 记忆年级学期：保存一次后成为缺省，下次自动沿用，直到再次修改
                                if (typeof window !== 'undefined') {
                                    localStorage.setItem('wn_default_gradeSemester', data.gradeSemester || "");
                                }
                                const payload: ParsedQuestionWithSubject = {
                                    ...data,
                                    mistakeStatus: normalizeMistakeStatusForSave(
                                        data.mistakeStatus,
                                        data.wrongAnswerText
                                    ),
                                };
                                // 用户没动过等级 ⇒ 不带这个字段（保持后端"录入默认"的语义，
                                // 而不是把它记成"手动定级"、让以后按错因自动派生失效）。
                                if (!manageTypeTouchedRef.current) {
                                    delete payload.manageType;
                                }
                                await onSave(payload);
                            } finally {
                                setIsSaving(false);
                            }
                        }}
                        disabled={isSaving}
                    >
                        {isSaving ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                            <Save className="mr-2 h-4 w-4" />
                        )}
                        {isSaving ? (t.common?.pleaseWait || "Please wait...") : t.editor.save}
                    </Button>
                </div>
            </div>

            <div className="space-y-6">
                {/* 左侧：编辑区 */}
                <div className="space-y-6">
                    {imagePreview && (
                        <Card>
                            <CardContent className="p-4">
                                <img src={imagePreview} alt="Original" className="w-full rounded-md" />
                            </CardContent>
                        </Card>
                    )}

                    <div className="space-y-2">
                        <Label>{t.editor.selectNotebook || "Select Notebook"}</Label>
                        <NotebookSelector
                            value={data.notebookId}
                            onChange={(id) => setData({ ...data, notebookId: id })}
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label>{t.editor.gradeSemester || "Grade/Semester"}</Label>
                            <Input
                                value={data.gradeSemester || ""}
                                onChange={(e) => setData({ ...data, gradeSemester: e.target.value })}
                                placeholder="e.g. Junior High Grade 1, 1st Semester"
                            />
                        </div>
                        <div className="space-y-2">
                            {/* 【2026-10-03 他要求】原「所属卷等级」(A卷/B卷/其他) 改成**错题等级**：
                                深挖 / 复练 / 未定，存到后端 manageType（deep / review / null）。
                                选项色值复用 lib/manage-type.ts（与列表卡片小标签同一处取色）。 */}
                            <Label>{L("错题等级", "Question level")}</Label>
                            <Select
                                value={data.manageType ?? "__undecided__"}
                                onValueChange={(val) => {
                                    manageTypeTouchedRef.current = true;
                                    setData({
                                        ...data,
                                        manageType: val === "__undecided__" ? null : (val as ManageType),
                                    });
                                }}
                            >
                                <SelectTrigger>
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
                </div>

                <div className="space-y-2">
                    <Label>题号（自动生成，可手动修改）</Label>
                    <Input
                        value={data.source || ""}
                        onChange={(e) => {
                            sourceEditedRef.current = true;
                            setData({ ...data, source: e.target.value });
                        }}
                        placeholder="如 sx20260912001"
                    />
                    <p className="text-xs text-muted-foreground">
                        格式：学科简拼 + 8位日期 + 3位当日流水；将用作二维码 / 文件名跳转错题页。
                    </p>
                </div>

                <div className="space-y-2">
                    <Label>{t.editor.question}</Label>
                        {/* 【2026-09-29】所见即所得：编辑即渲染，右栏预览整个去掉 */}
                        <MdEditor
                            value={data.questionText}
                            onChange={(md) => setData({ ...data, questionText: md })}
                            minHeightPx={150}
                        />
                        <Button
                            variant="default"
                            size="sm"
                            onClick={handleReanswer}
                            disabled={isReanswering || !data.questionText.trim()}
                            className="w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-medium"
                        >
                            {isReanswering ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    {t.editor.reanswering || 'AI solving...'}
                                </>
                            ) : (
                                <>
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                    {t.editor.reanswer || '🔄 Reanswer (based on corrected question)'}
                                </>
                            )}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            {t.editor.reanswerHint || '💡 If the question was misrecognized, correct it and click to regenerate answer'}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label>{t.editor.tags}</Label>
                        <TagInput
                            value={data.knowledgePoints}
                            onChange={(tags) => setData({ ...data, knowledgePoints: tags })}
                            placeholder={t.editor.tagsPlaceholder || "Enter knowledge tags..."}
                            enterHint={t.editor.createTagHint}
                            subject={notebooks.find(n => n.id === data.notebookId)?.subject || inferSubjectFromName(data.subject || null) || undefined}
                            gradeStage={educationStage}
                        />
                        <p className="text-xs text-muted-foreground">
                            {t.editor.tagsHint || "💡 Tag suggestions will appear as you type"}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label>{t.editor.answer}</Label>
                        <MdEditor
                            value={data.answerText}
                            onChange={(md) => setData({ ...data, answerText: md })}
                            minHeightPx={110}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label>{t.editor.analysis}</Label>
                        <MdEditor
                            value={data.analysis}
                            onChange={(md) => setData({ ...data, analysis: md })}
                            minHeightPx={200}
                        />
                    </div>

                    <Card>
                        <CardHeader>
                            <CardTitle>{t.editor.mistakeAnalysisTitle || "错因分析"}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>{t.editor.mistakeStatus || "作答状态"}</Label>
                                <Select
                                    value={data.mistakeStatus || "unknown"}
                                    onValueChange={(val) => setData({ ...data, mistakeStatus: val as MistakeStatus })}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="not_attempted">{t.editor.mistakeStatuses?.notAttempted || "不会做"}</SelectItem>
                                        <SelectItem value="wrong_attempt">{t.editor.mistakeStatuses?.wrongAttempt || "做错了"}</SelectItem>
                                        <SelectItem value="unknown">{t.editor.mistakeStatuses?.unknown || "未判断"}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label>{t.editor.wrongAnswerText || "错误解答原文"}</Label>
                                <MdEditor
                                    value={data.wrongAnswerText || ""}
                                    onChange={(md) => setData({
                                        ...data,
                                        wrongAnswerText: md,
                                        mistakeStatus: md.trim() ? "wrong_attempt" : data.mistakeStatus,
                                    })}
                                    minHeightPx={110}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>{t.editor.mistakeAnalysis || "错因分析"}</Label>
                                <MdEditor
                                    value={data.mistakeAnalysis || ""}
                                    onChange={(md) => setData({
                                        ...data,
                                        mistakeAnalysis: md,
                                    })}
                                    minHeightPx={140}
                                />
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* 右侧：预览区 */}
{/* 【2026-09-29】右栏预览已删：编辑器本身所见即所得（他拍板）。 */}
            </div>
        </div>
    );
}
