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

/**
 * 【2026-10-17 空空要的】题框**左侧**那个「会」字方框 —— 一眼看掌握、点一下切换。
 *
 * 他的原话：*"所有题框（蓝色框）左侧，与右侧点击正确、错误那个圆圈对称的地方，
 * 设置一个方形按钮……中间写一个'会'字。已掌握 ⇒ 绿底白字；未掌握 ⇒ 灰底白字。
 * 点击这个按钮切换……同时将对应结果即时录入到这道题的'已掌握/未掌握'。"*
 *
 * ⚠️ 为什么放在这个文件：它与蓝框、蓝加号、右侧灰圆是**同一类东西**
 *    （屏幕控件、`no-print`、绝对定位跟着纸走）。散到各自的卡片里写，迟早一边变样。
 * ⚠️ **位置由调用方给**（`leftMM`）—— 三类纸的"左边"不是同一个地方：
 *    · 复练卷 / 模仿卷的主题：`-11mm`（纸的左边距里，与右侧灰圆 `right:-11mm` 对称）
 *    · 模仿卷的附题：**落在中间那条分栏线上**（`-(栏距/2 + 半宽)`）——
 *      栏距只有 4mm，方框必然压住线两侧各一点，这是他要的效果（"摆放在线的上面"）
 * ⚠️ 配色与错题卡的圈、卷页的圆**同一族**（绿=已掌握/对，灰=未掌握/没记）。
 */
/** 方框边长（mm）—— 只有这一处定，调用方算位置时也用它，免得两边对不上 */
export const MASTERY_BOX_SIZE_MM = 8;

export const MASTERY_BOX_COLOR = {
    /** 已掌握：绿底白字（与 `REVIEW_MARK_COLORS.right` 同色系，但语义是"会"） */
    mastered: '#6fbf8b',
    /** 未掌握：灰底白字 */
    notMastered: '#9ca3af',
} as const;

export function MasteryToggleBox({
    mastered,
    onClick,
    title,
    sizeMM = MASTERY_BOX_SIZE_MM,
    leftMM = -11,
    zIndex = 7,
}: {
    /** 这道题现在是"已掌握"吗 */
    mastered: boolean;
    onClick: () => void;
    title?: string;
    /** 方框边长（他说"不用太大，小点就可以"） */
    sizeMM?: number;
    /** 相对题块左缘往左多少毫米（见上面的三类位置） */
    leftMM?: number;
    /** 必须**高于**模仿卷那条分栏线（线是同级兄弟、默认 z-index） */
    zIndex?: number;
}) {
    return (
        <button
            type="button"
            className="no-print"
            title={title}
            aria-pressed={mastered}
            onClick={onClick}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{
                position: 'absolute',
                left: `${leftMM}mm`,
                top: '50%',
                transform: 'translateY(-50%)',
                width: `${sizeMM}mm`,
                height: `${sizeMM}mm`,
                borderRadius: '1.2mm',
                border: 'none',
                background: mastered ? MASTERY_BOX_COLOR.mastered : MASTERY_BOX_COLOR.notMastered,
                color: '#ffffff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '8.5pt',
                fontWeight: 700,
                lineHeight: 1,
                cursor: 'pointer',
                boxShadow: '0 0.3mm 1mm rgba(0,0,0,0.3)',
                zIndex,
                touchAction: 'manipulation',
            }}
        >
            会
        </button>
    );
}

/**
 * 【2026-10-18 空空第 2 条】把**某一道题**在卷面上凸显出来。
 *
 * 场景：*"在点击二维码的条件进入已有组卷的，点击打开复练卷、模仿卷……
 *       能够凸显一下这道题，比如把这道题前面的流水号标出颜色也可以"*
 * ⇒ 他真正要的是"一眼找到它"。这里用**橙色描边 + 左上角小标签**，比改流水号颜色更醒目，
 *   而且**完全不碰纸面元素** —— 流水号的颜色是要印到纸上的，不能为了屏幕改。
 *
 * ⚠️ 两层都必须：`no-print`（绝不落纸）+ `pointerEvents: none`（不挡"会"字框 / 灰圆 / 加号的点击，
 *    也不挡拖动缩放）。`zIndex` 压在 4/5：那些按钮是 7，仍在其上。
 * ⚠️ 必须放在一个 `position: relative` 的容器里（题块外框 / 模仿卷左栏的罩框外层）。
 */
export function HighlightBox({ label }: { label: string }) {
    return (
        <>
            <span
                className="no-print"
                aria-hidden
                style={{
                    position: 'absolute',
                    top: '-0.6mm',
                    left: '-0.6mm',
                    right: '-0.6mm',
                    bottom: '-0.6mm',
                    border: '0.7mm solid #f59e0b',
                    borderRadius: '1.2mm',
                    boxShadow: '0 0 0 0.6mm rgba(245, 158, 11, 0.22)',
                    pointerEvents: 'none',
                    zIndex: 4,
                }}
            />
            <span
                className="no-print"
                style={{
                    position: 'absolute',
                    top: '-3.4mm',
                    left: 0,
                    background: '#f59e0b',
                    color: '#ffffff',
                    fontSize: '7pt',
                    fontWeight: 700,
                    lineHeight: 1.25,
                    padding: '0.2mm 1.2mm',
                    borderRadius: '0.8mm',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                    zIndex: 5,
                }}
            >
                {label}
            </span>
        </>
    );
}
