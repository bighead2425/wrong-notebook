"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Plus, House, Pencil, Printer, Sparkles, ArchiveRestore } from "lucide-react";
import Link from "next/link";
import { ErrorList } from "@/components/error-list";
import { RenameNotebookDialog } from "@/components/rename-notebook-dialog";
import { NotebookAnalyzeDialog } from "@/components/notebook-analyze-dialog";

import { Notebook } from "@/types/api";
import { apiClient } from "@/lib/api-client";

import { useLanguage } from "@/contexts/LanguageContext";

// ... imports

export default function NotebookDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { t } = useLanguage();
    const [notebook, setNotebook] = useState<Notebook | null>(null);
    const [loading, setLoading] = useState(true);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const [analyzeOpen, setAnalyzeOpen] = useState(false);

    useEffect(() => {
        if (params.id) {
            fetchNotebook(params.id as string);
        }
    }, [params.id]);

    const fetchNotebook = async (id: string) => {
        try {
            const data = await apiClient.get<Notebook>(`/api/notebooks/${id}`);
            setNotebook(data);
        } catch (error) {
            console.error("Failed to fetch notebook:", error);
            alert(t.notebooks?.notFound || "Notebook not found");
            router.push("/notebooks");
        } finally {
            setLoading(false);
        }
    };

    const handleRename = async (name: string) => {
        if (!notebook) return;
        const updated = await apiClient.put<Notebook>(`/api/notebooks/${notebook.id}`, { displayName: name });
        setNotebook(updated);
    };

    /** B15：按本拉回（归档粒度在 Notebook，题不自持归档位） */
    const handleUnarchive = async () => {
        if (!notebook) return;
        await apiClient.put<Notebook>(`/api/notebooks/${notebook.id}`, { archiveStatus: "active" });
        setNotebook({ ...notebook, archiveStatus: "active" });
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    if (!notebook) return null;

    return (
        <main className="min-h-screen p-4 md:p-8 bg-background">
            <div className="max-w-6xl mx-auto space-y-6 md:space-y-8">
                <div className="flex items-start gap-4">
                    <BackButton fallbackUrl="/notebooks" className="shrink-0" />
                    <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight truncate">{notebook.displayName}</h1>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => setRenameDialogOpen(true)}
                                title={t.notebooks?.rename || "Rename"}
                            >
                                <Pencil className="h-4 w-4" />
                            </Button>
                        </div>
                        <p className="text-muted-foreground text-sm sm:text-base">
                            {(t.notebooks?.totalErrors || "Total {count} errors").replace("{count}", (notebook._count?.errorItems || 0).toString())}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {/* #10 三级打印 · 第 2 级：只打这一本里还没打过的 */}
                        <Button
                            variant="secondary"
                            size="sm"
                            className="hidden sm:flex"
                            onClick={() => router.push(`/print-preview?notebookId=${notebook.id}&unprinted=1&mode=card`)}
                        >
                            <Printer className="mr-2 h-4 w-4" />
                            {t.notebooks?.printThisUnprinted || "打印本册未打印"}
                        </Button>
                        <Button
                            variant="secondary"
                            size="icon"
                            className="sm:hidden"
                            title={t.notebooks?.printThisUnprinted || "打印本册未打印"}
                            onClick={() => router.push(`/print-preview?notebookId=${notebook.id}&unprinted=1&mode=card`)}
                        >
                            <Printer className="h-4 w-4" />
                        </Button>

                        {/* #15 本集 AI 分析 */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="hidden sm:flex"
                            onClick={() => setAnalyzeOpen(true)}
                        >
                            <Sparkles className="mr-2 h-4 w-4" />
                            {t.notebooks?.aiAnalyze || "AI 分析"}
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            className="sm:hidden"
                            title={t.notebooks?.aiAnalyze || "AI 分析"}
                            onClick={() => setAnalyzeOpen(true)}
                        >
                            <Sparkles className="h-4 w-4" />
                        </Button>

                        <Link href={`/notebooks/${notebook.id}/add`}>
                            <Button size="sm" className="hidden sm:flex">
                                <Plus className="mr-2 h-4 w-4" />
                                {t.notebooks?.addError || "Add Error"}
                            </Button>
                            <Button size="icon" className="sm:hidden">
                                <Plus className="h-4 w-4" />
                            </Button>
                        </Link>
                        <Link href="/">
                            <Button variant="ghost" size="icon">
                                <House className="h-5 w-5" />
                            </Button>
                        </Link>
                    </div>
                </div>

                {notebook.archiveStatus === "archived" && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                        <span className="text-sm">
                            {t.notebooks?.archivedBanner || "这本已归档：里面的题不在主库出现，但仍然可以打开查看。"}
                        </span>
                        <Button variant="outline" size="sm" onClick={handleUnarchive}>
                            <ArchiveRestore className="mr-1.5 h-4 w-4" />
                            {t.notebooks?.unarchive || "拉回在用"}
                        </Button>
                    </div>
                )}

                <ErrorList notebookId={notebook.id} subjectName={notebook.displayName} />

                <RenameNotebookDialog
                    open={renameDialogOpen}
                    onOpenChange={setRenameDialogOpen}
                    currentName={notebook.displayName}
                    onRename={handleRename}
                />

                <NotebookAnalyzeDialog
                    notebookId={notebook.id}
                    notebookName={notebook.displayName}
                    open={analyzeOpen}
                    onOpenChange={setAnalyzeOpen}
                />
            </div>
        </main>
    );
}
