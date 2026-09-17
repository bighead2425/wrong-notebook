"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SubjectChip } from "@/components/subject-chip";
import { Undo2, Trash2, House, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { cleanMarkdown } from "@/lib/markdown-utils";

/**
 * 回收箱（#12 / H2 四分法）
 *
 * 定位：**不可见独立库**——不在「我的错题本」下显示，只能从首页 / 错题本页的入口进来。
 * 逻辑：
 *  - 所有删除（扫码删 / 详情删 / 多选删）都进这里，不是真删；
 *  - 在这里再删一次 = 彻底删除（会再确认一次）；
 *  - 「还原」返回原本（notebookId 一直没动过）。
 *  - 不进统计、平时不调用。
 */
export default function TrashPage() {
    const { t, language } = useLanguage();
    const zh = language === "zh";
    const L = (a: string, b: string) => (zh ? a : b);

    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);

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

    return (
        <main className="min-h-screen p-4 md:p-8 bg-background">
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-start gap-4">
                    <BackButton fallbackUrl="/" />
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
                    <Link href="/">
                        <Button variant="ghost" size="icon">
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>

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
                            return (
                                <Card key={item.id} className="gap-2 py-4">
                                    <CardContent className="space-y-3">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <SubjectChip subjectKey={item.notebook?.subject} />
                                                <span className="text-sm font-mono font-semibold truncate">{no}</span>
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
