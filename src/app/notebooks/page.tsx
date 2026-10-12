"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * 这一轮加的是三件"手"上的事 + 一件结构上的事：
 *
 *  ① **拖动排序**（第 6 条）：按住卡片拖到另一张**上面**松手，它就插到那一张**前面**。
 *     拖动中：被拖的那张红边框；指针底下跟着一张半透明"虚影"；落点那张**粉色填充**。
 *     手机端**长按**才拿得起来（否则会和"上下滑页面"打架）。
 *     ⚠️ 跨组不许落：**在用的**只能在在用组里排，**已归档**只能在**同一个年级**组里排
 *        （第 12 条）—— 他明说了"不能通过拖动的方式进入已归档 / 从已归档回到在用"。
 *        实现上就一句：落点判定先看"这两张是不是同一组"，不是就既不亮粉也不落。
 *
 *  ② **双击并入**（第 7 条）：双击一本当"目标本"（黄边框）⇒ 再双击另一本 ⇒ 确认后
 *     把目标本的**所有题**（含回收箱里的）改挂到那一本，然后把目标本删掉。
 *     ⚠️ 已归档的不参与双击（他自己也写了"已归档卡片不能双击"）。
 *
 *  ③ **拖动排序 / 并入 都只改"挂在哪一本"，一个字都不碰题号** ——
 *     他第 10 条把这件事定成了前置条件：题号是题从录入到销毁的身份证，
 *     组卷快照（`VolumeItem` 存的是快照）全靠它才对得上。
 *
 *  ④ **已归档按年级分组**（第 12 条）：像"根目录下的文件夹"，里面按**年级倒序**排，
 *     同年级的卡片放在一起；组内还能拖，跨组不行。
 *
 * ── 为什么拖动不用浏览器自带的 HTML5 拖放 ────────────────────────────
 * 那套在**触屏上根本不触发**（手机没有 dragstart）。而他要的正是"手机端长按拖动"，
 * 所以统一走 Pointer Events 自己实现：鼠标**移动超过 6px** 就算开始拖，
 * 手指**长按 400ms** 才算开始拖。两条路最后都汇到同一个落点判定里。
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

/** 拖动中那一份临时状态（只在拖动期间存在） */
interface DragState {
    /** 正在被拖的那一本 */
    id: string;
    /** 虚影跟着指针的视口坐标 */
    x: number;
    y: number;
    /** 指针底下那一张（同组才算数；跨组永远是 null ⇒ 不亮粉、松手也不动） */
    overId: string | null;
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

    // ===================== 【第 6 条】拖动排序 =====================

    /**
     * 拖动过程的"临时账"放在 ref 里（不参与渲染）：起点、允许落点的组、长按计时器。
     * 只有 `drag` 那个 state 会触发重画（红框 / 粉底 / 虚影都靠它）。
     */
    const dragRef = useRef<{
        id: string;
        group: string[];
        label: string;
        pointerType: string;
        startX: number;
        startY: number;
        lastX: number;
        lastY: number;
        timer: number | null;
    } | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    /** 刚拖完那一下的 click 要吞掉 —— 否则松手瞬间就跳进那个本了 */
    const suppressClickRef = useRef(false);
    /** 上一次按下的输入类型：触摸就直接跳转（手指上不存在双击），鼠标才需要那 220ms 的等待 */
    const lastPointerTypeRef = useRef<string>("mouse");
    const clickTimerRef = useRef<number | null>(null);

    /** 这一张属于哪个组（能落的地方 = 这一组里的其它卡） */
    const groupIdsOf = (nb: Notebook): string[] =>
        nb.archiveStatus === "archived"
            ? (archivedGroups.find(g => (g.grade || "") === (nb.grade || ""))?.list ?? []).map(n => n.id)
            : activeBooks.map(n => n.id);

    /** 指针底下是哪一张（同组才算落点；跨组一律不算） */
    const hitTest = useCallback((x: number, y: number, group: string[], selfId: string): string | null => {
        const el = document.elementFromPoint(x, y);
        const card = el?.closest?.("[data-notebook-id]") as HTMLElement | null;
        const id = card?.dataset.notebookId;
        if (!id || id === selfId) return null;
        return group.includes(id) ? id : null;
    }, []);

    const activateDrag = () => {
        const p = dragRef.current;
        if (!p || drag) return;
        setDrag({ id: p.id, x: p.lastX, y: p.lastY, overId: null });
        /** 手机上一记轻震 = "拿起来了"（有就震，没有就算了） */
        try { navigator.vibrate?.(20); } catch { /* 不管 */ }
    };

