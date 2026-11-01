"use client";

/**
 * 按**知识点**看题 —— 点一个标签，把挂在它（以及它下面所有子知识点）上的错题列出来。
 *
 * 【2026-11-01】为什么要有这一页：
 *   标签准了之后，"这个知识点她错了哪些题"才成立。在那之前只能按错题本翻，
 *   而错题本是按学期/册分的，跟她薄弱在哪没有关系。
 *
 * 三个入口都指向这里：
 *   · 详情页的标签
 *   · 标签管理页（标准标签库）里的标签
 *   · 以后任何"这一类一起练"的入口
 *
 * ⚠️ 查题走的是 `?tagId=…&includeChildren=1` —— **按 id 不按名字**：
 *   「计算」「阅读理解」这种名字在不同学科/不同册下都存在，按名字会串。
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Printer, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";
import { ErrorItemCard, type ErrorItemCardData } from "@/components/error-item-card";
import { useLanguage } from "@/contexts/LanguageContext";

interface TagInfo {
    id: string;
    name: string;
    path: string;
    subject: string;
    isSystem: boolean;
    itemCount: number;
    childCount: number;
    subtreeSize: number;
}

interface Paginated<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export default function ByTagPage() {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const { t } = useLanguage();

    const [tag, setTag] = useState<TagInfo | null>(null);
    const [items, setItems] = useState<ErrorItemCardData[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const id = params?.id;
        if (!id) return;
        let cancelled = false;

        (async () => {
            setLoading(true);
            setError(null);
            try {
                const info = await apiClient.get<TagInfo>(`/api/tags/${id}`);
                if (cancelled) return;
                setTag(info);

                /* 含子树：点一个"节"时，题其实挂在它下面的知识点上 */
                const list = await apiClient.get<Paginated<ErrorItemCardData>>(
                    `/api/error-items/list?tagId=${encodeURIComponent(id)}&includeChildren=1&pageSize=50`,
                );
                if (cancelled) return;
                setItems(list.items);
                setTotal(list.total);
            } catch (e) {
                if (!cancelled) {
                    console.error(e);
                    setError('这一类没能加载出来');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [params?.id]);

    const handlePrint = () => {
        if (!tag) return;
        /**
         * 直接跳打印预览：它会把 URL 参数原样透传给列表接口，
         * 所以 `tagId + includeChildren` 在那边照样生效。
         * 不在这一页另做一套"勾选 + 组卷"——那是组卷页的事，两处各写一遍必然走样。
         */
        router.push(
            `/print-preview?tagId=${encodeURIComponent(tag.id)}&includeChildren=1`,
        );
    };

    return (
        <main className="min-h-screen bg-background">
            <div className="container mx-auto p-4 space-y-5 pb-20">
                <div className="flex items-start gap-3">
                    <Link href="/tags">
                        <Button variant="ghost" size="icon" aria-label="返回">
                            <ArrowLeft className="w-4 h-4" />
                        </Button>
                    </Link>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-xl font-semibold truncate">
                            {tag?.name ?? '加载中…'}
                        </h1>
                        {tag && (
                            <p className="text-xs text-muted-foreground mt-0.5 break-all">
                                {tag.path}
                            </p>
                        )}
                        {tag && (
                            <p className="text-sm mt-2">
                                共 <span className="font-medium">{tag.itemCount}</span> 道题
                                {tag.childCount > 0 && (
                                    <span className="text-muted-foreground">
                                        　（含 {tag.childCount} 个子知识点）
                                    </span>
                                )}
                                {total > items.length && (
                                    <span className="text-muted-foreground">
                                        　本次显示前 {items.length} 道
                                    </span>
                                )}
                            </p>
                        )}
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handlePrint}
                        disabled={!tag || tag.itemCount === 0}
                        className="shrink-0"
                    >
                        <Printer className="h-4 w-4 mr-1" />
                        打印这一组
                    </Button>
                </div>

                {loading && (
                    <div className="flex items-center justify-center py-16 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin mr-2" />
                        正在取这一类的题…
                    </div>
                )}

                {!loading && error && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
                        {error}
                    </div>
                )}

                {!loading && !error && items.length === 0 && (
                    <div className="rounded-lg border p-10 text-center text-sm text-muted-foreground">
                        这一类还没有题。
                        <br />
                        <span className="text-xs">
                            等以后录到这个知识点的错题，它会自动出现在这里。
                        </span>
                    </div>
                )}

                {!loading && !error && items.length > 0 && (
                    <div className="space-y-3">
                        {items.map((item) => (
                            <ErrorItemCard
                                key={item.id}
                                item={item}
                                href={`/error-items/${item.id}`}
                            />
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
