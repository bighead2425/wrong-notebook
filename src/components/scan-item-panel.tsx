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
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Camera, ExternalLink, Link2, Loader2, Plus } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ErrorItem } from "@/types/api";
import { ErrorItemCard } from "@/components/error-item-card";
import { ReviewOutcomeEditor } from "@/components/review-outcome-editor";
import { cycleManageType } from "@/lib/manage-type";
// 【2026-10-15】掌握开关点一下变成什么（唯一实现在 level-settle.ts）
import { nextMasteryLevel } from "@/lib/level-settle";
import { serializeReviewOutcomes, type ReviewOutcomes } from "@/lib/review-outcomes";
import type { ReviewEventDraft } from "@/lib/review-event-draft";

export function ScanItemPanel({
    itemId,
    source,
    onBack,
    backLabel,
    /** 跳详情页时带的"回来"参数（详情页的返回键据此回到这一屏） */
    backTo,
    /**
     * 【2026-10-10】"用摄像头扫那道题的码" —— 由**扫码页**（`/scan`）提供，
     * 因为它手里才有摄像头那套东西。本组件只负责"请求进入扫码"，
     * 扫到什么、怎么确认，都在扫码页里做（他要求跟主页"扫一扫"是同一个东西）。
     */
    onScanForLink,
}: {
    itemId: string;
    /** 'main' | 'trash' */
    source: "main" | "trash";
    onBack: () => void;
    backLabel: string;
    backTo?: string;
    /** 参数是**当前这道题的题号**（扫码屏要显示"正在为「XX」找关联题"） */
    onScanForLink?: (currentNo: string) => void;
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

    /* ===== 【2026-10-10】关联别的题（把题 B 挂到当前这道题下面）=====
       【2026-10-12 他去掉了"搜题式关联"】
       他原话："上面的『题号里的几位，或题干里的一个词』并后面『查找』按钮，全部去掉，
       因为实际上不会这样关联题……手机端还会自动跳出键盘来，这种搜题的方式就不要了。"
       ⇒ 这个框里只剩两条**他真会用的**路：
         · **打开扫码**：用软件自己的摄像头扫那道题的二维码（和主页"扫一扫"同一个东西）；
         · **拍照新增**：题库里根本没有那道题时，拍一张、新增并顺手挂上来。
       ⚠️ 顺带删掉的还有"搜出来的候选列表"与它带的 `doLink`（**只被那个列表用过**）——
          留着就是死代码，只会让下一个人以为还有第三条路。 */

    const [linkOpen, setLinkOpen] = useState(false);
    const [linkNote, setLinkNote] = useState("");

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

    const saveOutcomes = async (next: ReviewOutcomes, event: ReviewEventDraft | null) => {
        if (!item) return;
        const serialized = serializeReviewOutcomes(next);
        setItem({ ...item, reviewOutcomes: serialized });
        try {
            const updated = await apiClient.put<{ attention?: number }>(`/api/error-items/${item.id}`, {
                reviewOutcomes: serialized,
                /** 【2026-10-16 如如】**补上复习流水** —— 见 `lib/review-event-draft.ts` 文件头
                 *  （这张表此前没人写：API 接得住、前端一处都没传 ⇒ 空表 + 完全静默）。 */
                ...(event ? { reviewEvent: event } : {}),
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
                {/* 【2026-10-10】把别的题挂到这道题下面（他原稿："扫到题 A → 在题 A 里关联题 B"） */}
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setLinkNote("");
                        setLinkOpen(true);
                    }}
                >
                    <Link2 className="mr-1.5 h-4 w-4" />
                    {L("关联别的题", "Link a question")}
                </Button>
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
                    /** 【2026-10-10】扫到的这道题是主题还是附题 —— 照详情接口回的 `link.role` 画角标 */
                    linkRole={item.link?.role ?? null}
                    onToggleMastery={() =>
                        patch(
                            { masteryLevel: nextMasteryLevel(item.masteryLevel) },
                            { masteryLevel: nextMasteryLevel(item.masteryLevel) },
                        )
                    }
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

            {/* ===== "关联别的题"对话框 =====
                【2026-10-12 他去掉了"搜题式关联"】这里原来有"题号里的几位 / 题干里的一个词"
                + 「查找」+ 一串候选。他的原话："实际上不会这样关联题……手机端还会自动跳出
                键盘来，这种搜题的方式就不要了。" ⇒ 现在只剩两条他真会用的路：
                  · **打开扫码**（软件自己的摄像头，和主页"扫一扫"同一个东西）；
                  · **拍照新增**（题库里没有 ⇒ 拍一张、新增、顺手挂上来）。 */}
            <Dialog
                open={linkOpen}
                onOpenChange={(open) => {
                    if (!open) setLinkOpen(false);
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{L("关联别的题", "Link a question")}</DialogTitle>
                        <DialogDescription>
                            {L(
                                `扫到或新增的那道题会挂到「${item.source || item.id}」下面，这道题就是主题。`,
                                `The question you scan or add will attach to ${item.source || item.id} (the main one).`,
                            )}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3">
                        {/* 【他要求】扫就走**软件自己的扫码**（不是手机相机拍照） */}
                        {onScanForLink && (
                            <Button
                                variant="outline"
                                className="w-full"
                                onClick={() => {
                                    setLinkOpen(false);
                                    onScanForLink(item.source || item.id);
                                }}
                            >
                                <Camera className="mr-2 h-4 w-4" />
                                {L("打开扫码 · 用摄像头扫那道题的二维码", "Open scanner (camera)")}
                            </Button>
                        )}

                        {/* 【他原稿】"如果选择拍照 ⇒ 说明题库里没有这道题，要在错题本中新增一道并关联上去"。
                            这条走的是**现成的"添题"链路**（拍照 → 美化 → 送 AI → 保存），
                            只在保存时多带一个 `parentId`（见 `BatchPipeline` 与新建接口）。 */}
                        {item.notebookId ? (
                            <Button
                                variant="outline"
                                className="w-full"
                                onClick={() => {
                                    setLinkOpen(false);
                                    router.push(`/notebooks/${item.notebookId}/add?linkTo=${item.id}`);
                                }}
                            >
                                <Plus className="mr-2 h-4 w-4" />
                                {L(
                                    "题库里没有 → 拍照新增一道，并挂到本题下面",
                                    "Not in the notebook → photograph a new one and attach it",
                                )}
                            </Button>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                {L(
                                    "（这道题还没归到任何错题本，所以只能关联已有的题）",
                                    "(This question has no notebook yet, so only existing ones can be attached.)",
                                )}
                            </p>
                        )}

                        {linkNote && (
                            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                {linkNote}
                            </p>
                        )}

                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setLinkOpen(false)}>
                            {L("关闭", "Close")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    );
}
