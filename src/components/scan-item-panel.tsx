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
import jsQR from "jsqr";
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
import { ArrowLeft, Camera, ExternalLink, Link2, Loader2, Search } from "lucide-react";
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

    /* ===== 【2026-10-10】关联别的题（把题 B 挂到当前这道题下面）===== */

    const [linkOpen, setLinkOpen] = useState(false);
    const [linkNo, setLinkNo] = useState("");
    const [linkLooking, setLinkLooking] = useState(false);
    const [linkBusy, setLinkBusy] = useState(false);
    const [linkNote, setLinkNote] = useState("");
    const [linkCandidate, setLinkCandidate] = useState<{
        id: string;
        no: string;
        text: string;
        trash: boolean;
    } | null>(null);

    /**
     * 按题号找那道题 —— 走的是扫码页**同一个接口**（`GET /api/scan?no=`），
     * 所以"扫到的"和"手工输的"在这儿是同一回事，不用两套查法。
     * ⚠️ 刻意**不包 useCallback**：它只被事件（点查找 / 回车 / 拍照）调用，
     *    包起来反而会把 `L`（每次渲染都变）拖进依赖数组里报警告，纯粹自找麻烦。
     */
    const findCandidate = async (raw: string) => {
        const no = raw.trim().toUpperCase();
        if (!no) return;
        setLinkLooking(true);
        setLinkNote("");
        setLinkCandidate(null);
        try {
            const res = await apiClient.get<{
                found: boolean;
                source?: string;
                item?: { id: string; source?: string | null; questionText?: string | null };
            }>(`/api/scan?no=${encodeURIComponent(no)}`);
            if (!res.found || !res.item) {
                setLinkNote(L("没找到这道题（题号是不是敲错了？）", "Not found — check the number"));
                return;
            }
            if (res.item.id === itemId) {
                setLinkNote(L("这就是当前这道题，不用和自己关联。", "That is this question itself."));
                return;
            }
            const text = (res.item.questionText || "").replace(/\s+/g, " ").trim();
            setLinkCandidate({
                id: res.item.id,
                no: res.item.source || res.item.id,
                text: text.length > 60 ? `${text.slice(0, 60)}…` : text,
                trash: res.source === "trash",
            });
        } catch (error) {
            console.error(error);
            alert(L("查询失败", "Lookup failed"));
        } finally {
            setLinkLooking(false);
        }
    };

    /**
     * 拍照认纸上的二维码（**只解一张，不常开摄像头**）。
     * 他原稿里"调用扫描仪扫码"那半句：在手机上就是"拍一下那道题的码"，
     * 比手敲题号稳（他的码本来就是给机器读的）。
     */
    const scanQrFromPhoto = async (file: File) => {
        try {
            const bitmap = await createImageBitmap(file);
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(bitmap, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (!code?.data) {
                setLinkNote(
                    L("这张照片里没读出二维码，换个角度再拍一次。", "No QR code found in that photo."),
                );
                return;
            }
            setLinkNo(code.data.trim().toUpperCase());
            await findCandidate(code.data);
        } catch (error) {
            console.error(error);
            setLinkNote(L("照片读不出来，改成手输题号试试。", "Could not read it — type the number instead."));
        }
    };

    /**
     * 把查到的题挂到**当前这道题**下面（当前这道题 = 主题）。
     *
     * ⚠️ 两边各自都已经是一组题的主题时，规则不肯替他决定（`plan.choice`）——
     *    这里问一句，**推荐"当前这道题继续当主题"**（他此刻正看着这一屏），
     *    选"是"就带 `chooseRootId` 重发一次，对方那一组会整棵接过来。
     */
    const doLink = async (chooseRootId?: string): Promise<void> => {
        if (!linkCandidate) return;
        setLinkBusy(true);
        try {
            const res = await apiClient.post<{
                ok: boolean;
                message?: string;
                choice?: { candidates: { id: string; no: string }[]; recommended: string };
            }>("/api/error-items/link", {
                action: "link",
                child: linkCandidate.id,
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
                if (ok) await doLink(itemId);
                return;
            }
            if (!res.ok) {
                alert(res.message || L("没有关联成功", "Could not link"));
                return;
            }
            setLinkNote(res.message || L("已关联", "Linked"));
            setLinkCandidate(null);
            setLinkNo("");
            /** 刷新本题：卡片角标与"名下几道"要跟着变 */
            fetchItem();
        } catch (error) {
            console.error(error);
            alert(L("没有关联成功", "Could not link"));
        } finally {
            setLinkBusy(false);
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
                        setLinkCandidate(null);
                        setLinkNo("");
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

            {/* ===== 【2026-10-10】"关联别的题"对话框 =====
                两条路都留着：**手输题号**（纸上有）与**拍那张纸的码**（他原本就想这么用）。
                查到之后先给他看一眼是哪道题，点「添加到本题」才真挂 ——
                关联是"牵一发动全身"的事（对方若是主题，整组都会被接过来），不能查完就自动生效。 */}
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
                                `查到的那道题会挂到「${item.source || item.id}」下面，这道题就是主题。`,
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
                                    placeholder={L("题号，如 SX20261010001", "Question no.")}
                                    value={linkNo}
                                    onChange={(e) => setLinkNo(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") findCandidate(linkNo);
                                    }}
                                />
                            </div>
                            <Button
                                variant="outline"
                                onClick={() => findCandidate(linkNo)}
                                disabled={!linkNo.trim() || linkLooking}
                            >
                                {linkLooking ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    L("查找", "Find")
                                )}
                            </Button>
                        </div>

                        {/* 拍照认码：手机上一按就成（`capture` 让手机直接调后置摄像头） */}
                        <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                            <Camera className="h-4 w-4" />
                            {L("或拍一下那道题纸上的二维码", "Or photograph that sheet's QR code")}
                            <input
                                type="file"
                                accept="image/*"
                                capture="environment"
                                className="hidden"
                                onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (f) scanQrFromPhoto(f);
                                    e.target.value = "";
                                }}
                            />
                        </label>

                        {linkNote && (
                            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                {linkNote}
                            </p>
                        )}

                        {linkCandidate && (
                            <div className="rounded-md border p-3 text-sm">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">{linkCandidate.no}</span>
                                    {linkCandidate.trash && (
                                        <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-xs text-rose-700">
                                            {L("在回收箱里", "In trash")}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">{linkCandidate.text}</p>
                            </div>
                        )}
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setLinkOpen(false)} disabled={linkBusy}>
                            {L("关闭", "Close")}
                        </Button>
                        <Button onClick={() => doLink()} disabled={!linkCandidate || linkBusy}>
                            {linkBusy ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <Link2 className="mr-2 h-4 w-4" />
                            )}
                            {L("添加到本题", "Attach")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
