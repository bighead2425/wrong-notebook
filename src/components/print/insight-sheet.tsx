import type { CSSProperties } from 'react';
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
export function InsightBlock({
    row,
    blankLines,
    showDivider,
    figureScale = 100,
    onMoveUp,
    onMoveDown,
    onFigureScale,
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
    onFigureScale?: (next: number) => void;
    L: (zh: string, en: string) => string;
}) {
    const body = stripMarkdownImages(row.content || '');
    const blankMM = blankLines * REVIEW_LAYOUT_MM.blankLineMM;

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
                <div style={{ flex: '0 0 auto', marginTop: '1mm', position: 'relative' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */}
                    <img
                        src={row.photoUrl}
                        alt=""
                        style={{
                            /**
                             * 【2026-10-01 排版】缩放作用在**宽度**上，高度按比例跟 ——
                             * 与复练纸题图**同一条思路**（那边也是 55% × 百分比，上限占满整栏）。
                             * 默认 100% 时占栏宽 55%，调到 180% 才铺满，不会一上来就顶格。
                             */
                            width: `${Math.min(100, REVIEW_FIGURE_BOX_RATIO * figureScale)}%`,
                            maxHeight: `${REVIEW_LAYOUT_MM.figureMaxHeightMM * (figureScale / 100)}mm`,
                            objectFit: 'contain',
                            display: 'block',
                        }}
                    />
                    {/* 图大小的加减（只在屏幕上；打印页给了 onFigureScale 才出现） */}
                    {onFigureScale && (
                        <span
                            className="no-print"
                            style={{
                                position: 'absolute',
                                right: 0,
                                bottom: 0,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6mm',
                                background: 'rgba(255,255,255,0.92)',
                                border: '0.2mm solid #c9c9c9',
                                borderRadius: '0.8mm',
                                padding: '0 1mm',
                                fontSize: '7pt',
                            }}
                        >
                            <button
                                type="button"
                                title={L('图小一点', 'Smaller')}
                                onClick={() => onFigureScale(Math.max(30, figureScale - 10))}
                                style={{ cursor: 'pointer' }}
                            >
                                −
                            </button>
                            <span>{figureScale}%</span>
                            <button
                                type="button"
                                title={L('图大一点', 'Bigger')}
                                onClick={() => onFigureScale(Math.min(180, figureScale + 10))}
                                style={{ cursor: 'pointer' }}
                            >
                                ＋
                            </button>
                        </span>
                    )}
                </div>
            ) : null}

            {/* 留白：她看完想补一句就写在这儿。积累纸只留 1 行（他定的）。 */}
            <div style={{ flex: '0 0 auto', minHeight: `${blankMM}mm` }} />
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
    rowByKey,
    blankLines,
    figureScaleOf,
    onMoveItem,
    onFigureScale,
    totalCount,
    pageQr,
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
    onFigureScale?: (id: string, next: number) => void;
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
                L={L}
            />

            {/* 底部留一点**页脚空隙**（他要求"原则上也应该给下面留一点页脚"） */}
            <div style={{ display: 'flex', flex: 1, minHeight: 0, paddingBottom: '6mm' }}>
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
                                        onFigureScale={
                                            onFigureScale
                                                ? (next) => onFigureScale(row.id, next)
                                                : undefined
                                        }
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
