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
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Camera, ExternalLink, Link2, Loader2, Plus, Search } from "lucide-react";
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

    /* ===== 【2026-10-10】关联别的题（把题 B 挂到当前这道题下面）===== */

    const [linkOpen, setLinkOpen] = useState(false);
    const [linkQuery, setLinkQuery] = useState("");
    const [linkSearching, setLinkSearching] = useState(false);
    const [linkBusy, setLinkBusy] = useState<string | null>(null);
    const [linkNote, setLinkNote] = useState("");
    /**
     * 搜出来的候选（**搜索式**，不是"精确题号"）。
     * ⚠️ 他 2026-10-10 实测反馈："输入题号查找失败" —— 上一版走的是 `GET /api/scan?no=`，
     *    那条路要求**一字不差的完整题号**；纸上少看一位、少个前缀就查不到。
     *    ⇒ 改成"给关键词就出候选，他自己挑"。
     */
    const [linkResults, setLinkResults] = useState<
        { id: string; no: string; text: string; mastered: boolean }[]
    >([]);

    /**
     * 按关键词找要关联的题 —— 走**列表接口**（题号片段 / 题干里的词都行）。
     * ⚠️ 用 `scope=all`：要关联的题可能在"已掌握"里，主库默认口径搜不到它。
     * ⚠️ 同批把列表接口的搜索补上了 `source`（题号）—— 原来它**不搜题号**，
     *    所以"搜题号搜不到"这件事在错题本页的搜索框里同样存在，一并修掉。
     * ⚠️ 刻意**不包 useCallback**（只被事件调用），免得把 `L` 拖进依赖数组。
     */
    const searchCandidates = async (raw: string) => {
        const q = raw.trim();
        if (!q) return;
        setLinkSearching(true);
        setLinkNote("");
        setLinkResults([]);
        try {
            const res = await apiClient.get<{
                items?: {
                    id: string;
                    source?: string | null;
                    questionText?: string | null;
                    masteryLevel?: number;
                }[];
            }>(`/api/error-items/list?query=${encodeURIComponent(q)}&scope=all&pageSize=10`);
            const rows = (res.items || []).filter((it) => it.id !== itemId);
            if (!rows.length) {
                setLinkNote(
                    L(
                        "没搜到可以关联的题。换个关键词试试：题号里的几位、或题干里的一个词。",
                        "No match — try part of the number, or a word from the question.",
                    ),
                );
                return;
            }
            setLinkResults(
                rows.map((it) => {
                    const text = (it.questionText || "").replace(/\s+/g, " ").trim();
                    return {
                        id: it.id,
                        no: it.source || it.id,
                        text: text.length > 56 ? `${text.slice(0, 56)}…` : text,
                        mastered: (it.masteryLevel ?? 0) >= 2,
                    };
                }),
            );
        } catch (error) {
            console.error(error);
            alert(L("搜索失败，请重试", "Search failed"));
        } finally {
            setLinkSearching(false);
        }
    };

    /**
     * 把某道题挂到**当前这道题**下面（当前这道题 = 主题）。
     *
     * ⚠️ 两边各自都已经是一组题的主题时，规则不肯替他决定（`plan.choice`）——
     *    这里问一句，**推荐"当前这道题继续当主题"**（他此刻正看着这一屏），
     *    选"是"就带 `chooseRootId` 重发一次，对方那一组会整棵接过来。
     * ⚠️ 成功后**不关对话框**，只把这条从候选里摘掉 —— 他常常要一次挂好几道。
     */
    const doLink = async (childId: string, chooseRootId?: string): Promise<void> => {
        setLinkBusy(childId);
        try {
            const res = await apiClient.post<{
                ok: boolean;
                message?: string;
                choice?: { candidates: { id: string; no: string }[]; recommended: string };
            }>("/api/error-items/link", {
                action: "link",
                child: childId,
                target: itemId,
                ...(chooseRootId ? { chooseRootId } : {}),
            });

            if (res.choice) {
                const ok = window.confirm(
                    L(
                        "这两道题各自都已经是一组题的主题了。\n让当前这道题当主题、把对方那一组一起接过来？（点取消 = 什么都不做）",
                        "Both are already main questions. Make the current one the main question and take over the other group?",
                    ),
                );
                if (ok) await doLink(childId, itemId);
                return;
            }
            if (!res.ok) {
                alert(res.message || L("没有关联成功", "Could not link"));
                return;
            }
            setLinkNote(res.message || L("已关联", "Linked"));
            setLinkResults((prev) => prev.filter((r) => r.id !== childId));
            /** 刷新本题：卡片角标与"名下几道"要跟着变 */
            fetchItem();
        } catch (error) {
            console.error(error);
            alert(L("没有关联成功", "Could not link"));
        } finally {
            setLinkBusy(null);
        }
    };

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
                {/* 【2026-10-10】把别的题挂到这道题下面（他原稿："扫到题 A → 在题 A 里关联题 B"） */}
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setLinkNote("");
                        setLinkResults([]);
                        setLinkQuery("");
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

            {/* ===== 【2026-10-10】"关联别的题"对话框（**搜索式**）=====
                他实测反馈过两条，这一版都改了：
                  ① "输题号查找失败" ⇒ 改成**按关键词搜**（题号里的几位、题干里的一个词都行），
                     给一串候选人他自己挑 —— 精确题号那条路太脆（少一位就查不到）；
                  ② "拍照调的是手机相机，不是软件里的扫码" ⇒ **撤掉拍照入口**，
                     改成「打开扫码」：走软件自己的摄像头（和主页"扫一扫"同一个东西）。 */}
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
                                `找到的那道题会挂到「${item.source || item.id}」下面，这道题就是主题。`,
                                `The question you pick will attach to ${item.source || item.id} (the main one).`,
                            )}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <Input
                                    className="pl-8"
                                    placeholder={L(
                                        "题号里的几位，或题干里的一个词",
                                        "Part of the number, or a word",
                                    )}
                                    value={linkQuery}
                                    onChange={(e) => setLinkQuery(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") searchCandidates(linkQuery);
                                    }}
                                />
                            </div>
                            <Button
                                variant="outline"
                                onClick={() => searchCandidates(linkQuery)}
                                disabled={!linkQuery.trim() || linkSearching}
                            >
                                {linkSearching ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    L("查找", "Find")
                                )}
                            </Button>
                        </div>

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

                        {linkResults.length > 0 && (
                            <div className="max-h-[42vh] space-y-1.5 overflow-y-auto">
                                {linkResults.map((r) => (
                                    <div
                                        key={r.id}
                                        className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="font-medium">{r.no}</span>
                                                {r.mastered && (
                                                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-700">
                                                        {L("已掌握", "Mastered")}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="mt-1 text-xs text-muted-foreground">{r.text}</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            disabled={linkBusy !== null}
                                            onClick={() => doLink(r.id)}
                                        >
                                            {linkBusy === r.id ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                L("添加", "Attach")
                                            )}
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setLinkOpen(false)}
                            disabled={linkBusy !== null}
                        >
                            {L("关闭", "Close")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    );
}
