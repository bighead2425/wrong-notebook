"use client";

import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * 题块要给这对按钮**永远**留出的一条右边带（mm）。
 *
 * ⚠️ 关键是"永远"：量尺容器里**不画**按钮（那一路不传回调），
 *    要是只有正式版面留这条带子，两边文本的折行宽度就不一样，
 *    量到的高度 ≠ 印出来的高度 —— 分页立刻开始出错（这是这个项目踩过几次的老坑）。
 *    所以留白写在**题块自己身上**，与画不画按钮无关。
 */
export const MOVE_BUTTONS_RESERVE_MM = 5;

/**
 * 【2026-10-12】题块右上角那对**上移 / 下移**按钮（只在屏幕上、**绝不打印**）。
 *
 * 他要的东西（原话提炼）：
 *   *"右边给一组按钮符号，一个是尖朝上的大于号，一个是尖朝下的大于号，两个按钮符号竖直排列，
 *     当点相应某道题的上面大于号，则这道题往前移动一题，和上一题交换位置和流水号……
 *     提示：这个功能在「积累纸·打印」页面，有过类似的开发。"*
 *
 * 为什么抽成一个共用件（而不是在复练纸、模仿纸各写一份）：
 *   两处要**长得一模一样** —— 复练纸右栏的题、模仿纸右栏的附题，在"能上下挪"这件事上
 *   是同一个操作。各写一份的下场是"一个 3.2mm 一个 3.6mm、一个能点到按钮一个点不到"。
 *   与「积累纸·打印」那对按钮同一套外观（那里也是 ChevronUp/ChevronDown 竖排）。
 *
 * ⚠️ **绝对定位**：它不参与布局 ⇒ 量尺量出来的高度与正式版面一字不差
 *    （老规矩：量到的必须是印出来的）。
 * ⚠️ `no-print`：这是操作，纸上不许出现箭头。
 * ⚠️ 到边界的那一头**灰掉但仍在位**（`disabled`）—— 两个按钮都不见了的话，
 *    他会以为这个功能时有时无；一直在位、灰着，才读得出"到头了"。
 *    两个回调都没给 ⇒ 整个组件不渲染（量尺容器、卷管理页、扫码那几路都是这样）。
 */
export function MoveButtons({
    onMoveUp,
    onMoveDown,
    titleUp,
    titleDown,
}: {
    /** 上移一位（和上一题交换顺序与流水号）；不给 = 已经是最上面那道 */
    onMoveUp?: () => void;
    /** 下移一位；不给 = 已经是最后一道 */
    onMoveDown?: () => void;
    titleUp: string;
    titleDown: string;
}) {
    if (!onMoveUp && !onMoveDown) return null;

    const style = (enabled: boolean) =>
        ({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '4.2mm',
            height: '3.6mm',
            padding: 0,
            border: '0.2mm solid #c9c9c9',
            borderRadius: '0.8mm',
            background: '#ffffff',
            cursor: enabled ? 'pointer' : 'default',
            opacity: enabled ? 1 : 0.3,
            lineHeight: 1,
        }) as const;

    return (
        <span
            className="print-move-buttons no-print"
            style={{
                position: 'absolute',
                right: 0,
                top: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5mm',
                zIndex: 5,
            }}
        >
            <button type="button" title={titleUp} disabled={!onMoveUp} onClick={onMoveUp} style={style(!!onMoveUp)}>
                <ChevronUp style={{ width: '3mm', height: '3mm' }} />
            </button>
            <button
                type="button"
                title={titleDown}
                disabled={!onMoveDown}
                onClick={onMoveDown}
                style={style(!!onMoveDown)}
            >
                <ChevronDown style={{ width: '3mm', height: '3mm' }} />
            </button>
        </span>
    );
}
