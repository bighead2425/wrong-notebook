"use client";

import { useEffect, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { useLanguage } from "@/contexts/LanguageContext";
import {
    SUBJECT_OPTIONS,
    GRADE_STAGE_OPTIONS,
    GRADES_BY_STAGE,
    SEMESTER_OPTIONS,
    buildDisplayName,
} from "@/lib/notebook-fields";
import type { Notebook } from "@/types/api";

/**
 * 「重调整错题本」（2026-10-12 需求第 9 条）。
 *
 * 他原话："错题卡上有重命名错题本这个按钮（一支笔标识），点击打开重命名错题本对话框，
 *          这个框的内容需要修改，改为与我的错题本下点击左上角新建错题本跳出的对话框相似，
 *          标题为『重调整错题本』，下面有当前学段、年级、学期、学科、错题本名称……
 *          如果更新的错题本名称和当前已有错题本名称重名，则跳出提示不予更新。"
 *
 * ── 与「新建」那版刻意**不同**的一处：名字不再自动跟着四字段跑 ──────────────
 * 新建时名字默认由四字段拼（"小五上数学"），用户没碰过就跟着改。
 * 这里是**改一本已经存在的本**：它现在的名字完全可能是他自己起的（如"数学"），
 * 一进来就把输入框显示成"小上数学"、一保存就悄悄改名 —— 那是我们不能接受的
 * （他只会看到"我什么都没改，名字怎么变了"）。
 * 所以：**名字初始就是现在这个名字**，只有他自己动手才会变；
 * 旁边留一个「按上面四项重新生成」的小按钮，想用自动名时点一下就行（显式，不猜）。
 *
 * ⚠️ 重名两道拦：这里先用传进来的 `existingNames` 拦一次（当场看得见），
 *    服务端 PUT 还会再拦一次（并发/绕过时兜底，返回 409）。
 */
export interface EditNotebookPayload {
    displayName: string;
    gradeStage: string;
    grade: string;
    semester: string;
    subject: string;
}

interface EditNotebookDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** 要调整的那一本（null = 不渲染内容） */
    notebook: Notebook | null;
    /** 当前页面已有的本名（用于本地重名拦截；不含正在编辑的这一本） */
    existingNames?: string[];
    onSave: (payload: EditNotebookPayload) => Promise<void>;
}

const selectClass =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function EditNotebookDialog({
    open,
    onOpenChange,
    notebook,
    existingNames = [],
    onSave,
}: EditNotebookDialogProps) {
    const { t, language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [gradeStage, setGradeStage] = useState("primary");
    const [grade, setGrade] = useState("");
    const [semester, setSemester] = useState("上");
    const [subject, setSubject] = useState("math");
    const [displayName, setDisplayName] = useState("");
    const [loading, setLoading] = useState(false);

    /** 每次打开都按这本**现在的**四字段 + 名字重置一遍（不残留上一次编辑） */
    useEffect(() => {
        if (!open || !notebook) return;
        setGradeStage(notebook.gradeStage || "primary");
        setGrade(notebook.grade || "");
        setSemester(notebook.semester || "上");
        setSubject(notebook.subject || "math");
        setDisplayName(notebook.displayName || "");
        setLoading(false);
    }, [open, notebook]);

    const grades = GRADES_BY_STAGE[gradeStage] || GRADES_BY_STAGE.primary;

    const handleSave = async () => {
        const name = displayName.trim();
        if (!name) {
            alert(t.notebooks?.dialog?.enterName || "Please enter notebook name");
            return;
        }
        /** 本地先拦一次重名：当场告诉他，而不是等接口回来弹一句"更新失败" */
        if (name !== notebook?.displayName && existingNames.includes(name)) {
            alert(L(`已经有一本叫「${name}」了，换个名字。`, `A notebook named "${name}" already exists.`));
            return;
        }

        setLoading(true);
        try {
            await onSave({ displayName: name, gradeStage, grade, semester, subject });
            onOpenChange(false);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{L("重调整错题本", "Re-adjust notebook")}</DialogTitle>
                    <DialogDescription>
                        {L(
                            "改的是这本自己的属性：学段 / 年级 / 学期 / 学科 / 名字。里面的题不用动 —— 它们跟着这本走。",
                            "Adjust this notebook's own attributes. Its questions follow automatically.",
                        )}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label htmlFor="edit-nb-stage">学段</Label>
                            <select
                                id="edit-nb-stage"
                                className={selectClass}
                                value={gradeStage}
                                onChange={(e) => {
                                    setGradeStage(e.target.value);
                                    setGrade((GRADES_BY_STAGE[e.target.value] || [])[0]?.key || "");
                                }}
                            >
                                {GRADE_STAGE_OPTIONS.map((o) => (
                                    <option key={o.key} value={o.key}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="edit-nb-grade">年级</Label>
                            <select
                                id="edit-nb-grade"
                                className={selectClass}
                                value={grade}
                                onChange={(e) => setGrade(e.target.value)}
                            >
                                {/* 老数据有 grade 为空串（默认本"数学""语文"）⇒ 给一个空选项，不硬塞一个年级 */}
                                {!grades.some((o) => o.key === grade) && <option value={grade}>{grade || "（未设年级）"}</option>}
                                {grades.map((o) => (
                                    <option key={o.key} value={o.key}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="edit-nb-semester">学期</Label>
                            <select
                                id="edit-nb-semester"
                                className={selectClass}
                                value={semester}
                                onChange={(e) => setSemester(e.target.value)}
                            >
                                {SEMESTER_OPTIONS.map((o) => (
                                    <option key={o.key} value={o.key}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="edit-nb-subject">学科</Label>
                            <select
                                id="edit-nb-subject"
                                className={selectClass}
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                            >
                                {SUBJECT_OPTIONS.map((o) => (
                                    <option key={o.key} value={o.key}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                            <Label htmlFor="edit-nb-name">
                                {t.notebooks?.dialog?.nameLabel || "Notebook Name"}
                            </Label>
                            {/* 想用"四字段自动拼"的名字时显式点一下 —— 不替他自动改名（见文件头） */}
                            <button
                                type="button"
                                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                                onClick={() => setDisplayName(buildDisplayName({ gradeStage, grade, semester, subject }))}
                            >
                                {L("按上面四项重新生成", "Regenerate from fields")}
                            </button>
                        </div>
                        <Input
                            id="edit-nb-name"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleSave()}
                        />
                    </div>

                    {/* 题号绝不改 —— 他 2026-10-12 需求第 10 条把这条定成了前置条件 */}
                    <p className="text-xs text-muted-foreground">
                        {L(
                            "⚠️ 里面每道题的题号不会变（题号是一道题从录入到销毁的身份证，组卷快照靠它才对得上）。",
                            "Question numbers never change — printed-volume snapshots depend on them.",
                        )}
                    </p>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t.common.cancel}
                    </Button>
                    <Button onClick={handleSave} disabled={loading || !displayName.trim()}>
                        {loading ? L("更新中…", "Updating…") : L("更新", "Update")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
