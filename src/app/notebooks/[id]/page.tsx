"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { ChevronLeft, ChevronRight, House, Pencil, Printer, Sparkles, ArchiveRestore } from "lucide-react";
import Link from "next/link";
import { ErrorList } from "@/components/error-list";
import { EditNotebookDialog, type EditNotebookPayload } from "@/components/edit-notebook-dialog";
import { NotebookAnalyzeDialog } from "@/components/notebook-analyze-dialog";

import { Notebook } from "@/types/api";
import { apiClient } from "@/lib/api-client";

import { useLanguage } from "@/contexts/LanguageContext";

// ... imports

export default function NotebookDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { t, language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);
    const [notebook, setNotebook] = useState<Notebook | null>(null);

    /**
     * 【2026-10-03 他要求】"上一个 / 下一个错题本"要按**我的错题本页**里的顺序来，
     * 所以这里拉同一份列表，按它在数组里的位置取前后。
     * 拿不到（接口失败/没权限）就整组按钮不显示 —— 导航是锦上添花，不能挡路。
     */
    const [siblingIds, setSiblingIds] = useState<string[]>([]);
    /** 【2026-10-12 需求第 9 条】同一份列表顺带留下"现有名字"，给重调整对话框当场拦重名 */
    const [siblingNames, setSiblingNames] = useState<string[]>([]);
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await apiClient.get<{ notebooks?: Notebook[] } | Notebook[]>("/api/notebooks");
                const list = Array.isArray(res) ? res : res.notebooks || [];
                if (alive) {
                    setSiblingIds(list.map((n) => n.id));
                    setSiblingNames(list.map((n) => n.displayName));
                }
            } catch {
                if (alive) {
                    setSiblingIds([]);
                    setSiblingNames([]);
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    /** 我在列表里的位置 ⇒ 前后各是谁（找不到位置或到头了就是 null ⇒ 按钮置灰） */
    const myIndex = siblingIds.indexOf(String(params.id));
    const prevNotebookId = myIndex > 0 ? siblingIds[myIndex - 1] : null;
    const nextNotebookId =
        myIndex >= 0 && myIndex < siblingIds.length - 1 ? siblingIds[myIndex + 1] : null;
    const [loading, setLoading] = useState(true);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const [analyzeOpen, setAnalyzeOpen] = useState(false);
    /**
     * 【2026-09-30】页头那句「共 XX 道错题，当前选中 YY 道题」的两个数 ——
     * 由 `ErrorList` 报上来（它才知道"筛选后还剩几道"）：
     *   total         = 当前筛选后剩多少道
     *   notebookTotal = 这本一共多少道（不带筛选）
     */
    const [counts, setCounts] = useState<{ total: number; notebookTotal: number | null } | null>(null);

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

    /**
     * 【2026-10-12 需求第 9 条】这里也从"只改名字"换成「重调整」（四字段 + 名字都能改）。
     * 与「我的错题本」页那个笔按钮打开的是**同一个**对话框 —— 一处改样、两处一致。
     */
    const handleSaveEdit = async (payload: EditNotebookPayload) => {
        if (!notebook) return;
        const updated = await apiClient.put<Notebook>(`/api/notebooks/${notebook.id}`, payload);
        setNotebook(updated);
        setSiblingNames((prev) => prev.map((n) => (n === notebook.displayName ? updated.displayName : n)));
    };

    /** B15：按本拉回（归档粒度在 Notebook，题不自持归档位） */
    const handleUnarchive = async () => {
        if (!notebook) return;
        await apiClient.put<Notebook>(`/api/notebooks/${notebook.id}`, { archiveStatus: "active" });
        setNotebook({ ...notebook, archiveStatus: "active" });
    };

    /**
     * 【2026-10-19 空空第 1 条】**「复练」入口已删除**（右上角那个按钮他说用不上）。
     *
     * 原来这里还有个 `openReviewVolumes()`，带着本子的年级+学科跳 `/review-volumes`。
     * 按钮没了，它就成了一块没人调的代码 —— 一并删掉，别留"看起来还有入口"的假象。
     * 复练卷页本身照旧能从主页进（`/review-volumes`），只是不再从"某一本错题本"里带筛选跳过去。
     */

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
                    <div className="flex-1 min-w-0">
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
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {/* 【2026-10-19 空空第 1 条】**右上角只留返回主页**。
                            他原话："右上角有一个『复练』的按钮，这个按钮其实有点用不上，所以把这个按钮取消吧。
                            并且把右上角的『印新录入』『AI分析』两个按钮，向下调整，放到
                            共 XX 道、选中 XX 道、小于号、大于号这一行，并放在靠右的位置。"
                            ⇒ 三个按钮（打印本册未打印 / AI 分析 / 复练）全搬走，
                              前两个移到下面那一行的右侧，复练**直接删掉**。 */}
                        <Link href="/">
                            <Button variant="ghost" size="icon">
                                <House className="h-5 w-5" />
                            </Button>
                        </Link>
                    </div>
                </div>

                {/* 【2026-09-30 他要求】计数单独占一整行（原来夹在标题与按钮之间，窄屏被挤成两行很难看），
                    文案也缩短成「共 XX 道，选中 YY 道」。
                    XX = 整个错题本的总量（不带筛选，服务端算）；YY = 当前筛选后还剩几道。
                    数据还没回来时退回原来的样子，不闪空。 */}
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-muted-foreground text-sm">
                        {counts && counts.notebookTotal !== null
                            ? (t.notebooks?.totalErrorsSelected || "Total {total} · {selected} shown")
                                .replace("{total}", counts.notebookTotal.toString())
                                .replace("{selected}", counts.total.toString())
                            : (t.notebooks?.totalErrors || "Total {count} errors").replace("{count}", (notebook._count?.errorItems || 0).toString())}
                    </p>
                    {/* 【2026-10-03 他要求】在这一本里直接跳到**上一本 / 下一本**。
                        原话："点击后进入我的错题本页中这个错题本所在位置的上一个/下一个错题本"。
                        ⇒ 顺序必须与"我的错题本页"看到的一致 ⇒ 拉**同一份列表**、按数组位置取前后。
                        拿不到列表（接口失败）就整组不显示，不挡路。 */}
                    {siblingIds.length > 1 && (
                        <div className="flex items-center gap-1">
                            <Button
                                variant="outline"
                                size="icon-sm"
                                disabled={!prevNotebookId}
                                title={L('上一个错题本', 'Previous notebook')}
                                onClick={() => prevNotebookId && router.push(`/notebooks/${prevNotebookId}`)}
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                                variant="outline"
                                size="icon-sm"
                                disabled={!nextNotebookId}
                                title={L('下一个错题本', 'Next notebook')}
                                onClick={() => nextNotebookId && router.push(`/notebooks/${nextNotebookId}`)}
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    )}
                    {/* 【2026-10-19 空空第 1 条】原来在右上角的两个按钮搬到这里，**靠右**。
                        `ml-auto` 把它推到这一行最右边；与"上一本 / 下一本"那组之间靠容器 `gap-2`
                        拉开距离（他要求"和小于号、大于号中间留有距离"）。
                        手机上只用图标（这一行本来就不宽，带文字会挤成两行）。 */}
                    <div className="ml-auto flex items-center gap-2">
                        {/* #10 三级打印 · 第 2 级：只打这一本里还没打过的 */}
                        <Button
                            variant="secondary"
                            size="sm"
                            className="hidden sm:flex"
                            onClick={() => router.push(`/print-preview?notebookId=${notebook.id}&unprinted=1`)}
                        >
                            <Printer className="mr-2 h-4 w-4" />
                            {t.notebooks?.printThisUnprinted || "打印本册未打印"}
                        </Button>
                        <Button
                            variant="secondary"
                            size="icon"
                            className="sm:hidden"
                            title={t.notebooks?.printThisUnprinted || "打印本册未打印"}
                            onClick={() => router.push(`/print-preview?notebookId=${notebook.id}&unprinted=1`)}
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

                <ErrorList
                    notebookId={notebook.id}
                    subjectName={notebook.displayName}
                    /* 【2026-09-30】把"筛完还剩几道 / 这本一共几道"报上来，给页头那句话用 */
                    onCountChange={setCounts}
                />

                <EditNotebookDialog
                    open={renameDialogOpen}
                    onOpenChange={setRenameDialogOpen}
                    notebook={notebook}
                    existingNames={siblingNames.filter((n) => n !== notebook.displayName)}
                    onSave={handleSaveEdit}
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
