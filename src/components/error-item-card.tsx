"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckCircle, Clock, Printer, Trash2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ErrorItem } from "@/types/api";
import {
    DEEP_NUDGE_COLOR,
    getManageTypeLabel,
    manageTypeScreenColor,
    needsDeepPrintNudge,
} from "@/lib/manage-type";
import { getMistakeCategoryLabel, normalizeMistakeCategory } from "@/lib/mistake-category";
import { attentionLevelOf } from "@/lib/attention-level";
import { cleanMarkdown } from "@/lib/markdown-utils";
import { PrintCounts } from "@/components/print-counts";
import { ReviewDots } from "@/components/review-dots";

/**
 * 【2026-10-01 抽出来的共享组件】**错题卡**。
 *
 * 为什么抽：他 2026-10-01 的「扫一扫」需求原话是
 *   *"直接提供这道题在错题本页中的错题卡，上面很多可便捷操作的功能在错题卡上已经能实现了"*
 * —— 也就是**扫码结果页要的就是这张卡本身**。抄第二份必然走样（改了一处忘了另一处），
 * 所以卡片只有这一份实现：错题本页与扫码结果页都用它。
 *
 * ── 卡片上"即点即存"的五个位置（都不进详情页）──────────────────────────
 *   左上：待复习 ⇄ 已掌握      （`onToggleMastery`）
 *   右上：等级奖牌（点一下升一级，👑 回 🥉）+ 录入时间 + 垃圾桶（`onCycleAttention` / `onTrash`）
 *   右下：类型标签（点一下轮转 深挖→复练→未定）（`onCycleManageType`）
 *   左下：打印机图标（进深挖纸界面；**深挖未印时上色**）+ 两个打印次数（`onDeepDivePrint`）
 *   底端中间：四个复习结果圆圈（只读展示，详情页才可改）
 *
 * ⚠️ **发请求不在这里**：组件只负责"点了哪个"，保存与乐观更新交给父组件
 *   （错题本页走列表的 `patchItemFields`，扫码页走它自己的单题状态）。
 *   这样同一种交互只有一套 UI、两套数据来源各管各的。
 *
 * ⚠️ 卡片主体（题干、徽章）在 `<Link>` 里，而**四个绝对定位的操作件都在 Link 外面**：
 *   按钮套在链接里点一下会连跳转一起触发（早先踩过）。外面这些各自 `preventDefault`。
 */
export interface ErrorItemCardProps {
    item: ErrorItem;
    /** 点卡片去哪；默认进这道题的详情页 */
    href?: string;
    /** 多选模式（错题本页专有）：左上出现勾选框、点卡片任意处 = 切换选中、标签不再响应点击 */
    selectMode?: boolean;
    selected?: boolean;

    onToggleSelect?: (e: ReactMouseEvent) => void;
    onToggleMastery?: (e: ReactMouseEvent) => void;
    onCycleAttention?: (e: ReactMouseEvent) => void;
    onCycleManageType?: (e: ReactMouseEvent) => void;
    onTrash?: (e: ReactMouseEvent) => void;
    onDeepDivePrint?: (e: ReactMouseEvent) => void;

    /** 标签：展开态与点击（列表页用来筛选题；扫码页不传 = 纯展示） */
    tagsExpanded?: boolean;
    onToggleTagsExpanded?: (e: ReactMouseEvent) => void;
    onTagClick?: (tag: string, e: ReactMouseEvent) => void;
    /** 当前选中的标签（高亮用）；不传 = 不高亮 */
    selectedTag?: string | null;
}

