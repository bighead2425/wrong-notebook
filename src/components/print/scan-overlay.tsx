import type { CSSProperties } from 'react';

/**
 * 【扫码浏览】题块上那两件**屏幕控件**：天蓝框 + 中间一个蓝底白加号。
 *
 * 最先只有复练纸有它们（2026-10-01），后来模仿纸也要同一套（他 2026-10-10 设计稿第 8 条：
 * "右边栏每道题和复练卷一样每道题一个蓝框，中间是蓝底中间白加号"）。
 *
 * ⚠️ 抽出来共用（而不是在 `imitate-card.tsx` 里再抄一份）的理由很简单：
 *    这是**同一件东西要长同一个样**，两边各写一遍就会有一边慢慢变样
 *    （颜色差一点、圆小一点、加号粗一点）—— 而"看起来一样"正是他要的效果。
 * ⚠️ 两者都必须带 `no-print`：它们是屏幕控件，**绝不许落纸**。
 * ⚠️ 定位方式：调用方得先给一个 `position: relative` 的包裹层（复练纸/模仿纸都这么做的），
 *    这两个元素自己用 `absolute` 罩在里面 —— 这样纸滚动、缩放时框天然跟着走，不可能漂移。
 */

/** 框的颜色（天蓝，他挑的） */
export const SCAN_FRAME_COLOR = '#38bdf8';
/** 圆底（蓝）与加号（白） */
export const SCAN_PLUS_BG = '#2563eb';
export const SCAN_PLUS_GLYPH = '#ffffff';

/** 加号的 svg 路径 —— 只有这一处写它 */
export const SCAN_PLUS_PATH = 'M12 5v14M5 12h14';

/** 天蓝框：罩住一整块题（`inset` 让它比题块略小一点，看着像框住而不是贴着） */
export function ScanBlockFrame({
    inset = '0.8mm 1mm',
    color = SCAN_FRAME_COLOR,
    radius = '1.6mm',
    zIndex,
}: {
    inset?: string;
    color?: string;
    radius?: string;
    zIndex?: number;
} = {}) {
    const style: CSSProperties = {
        position: 'absolute',
        inset,
        border: `0.45mm solid ${color}`,
        borderRadius: radius,
        boxSizing: 'border-box',
        pointerEvents: 'none',
    };
    if (zIndex !== undefined) style.zIndex = zIndex;
    return <span aria-hidden="true" className="no-print" style={style} />;
}

/**
 * 中间那个**蓝底白加号**（点它 = 进这道题）。
 *
 * @param sizeMM 圆的直径 —— 默认 10mm（手指按得住；比旁边那枚灰圆 11mm 略小）
 */
export function ScanPlusButton({
    onClick,
    title,
    sizeMM = 10,
    zIndex = 6,
    bg = SCAN_PLUS_BG,
    glyph = SCAN_PLUS_GLYPH,
}: {
    onClick: () => void;
    title?: string;
    sizeMM?: number;
    zIndex?: number;
    bg?: string;
    glyph?: string;
}) {
    return (
        <button
            type="button"
            className="no-print"
            title={title}
            onClick={onClick}
            style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: `${sizeMM}mm`,
                height: `${sizeMM}mm`,
                borderRadius: '9999px',
                background: bg,
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                zIndex,
                boxShadow: '0 0.4mm 1.2mm rgba(0,0,0,0.35)',
            }}
        >
            <svg viewBox="0 0 24 24" style={{ width: '5.5mm', height: '5.5mm' }} aria-hidden="true">
                <path d={SCAN_PLUS_PATH} stroke={glyph} strokeWidth={3.4} strokeLinecap="round" fill="none" />
            </svg>
        </button>
    );
}
