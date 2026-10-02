import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Fragment } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import {
    COLUMN_GAP_MM,
    REVIEW_FIGURE_BOX_RATIO,
    REVIEW_LAYOUT_MM,
    REVIEW_PAGE_HEIGHT_MM,
    REVIEW_PUNCH_GUTTER_MM,
    type MeasuredPageLayout,
} from '@/lib/review-card';
import { VolumeHeader, stripMarkdownImages } from './review-card';
import { INSIGHT_PLUS_GLYPH_COLOR, insightPlusColor } from '@/lib/insight-plus';

/**
 * **积累纸**（`kind='build'`）—— 把日积月累的条目排成卷印出来。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要单独一个文件，而不是塞进 `review-card.tsx`：
 *
 * 复练纸的题块身上挂了一堆**只属于"题"**的零件：题图缩放把手、升降级小框、
 * 拖虚线调留白、扫码用的天蓝框与加号。积累条目没有这些概念，
 * 硬塞进去只会让那个已经很重的组件再重一层。
 *
 * 但下面这些**必须共用**（一份实现，绝不抄第二份）：
 *   · 分页/分栏：`lib/review-card.ts` 的 `paginateMeasured`（只吃"块 + 高度"，与内容无关）
 *   · 页眉：`review-card.tsx` 的 `VolumeHeader`（卷号 / 页码 / 页二维码 / 打孔让位）
 *   · 版面常量：`REVIEW_PAGE_HEIGHT_MM` / `COLUMN_GAP_MM` / `REVIEW_PUNCH_GUTTER_MM`
 * ══════════════════════════════════════════════════════════════════
 *
 * 版面（他 2026-10-01 定的）：**两栏 + 中间一条灰竖线**，每条下面**留白 1 行**。
 * 「本来就是用来反复阅看的内容，没必要留大白」—— 密排，一页装尽量多。
 */

/** 一条积累在纸上的样子（打印预览页/组卷页传进来的形态） */
export interface InsightPrintRow {
    /** 积累条目的 id（页内快照用 key = id） */
    id: string;
    /** JL 编号（如 JL20261001001） */
    code: string;
    /** 正文（md 源） */
    content: string;
    /** 配图（已取好的 data URL / 路径；一条最多一张） */
    photoUrl?: string | null;
}

/**
 * 一条积累的块。
 *
 * 结构与复练纸的题块刻意保持一致（顶部一条浅虚线 + 内容 + 底部留白），
 * 这样**量高、分页、分栏那套算法拿到的东西形状一样**，不用为积累纸再写一套。
 *
 * ⚠️ `data-insight-block` 是量尺容器的钩子（与题块的 `data-review-block` 同一个用法）：
 *    让"量到的高度"就是"印出来的高度"。
 */
/**
 * 【2026-10-02】积累纸张底部留的**页脚空隙**（mm）。
 * ⚠️ 一处定义、两处使用：纸面上用它当 `paddingBottom`，分页算法用它当"每栏少算这么多"
 *    （见 `paginateMeasured` 的 `reservedMM`）—— 两边必须同源，否则最后一屏会溢出。
 */
export const INSIGHT_FOOTER_MM = 6;

