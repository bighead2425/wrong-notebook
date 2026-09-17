"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, Copy, X } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";

interface NotebookAnalyzeDialogProps {
    notebookId: string;
    notebookName: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

interface PackResponse {
    notebook: { id: string; displayName: string; meta: string };
    count: number;
    packed: string;
}

/**
 * 本集 AI 分析（#15 / T9）
 *
 * 流程：打包本里「未掌握」的题（题号 + 知识点 + 错因）→ 家长可在框里改 →
 *       ① 提交分析：连 AI，输出薄弱点 / 能力欠缺 / 下一步建议
 *       ② 复制    ：提示词 + 内容进剪贴板，方便丢给别的 AI
 *       ③ 取消
 *
 * 只收未软删、masteryLevel < 2 的题——已经会了的题不该再占用分析注意力（原则⑤）。
 */
export function NotebookAnalyzeDialog({
    notebookId, notebookName, open, onOpenChange,
}: NotebookAnalyzeDialogProps) {
    const { t, language } = useLanguage();
    const zh = language === "zh";
    const L = (a: string, b: string) => (zh ? a : b);

    const [content, setContent] = useState("");
    const [count, setCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open || !notebookId) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            setResult(null);
            setError(null);
            try {
                const data = await apiClient.get<PackResponse>(`/api/notebooks/${notebookId}/analyze`);
                if (!cancelled) {
                    setContent(data.packed);
                    setCount(data.count);
                }
            } catch (e) {
                console.error(e);
                if (!cancelled) setError(L("打包失败", "Failed to pack analysis"));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [open, notebookId]);

    const handleAnalyze = async () => {
        setAnalyzing(true);
        setError(null);
        setResult(null);
        try {
            const data = await apiClient.post<{ result: string }>(
                `/api/notebooks/${notebookId}/analyze`,
                { content },
                { timeout: 180000 },
            );
            setResult(data.result);
        } catch (e: any) {
            console.error(e);
            setError(e?.data?.message || L("分析失败，请检查 AI 配置", "Analysis failed — check AI settings"));
        } finally {
            setAnalyzing(false);
        }
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            alert(L("已复制到剪贴板", "Copied to clipboard"));
        } catch {
            alert(L("复制失败，请手动选择文本复制", "Copy failed — please select and copy manually"));
        }
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="bg-background border rounded-lg shadow-xl w-full max-w-3xl max-h-[88vh] flex flex-col">
                <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                    <div className="min-w-0">
                        <h2 className="text-base font-semibold truncate">
                            {L("本集 AI 分析", "Notebook AI analysis")} · {notebookName}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {L("只打包未掌握的题", "Only unmastered items")} · {count} {L("题", "items")}
                        </p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {loading ? (
                        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t.common.loading}
                        </div>
                    ) : (
                        <>
                            <label className="text-xs text-muted-foreground">
                                {L("可以改，改完再提交", "Editable before submitting")}
                            </label>
                            <textarea
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                rows={12}
                                className="w-full rounded-md border bg-background p-3 font-mono text-xs leading-relaxed resize-y"
                            />

                            {error && (
                                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                    {error}
                                </div>
                            )}

                            {result && (
                                <div className="rounded-md border bg-muted/30 p-4">
                                    <div className="text-sm font-semibold mb-2">
                                        {L("分析结果", "Analysis")}
                                    </div>
                                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">
                                        {result}
                                    </pre>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {L("取消", "Cancel")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleCopy} disabled={loading || !content}>
                        <Copy className="mr-1.5 h-4 w-4" />
                        {L("复制", "Copy")}
                    </Button>
                    <Button size="sm" onClick={handleAnalyze} disabled={loading || analyzing || !content.trim()}>
                        {analyzing
                            ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            : <Sparkles className="mr-1.5 h-4 w-4" />}
                        {analyzing ? L("分析中…", "Analyzing…") : L("提交分析", "Analyze")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
