"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Plus, House, Trash2, Printer, ChevronDown, ChevronUp, FolderOpen, Merge } from "lucide-react";
import Link from "next/link";
import { NotebookCard } from "@/components/notebook-card";
import { CreateNotebookDialog, type CreateNotebookPayload } from "@/components/create-notebook-dialog";
import { EditNotebookDialog, type EditNotebookPayload } from "@/components/edit-notebook-dialog";
import { buildNotebookMeta, gradeRankOf } from "@/lib/notebook-fields";

import { Notebook } from "@/types/api";
import { apiClient } from "@/lib/api-client";

import { useLanguage } from "@/contexts/LanguageContext";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-10-12 需求第 6 / 7 / 8 / 9 / 11 / 12 条】「我的错题本」这一页
 * ══════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 【2026-10-12 晚 · 操作方式**推倒重来**，别再往回改】
 *
 * 中午那版想的是"拖动排序 + 双击并入"，当天晚上他实测后**否掉了**，原话：
 *   "我在电脑端单击卡片，进不去错题本；双击错题卡，卡片没有反应；只有拖拽卡片能够调整顺序，
 *    为了一个小功能反而将大功能耽误了……在手机端单击卡片能够进入错题本，
 *    双击能够唤起合并但同时也进入错题本了，拖拽没有反应。我分析了一下操作逻辑，
 *    这样下去不行，双击合并与拖拽排序，不是常见操作，因为这些操作相互影响甚至无法进入错题本，
 *    这个风险就太大了。"
 *
 * ⇒ 现在**只用三个按钮**，单击回到"最跟手"的那个动作：
 *   ① 卡片右下角 **↖** = 往前挪一位；
 *   ② 卡片右下角 **↘** = 往后挪一位；
 *   ③ 卡片右下角 **合并键** = 顶上原来的"双击选目标本"：点它 ⇒ 这张变黄框（已选中）
 *      ⇒ **再点另一张卡片**（不用点它的按钮，整张卡都算）就把这张并进那一张；
 *      **再点自己这张** = 取消。
 *
 * 📌 留给以后的教训（一句话）：**"单击"是这一页的主干道，任何新交互都不许跟它抢。**
 *    拖动要吃掉按下与移动，双击要吃掉第一次单击 —— 两样都会把主干道堵死。
 *
 * 不变的三条：
 *   · 排序 / 并入 都**只改"挂在哪一本"**，一个字都不碰**题号**（他第 10 条的前置条件：
 *     题号是题从录入到销毁的身份证，组卷快照 `VolumeItem` 全靠它才对得上）；
 *   · 排序**不许跨组**：在用的只能在在用组里挪，已归档只能在**同一个年级**里挪（第 12 条）；
 *   · 已归档**不参与并入**（界面不给按钮，服务端也拦一道）。
 *
 *  ④ **已归档按年级分组**（第 12 条）：像"根目录下的文件夹"，里面按**年级倒序**排，
 *     同年级的卡片放在一起；组内可挪、跨组不行。
 */

/**
 * 接口抛出来的"那句话"。
 *
 * `apiClient` 失败时抛的是**它自己拼的对象**（带 `data.message`），不是 `Error`；
 * 而 TS 的 `catch` 变量是 `unknown`。原来这一页到处写 `catch (error)` 图省事，
 * 那是 `no-explicit-any`（本项目 lint 门禁里唯一的 error 级规则，**只许减不许增**）。
 * 收成一个函数：类型说清楚，也不用每处再 `any` 一遍。
 */
function apiMessageOf(error: unknown): string | undefined {
    if (error && typeof error === "object" && "data" in error) {
        const data = (error as { data?: unknown }).data;
        if (data && typeof data === "object" && "message" in data) {
            const message = (data as { message?: unknown }).message;
            if (typeof message === "string" && message) return message;
        }
    }
    return undefined;
}

