"use client";

import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * 这对按钮**探出题块右缘多少 mm**（负值 = 往纸边方向探出去）。
 *
 * 【2026-10-12 需求第 13 条 他改主意了】原来是在题块里**预留 5mm 一条带子**把它们放下，
 * 他实测后否掉了 —— 原话："这个大于号的位置目前已经侵入题干原来的位置了…… 
 * 把这个大于号尽量往页面边上放，放到贴近页边沿，甚至是页边沿外面都可以，
 * 这样的话就不耽搁题干的排版了……向上和向下在卷组建成功后进入已组建卷内后，
 * 这个大于号就不存在了，反而之前在最初组建的时候因为侵入题干的影响一直到组建完毕，
 * 这样得不偿失。"
 *
 * ⇒ 现在**一个字都不给题干让位**，整对按钮挂到题块右缘**外面**去：
 *   题块右缘就是纸的内容区右缘，再往右就是 15mm 的页边距 —— 正好够放。
 *   （屏幕上纸的盒子比内容区两侧各宽 15mm，所以它看得见；打印时它们是 `no-print`，根本不出现。）
 *
 * ⚠️ 与"右侧那个灰色流水号圆圈"（`right: -11mm`）共用这条页边距：**不会打架** ——
 *    圆圈在题块的**垂直正中**，这对箭头在题块**顶上**，一上一下错开。
 */
export const MOVE_BUTTONS_OFFSET_MM = 6;

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
                /** 负值 = 探到题块右缘**外面**（纸的页边距里），不再占题干的宽度 */
                right: `-${MOVE_BUTTONS_OFFSET_MM}mm`,
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
