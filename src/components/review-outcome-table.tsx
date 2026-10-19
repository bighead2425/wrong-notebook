"use client";

import { useState } from "react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
// 三态配色只有一处（与卷页的圆、错题卡的圈**刻意一致**）—— 别在这里自己调一套红绿
import { REVIEW_MARK_COLORS } from "@/lib/scan-marking";
import { isLegacySource, reviewEventSourceLabel } from "@/lib/review-event-source";
import { RECENT_REVIEW_LIMIT, type ReviewOutcome } from "@/lib/review-outcomes";

/**
 * 【2026-10-16 如如】详情页 / 扫到的单题页的「复习结果」—— **一张表**。
 *
 * 出处：`docs\18` §4.2（规格）+ `docs\16`（他 2026-10-16 21:36~22:43 的原话）。
 *
 * ── 它取代了什么 ────────────────────────────────────────────────────
 *   旧的是 `review-outcome-editor.tsx`：**四行计划格 + 一行"最近一次"**，
 *   每行三个圈，改一格就整包覆盖写回。
 *   ⭐ 换成表的原因：复习结果现在是**流水**（`ReviewEvent`，一条一次、带日期），
 *     而"计划第几格"这个概念**只在纸上有意义**（纸背面印着四个日期框）。
 *     界面上再按格子显示，就会出现"表里有 7 条、却只有 4 个格子"的错位。
 *
 * ── 表格（最多 `RECENT_REVIEW_LIMIT` = 4 行）────────────────────────
 *   | 时间 | 来源 | 结果 |
 *   · **无记录** ⇒ 留一行，时间列写「无」
 *   · 点「结果」⇒ 下拉：绿对号 / 粉错号 / 删
 *       - 当前已经是对 ⇒ 点"对"**无效果**（他明确要求）
 *       - 点"错" ⇒ 改成错；点"删" ⇒ 删掉这一条
 *
 * ── 表下面一行 ──────────────────────────────────────────────────────
 *   两个圆（白对号 / 白错号）+「记录」按钮：两个圆**互斥**（不能同时点亮），
 *   点亮后点「记录」⇒ 写一条：**时间 = 现在**、结果 = 点亮那个。
 *
 * ⚠️ **时间列的日期从哪来**：拿 `createdAt`（入库时刻）在**客户端**按本地时区格式化
 *    —— 因为 `occurredOn` 只有"哪一天"、没有时分，凑不出"2026-10-16 21:30"。
 *    对于"扫回来当场点"的用法，两者本来就是同一时刻 ✓
 * ⚠️ `source = 'legacy'`（老数据补的流水）**不显示日期**：老数据里根本没有日期，
 *    补的时候只能拿创建日顶 ⇒ 显示出来就是假的。时间列写「迁移前」。
 * ⚠️ **已掌握的题录不了**（`disabled`）：冻住就真冻住，服务端也会忽略。
 */

/** 一行（接口 `GET /api/error-items/[id]/review-events` 回来的形状） */
export interface ReviewEventRowView {
    id: string;
    /** 客户端算好的日键（`YYYY-MM-DD`） */
    occurredOn: string;
    outcome: ReviewOutcome;
    source: string | null;
    volumeNo?: string | null;
    /** 入库时刻（ISO 串） */
    createdAt: string;
}

/** 本地时区的 `YYYY-MM-DD HH:mm`（容器跑 UTC ⇒ 只能在这一侧算） */
function formatLocalDateTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一个圆圈的样子（选中 = 绿/粉；未选中 = 灰底白符号，"看得出这里可以点"） */
function dotStyle(kind: ReviewOutcome, selected: boolean): React.CSSProperties {
    const base: React.CSSProperties = {
        width: "20px",
        height: "20px",
        borderRadius: "9999px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "11px",
        lineHeight: 1,
        fontWeight: 700,
        padding: 0,
        cursor: "pointer",
    };
    const color = selected ? REVIEW_MARK_COLORS[kind] : REVIEW_MARK_COLORS.none;
    return { ...base, background: color.bg, color: color.fg };
}

/** 结果那一格的小圆（表里只读显示 / 下拉触发） */
function ResultDot({ outcome }: { outcome: ReviewOutcome }) {
    const c = REVIEW_MARK_COLORS[outcome];
    return (
        <span
            style={{
                width: "16px",
                height: "16px",
                borderRadius: "9999px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "10px",
                lineHeight: 1,
                fontWeight: 700,
                background: c.bg,
                color: c.fg,
            }}
        >
            {outcome === "right" ? "✓" : "✗"}
        </span>
    );
}