export default function NotebooksPage() {
    const router = useRouter();
    const { t, language } = useLanguage(); // Use hook
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    /** 【2026-10-12 第 9 条】改成了"重调整错题本"（四字段 + 名字都能改），不再是只改名字 */
    const [editTarget, setEditTarget] = useState<Notebook | null>(null);
    /** 【第 7 条】双击选中的"目标本"（要并进别人、自己会被删掉的那一本） */
    const [mergeSource, setMergeSource] = useState<Notebook | null>(null);

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
        } catch (error) {
            console.error(error);
            const message = apiMessageOf(error) || t.notebooks?.createError || "Failed to create";
            alert(message);
        }
    };

    /**
     * 【第 9 条】重调整：四字段 + 显示名一起提交。
     *
     * ⚠️ 题不用动。每道题只记了"我挂在哪一本"（`notebookId`），
     *    年级 / 学期 / 学科这些**都从本上取**（列表副标题、学科配色都是这么来的）⇒
     *    改本 = 题的信息自动跟着变，不存在"要挨个改题"的第二步。
     *    回收箱里的题同理（它们也挂着同一个 notebookId）。
     *    唯一**刻意不动**的是**题号**：见文件头第 ③ 条。
     */
    const handleSaveEdit = async (payload: EditNotebookPayload) => {
        if (!editTarget) return;
        try {
            const updated = await apiClient.put<Notebook>(`/api/notebooks/${editTarget.id}`, payload);
            setNotebooks((prev) => prev.map((n) => (n.id === updated.id ? { ...n, ...updated } : n)));
            setArchivedBooks((prev) => prev.map((n) => (n.id === updated.id ? { ...n, ...updated } : n)));
            setEditTarget(null);
        } catch (error) {
            console.error(error);
            // 服务端重名会回 409（本地也拦了一道，这里是并发/绕过时的兜底）
            alert(apiMessageOf(error) || L("更新失败，请重试", "Failed to update"));
            throw error;
        }
    };

    const handleDelete = async (id: string, errorCount: number, name: string) => {
        if (errorCount > 0) {
            alert(t.notebooks?.deleteNotEmpty || "Please clear all items in this notebook first.");
            return;
        }
        /**
         * 【第 8 条】空本可以直接删了 —— 回收箱里若还有这本的题，
         * 服务端会**先真删那几道、再删本**（见 `api/notebooks/[id]` DELETE）。
         * 所以这句确认必须说清"回收箱里那几道也会被一起清掉"，
         * 不能让他以为只是把空壳挪走。
         */
        if (!confirm(
            L(
                `删除「${name}」？\n\n回收箱里从这本删掉的题也会被一并彻底清除。`,
                `Delete "${name}"? Items from it that are still in the trash will be purged too.`,
            ),
        )) return;

        try {
            const res = await apiClient.delete<{ message?: string; purgedItems?: number }>(`/api/notebooks/${id}`);
            if (res?.purgedItems) {
                alert(L(`已删除「${name}」，并顺带彻底清除了回收箱里 ${res.purgedItems} 道来自这本的题。`,
                    `Deleted "${name}" and purged ${res.purgedItems} trashed item(s) from it.`));
            }
            await fetchNotebooks();
        } catch (error) {
            console.error(error);
            const message = apiMessageOf(error) || t.notebooks?.deleteError || "Failed to delete";
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
            /** 挪了窝 ⇒ 那个"目标本"选中态就没意义了，顺手清掉（免得他对着一个看不见的本发愣） */
            if (mergeSource?.id === id) setMergeSource(null);
            await fetchNotebooks();
        } catch (error) {
            console.error(error);
            alert(apiMessageOf(error) || t.notebooks?.archiveError || "Failed to archive");
        }
    };

    // H2 四分法：在用本 / 已归档本分开摆，归档的本仍可见（否则拉不回来）
    const activeBooks = notebooks.filter(n => n.archiveStatus !== "archived");
    // 【custom-v25】归档本不再由这份列表里筛 —— 它单独按需拉取（见 archivedBooks 状态）

    /**
     * 【第 12 条】已归档按**年级**分组，组间**年级倒序**（六年级在前、一年级在后），
     * 认不出年级的（老数据空串）落进最后那个"未设年级"组。
     * 组内顺序就是接口给的顺序（`sortOrder asc, createdAt desc`）—— 拖动会改写它。
     */
    const archivedGroups = useMemo(() => {
        const map = new Map<string, Notebook[]>();
        for (const nb of archivedBooks) {
            const key = nb.grade || "";
            const list = map.get(key);
            if (list) list.push(nb);
            else map.set(key, [nb]);
        }
        return [...map.entries()]
            .map(([grade, list]) => ({ grade, list }))
            .sort((a, b) => gradeRankOf(b.grade) - gradeRankOf(a.grade));
    }, [archivedBooks]);

    /** 改名字时用来当场拦重名的"现有名字表"（两边的本都算上） */
    const allNames = useMemo(
        () => [...notebooks, ...archivedBooks].map(n => n.displayName),
        [notebooks, archivedBooks],
    );

    // ============ 【第 6 条 · 他 10-12 晚改的方案】排序改成两个箭头按钮 ============

    /**
     * 这一张属于哪个组 —— 决定"往前一位 / 往后一位"能在**哪一段范围**里换位。
     *   · 在用的本：整个"在用"那一堆；
     *   · 已归档：**同一个年级**那一组（他第 12 条：同年级内可调、跨年级不行）。
     */
    const groupIdsOf = (nb: Notebook): string[] =>
        nb.archiveStatus === "archived"
            ? (archivedGroups.find(g => (g.grade || "") === (nb.grade || ""))?.list ?? []).map(n => n.id)
            : activeBooks.map(n => n.id);

    /** 先把界面上那一组按新顺序摆好（立刻看到效果），接口在后台追 */
    const applyOrderLocally = (orderedIds: string[]) => {
        const reorder = (list: Notebook[]) => {
            const byId = new Map(list.map(n => [n.id, n]));
            const picked = orderedIds.map(id => byId.get(id)).filter((n): n is Notebook => !!n);
            const rest = list.filter(n => !orderedIds.includes(n.id));
            return [...picked, ...rest];
        };
        setNotebooks(reorder);
        setArchivedBooks(reorder);
    };

    /** 把这一组的顺序存回去（整组重写 0..n-1，理由见接口注释） */
    const persistOrder = async (orderedIds: string[]) => {
        applyOrderLocally(orderedIds);
        try {
            await apiClient.post("/api/notebooks/reorder", { ids: orderedIds });
        } catch (error) {
            console.error(error);
            alert(L("顺序没保存成功，已恢复原样", "Failed to save the new order"));
            await fetchNotebooks();
            if (archivedExpanded) await fetchArchived();
        }
    };

    /**
     * 往前 / 往后挪**一位**（`dir = -1` 往前、`1` 往后）—— 只和紧挨着的那一张换位。
     *
     * ⚠️ 顺序的唯一真相是后端那一列 `sortOrder`：界面先动、接口在后台追，
     *    失败就整组刷回来（见 `persistOrder` 的 catch）。
     * ⚠️ 到头了什么都不做（第一张不能再往前、最后一张不能再往后）。按钮本身也会
     *    `disabled`，这里再兜一道，免得以后别处调用踩空。
     */
    const moveInGroup = (nb: Notebook, dir: -1 | 1) => {
        const group = groupIdsOf(nb);
        const i = group.indexOf(nb.id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= group.length) return;
        const next = [...group];
        [next[i], next[j]] = [next[j], next[i]];
        void persistOrder(next);
    };

    // ===================== 【第 7 条】双击并入 =====================

    const doMerge = async (from: Notebook, to: Notebook) => {
        const fromCount = from._count?.errorItems ?? 0;
        if (!confirm(
            L(
                `是否将「${from.displayName}」（${fromCount} 道题）全部融入「${to.displayName}」？\n\n` +
                `融入后「${from.displayName}」这本会被删除；里面每道题的**题号都不会变**。\n` +
                `（回收箱里来自这本的题也会一起并过去）`,
                `Merge "${from.displayName}" (${fromCount} items) into "${to.displayName}"? ` +
                `"${from.displayName}" will be deleted. Question numbers never change.`,
            ),
        )) return;

        try {
            const res = await apiClient.post<{ movedItems?: number; movedTrashItems?: number }>(
                "/api/notebooks/merge",
                { fromId: from.id, toId: to.id },
            );
            setMergeSource(null);
            await fetchNotebooks();
            if (archivedExpanded) await fetchArchived();
            alert(L(
                `已把「${from.displayName}」并进「${to.displayName}」，共 ${res?.movedItems ?? 0} 道题` +
                (res?.movedTrashItems ? `（其中 ${res.movedTrashItems} 道在回收箱里，也一并并过来了）` : "") + "。",
                `Merged into "${to.displayName}" (${res?.movedItems ?? 0} items).`,
            ));
        } catch (error) {
            console.error(error);
            alert(apiMessageOf(error) || L("并入失败，请重试", "Merge failed"));
        }
    };

    /**
     * 点右下角那个「合并」键：没选中就选中它；**已经选中的就是"取消"**。
     * （他第 3 条：`点击后替代目前双击错题本卡片的操作，……如果还点击这个卡片则取消合并`。）
     */
    const toggleMergeArmed = (nb: Notebook) => {
        /** 已归档不参与（他第 7 条写的"已归档卡片不能双击"；按钮上同理，这里兜一道） */
        if (nb.archiveStatus === "archived") return;
        setMergeSource(prev => (prev?.id === nb.id ? null : nb));
    };

    /**
     * 单击卡片。
     *
     * 【他 10-12 晚的原话，这段注释是留给以后的我的】
     *   "我在电脑端单击卡片，进不去错题本；双击错题卡，卡片没有反应；只有拖拽卡片能够调整顺序，
     *    为了一个小功能反而将大功能耽误了……双击合并与拖拽排序，不是常见操作，
     *    因为这些操作相互影响甚至无法进入错题本，这个风险就太大了。"
     *
     * ⇒ **拖动与双击全部拆掉**，单击**立刻**进本子（原来为了给双击让路还压了 220ms，
     *   现在不需要了 —— 单击必须是最跟手的那个动作）。
     * ⇒ 但"正在选目标本"时例外：那一下子是**并入**、不是进本子（他自己定的：
     *    "在此基础上用户再点击一下其他卡片，就可以进行合并"）。
     */
    const handleCardClick = (nb: Notebook) => {
        if (mergeSource) {
            if (mergeSource.id === nb.id) setMergeSource(null); // 点自己 = 取消
            else void doMerge(mergeSource, nb);
            return;
        }
        router.push(`/notebooks/${nb.id}`);
    };

    /** 卡片上唯一那个临时外观：**被选为"要并进去"的目标本 ⇒ 黄框** */
    const cardStateClass = (nb: Notebook) =>
        mergeSource?.id === nb.id ? "ring-2 ring-amber-400 border-amber-400 bg-amber-50" : "";

    const renderCard = (notebook: Notebook, archived: boolean) => {
        /** 这一张在它那一组里的位置 —— 决定两个箭头能不能按（到头就置灰） */
        const group = groupIdsOf(notebook);
        const idx = group.indexOf(notebook.id);
        return (
            <NotebookCard
                key={notebook.id}
                id={notebook.id}
                displayName={notebook.displayName}
                meta={buildNotebookMeta(notebook)}
                archived={archived}
                errorCount={notebook._count?.errorItems || 0}
                className={cardStateClass(notebook)}
                onClick={() => handleCardClick(notebook)}
                onRename={() => setEditTarget(notebook)}
                onToggleArchive={handleArchiveToggle}
                onDelete={() => handleDelete(notebook.id, notebook._count?.errorItems || 0, notebook.displayName)}
                itemLabel={t.notebooks?.items || "items"}
                /* 【第 1 条】学科色（染图标 + 左侧色带）—— 颜色表来自 subject-colors，与本子属性同源 */
                subject={notebook.subject}
                /* 【第 3 条】卡片右下角那三个按钮（见 `notebook-card.tsx`） */
                canMoveUp={idx > 0}
                canMoveDown={idx >= 0 && idx < group.length - 1}
                onMoveUp={() => moveInGroup(notebook, -1)}
                onMoveDown={() => moveInGroup(notebook, 1)}
                onMerge={archived ? undefined : () => toggleMergeArmed(notebook)}
                mergeArmed={mergeSource?.id === notebook.id}
            />
        );
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    return (
        <main className="min-h-screen p-4 md:p-8 bg-background">
            <div className="mx-auto max-w-7xl space-y-8">
                <div className="flex items-center gap-4">
                    <BackButton fallbackUrl="/" />
                    {/* 那句"按科目分类管理你的错题"已按他的要求去掉（2026-09-28）——
                        标题本身已经说清了这是哪儿，少一行手机上少一次折行 */}
                    <h1 className="flex-1 text-2xl sm:text-3xl font-bold tracking-tight min-w-0">
                        {t.notebooks?.title || "My Notebooks"}
                    </h1>
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
                            <Button variant="outline" size="sm" title={t.notebooks?.trash || "回收箱"} className="hidden sm:flex">
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t.notebooks?.trash || "回收箱"}
                            </Button>
                        </Link>
                        <Link href="/trash" className="sm:hidden">
                            <Button variant="outline" size="icon" title={t.notebooks?.trash || "回收箱"}>
                                <Trash2 className="h-4 w-4" />
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

                {/* #10 三级打印 · 第 1 级：所有本里还没打印过的题
                    （那句"把各本里从没打过的题一次打成错题卡"已按他的要求去掉） */}
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => router.push("/print-preview?unprinted=1&mode=card")}
                    >
                        <Printer className="mr-2 h-4 w-4" />
                        {t.notebooks?.printAllUnprinted || "打印所有未打印"}
                    </Button>
                    {/* 一句用法提示：不写他就要自己摸（这也是一处"软件自己说清怎么用"） */}
                    <span className="text-xs text-muted-foreground">
                        {L("点卡片进错题本；卡片右下角 ↖↘ 调顺序、⧉ 是把这一本并进另一本",
                           "Tap a card to open it · ↖↘ reorder · the merge button merges into another")}
                    </span>
                </div>

                {/* 【第 7 条】选中"目标本"之后给一条明确的横幅：不然黄色边框代表什么全靠猜 */}
                {mergeSource && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2">
                        <span className="text-sm flex items-center gap-2">
                            <Merge className="h-4 w-4" />
                            {L(
                                `已选中「${mergeSource.displayName}」：再点另一张卡片，就把它整本并进那一本（它自己会被删除）；点它自己 = 取消。`,
                                `Selected "${mergeSource.displayName}": click another notebook to merge it in; click it again to cancel.`,
                            )}
                        </span>
                        <Button variant="outline" size="sm" onClick={() => setMergeSource(null)}>
                            {t.common.cancel || "取消"}
                        </Button>
                    </div>
                )}

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
                            {activeBooks.map((notebook) => renderCard(notebook, false))}
                        </div>

                        {/*
                          【custom-v25】已归档改成折叠区块：
                            · 默认**不读取**归档本（连请求都不发），点箭头才去读；
                            · 箭头方向即状态：收起是 ▾、展开是 ▴；
                            · 展开过再收起**不重新读**，数据留着，来回点不折腾接口。
                          【2026-10-12 第 12 条】展开后**按年级分组**（年级倒序），
                            每组就是一个小"文件夹"，同组内还能拖。
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
                                    <div className="space-y-6">
                                        {archivedGroups.map(({ grade, list }) => (
                                            <div key={grade || "__none__"} className="space-y-2">
                                                {/* 年级这个"文件夹"的头 —— 组内可拖、跨组不行 */}
                                                <div className="flex items-center gap-2 px-1">
                                                    <FolderOpen className="h-4 w-4 text-muted-foreground" />
                                                    <h3 className="text-sm font-semibold">
                                                        {grade || L("未设年级", "No grade")}
                                                    </h3>
                                                    <span className="text-xs text-muted-foreground">
                                                        {list.length} {L("本", "notebooks")}
                                                    </span>
                                                </div>
                                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                                    {list.map((notebook) => renderCard(notebook, true))}
                                                </div>
                                            </div>
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

                <EditNotebookDialog
                    open={!!editTarget}
                    onOpenChange={(open) => { if (!open) setEditTarget(null); }}
                    notebook={editTarget}
                    existingNames={allNames.filter(n => n !== editTarget?.displayName)}
                    onSave={handleSaveEdit}
                />
            </div >
            {/* ⚠️ 这里原先挂着拖动时那个"跟手虚影"。2026-10-12 晚拖动整块拆掉（见文件头），
                虚影也一并没了 —— 别再照老代码往回抄。 */}
        </main >
    );
}
