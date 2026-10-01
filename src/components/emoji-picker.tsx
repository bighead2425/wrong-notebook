"use client";

/**
 * 【2026-10-01】中文 emoji 候选浮层（纯展示 + 点选，不含任何编辑器逻辑）。
 *
 * 设计要点（都对应评估报告第 4 节）：
 *   ① **必须 portal 到 document.body**：编辑区外层有 overflow 约束（表格要横向滚动），
 *      浮层放在编辑区里会被裁掉。Obsidian 原版也是直接挂 body。
 *   ② **点选用 onPointerDown + preventDefault**，而不是 onClick —— 这样编辑区不会先失焦
 *      （ProseMirror 的插入逻辑结束后本来就会 focus()，双保险；也避开 iOS 上 blur 先于 click 的老问题）。
 *   ③ **跟着光标定位，但要避让软键盘**：用 window.visualViewport 拿"真正可见的高度"，
 *      下方放不下就翻到上方；再放不下就压缩最大高度并从面板内部滚动。
 *   ④ 面板内滚动不带动页面：overscroll-behavior: contain。
 *   ⑤ 手机上格子放大到 ≥ 40px（手指点得准）。
 *
 * 本组件**不接触任何文档/事务**：选中只是回调 `onSelect(item)`，
 * 真正的插入由 md-editor.tsx 走编辑器事务完成（红线见 md-editor.tsx 文件头）。
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { EmojiIndexItem } from '@/lib/emoji-search';

/** 面板网格列数（方向键 ↑↓ 一次跳一行的距离由它决定，md-editor 也要用） */
export const EMOJI_PICKER_COLS = 7;
/** 格子边长（px）—— 手机上按手指点得准来放大 */
const CELL_PX = 40;
/** 面板最大高度（px）—— 超过就在面板内部滚动 */
const PANEL_MAX_H = 260;
/** 面板左右上下留白（避免贴边被裁） */
const GAP = 8;

export interface EmojiPickerAnchor {
    /** 光标处（触发标记末尾）的屏幕坐标 */
    left: number;
    top: number;
    bottom: number;
}

export interface EmojiPickerViewState {
    /** `；；` 起点在文档中的位置 */
    from: number;
    /** `：：` 终点（即光标）在文档中的位置 */
    to: number;
    /** 搜索词 */
    query: string;
    /** `；；…：：` 的原文（插入时用它校验"这段还是原来那段"，防止错位吞字） */
    raw: string;
    /** 命中的候选（已按搜索词过滤） */
    items: EmojiIndexItem[];
    /** 当前高亮项下标（键盘操作由插件维护） */
    activeIndex: number;
    anchor: EmojiPickerAnchor;
}

export interface EmojiPickerProps {
    /** null ⇒ 不展示 */
    state: EmojiPickerViewState | null;
    onSelect: (item: EmojiIndexItem) => void;
    /** 点面板外 / 需要关闭时调用（只关面板，**不改文档**） */
    onClose: () => void;
}

export function EmojiPicker({ state, onSelect, onClose }: EmojiPickerProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);

    // 点面板以外的任何地方 ⇒ 关闭（只关面板，绝不改文档）
    useEffect(() => {
        if (!state) return;
        const onPointerDown = (event: PointerEvent) => {
            if (panelRef.current?.contains(event.target as Node)) return;
            onClose();
        };
        // 捕获阶段：比编辑区自己的处理更早看到，避免"点了别处却在编辑区里换了光标又留着面板"
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, [state, onClose]);

    // SSR 阶段 state 恒为 null（只有客户端的编辑器插件会回调它）⇒ 不会碰到 document
    if (!state) return null;

    const { items, activeIndex, anchor } = state;
    const panelWidth = EMOJI_PICKER_COLS * CELL_PX + GAP * 2;

    // ---- 定位：优先光标下方，放不下翻上方，再不够就压缩高度内部滚动 ----
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const viewTop = vv?.offsetTop ?? 0;
    const viewBottom = viewTop + (vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0));
    const viewLeft = vv?.offsetLeft ?? 0;
    const viewWidth = vv?.width ?? (typeof window !== 'undefined' ? window.innerWidth : panelWidth);

    const rows = Math.max(1, Math.ceil(items.length / EMOJI_PICKER_COLS));
    const wantH = Math.min(PANEL_MAX_H, rows * CELL_PX + 34);
    const spaceBelow = viewBottom - anchor.bottom - GAP;
    const spaceAbove = anchor.top - viewTop - GAP;
    const flipUp = spaceBelow < wantH && spaceAbove > spaceBelow;
    const maxH = Math.max(140, flipUp ? Math.min(wantH, spaceAbove) : Math.min(wantH, spaceBelow));
    const top = flipUp ? Math.max(viewTop + GAP, anchor.top - maxH - 4) : anchor.bottom + 4;
    const left = Math.min(Math.max(viewLeft + GAP, anchor.left), viewLeft + viewWidth - panelWidth - GAP);

    const panel = (
        <div
            ref={panelRef}
            role="listbox"
            aria-label="选择 emoji"
            data-emoji-picker
            className="fixed z-[80] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg"
            style={{
                left: `${left}px`,
                top: `${top}px`,
                width: `${panelWidth}px`,
                maxHeight: `${maxH}px`,
                overflowY: 'auto',
                overscrollBehavior: 'contain',
            }}
        >
            <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                <span className="truncate">
                    {state.query ? `“${state.query}”` : '全部'}
                </span>
                <span>{items.length} 个</span>
            </div>
            <div
                className="grid"
                style={{ gridTemplateColumns: `repeat(${EMOJI_PICKER_COLS}, 1fr)`, gap: '2px' }}
            >
                {items.map((item, index) => (
                    <button
                        key={`${item.c}-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        title={item.n}
                        // preventDefault：别让编辑区失焦（插入后会 focus()，这里也顺手保住）
                        onPointerDown={(event) => {
                            event.preventDefault();
                            onSelect(item);
                        }}
                        className={`flex items-center justify-center rounded-md text-2xl leading-none transition-colors ${
                            index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                        }`}
                        style={{ height: `${CELL_PX - 4}px` }}
                    >
                        {item.c}
                    </button>
                ))}
            </div>
        </div>
    );

    return createPortal(panel, document.body);
}