    const onCardPointerDown = (nb: Notebook, e: React.PointerEvent<HTMLDivElement>) => {
        // 只认左键 / 触摸 / 笔（右键、中键不参与）
        if (e.pointerType === "mouse" && e.button !== 0) return;
        /**
         * ⚠️ 从**卡片上那几个小按钮**（改名 / 归档 / 删除）上按下去时，**不算要拖卡片**。
         * 那些按钮只有 `onClick` 里的 stopPropagation，挡不住 pointerdown ⇒
         * 不排除的话，手抖挪 6px 就会被判成拖动，松手时那一下 click 还被吞掉 ——
         * 表现是"删除按钮点不动、要多点两下"。规则很朴素：**按钮上的按下不是拖**。
         */
        if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
        /**
         * ⚠️ 每次按下都把"吞掉这一次点击"的旗子放下来。
         * 因为"拖完"未必会跟着来一个 click（指针挪远了浏览器就不发 click 了），
         * 旗子留在那儿会把他**下一次正常的单击**也吞掉 —— 表现是"点一次没反应，要点两次"。
         */
        suppressClickRef.current = false;
        lastPointerTypeRef.current = e.pointerType;
        dragRef.current = {
            id: nb.id,
            group: groupIdsOf(nb),
            label: nb.displayName,
            pointerType: e.pointerType,
            startX: e.clientX,
            startY: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
            timer: null,
        };
        /**
         * 抓住指针：这样指针移出这张卡之后，事件**还是发给它**，
         * 拖动才不会在离开卡片边缘的一瞬间断掉。
         */
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 某些环境不支持，忽略 */ }
        if (e.pointerType !== "mouse") {
            // 手指：长按 400ms 才算"拿起来了"（否则会和上下滑页面打架）
            dragRef.current.timer = window.setTimeout(activateDrag, 400);
        }
    };

    const onCardPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const p = dragRef.current;
        if (!p) return;
        p.lastX = e.clientX;
        p.lastY = e.clientY;
        if (!drag) {
            const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
            // 鼠标：挪动超过 6px 就算开始拖（免得"手抖一下"也被当成拖动）
            if (p.pointerType === "mouse" && moved > 6) {
                activateDrag();
                return;
            }
            /**
             * 手指：**动得比 10px 还多就放弃长按** —— 那是他在上下滑页面，不是要拖卡片。
             * 不放弃的话，长按计时器会在页面滑动中途把人"抓"起来，手感很怪。
             */
            if (p.pointerType !== "mouse" && moved > 10 && p.timer) {
                window.clearTimeout(p.timer);
                dragRef.current = null;
            }
            return;
        }
        setDrag(prev => (prev ? { ...prev, x: e.clientX, y: e.clientY, overId: hitTest(e.clientX, e.clientY, p.group, p.id) } : prev));
    };

    const finishDragPointer = () => {
        const p = dragRef.current;
        if (p?.timer) window.clearTimeout(p.timer);
        dragRef.current = null;
        const current = drag;
        setDrag(null);
        if (!current) return;
        /** 拖完这一下别再当"点击"（不然松手就跳进那个本）*/
        suppressClickRef.current = true;
        if (current.overId) void dropBefore(current.id, current.overId);
    };

    /**
     * 把 `dragId` 插到 `overId` **前面**（他原话："将拖动的错题本卡片放到这个其他卡片的前面"）。
     * 落点那一张如果本来就是它的下一张，等于没动 —— 直接返回，不白跑一次接口。
     */
    const dropBefore = async (dragId: string, overId: string) => {
        const nb = [...activeBooks, ...archivedBooks].find(n => n.id === dragId);
        if (!nb) return;
        const group = groupIdsOf(nb);
        const next = group.filter(id => id !== dragId);
        const at = next.indexOf(overId);
        if (at < 0) return;
        next.splice(at, 0, dragId);
        if (next.join("|") === group.join("|")) return;

        applyOrderLocally(next);
        try {
            await apiClient.post("/api/notebooks/reorder", { ids: next });
        } catch (error) {
            console.error(error);
            alert(L("顺序没保存成功，已恢复原样", "Failed to save the new order"));
            await fetchNotebooks();
            if (archivedExpanded) await fetchArchived();
        }
    };

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

    const handleCardDoubleClick = (nb: Notebook) => {
        /** 已归档不参与（他自己写的"已归档卡片不能双击"）；这里再拦一道，防手滑 */
        if (nb.archiveStatus === "archived") return;
        if (!mergeSource) {
            setMergeSource(nb);
            return;
        }
        if (mergeSource.id === nb.id) {
            setMergeSource(null); // 再双击自己 = 取消
            return;
        }
        void doMerge(mergeSource, nb);
    };

    /**
     * 单击进本子。
     * ⚠️ 鼠标上要**等 220ms** 再跳 —— 因为他要的"双击选目标本"里，
     *    第一下 click 会先于 dblclick 到达；不等待就会"第一下就跳走了，双击永远打不出来"。
     *    手指上不存在双击（他也没要求），所以触摸直接跳，不拖这 220ms。
     */
    const handleCardClick = (nb: Notebook) => {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        if (lastPointerTypeRef.current === "touch") {
            router.push(`/notebooks/${nb.id}`);
            return;
        }
        if (clickTimerRef.current) {
            // 第二下 ⇒ 这是双击，交给 onDoubleClick，别再排跳转
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
            return;
        }
        clickTimerRef.current = window.setTimeout(() => {
            clickTimerRef.current = null;
            router.push(`/notebooks/${nb.id}`);
        }, 220);
    };

    /** 卡片上那几个临时外观（红框 / 粉底 / 黄框）—— 判断只写在**这一处** */
    const cardStateClass = (nb: Notebook) => {
        const classes: string[] = [];
        // 他要的就一条：**红边框**（那半透明是他没要的，别加戏）
        if (drag?.id === nb.id) classes.push("ring-2 ring-red-500 border-red-500");
        else if (drag?.overId === nb.id) classes.push("ring-2 ring-pink-400 bg-pink-100 border-pink-400");
        if (mergeSource?.id === nb.id) classes.push("ring-2 ring-amber-400 border-amber-400 bg-amber-50");
        return classes.join(" ");
    };

    /** 拖动的包装：把 pointer 那四条事件 + 落点标记挂到卡片外面（卡片本身不懂拖动） */
    const dragWrapper = (nb: Notebook, inner: React.ReactNode) => (
        <div
            key={nb.id}
            data-notebook-id={nb.id}
            onPointerDown={(e) => onCardPointerDown(nb, e)}
            onPointerMove={onCardPointerMove}
            onPointerUp={finishDragPointer}
            onPointerCancel={finishDragPointer}
            /* 拖动中禁掉滚动手势，否则手机上一边拖一边页面在滚 */
            style={drag?.id === nb.id ? { touchAction: "none" } : undefined}
            className={`${drag?.id === nb.id ? "select-none" : ""} ${drag ? "cursor-grabbing" : ""}`}
        >
            {inner}
        </div>
    );

    const renderCard = (notebook: Notebook, archived: boolean) =>
        dragWrapper(
            notebook,
            <NotebookCard
                id={notebook.id}
                displayName={notebook.displayName}
                meta={buildNotebookMeta(notebook)}
                archived={archived}
                errorCount={notebook._count?.errorItems || 0}
                className={cardStateClass(notebook)}
                onClick={() => handleCardClick(notebook)}
                onDoubleClick={archived ? undefined : () => handleCardDoubleClick(notebook)}
                onRename={() => setEditTarget(notebook)}
                onToggleArchive={handleArchiveToggle}
                onDelete={() => handleDelete(notebook.id, notebook._count?.errorItems || 0, notebook.displayName)}
                itemLabel={t.notebooks?.items || "items"}
            />,
        );

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
                    {/* 手势提示：不写一句他根本不知道能拖（这也是一处"软件自己说清怎么用"） */}
                    <span className="text-xs text-muted-foreground">
                        {L("按住卡片可拖动排序；双击一本、再双击另一本，可把前一本并进后一本",
                           "Drag to reorder · double-click one then another to merge")}
                    </span>
                </div>

                {/* 【第 7 条】选中"目标本"之后给一条明确的横幅：不然黄色边框代表什么全靠猜 */}
                {mergeSource && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2">
                        <span className="text-sm flex items-center gap-2">
                            <Merge className="h-4 w-4" />
                            {L(
                                `已选中「${mergeSource.displayName}」：再双击另一本，就把它整本并进那一本（它自己会被删除）。`,
                                `Selected "${mergeSource.displayName}": double-click another notebook to merge it in.`,
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

            {/* 【第 6 条】跟着指针的那张"虚影" —— 只是个提示（`pointer-events-none` 不挡落点判定） */}
            {drag && (
                <div
                    className="pointer-events-none fixed z-50 rounded-md border bg-background/90 px-3 py-2 text-sm shadow-lg opacity-80"
                    style={{ left: drag.x + 14, top: drag.y + 14 }}
                >
                    {[...activeBooks, ...archivedBooks].find(n => n.id === drag.id)?.displayName ?? ""}
                </div>
            )}
        </main >
    );
}
