"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SubjectChip } from "@/components/subject-chip";
import { Undo2, Trash2, House, Loader2, CheckSquare, Square, CheckCheck, Eraser } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { cleanMarkdown } from "@/lib/markdown-utils";

/**
 * 回收箱（#12 / H2 四分法）
 *
 * 定位：**不可见独立库**——不在「我的错题本」下显示，只能从错题本页的入口进来。
 * 逻辑：
 *  - 所有删除（扫码删 / 详情删 / 多选删）都进这里，不是真删；
 *  - 在这里再删一次 = 彻底删除（会再确认一次）；
 *  - 「还原」返回原本（notebookId 一直没动过）。
 *  - 不进统计、平时不调用。
 *
 * 【custom-v25 三处调整】
 *  ① 左上角箭头改为回到「我的错题本」（原来回主页，可右上角已经有主页键了，重复且绕远）。
 *  ② 点题号能进这道题的详情页 —— 不看一眼是哪道题就不敢删的情况太常见了。
 *  ③ 加多选：全选 / 清除 / 还原选中 / 彻底删除 / 取消，与错题本里的多选同一套手感。
 */

/** 批量接口一次最多 100 条（见 batch-delete 路由），超出分片发送 */
const BATCH_LIMIT = 100;

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export default function TrashPage() {
    const { t, language } = useLanguage();
    const zh = language === "zh";
    const L = (a: string, b: string) => (zh ? a : b);

    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);

    // ===== 多选 =====
    const [multi, setMulti] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);

    const fetchTrash = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiClient.get<PaginatedResponse<ErrorItem>>(
                "/api/error-items/list?trash=1&pageSize=200",
            );
            setItems(res.items);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchTrash();
    }, [fetchTrash]);

    const handleRestore = async (id: string) => {
        setBusyId(id);
        try {
            await apiClient.patch(`/api/error-items/${id}`, { action: "restore" });
            await fetchTrash();
        } catch (error) {
            console.error(error);
            alert(L("还原失败", "Restore failed"));
        } finally {
            setBusyId(null);
        }
    };

    const handlePermanentDelete = async (id: string, no: string) => {
        if (!confirm(L(
            `彻底删除 ${no}？删了就找不回来了。`,
            `Permanently delete ${no}? This cannot be undone.`,
        ))) return;

        setBusyId(id);
        try {
            await apiClient.delete(`/api/error-items/${id}?hard=1`);
            await fetchTrash();
        } catch (error) {
            console.error(error);
            alert(L("删除失败", "Delete failed"));
        } finally {
            setBusyId(null);
        }
    };

    // ===== 多选操作 =====
    const toggleSelect = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const selectAll = () => setSelected(new Set(items.map((i) => i.id)));
    const clearSelection = () => setSelected(new Set());

    const exitMulti = () => {
        setMulti(false);
        setSelected(new Set());
    };

    const handleRestoreSelected = async () => {
        const ids = [...selected];
        if (!ids.length) return;
        if (!confirm(L(
            `把选中的 ${ids.length} 道还原回原来的错题本？`,
            `Restore ${ids.length} selected item(s)?`,
        ))) return;
        setBusy(true);
        try {
            for (const part of chunk(ids, BATCH_LIMIT)) {
                await apiClient.post("/api/error-items/restore", { ids: part });
            }
            clearSelection();
            await fetchTrash();
        } catch (error) {
            console.error(error);
            alert(L("还原失败", "Restore failed"));
        } finally {
            setBusy(false);
        }
    };

    const handleDeleteSelected = async () => {
        const ids = [...selected];
        if (!ids.length) return;
        if (!confirm(L(
            `彻底删除选中的 ${ids.length} 道？删了就找不回来了。`,
            `Permanently delete ${ids.length} selected item(s)? This cannot be undone.`,
        ))) return;
        setBusy(true);
        try {
            // 接口单次上限 100，超出分片；分片之间有一条失败就整批停，避免"删一半"
            for (const part of chunk(ids, BATCH_LIMIT)) {
                await apiClient.post("/api/error-items/batch-delete", { ids: part, permanent: true });
            }
            clearSelection();
            await fetchTrash();
        } catch (error) {
            console.error(error);
            alert(L("删除失败", "Delete failed"));
        } finally {
            setBusy(false);
        }
    };

    const allSelected = items.length > 0 && selected.size === items.length;

    return (
        <main className="min-h-screen p-4 md:p-8 bg-background">
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-start gap-4">
                    {/* 【custom-v25】回「我的错题本」而不是回主页 —— 回收箱是从那儿进来的，
                        回去正好看一眼刚才删掉的题；主页键右上角另有。 */}
                    <BackButton fallbackUrl="/notebooks" />
                    <div className="flex-1 space-y-1">
                        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                            {L("回收箱", "Trash")}
                        </h1>
                        <p className="text-muted-foreground text-sm sm:text-base">
                            {L(
                                "删掉的错题先放这儿，不会真的丢。要恢复就点「还原」。",
                                "Deleted items stay here until you decide. Restore to bring one back.",
                            )}
                        </p>
                    </div>
                    {!loading && items.length > 0 && !multi && (
                        <Button variant="outline" size="sm" onClick={() => setMulti(true)}>
                            <CheckSquare className="mr-2 h-4 w-4" />
                            {L("多选", "Select")}
                        </Button>
                    )}
                    <Link href="/">
                        <Button variant="ghost" size="icon">
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>

                {/* 多选工具条：与错题本里的多选同一套手感 */}
                {multi && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
                        <Button variant="outline" size="sm" onClick={selectAll} disabled={busy || allSelected}>
                            <CheckCheck className="mr-2 h-4 w-4" />
                            {L("全选", "All")}
                        </Button>
                        <Button variant="outline" size="sm" onClick={clearSelection} disabled={busy || selected.size === 0}>
                            <Eraser className="mr-2 h-4 w-4" />
                            {L("清除", "Clear")}
                        </Button>
                        <span className="text-sm text-muted-foreground px-1">
                            {L("已选", "Selected")} {selected.size} / {items.length}
                        </span>
                        <div className="flex-1" />
                        <Button variant="outline" size="sm" onClick={handleRestoreSelected} disabled={busy || selected.size === 0}>
                            <Undo2 className="mr-2 h-4 w-4" />
                            {L("还原选中", "Restore")}
                        </Button>
                        <Button variant="destructive" size="sm" onClick={handleDeleteSelected} disabled={busy || selected.size === 0}>
                            <Trash2 className="mr-2 h-4 w-4" />
                            {L("彻底删除", "Delete forever")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={exitMulti} disabled={busy}>
                            {L("取消", "Cancel")}
                        </Button>
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.common.loading}
                    </div>
                ) : items.length === 0 ? (
                    <div className="text-center py-16 border-2 border-dashed rounded-lg text-muted-foreground">
                        {L("回收箱是空的", "Trash is empty")}
                    </div>
                ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                        {items.map((item) => {
                            const no = item.source || item.id;
                            const preview = cleanMarkdown((item.questionText || "").split("\n\n")[0] || "");
                            const checked = selected.has(item.id);
                            return (
                                <Card
                                    key={item.id}
                                    className={`gap-2 py-4 ${multi ? "cursor-pointer" : ""} ${checked ? "ring-2 ring-primary" : ""}`}
                                    onClick={multi ? () => toggleSelect(item.id) : undefined}
                                >
                                    <CardContent className="space-y-3">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 min-w-0">
                                                {/* 多选时左上角给出可选中框 */}
                                                {multi && (
                                                    <span className="shrink-0 text-primary">
                                                        {checked
                                                            ? <CheckSquare className="h-5 w-5" />
                                                            : <Square className="h-5 w-5 text-muted-foreground" />}
                                                    </span>
                                                )}
                                                <SubjectChip subjectKey={item.notebook?.subject} />
                                                {/* 【custom-v25】点题号进详情页：不看一眼是哪道题是不敢删的。
                                                    多选状态下点击整卡=勾选，故此处不再挂链接，避免误跳。 */}
                                                {multi ? (
                                                    <span className="text-sm font-mono font-semibold truncate">{no}</span>
                                                ) : (
                                                    <Link
                                                        href={`/error-items/${item.id}`}
                                                        title={L("查看这道题的详情", "Open details")}
                                                        className="text-sm font-mono font-semibold truncate underline-offset-2 hover:underline hover:text-primary"
                                                    >
                                                        {no}
                                                    </Link>
                                                )}
                                            </div>
                                            {item.deletedAt && (
                                                <span className="text-xs text-muted-foreground whitespace-nowrap">
                                                    {new Date(item.deletedAt).toLocaleDateString()}
                                                </span>
                                            )}
                                        </div>

                                        <p className="text-sm text-muted-foreground line-clamp-3">
                                            {preview || L("（没有题干）", "(no question text)")}
                                        </p>

                                        {item.notebook?.displayName && (
                                            <Badge variant="outline" className="text-xs">
                                                {item.notebook.displayName}
                                            </Badge>
                                        )}

                                        {/* 多选时不再逐张给按钮，统一走上面的工具条 */}
                                        {!multi && (
                                            <div className="flex gap-2">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={busyId === item.id}
                                                    onClick={() => handleRestore(item.id)}
                                                >
                                                    <Undo2 className="mr-1.5 h-4 w-4" />
                                                    {L("还原", "Restore")}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="destructive"
                                                    disabled={busyId === item.id}
                                                    onClick={() => handlePermanentDelete(item.id, no)}
                                                >
                                                    <Trash2 className="mr-1.5 h-4 w-4" />
                                                    {L("彻底删除", "Delete forever")}
                                                </Button>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                )}
            </div>
        </main>
    );
}
