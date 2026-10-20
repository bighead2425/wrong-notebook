"use client";

/**
 * 【2026-10-19 空空第 2 条】**「举一反三」变成一扇门**
 *
 * 他原话：
 *   "把『关联别的题』和『举一反三』功能进行合并，在错题详情页，点击右上角的『举一反三』，
 *    目前是生成练习题的功能，现在把『扫到的这道题』页中，点击关联别的题的功能
 *    即『扫码关联』『题库里没有，拍照』这两个功能也放到里面去。
 *    同样的将生成练习题的功能也放到关联别的题里面去。"
 *
 * ── 读法（这一条有两种理解，我按这个做的）──────────────────────────
 *   "合并"不是把两件事塞进同一屏，而是：**点同一个入口，弹出这一组选择**。
 *   原来：点【举一反三】= 直接跳去生成练习题（没有选择）。
 *   现在：点【举一反三】= 弹出三个选项 ——
 *     ① 生成练习题（原功能，第一项，因为它最常用）
 *     ② 扫码关联（扫另一道题的二维码，挂到这道题下面）
 *     ③ 题库里没有 → 拍照新增一道，并挂到这道题下面
 *
 * ── 为什么不做成"三个并列按钮"放在页面上 ──────────────────────────
 *   详情页右上角已经有 5 个按钮（导出 / 举一反三 / 掌握 / 删除 / 打印…），
 *   再加两个会把那一行彻底挤爆（他这一轮第 5 条骂的就是手机端挤）。
 *   **一个入口 + 一层选择**，反而更省地方，也更符合"举一反三"这四个字的意思：
 *   不是"再练一道"，而是"围绕这道题再做点什么"。
 */

import { useRouter } from "next/navigation";
import { Camera, FileUp, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";

export interface PracticeLinkDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** 当前这道题的内部 id（关联时当 from） */
    itemId: string;
    /** 题号（`SX…`），只用来在提示语里说清"围绕哪道题" */
    itemNo: string;
    /** 这道题所在的错题本；没有就不给"拍照新增"那条（新题得有地方放） */
    notebookId?: string | null;
}

export function PracticeLinkDialog({
    open,
    onOpenChange,
    itemId,
    itemNo,
    notebookId,
}: PracticeLinkDialogProps) {
    const router = useRouter();
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{L("举一反三", "Build on this question")}</DialogTitle>
                    <DialogDescription>
                        {L(
                            `围绕「${itemNo}」做点什么。`,
                            `What would you like to do with “${itemNo}”?`,
                        )}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    {/* ① 生成练习题 —— 原来的【举一反三】，放第一项（最常用） */}
                    <Button
                        className="h-auto w-full justify-start gap-3 py-3"
                        onClick={() => {
                            onOpenChange(false);
                            router.push(`/practice?id=${itemId}`);
                        }}
                    >
                        <RefreshCw className="h-4 w-4 shrink-0" />
                        <span className="flex flex-col items-start text-left">
                            <span>{L("生成练习题", "Generate practice questions")}</span>
                            <span className="text-xs font-normal opacity-80">
                                {L("按这道题的知识点，出几道同类题", "Same knowledge point, new questions")}
                            </span>
                        </span>
                    </Button>

                    {/* ② 扫码关联 —— 与"扫到的这道题"页里那个【打开扫码】同一条路 */}
                    <Button
                        variant="outline"
                        className="h-auto w-full justify-start gap-3 py-3"
                        onClick={() => {
                            onOpenChange(false);
                            /**
                             * 走 `/scan` 的**关联模式**（不是跳到那道题去看）。
                             * ⚠️ 那边原本只有"扫到的这道题"页内部的回调能进（`startLinkScan`），
                             *    没有 URL 入口 ⇒ 这一条是本次新开的：`?linkFrom=` + `?linkFromNo=`。
                             *    两个都带，是因为扫到之后那句"挂到 SX… 下面？"要用题号说人话。
                             */
                            const qs = new URLSearchParams({
                                linkFrom: itemId,
                                linkFromNo: itemNo,
                                /**
                                 * 返回键的落点：**这道题的详情页**。
                                 * 不加这个的话，扫不出来想退出，一按返回就跳回主页 ——
                                 * 那道题还得重新找一遍（`/scan` 的返回键是 push 固定目标，不是 history.back）。
                                 */
                                back: `/error-items/${itemId}`,
                            });
                            router.push(`/scan?${qs.toString()}`);
                        }}
                    >
                        <Camera className="h-4 w-4 shrink-0" />
                        <span className="flex flex-col items-start text-left">
                            <span>{L("扫码关联另一道题", "Link another question by scanning")}</span>
                            <span className="text-xs font-normal opacity-70">
                                {L("扫那道题纸上的题号二维码", "Scan the question-no QR on its paper")}
                            </span>
                        </span>
                    </Button>

                    {/* ③ 拍照新增 —— 题库里没有这条路。与"扫到的这道题"页那条完全同义 */}
                    {notebookId ? (
                        <Button
                            variant="outline"
                            className="h-auto w-full justify-start gap-3 py-3"
                            onClick={() => {
                                onOpenChange(false);
                                router.push(`/notebooks/${notebookId}/add?linkTo=${itemId}`);
                            }}
                        >
                            <Plus className="h-4 w-4 shrink-0" />
                            <span className="flex flex-col items-start text-left">
                                <span>{L("题库里没有 → 拍照新增", "Not in the notebook → add by photo")}</span>
                                <span className="text-xs font-normal opacity-70">
                                    {L("拍一张、新建一道，并挂到这道题下面", "Photograph a new one and attach it here")}
                                </span>
                            </span>
                        </Button>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            {L(
                                "（这道题还没归到任何错题本，所以只能关联已有的题）",
                                "(This question has no notebook yet, so only existing ones can be linked.)",
                            )}
                        </p>
                    )}
                    {/* ④【2026-10-21 空空】从收件箱拉取 PDF ——
                        试卷宝只能导出 PDF，所以这条链路是：PDF → 逐页转图 → 走原来的录入。
                        导入的题会以 `parentId = itemId` 挂到这道题下面（附题）。 */}
                    <Button
                        variant="outline"
                        className="h-auto w-full justify-start gap-3 py-3"
                        onClick={() => {
                            onOpenChange(false);
                            const qs = new URLSearchParams({ dir: "scan2pdf", parent: itemId });
                            router.push(`/batch?${qs.toString()}`);
                        }}
                    >
                        <FileUp className="h-4 w-4 shrink-0" />
                        <span className="flex flex-col items-start text-left">
                            <span>{L("从收件箱拉取（PDF）", "Pull from inbox (PDF)")}</span>
                            <span className="text-xs font-normal opacity-70">
                                {L(
                                    "试卷宝导出的 PDF：按页转成图片，逐道挂到这道题下面",
                                    "PDF from the exam app: pages become images, attached here",
                                )}
                            </span>
                        </span>
                    </Button>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {L("关闭", "Close")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
