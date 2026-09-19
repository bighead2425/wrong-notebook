"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Plus, House, Trash2, Printer, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { NotebookCard } from "@/components/notebook-card";
import { CreateNotebookDialog, type CreateNotebookPayload } from "@/components/create-notebook-dialog";
import { RenameNotebookDialog } from "@/components/rename-notebook-dialog";
import { buildNotebookMeta } from "@/lib/notebook-fields";

import { Notebook } from "@/types/api";
import { apiClient } from "@/lib/api-client";

import { useLanguage } from "@/contexts/LanguageContext";

// ... imports

export default function NotebooksPage() {
    const router = useRouter();
    const { t } = useLanguage(); // Use hook
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [renameTarget, setRenameTarget] = useState<Notebook | null>(null);

    /**
     * 【custom-v25 已归档改为"按需读取"】
     *
     * 归档本会随学期越积越多，而日常几乎只在动当前学期的本。
     * 从前每次进本页都把它们一并读出来（还要为每本数行数），
     * 以后越来越慢且毫无必要 —— 现在**默认根本不请求归档本**，
     * 点了「已归档 ▾」才去读一次。
     * 接口侧配合：GET /api/notebooks 默认只返回非归档，`?archived=1` 才只要归档的。
     */
    const [archivedBooks, setArchivedBooks] = useState<Notebook[]>([]);
    const [archivedExpanded, setArchivedExpanded] = useState(false);
    const [archivedLoading, setArchivedLoading] = useState(false);

    useEffect(() => {
        fetchNotebooks();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fetchNotebooks = async () => {
        try {
            const data = await apiClient.get<Notebook[]>("/api/notebooks");
            setNotebooks(data);
            // 归档区若正展开着，顺手刷一下 —— 否则刚「拉回在用」的那本会在归档区里阴魂不散
            if (archivedExpanded) void fetchArchived();
        } catch (error) {
            console.error("Failed to fetch notebooks:", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchArchived = async () => {
        setArchivedLoading(true);
        try {
            const data = await apiClient.get<Notebook[]>("/api/notebooks?archived=1");
            setArchivedBooks(data);
        } catch (error) {
            console.error("Failed to fetch archived notebooks:", error);
        } finally {
            setArchivedLoading(false);
        }
    };

    const toggleArchived = () => {
        const next = !archivedExpanded;
        setArchivedExpanded(next);
        // 「不展开就不读」的落点就在这一句
        if (next) void fetchArchived();
    };

    const handleCreate = async (payload: CreateNotebookPayload) => {
        try {
            await apiClient.post("/api/notebooks", payload);
            await fetchNotebooks();
        } catch (error: any) {
            console.error(error);
            const message = error.data?.message || t.notebooks?.createError || "Failed to create";
            alert(message);
        }
    };

    const handleRename = async (name: string) => {
        if (!renameTarget) return;
        await apiClient.put(`/api/notebooks/${renameTarget.id}`, { displayName: name });
        setRenameTarget(null);
        await fetchNotebooks();
    };

    const handleDelete = async (id: string, errorCount: number, name: string) => {
        if (errorCount > 0) {
            alert(t.notebooks?.deleteNotEmpty || "Please clear all items in this notebook first.");
            return;
        }
        if (!confirm((t.notebooks?.deleteConfirm || "Are you sure?").replace("{name}", name))) return;

        try {
            await apiClient.delete(`/api/notebooks/${id}`);
            await fetchNotebooks();
        } catch (error: any) {
            console.error(error);
            const message = error.data?.message || t.notebooks?.deleteError || "Failed to delete";
            alert(message);
        }
    };

    const handleArchiveToggle = async (id: string) => {
        // 【custom-v25】两个列表都要找：归档区里的本**不在** notebooks 里
        // （接口默认只返回非归档）。只查 notebooks 的话，归档卡片上的「拉回在用」会静默失效。
        const nb = notebooks.find(n => n.id === id) ?? archivedBooks.find(n => n.id === id);
        if (!nb) return;
        const toArchived = nb.archiveStatus !== "archived";
        if (toArchived && !confirm(`${t.notebooks?.archiveConfirm || "Archive"}「${nb.displayName}」？`)) return;
        try {
            await apiClient.put(`/api/notebooks/${id}`, {
                archiveStatus: toArchived ? "archived" : "active",
            });
            await fetchNotebooks();
        } catch (error: any) {
            console.error(error);
            alert(error?.data?.message || t.notebooks?.archiveError || "Failed to archive");
        }
    };

    const handleNotebookClick = (id: string) => {
        router.push(`/notebooks/${id}`);
    };

    // H2 四分法：在用本 / 已归档本分开摆，归档的本仍可见（否则拉不回来）
    const activeBooks = notebooks.filter(n => n.archiveStatus !== "archived");
    // 【custom-v25】归档本不再由这份列表里筛 —— 它单独按需拉取（见 archivedBooks 状态）

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    return (
        <main className="min-h-screen p-4 md:p-8 bg-background">
            <div className="max-w-6xl mx-auto space-y-8">
                <div className="flex items-start gap-4">
                    <BackButton fallbackUrl="/" />
                    <div className="flex-1 space-y-1">
                        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t.notebooks?.title || "My Notebooks"}</h1>
                        <p className="text-muted-foreground text-sm sm:text-base">
                            {t.notebooks?.subtitle || "Manage your mistakes by subject"}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {/*
                          回收箱入口（【custom-v24】按用户要求改造）
                          ① 原来的纯图标按钮换成「图标 + 回收箱」三个字，一眼能认出是去哪。
                          ② 图标从 ArchiveRestore 换成 Trash2 —— ArchiveRestore 是「盒子+回退箭头」，
                             在别处已经承担「拉回在用（取消归档）」的意思，同一个页面上两个语义撞车，
                             用户说「尽量给岔开」。垃圾桶图标是「丢弃/暂存」的通用语义，不会误读成还原。
                          ③ 页面里归档横幅的「拉回在用」仍是 ArchiveRestore，两者从此泾渭分明。
                        */}
                        <Link href="/trash">
                            <Button variant="outline" size="sm" title={t.notebooks?.trash || "回收箱"}>
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t.notebooks?.trash || "回收箱"}
                            </Button>
                        </Link>
                        <Button onClick={() => setDialogOpen(true)} size="sm" className="hidden sm:flex">
                            <Plus className="mr-2 h-4 w-4" />
                            {t.notebooks?.create || "New Notebook"}
                        </Button>
                        <Button onClick={() => setDialogOpen(true)} size="icon" className="sm:hidden">
                            <Plus className="h-4 w-4" />
                        </Button>
                        <Link href="/">
                            <Button variant="ghost" size="icon">
                                <House className="h-5 w-5" />
                            </Button>
                        </Link>
                    </div>
                </div>

                {/* #10 三级打印 · 第 1 级：所有本里还没打印过的题 */}
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => router.push("/print-preview?unprinted=1&mode=card")}
                    >
                        <Printer className="mr-2 h-4 w-4" />
                        {t.notebooks?.printAllUnprinted || "打印所有未打印"}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        {t.notebooks?.printAllHint || "把各本里从没打过的题一次打成错题卡"}
                    </p>
                </div>

                {notebooks.length === 0 ? (
                    <div className="text-center py-12 border-2 border-dashed rounded-lg">
                        <p className="text-muted-foreground mb-4">
                            {t.notebooks?.empty || "No notebooks yet."}
                        </p>
                        <Button onClick={() => setDialogOpen(true)}>
                            <Plus className="mr-2 h-4 w-4" />
                            {t.notebooks?.createFirst || "Create Notebook"}
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-8">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {activeBooks.map((notebook) => (
                                <NotebookCard
                                    key={notebook.id}
                                    id={notebook.id}
                                    displayName={notebook.displayName}
                                    meta={buildNotebookMeta(notebook)}
                                    archived={false}
                                    errorCount={notebook._count?.errorItems || 0}
                                    onClick={() => handleNotebookClick(notebook.id)}
                                    onRename={() => setRenameTarget(notebook)}
                                    onToggleArchive={handleArchiveToggle}
                                    onDelete={() => handleDelete(notebook.id, notebook._count?.errorItems || 0, notebook.displayName)}
                                    itemLabel={t.notebooks?.items || "items"}
                                />
                            ))}
                        </div>

                        {/*
                          【custom-v25】已归档改成折叠区块：
                            · 默认**不读取**归档本（连请求都不发），点箭头才去读；
                            · 箭头方向即状态：收起是 ▾、展开是 ▴；
                            · 展开过再收起**不重新读**，数据留着，来回点不折腾接口。
                        */}
                        <div className="space-y-3">
                            <button
                                type="button"
                                onClick={toggleArchived}
                                aria-expanded={archivedExpanded}
                                className="flex items-center gap-2 text-left rounded-md px-1 py-1 hover:bg-accent/50 transition-colors"
                            >
                                <h2 className="text-lg font-semibold">{t.notebooks?.archived || "已归档"}</h2>
                                {archivedExpanded
                                    ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                                    : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                                <span className="text-xs text-muted-foreground">
                                    {archivedExpanded
                                        ? (t.notebooks?.archivedHint || "点书本上的图标可以拉回在用")
                                        : (t.notebooks?.archivedCollapsedHint || "点一下才读取已归档的错题本")}
                                </span>
                            </button>

                            {archivedExpanded && (
                                archivedLoading ? (
                                    <p className="text-sm text-muted-foreground pl-1">{t.common.loading}</p>
                                ) : archivedBooks.length === 0 ? (
                                    <p className="text-sm text-muted-foreground pl-1">
                                        {t.notebooks?.archivedEmpty || "还没有归档的错题本"}
                                    </p>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {archivedBooks.map((notebook) => (
                                            <NotebookCard
                                                key={notebook.id}
                                                id={notebook.id}
                                                displayName={notebook.displayName}
                                                meta={buildNotebookMeta(notebook)}
                                                archived
                                                errorCount={notebook._count?.errorItems || 0}
                                                onClick={() => handleNotebookClick(notebook.id)}
                                                onRename={() => setRenameTarget(notebook)}
                                                onToggleArchive={handleArchiveToggle}
                                                onDelete={() => handleDelete(notebook.id, notebook._count?.errorItems || 0, notebook.displayName)}
                                                itemLabel={t.notebooks?.items || "items"}
                                            />
                                        ))}
                                    </div>
                                )
                            )}
                        </div>
                    </div>
                )}

                <CreateNotebookDialog
                    key={t.common.loading} // Force re-render when language changes
                    open={dialogOpen}
                    onOpenChange={setDialogOpen}
                    onCreate={handleCreate}
                />

                <RenameNotebookDialog
                    open={!!renameTarget}
                    onOpenChange={(open) => { if (!open) setRenameTarget(null); }}
                    currentName={renameTarget?.displayName || ""}
                    onRename={handleRename}
                />
            </div >
        </main >
    );
}
