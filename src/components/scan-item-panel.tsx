"use client";

/**
 * 【2026-10-01 新增】扫码结果 · **一道题的卡**。
 *
 * 他 2026-10-01 的要求（原话拆解）：
 *   *"直接提供这道题在错题本页中的错题卡，上面很多可便捷操作的功能在错题卡上已经能实现了，
 *     同时在错题卡下面提供这道题在错题详情页面中复习结果栏中的四行内容。
 *     这样扫描一个深挖纸上的二维码后……可以实现调整是不是已经掌握了（错题卡左上角）、
 *     打印（左下角）、等级调整和删除这道题（错题卡右上角）、这道题的类型（右下角），
 *     同时还可以直接录入这道题的复习情况。如果上述内容还不够，就可以点击错题卡，
 *     直接进入这道题的详情页面。"*
 *
 * 所以这一屏 = **错题卡（共享组件，与错题本页同一份）** + **复习结果四行（同一份编辑器）**。
 *
 * ⚠️ 卡片上的五个"即点即存"位置在这里走**自己的单题状态**（不是列表页那套列表态）：
 *    点了先改画面、再发请求，失败弹提示并拉回真实数据（与列表页同一条原则：
 *    失败绝不能静默）。
 *
 * 扫到回收箱里的题时（`source === 'trash'`）**照样能看**，但页面底色不同（H2/#12 的老规矩）。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ErrorItem } from "@/types/api";
import { ErrorItemCard } from "@/components/error-item-card";
import { ReviewOutcomeEditor } from "@/components/review-outcome-editor";
import { cycleAttentionLevel } from "@/lib/attention-level";
import { cycleManageType } from "@/lib/manage-type";
import { serializeReviewOutcomes, type ReviewOutcomes } from "@/lib/review-outcomes";

export function ScanItemPanel({
    itemId,
    source,
    onBack,
    backLabel,
    /** 跳详情页时带的"回来"参数（详情页的返回键据此回到这一屏） */
    backTo,
}: {
    itemId: string;
    /** 'main' | 'trash' */
    source: "main" | "trash";
    onBack: () => void;
    backLabel: string;
    backTo?: string;
}) {
    const { t, language } = useLanguage();
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);
    const router = useRouter();

    const [item, setItem] = useState<ErrorItem | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchItem = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiClient.get<ErrorItem>(`/api/error-items/${itemId}`);
            setItem(data);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    }, [itemId]);

    useEffect(() => {
        fetchItem();
    }, [fetchItem]);

    /** 乐观更新 + 失败回正（与列表页 `patchItemFields` 同一条规矩） */
    const patch = async (body: Record<string, unknown>, optimistic: Partial<ErrorItem>) => {
        if (!item) return;
        setItem({ ...item, ...optimistic });
        try {
            await apiClient.put(`/api/error-items/${item.id}`, body);
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.updateFailed || "Update failed");
            fetchItem();
        }
    };

    const saveOutcomes = async (next: ReviewOutcomes) => {
        if (!item) return;
        const serialized = serializeReviewOutcomes(next);
        setItem({ ...item, reviewOutcomes: serialized });
        try {
            // 【2026-10-03】复习结果会**联动等级** ⇒ 顺带把服务器算完的等级接回来
            const updated = await apiClient.put<{ attention?: number }>(`/api/error-items/${item.id}`, {
                reviewOutcomes: serialized,
            });
            if (typeof updated?.attention === 'number') {
                setItem((prev) => (prev ? { ...prev, attention: updated.attention as number } : prev));
            }
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.updateFailed || "Update failed");
            fetchItem();
        }
    };

    const trash = async () => {
        if (!item) return;
        const msg = t.common?.messages?.confirmMoveToTrash
            || "Move this question to the trash? You can restore it from the trash later.";
        if (!confirm(msg)) return;
        try {
            await apiClient.delete(`/api/error-items/${item.id}`);
            onBack();
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.deleteFailed || "Delete failed");
        }
    };

    const detailHref = backTo
        ? `/error-items/${itemId}?back=${encodeURIComponent(backTo)}`
        : `/error-items/${itemId}`;

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t.common?.loading || "Loading…"}
            </div>
        );
    }
    if (!item) {
        return (
            <div className="space-y-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">{L("没找到这道题", "Question not found")}</p>
                <Button variant="outline" onClick={onBack}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    {backLabel}
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* 顶条：返回上一层 + 说明这道题是从哪扫出来的 */}
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={onBack}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    {backLabel}
                </Button>
                <span className="font-mono text-sm font-semibold">{item.source || item.id}</span>
                {source === "trash" && (
                    <span className="rounded bg-rose-500/15 px-2 py-0.5 text-xs text-rose-700">
                        {L("这道题在回收箱里", "This item is in the trash")}
                    </span>
                )}
                <span className="flex-1" />
                <Link href={detailHref}>
                    <Button variant="outline" size="sm">
                        <ExternalLink className="mr-1.5 h-4 w-4" />
                        {L("打开详情页", "Open details")}
                    </Button>
                </Link>
            </div>

            {/* 错题卡：与错题本页**同一份组件**。
                【2026-10-01 他反馈后改】两点：
                  ① `href={null}` ⇒ **整卡不再当跳转热区**（手机上点等级/掌握度容易误触跳走；
                     进详情页走右上角那个按钮，一次意图一个动作）。
                  ② **卡片撑满底色框**：外层去掉 `p-3` —— 他原话"下面的背景框都比它大，
                     没有必要，把错题卡大小放到底色框大小"。底色框只保留"这道题在回收箱里"
                     的红/绿提示语义，`overflow-hidden` 保证圆角不溢出。 */}
            <div
                className={`overflow-hidden rounded-lg ${
                    source === "trash" ? "bg-rose-500/10" : "bg-emerald-500/10"
                }`}
            >
                <ErrorItemCard
                    item={item}
                    href={null}
                    onToggleMastery={() =>
                        patch(
                            { masteryLevel: item.masteryLevel > 0 ? 0 : 2 },
                            { masteryLevel: item.masteryLevel > 0 ? 0 : 2 },
                        )
                    }
                    onCycleAttention={() => {
                        const next = cycleAttentionLevel(item.attention);
                        patch({ attention: next }, { attention: next });
                    }}
                    onCycleManageType={() => {
                        const next = cycleManageType(item.manageType);
                        patch({ manageType: next }, { manageType: next });
                    }}
                    onTrash={trash}
                    onDeepDivePrint={() => {
                        router.push(`/print-preview?ids=${item.id}&mode=deep`);
                    }}
                />
            </div>

            {/* 错题详情页里"复习结果"那一栏的四行 —— 同一份编辑器 */}
            <div className="rounded-lg border bg-background p-3">
                <ReviewOutcomeEditor
                    value={item.reviewOutcomes}
                    createdAt={item.createdAt}
                    onChange={saveOutcomes}
                    L={L}
                />
            </div>
        </div>
    );
}