export function InsightBlock({
    row,
    blankLines,
    showDivider,
    figureScale = 100,
    onMoveUp,
    onMoveDown,
    onFigureScaleStart,
    onPlusClick,
    plusLinked = false,
    L,
}: {
    row: InsightPrintRow;
    /** 本条生效的留白行数（积累纸默认 1） */
    blankLines: number;
    /** 本栏内不是第一条时才画那条浅虚线 */
    showDivider: boolean;
    /**
     * 【2026-10-01 排版】这条配图的缩放百分比（100 = 默认）。
     * 与复练纸的题图缩放同一个含义 —— 他把"图要不要小一点"当作印刷手感的一部分。
     */
    figureScale?: number;
    /** 排版用（只在打印页给；不给就不出现那些小按钮） */
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    /**
     * 【2026-10-02 他要求】改回**拖把手**调图大小（与复练纸一模一样）：
     * "图片左上角是锁定的，用户通过拖拉把手调整图片大小" ——
     * 原来那两个 −/+ 百分比按钮"略显复杂了"。签名与复练纸的 `onFigureScaleStart` 一致。
     */
    onFigureScaleStart?: (e: ReactPointerEvent) => void;
    /**
     * 【2026-10-03 需求第 11 条】**扫码预览**专用：点这条中间的圆圈加号。
     * ⚠️ **不传 ⇒ 行为一字不变**（打印页、积累纸打印页都不传）：
     *    框和加号是纯屏幕控件，只在扫码预览那一屏才画。
     */
    onPlusClick?: () => void;
    /**
     * 这条**有没有关联错题**（决定框与圆圈的颜色：棕黄 / 紫）。
     * 只在 `onPlusClick` 给了的时候才有意义；不传按"未关联"（棕黄）处理。
     */
    plusLinked?: boolean;
    L: (zh: string, en: string) => string;
}) {
    const body = stripMarkdownImages(row.content || '');
    const blankMM = blankLines * REVIEW_LAYOUT_MM.blankLineMM;
    /** 框与圆的颜色（棕黄 / 紫）——规则在 `lib/insight-plus.ts`，一处定义 */
    const plusColor = insightPlusColor(plusLinked);

    return (
        <div
            className="print-insight-block"
            data-insight-block={row.id}
            style={{
                display: 'flex',
                flexDirection: 'column',
                flex: '0 0 auto',
                position: 'relative',
                // 【2026-10-02 他要求】分隔虚线改**蓝色** —— 原来灰色"不容易看出一个是一个来"
                borderTop: showDivider ? '0.3mm dashed #5b9bd5' : undefined,
            }}
        >
            {/* 编号一行：JL 编号是这条内容的身份证，印在最上面，
                扫页二维码定位到页之后，靠它认出"说的是哪一条"。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1mm', flex: '0 0 auto' }}>
                <span
                    style={{
                        fontSize: '7.5pt',
                        fontWeight: 700,
                        color: '#555',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {row.code}
                </span>
                <span style={{ flex: 1 }} />
                {/* 【2026-10-01 排版】上移 / 下移（只在屏幕上）。
                    ⚠️ 做成了**按钮而不是拖动**：手机上没有原生拖放，自己做拖拽手势
                    既容易误触、又和整页滚动打架 —— 两个按钮在两头都稳。
                    改完点工具栏的【保存版面】才落库（与复练卷页的"更新组卷"同一套手感）。 */}
                {(onMoveUp || onMoveDown) && (
                    <span className="no-print" style={{ display: 'flex', gap: '0.8mm', flexShrink: 0 }}>
                        <button
                            type="button"
                            title={L('上移一位', 'Move up')}
                            disabled={!onMoveUp}
                            onClick={onMoveUp}
                            style={{ cursor: onMoveUp ? 'pointer' : 'default', opacity: onMoveUp ? 1 : 0.25 }}
                        >
                            <ChevronUp style={{ width: '3.4mm', height: '3.4mm' }} />
                        </button>
                        <button
                            type="button"
                            title={L('下移一位', 'Move down')}
                            disabled={!onMoveDown}
                            onClick={onMoveDown}
                            style={{ cursor: onMoveDown ? 'pointer' : 'default', opacity: onMoveDown ? 1 : 0.25 }}
                        >
                            <ChevronDown style={{ width: '3.4mm', height: '3.4mm' }} />
                        </button>
                    </span>
                )}
            </div>

            {/* 正文：没有内容时留一句提示，别留一片空白让人以为漏印了 */}
            {/* 【2026-10-02 他要求】正文**10pt**，与复练纸题干看齐 —— 原来 9.5pt
                在两栏密排里"实在惨不忍睹，时间长了容易近视眼"。
                （JL 编号保持小字不变 —— 他说"上面的积累号我觉得不用放大了"。） */}
            <div style={{ fontSize: '10pt', lineHeight: 1.55, flex: '0 0 auto', marginTop: '0.5mm' }}>
                {body.trim() ? (
                    <MarkdownRenderer content={body} />
                ) : (
                    <span style={{ color: '#999' }}>{L('（这条没有正文）', '(no content)')}</span>
                )}
            </div>

            {row.photoUrl ? (
                <div
                    style={{
                        flex: '0 0 auto',
                        marginTop: '1mm',
                        position: 'relative',
                        display: 'flex',
                        flexDirection: 'column',
                        /**
                         * 【2026-10-02 他要求】改回**拖把手**（与复练纸完全一样）：
                         * "图片左上角是锁定的，用户通过拖拉把手调整图片大小"。
                         * 手指/笔直接在图上左右拖也能缩（鼠标只认右下角那个把手，免得误拖）——
                         * 复用复练纸那套 `.print-fig-handle`，不另起炉灶。
                         */
                        touchAction: onFigureScaleStart ? 'none' : undefined,
                    }}
                    onPointerDown={(e) => {
                        if (e.pointerType === 'mouse') return; // 鼠标走把手
                        onFigureScaleStart?.(e);
                    }}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */}
                    <img
                        src={row.photoUrl}
                        alt=""
                        style={{
                            /**
                             * 缩放作用在**宽度**上，高度按比例跟 —— 与复练纸题图**同一条思路**
                             * （那个也是 55% × 百分比，上限占满整栏）。默认 100% 占栏宽 55%。
                             */
                            width: `${Math.min(100, REVIEW_FIGURE_BOX_RATIO * figureScale)}%`,
                            maxHeight: `${REVIEW_LAYOUT_MM.figureMaxHeightMM * (figureScale / 100)}mm`,
                            objectFit: 'contain',
                            objectPosition: 'left top', // 左上角固定
                            display: 'block',
                        }}
                    />
                    {onFigureScaleStart && (
                        <span
                            className="print-fig-handle no-print"
                            title={L('拖动调整图片大小（左上角固定）', 'Drag to resize (top-left pinned)')}
                            onPointerDown={(e) => {
                                if (e.pointerType !== 'mouse') return;
                                onFigureScaleStart(e);
                            }}
                        />
                    )}
                </div>
            ) : null}

            {/* 留白：她看完想补一句就写在这儿。积累纸只留 1 行（他定的）。 */}
            <div style={{ flex: '0 0 auto', minHeight: `${blankMM}mm` }} />

            {/*
             * 【2026-10-03 需求第 11 条】扫码预览：给这条罩一层框 + 正中一个"圆圈加号"。
             *
             * 三条照抄复练卷那套（`review-card.tsx` 的扫码加号）：
             *  ① **框与加号都画在本块的 DOM 里面**（本块已是 `position: relative`），
             *     纸滚动/缩放时天然跟着走、**结构上不可能漂移**；
             *  ② 一律 `no-print` —— 屏幕上才有，**纸上零装饰**是铁律；
             *  ③ 圆点 10mm（≥ 他要求的 9mm），按钮够大好点、防误触。
             * 颜色按"该条有没有关联错题"：棕黄（未关联）/ 紫（已关联），见 `lib/insight-plus.ts`。
             */}
            {onPlusClick && (
                <>
                    <span
                        aria-hidden="true"
                        className="no-print"
                        style={{
                            position: 'absolute',
                            inset: '0.8mm 1mm',
                            border: `0.45mm solid ${plusColor}`,
                            borderRadius: '1.6mm',
                            boxSizing: 'border-box',
                            pointerEvents: 'none',
                        }}
                    />
                    <button
                        type="button"
                        className="no-print"
                        title={L('点这里 → 去日积月累页看这条', 'Open this takeaway')}
                        onClick={onPlusClick}
                        style={{
                            position: 'absolute',
                            left: '50%',
                            top: '50%',
                            transform: 'translate(-50%, -50%)',
                            width: '10mm',
                            height: '10mm',
                            borderRadius: '9999px',
                            background: plusColor,
                            border: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            zIndex: 6,
                            boxShadow: '0 0.4mm 1.2mm rgba(0,0,0,0.35)',
                        }}
                    >
                        <svg viewBox="0 0 24 24" style={{ width: '5.5mm', height: '5.5mm' }} aria-hidden="true">
                            <path
                                d="M12 5v14M5 12h14"
                                stroke={INSIGHT_PLUS_GLYPH_COLOR}
                                strokeWidth={3.4}
                                strokeLinecap="round"
                                fill="none"
                            />
                        </svg>
                    </button>
                </>
            )}
        </div>
    );
}