export function ReviewOutcomeTable({
    events,
    source,
    language = "zh",
    busy = false,
    disabled = false,
    onRecord,
    onChange,
    onDelete,
    L,
}: {
    /** **正序**（末尾 = 最近一次）；最多显示 `RECENT_REVIEW_LIMIT` 行 */
    events: readonly ReviewEventRowView[];
    /**
     * 新记录写哪个来源 —— **由页面按"自己是谁"给**（判据是"从哪个入口进来"，
     * 不能靠二维码内容猜，见 `lib/review-event-source.ts`）：
     *   详情页 ⇒ `detail_page`；扫到的单题页 / 从卷页点加号进来 ⇒ `single_scan`
     */
    source: "detail_page" | "single_scan";
    language?: "zh" | "en";
    busy?: boolean;
    /** 已掌握 ⇒ 全禁用（含下拉里的改/删） */
    disabled?: boolean;
    onRecord: (outcome: ReviewOutcome) => void;
    /** 改某一条的结果（当前已经是对 ⇒ 组件自己不会调它） */
    onChange: (eventId: string, outcome: ReviewOutcome) => void;
    onDelete: (eventId: string) => void;
    L: (zh: string, en: string) => string;
}) {
    /** 表下面那两个圆的点亮态（互斥：存一个值就天然互斥了） */
    const [picked, setPicked] = useState<ReviewOutcome | null>(null);

    /**
     * 最多 4 行、**旧的在上、最新的在下**（`docs\18` §4.2 原写"新的在上面"，
     * 空空 2026-10-17 实测后改口）：
     *   · 错题卡那 4 个圈是"**从左到右 = 从旧到新**"；
     *   · 这张表跟着改成"**从上到下 = 从旧到新**"，两处读起来才是同一个方向。
     */
    const rows = [...events].slice(-RECENT_REVIEW_LIMIT);
    const locked = disabled || busy;

    const record = () => {
        if (!picked || locked) return;
        onRecord(picked);
        setPicked(null);
    };

    return (
        <div className="space-y-2">
            <div className="text-sm font-medium">{L("复习结果", "Review results")}</div>

            {/* 【2026-10-19 手机版面第 1 批】表格允许横滚（空空拍板第 3 条）——
                现在三列够放，但以后加一列就会挤；先给它一个能滚的壳，不用再改这里。 */}
            <div className="overflow-x-auto">
            <table className="w-max min-w-full text-xs">
                <thead>
                    <tr className="text-left text-muted-foreground">
                        <th className="w-[42%] py-1 font-normal">{L("时间", "Time")}</th>
                        <th className="py-1 font-normal">{L("来源", "Source")}</th>
                        <th className="w-[56px] py-1 text-right font-normal">{L("结果", "Result")}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 && (
                        <tr className="border-t">
                            {/* 没记录也留一行：空表会让人以为"这块坏了" */}
                            <td className="py-1.5 text-muted-foreground">{L("无", "None")}</td>
                            <td className="py-1.5 text-muted-foreground">—</td>
                            <td className="py-1.5 text-right text-muted-foreground">—</td>
                        </tr>
                    )}
                    {rows.map((row) => {
                        const legacy = isLegacySource(row.source);
                        return (
                            <tr key={row.id} className="border-t">
                                <td className="py-1.5 font-mono tabular-nums">
                                    {legacy ? L("迁移前", "Before migration") : formatLocalDateTime(row.createdAt)}
                                </td>
                                <td className="py-1.5">
                                    {reviewEventSourceLabel(row.source, {
                                        volumeCode: row.volumeNo,
                                        zh: language === "zh",
                                    })}
                                </td>
                                <td className="py-1.5 text-right">
                                    <DropdownMenu>
                                        {/* ⚠️ `disabled` 挂在**子按钮**上，不挂在 Trigger 上 ——
                                            用了 `asChild` 之后 Trigger 自己的 props 不保证会落到真实按钮上
                                            （React 只把"能识别的"传下去），挂子元素上才是准的。 */}
                                        <DropdownMenuTrigger asChild>
                                            <button
                                                type="button"
                                                disabled={locked}
                                                className="rounded-full disabled:opacity-50"
                                                title={L("点一下改结果 / 删除", "Click to change or delete")}
                                                aria-label={L("改结果 / 删除", "Change or delete")}
                                            >
                                                <ResultDot outcome={row.outcome} />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                /* 当前已经是对 ⇒ 点了没效果（他明确要求），所以直接不渲染那一下 */
                                                onClick={() => {
                                                    if (row.outcome !== "right") onChange(row.id, "right");
                                                }}
                                            >
                                                <span style={{ color: REVIEW_MARK_COLORS.right.bg }}>✓</span>
                                                {L("改成做对", "Mark correct")}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => {
                                                    if (row.outcome !== "wrong") onChange(row.id, "wrong");
                                                }}
                                            >
                                                <span style={{ color: REVIEW_MARK_COLORS.wrong.fg }}>✗</span>
                                                {L("改成做错", "Mark wrong")}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                className="text-rose-600"
                                                onClick={() => onDelete(row.id)}
                                            >
                                                {L("删掉这条", "Delete this one")}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            </div>

            {/* 表下面那一行：两个圆互斥 + 「记录」*/}
            <div className="flex items-center gap-2 pt-1">
                <button
                    type="button"
                    disabled={locked}
                    aria-pressed={picked === "right"}
                    style={dotStyle("right", picked === "right")}
                    title={L("记一次：做对了", "Record: correct")}
                    onClick={() => setPicked(picked === "right" ? null : "right")}
                >
                    ✓
                </button>
                <button
                    type="button"
                    disabled={locked}
                    aria-pressed={picked === "wrong"}
                    style={dotStyle("wrong", picked === "wrong")}
                    title={L("记一次：做错了", "Record: wrong")}
                    onClick={() => setPicked(picked === "wrong" ? null : "wrong")}
                >
                    ✗
                </button>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!picked || locked}
                    onClick={record}
                >
                    {busy ? L("记录中…", "Saving…") : L("记录", "Record")}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                    {L(`来源：${source === "detail_page" ? "本页录入" : "单题扫描录入"}`, `Source: ${source}`)}
                </span>
            </div>

            {disabled && (
                <p className="text-[11px] text-amber-700">
                    {L("这道题已掌握 ⇒ 录不了。要先取消已掌握才能继续录。", "Mastered — unmark it first to record.")}
                </p>
            )}
        </div>
    );
}
