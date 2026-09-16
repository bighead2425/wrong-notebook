"use client";

import { useState } from "react";
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

export interface CreateNotebookPayload {
    displayName: string;
    gradeStage: string;
    grade: string;
    semester: string;
    subject: string;
}

interface CreateNotebookDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (payload: CreateNotebookPayload) => Promise<void>;
}

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function CreateNotebookDialog({ open, onOpenChange, onCreate }: CreateNotebookDialogProps) {
    const [gradeStage, setGradeStage] = useState("primary");
    const [grade, setGrade] = useState("五年级");
    const [semester, setSemester] = useState("上");
    const [subject, setSubject] = useState("math");
    const [displayName, setDisplayName] = useState("");
    const [nameTouched, setNameTouched] = useState(false);
    const [loading, setLoading] = useState(false);
    const { t } = useLanguage();

    // 显示名：用户没手动改过就跟着四字段自动更新（如 "小五上数学"）
    const autoName = buildDisplayName({ gradeStage, grade, semester, subject });
    const effectiveName = nameTouched ? displayName : autoName;

    const reset = () => {
        setGradeStage("primary");
        setGrade("五年级");
        setSemester("上");
        setSubject("math");
        setDisplayName("");
        setNameTouched(false);
    };

    const handleCreate = async () => {
        if (!effectiveName.trim()) {
            alert(t.notebooks?.dialog?.enterName || "Please enter notebook name");
            return;
        }

        setLoading(true);
        try {
            await onCreate({
                displayName: effectiveName.trim(),
                gradeStage,
                grade,
                semester,
                subject,
            });
            reset();
            onOpenChange(false);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const grades = GRADES_BY_STAGE[gradeStage] || GRADES_BY_STAGE.primary;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t.notebooks?.dialog?.title || "Create New Notebook"}</DialogTitle>
                    <DialogDescription>
                        {t.notebooks?.dialog?.desc || "一本教科书 = 一个错题本，如「小五上数学」"}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label htmlFor="nb-stage">学段</Label>
                            <select
                                id="nb-stage"
                                className={selectClass}
                                value={gradeStage}
                                onChange={(e) => {
                                    setGradeStage(e.target.value);
                                    // 学段切换后年级列表变了，重置为该学段第一个年级
                                    setGrade((GRADES_BY_STAGE[e.target.value] || [])[0]?.key || "");
                                }}
                            >
                                {GRADE_STAGE_OPTIONS.map(o => (
                                    <option key={o.key} value={o.key}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="nb-grade">年级</Label>
                            <select
                                id="nb-grade"
                                className={selectClass}
                                value={grade}
                                onChange={(e) => setGrade(e.target.value)}
                            >
                                {grades.map(o => (
                                    <option key={o.key} value={o.key}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="nb-semester">学期</Label>
                            <select
                                id="nb-semester"
                                className={selectClass}
                                value={semester}
                                onChange={(e) => setSemester(e.target.value)}
                            >
                                {SEMESTER_OPTIONS.map(o => (
                                    <option key={o.key} value={o.key}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="nb-subject">学科</Label>
                            <select
                                id="nb-subject"
                                className={selectClass}
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                            >
                                {SUBJECT_OPTIONS.map(o => (
                                    <option key={o.key} value={o.key}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="name">
                            {t.notebooks?.dialog?.nameLabel || "Notebook Name"}
                        </Label>
                        <Input
                            id="name"
                            placeholder={autoName}
                            value={effectiveName}
                            onChange={(e) => {
                                setNameTouched(true);
                                setDisplayName(e.target.value);
                            }}
                            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                        />
                        <p className="text-xs text-muted-foreground">
                            默认按四字段自动生成，可改成任何好记的名字
                        </p>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t.common.cancel}
                    </Button>
                    <Button onClick={handleCreate} disabled={loading || !effectiveName.trim()}>
                        {loading ? (t.notebooks?.dialog?.creating || "Creating...") : (t.notebooks?.dialog?.create || "Create")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