/**
 * 一张积累纸。
 *
 * 与 `ReviewSheet` 的差别只有一处：**块换成了 `InsightBlock`**，其余（页眉、两栏、
 * 中间那条灰竖线、打孔位）全部照抄同一套 —— 他要求"积累纸的版面设计和复练纸基本一致"。
 */
export function InsightSheet({
    page,
    pageNo,
    pageCount,
    volumeNo,
    gradeText,
    printDate,
    emojiMark,
    rowByKey,
    blankLines,
    figureScaleOf,
    onMoveItem,
    onFigureScaleStart,
    totalCount,
    pageQr,
    onItemPlusClick,
    linkedOf,
    L,
}: {
    page: MeasuredPageLayout;
    /** 页码（1 起） */
    pageNo: number;
    /** 总页数（印在页眉"第X/Y页"的那个 Y） */
    pageCount: number;
    /** 卷号（BU…）；还没建卷时传占位，比如"（未生成）" */
    volumeNo: string;
    /** 页眉上那句"年级·学期" */
    gradeText?: string | null;
    /** 印于（可读串） */
    printDate?: string;
    /**
     * 【2026-10-03 需求第 10 条】这份积累纸的**随机 emoji 标识**（整份所有页共用）。
     * 不传 ⇒ 页眉不画它，行为一字不变。
     */
    emojiMark?: string | null;
    /** key(积累 id) → 内容 */
    rowByKey: Record<string, InsightPrintRow>;
    /** 每条的留白行数（整卷一个值，积累纸默认 1） */
    blankLines: number;
    /**
     * 排版三件套（**只在打印页给**；组卷预览/其他屏不传 ⇒ 纸上干干净净没有按钮）：
     *  · `figureScaleOf` 某条配图的缩放百分比
     *  · `onMoveItem` 某条上移/下移一位（改动先落本地，点【保存版面】才写库）
     */
    figureScaleOf?: (id: string) => number;
    onMoveItem?: (id: string, dir: -1 | 1) => void;
    /** 按下某条的图/把手 ⇒ 开始拖拽缩放（签名与复练纸一致） */
    onFigureScaleStart?: (id: string) => (e: ReactPointerEvent) => void;
    /** 整卷共几条 —— 用来判断"这条是不是最后一条"（最后一条的"下移"要灰掉） */
    totalCount?: number;
    /**
     * 【2026-10-02 修】页眉二维码的**图片 dataURL**。
     * ⚠️ 我第一版在这里传的是 `pageQrPayload(...)` —— 那是二维码的**文本内容**
     * （`BU…-01`），不是图片地址，直接塞给 `<img src>` 就是一个裂图
     * （他实测"二维码不知道是显示不出来还是没有生成"）。复练卷页那边一直是
     * 用 `makeQrDataUrl` 先把文本**画成图**再传进来的，这里照做。
     */
    pageQr?: string;
    /**
     * 【2026-10-03 需求第 11 条】**扫码预览**专用（打印页/积累纸打印页一律不传 ⇒ 行为一字不变）：
     *   · `onItemPlusClick` 点了某条中间的圆圈加号 ⇒ 上层跳日积月累页看这一条；
     *   · `linkedOf(code)` 这条**有没有关联错题** ⇒ 决定框与圆的颜色（棕黄 / 紫）。
     */
    onItemPlusClick?: (row: InsightPrintRow) => void;
    linkedOf?: (code: string) => boolean;
    L: (zh: string, en: string) => string;
}) {
    /** 打孔位：奇数页留左、偶数页留右（与复练纸同一个规矩，家里活页夹按一个物理边打孔） */
    const punchOnLeft = pageNo % 2 === 1;
    const punchVars = {
        '--punch-l': punchOnLeft ? `${REVIEW_PUNCH_GUTTER_MM}mm` : '0mm',
        '--punch-r': punchOnLeft ? '0mm' : `${REVIEW_PUNCH_GUTTER_MM}mm`,
    } as CSSProperties;

    return (
        <div
            className="print-card print-review-sheet"
            style={{
                height: `${REVIEW_PAGE_HEIGHT_MM}mm`,
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                overflow: 'hidden',
                ...punchVars,
            }}
        >
            <VolumeHeader
                kind="build"
                volumeNo={volumeNo}
                pageNo={pageNo}
                pageCount={pageCount}
                gradeText={gradeText ?? undefined}
                printDate={printDate ? new Date(printDate) : new Date()}
                pageQr={pageQr}
                emojiMark={emojiMark}
                L={L}
            />

            {/* 底部留一点**页脚空隙**（他要求"原则上也应该给下面留一点页脚"）。
                ⚠️ 这个高度**必须**同时传给分页算法（`paginateMeasured(..., INSIGHT_FOOTER_MM)`），
                   否则算法以为还能多塞 6mm 的东西 ⇒ 最后一屏溢出。两边共用本常量。 */}
            <div
                style={{
                    display: 'flex',
                    flex: 1,
                    minHeight: 0,
                    paddingBottom: `${INSIGHT_FOOTER_MM}mm`,
                }}
            >
                {page.columns.map((col, ci) => (
                    <Fragment key={ci}>
                        {ci > 0 && (
                            // 中间那条**灰竖线** —— 他要的"每页中间一条竖线把左右隔开"
                            <span
                                className="print-review-col-divider"
                                style={{
                                    width: 0,
                                    margin: `0 ${COLUMN_GAP_MM / 2}mm`,
                                    borderLeft: '0.2mm solid #b5b5b5',
                                    flex: '0 0 auto',
                                }}
                            />
                        )}
                        <div
                            className="print-review-column"
                            style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
                        >
                            {col.blocks.map((b, bi) => {
                                const row = rowByKey[b.key];
                                if (!row) return null;
                                return (
                                    <InsightBlock
                                        key={b.key}
                                        row={row}
                                        blankLines={blankLines}
                                        showDivider={bi > 0}
                                        figureScale={figureScaleOf ? figureScaleOf(row.id) : 100}
                                        onMoveUp={
                                            onMoveItem && b.seq > 1
                                                ? () => onMoveItem(row.id, -1)
                                                : undefined
                                        }
                                        onMoveDown={
                                            onMoveItem && (totalCount === undefined || b.seq < totalCount)
                                                ? () => onMoveItem(row.id, 1)
                                                : undefined
                                        }
                                        onFigureScaleStart={
                                            onFigureScaleStart
                                                ? onFigureScaleStart(row.id)
                                                : undefined
                                        }
                                        /* 【2026-10-03 需求第 11 条】扫码预览：圆圈加号（只在这屏画）。
                                           颜色按这条有没有关联错题走 —— 判据是**快照里的 JL 编号**
                                           （`row.code`），由上层传来。 */
                                        onPlusClick={
                                            onItemPlusClick ? () => onItemPlusClick(row) : undefined
                                        }
                                        plusLinked={linkedOf ? linkedOf(row.code) : false}
                                        L={L}
                                    />
                                );
                            })}
                        </div>
                    </Fragment>
                ))}
            </div>
        </div>
    );
}