export function ErrorItemCard({
    item,
    href,
    selectMode = false,
    selected = false,
    onToggleSelect,
    onToggleMastery,
    onCycleAttention,
    onCycleManageType,
    onTrash,
    onDeepDivePrint,
    tagsExpanded = false,
    onToggleTagsExpanded,
    onTagClick,
    selectedTag = null,
}: ErrorItemCardProps) {
    const { t, language } = useLanguage();
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);

    /** "深挖了还没印"要不要提醒（判定只有一处，详情页那个黄底计数用的是同一个函数） */
    const nudge = needsDeepPrintNudge(item);

    // 优先使用 tags 关联，回退到 knowledgePoints
    let tags: string[] = [];
    if (item.tags && item.tags.length > 0) {
        tags = item.tags.map((tag) => tag.name);
    } else {
        try {
            tags = JSON.parse(item.knowledgePoints || "[]");
        } catch {
            tags = [];
        }
    }

    const rawText = (item.questionText || "").split("\n\n")[0];
    const cleanText = cleanMarkdown(rawText);
    const preview = cleanText.length > 80 ? `${cleanText.substring(0, 80)}...` : cleanText;

    return (
        <div className="relative">
            {/* 选择模式下的复选框 */}
            {selectMode && (
                <div className="absolute top-2 left-2 z-10" onClick={onToggleSelect}>
                    <Checkbox checked={selected} className="h-5 w-5 border-2 bg-background shadow-sm" />
                </div>
            )}

            <Link
                href={selectMode ? "#" : (href ?? `/error-items/${item.id}`)}
                onClick={(e) => {
                    if (!selectMode) return;
                    e.preventDefault();
                    onToggleSelect?.(e);
                }}
            >
                <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer gap-2 pt-4">
                    <CardHeader className="pb-0">
                        <div className="flex justify-between items-start">
                            {/* 左上角：「待复习 / 已掌握」点一下互转并保存。
                                ⚠️ 点到"已掌握"后这道题就不在主库了（四分法：主库 = masteryLevel<2），
                                   刷新/换筛选后它会进"已掌握分区"；再点回来就回来。 */}
                            <Badge
                                variant={item.masteryLevel > 0 ? "default" : "secondary"}
                                className={`${item.masteryLevel > 0 ? "bg-green-600 hover:bg-green-700" : ""} ${selectMode ? "" : "cursor-pointer"}`}
                                title={item.masteryLevel > 0
                                    ? L("点一下改回「待复习」", "Click to mark as to-review")
                                    : L("点一下标成「已掌握」", "Click to mark as mastered")}
                                onClick={selectMode ? undefined : onToggleMastery}
                            >
                                {item.masteryLevel > 0 ? (
                                    <span className="flex items-center gap-1">
                                        <CheckCircle className="h-3 w-3" /> {t.notebook.mastered}
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-1">
                                        <Clock className="h-3 w-3" /> {t.notebook.review}
                                    </span>
                                )}
                            </Badge>
                            {/* 右上角：等级奖牌 + 录入时间 + 垃圾桶 */}
                            <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                    type="button"
                                    className={`mr-0.5 rounded px-0.5 text-sm leading-none ${selectMode ? "cursor-default" : "cursor-pointer hover:bg-muted"}`}
                                    title={L(
                                        `等级：${attentionLevelOf(item.attention).zh}（点一下升一级）`,
                                        `Level: ${attentionLevelOf(item.attention).en} (click to upgrade)`,
                                    )}
                                    onClick={selectMode ? undefined : onCycleAttention}
                                >
                                    {attentionLevelOf(item.attention).medal}
                                </button>
                                <span className="text-xs text-muted-foreground">
                                    {format(new Date(item.createdAt), "MM/dd")}
                                </span>
                                {/* 【2026-10-01】垃圾桶**只在给了 onTrash 时出现**：
                                    日积月累页也出这张卡，但在那里点"删错题"人会发懵
                                    （"我删的是积累还是错题？"）—— 删除回错题本页/扫码页做。 */}
                                {onTrash && (
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        className="text-muted-foreground hover:text-destructive"
                                        title={t.common?.delete || "Move to trash"}
                                        onClick={onTrash}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="text-sm line-clamp-3">{preview}</div>
                        {/* 错因（8 种里的一种）。没打错因就不占位 */}
                        <div className="flex flex-wrap gap-2 mt-3">
                            {normalizeMistakeCategory(item.mistakeCategory) && (
                                <Badge variant="secondary" className="text-xs">
                                    {getMistakeCategoryLabel(item.mistakeCategory, language)}
                                </Badge>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-2 mt-3">
                            {(tagsExpanded ? tags : tags.slice(0, 3)).map((tag: string) => (
                                <Badge
                                    key={tag}
                                    variant={selectedTag === tag ? "default" : "outline"}
                                    className={`text-xs transition-colors ${selectMode || !onTagClick ? "" : "cursor-pointer hover:bg-primary/10"}`}
                                    /* 多选模式下标签不再响应点击：此时点卡片任意处＝切换选中，
                                       标签要是还能筛选题，就会出现"点一下同时干了两件事"的歧义 */
                                    onClick={
                                        selectMode || !onTagClick
                                            ? undefined
                                            : (e) => onTagClick(tag, e)
                                    }
                                >
                                    {tag}
                                </Badge>
                            ))}
                            {tags.length > 3 && (
                                <Badge
                                    variant="secondary"
                                    className={`text-xs transition-colors ${selectMode || !onToggleTagsExpanded ? "" : "cursor-pointer hover:bg-secondary/80"}`}
                                    title={tagsExpanded
                                        ? (t.notebooks?.collapseTagsTooltip || "Click to collapse")
                                        : (t.notebooks?.expandTagsTooltip || "Click to expand {count} tags").replace("{count}", (tags.length - 3).toString())}
                                    onClick={selectMode ? undefined : onToggleTagsExpanded}
                                >
                                    {tagsExpanded ? (
                                        <>{t.notebooks?.collapseTags || "Collapse"}</>
                                    ) : (
                                        <>{(t.notebooks?.expandTags || "+{count} more").replace("{count}", (tags.length - 3).toString())}</>
                                    )}
                                </Badge>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </Link>

            {/* 右下角：复习类型（深挖/复练/未定），点一下轮转、即点即存。
                用绝对定位而不是塞进标签流：标签会换行，`ml-auto` 在 flex-wrap 里靠不住。 */}
            <button
                type="button"
                className={`absolute bottom-2 right-3 text-[11px] font-semibold ${selectMode ? "cursor-default" : "cursor-pointer hover:underline"}`}
                style={{ color: manageTypeScreenColor(item.manageType) }}
                title={L("点一下换类型：深挖 → 复练 → 未定", "Click to cycle: deep → review → undecided")}
                onClick={selectMode ? undefined : onCycleManageType}
            >
                {getManageTypeLabel(item.manageType)}
            </button>

            {/* 左下角：打印机图标（进深挖纸界面；**深挖未印时上色**）+ 两个打印次数 */}
            <span className="absolute bottom-2 left-3 flex items-center gap-1 text-[11px]">
                <button
                    type="button"
                    className={`shrink-0 rounded p-0.5 ${selectMode ? "cursor-default" : "cursor-pointer hover:bg-muted"}`}
                    style={{ color: nudge ? DEEP_NUDGE_COLOR : undefined }}
                    title={nudge
                        ? L("这是深挖题、还没印过 —— 点这里去印深挖纸", "Deep-dive item, not printed yet — click to print")
                        : L("打印这道题的深挖纸", "Print the deep-dive sheet for this item")}
                    onClick={selectMode ? undefined : onDeepDivePrint}
                >
                    <Printer className="h-3.5 w-3.5" />
                </button>
                <span
                    className="pointer-events-none"
                    title={`深挖纸打印次数 ${item.printCount ?? 0} ｜ 复练纸印刷次数 ${item.reviewPrintCount ?? 0}`}
                >
                    <PrintCounts deep={item.printCount} review={item.reviewPrintCount} compact />
                </span>
            </span>

            {/* 底端中间：四个复习结果圆圈（前三个 = 第 1/7/21 天计划复习，第四个 = 最近一次） */}
            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-none">
                <ReviewDots outcomes={item.reviewOutcomes} language={language} />
            </span>
        </div>
    );
}
