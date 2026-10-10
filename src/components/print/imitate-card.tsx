import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ErrorItem } from '@/types/api';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import {
    COLUMN_GAP_MM,
    REVIEW_LAYOUT_MM,
    REVIEW_PAGE_HEIGHT_MM,
    REVIEW_PUNCH_GUTTER_MM,
    VOLUME_COLUMN_MM,
} from '@/lib/review-card';
import type { ImitateSegmentSpec, ImitateSheet as ImitateSheetLayout } from '@/lib/imitate-card';
import type { VolumeKind } from '@/lib/volume-code';
import { useFigureImages } from './use-print-images';
import { MissingQuestionBlock, ReviewQuestionBlock, VolumeHeader } from './review-card';

/**
 * T4 **模仿纸**的纸面（2026-10-11）。
 *
 * 版面（他 2026-10-10 定的）：
 *
 * ```
 * ┌──────────────── 卷头（阳文框「模仿」+ 卷号 + 第X/Y页 + 页二维码）────────────────┐
 * ├───────────────────────┬─┬───────────────────────┤
 * │ 左栏（**贯通**）        │ │ 右栏：附题（与复练纸同一套）  │
 * │  题干（OCR）            │ │  1. 题干 + 题图 + 留白     │
 * │  题图（如有）           │ │  ── 虚线 ──              │
 * │  ──── 遮挡线 ────       │ │  2. …                    │
 * │  参考答案               │ │  （**一道题绝不跨页**）     │
 * │  解析                   │ │                          │
 * │  （一页放不下 ⇒ 顺延下一页）│ │                          │
 * └───────────────────────┴─┴───────────────────────┘
 * ```
 *
 * ⚠️ 这张纸**故意印 AI 内容**（左栏的参考答案与解析）—— 它是四种纸里唯一的例外，
 *    立意就是他说的"我如何能对"：自驱力弱的孩子先把方法看会，再照着做附题。
 *    另外三种纸（深挖 / 复练 / 积累）仍然守"纸上零 AI 内容"，一个字都不许漏。
 * ⚠️ **不印错因**：他 2026-10-10 更正过 —— 模仿纸不谈"错"这件事。
 *
 * ⚠️ 左栏与右栏是**两条独立的流**（左栏可顺延、右栏整块不跨页），
 *    分页由纯函数 `lib/imitate-card.ts` 算好（`paginateImitate`），本组件只负责画。
 */

/**
 * 段与段之间的间距 —— **放进段自己的高度里**（`paddingBottom`）。
 *
 * 为什么不用父层的 `gap`：量尺是"逐段读 `getBoundingClientRect()`"，
 * `gap` 不属于任何一个段的矩形 ⇒ 量出来的总高比实际占位少一截，
 * 于是分页会以为"这页还塞得下"，一段就被挤出纸外（肉眼只看到"最后一段不见了"）。
 */
const SEG_GAP_MM = 1.5;

/** 遮挡线上下多留一点，好让它跟题目、答案都分开 */
const DIVIDER_PAD_MM = 2;

/**
 * 左栏的段序列 —— **量尺与正式版面共用同一份**（这是他这套"先量后分"的老规矩：
 * 两处若各写一遍，"量到的"就不是"印出来的"）。
 *
 * 每段自带 `data-imitate-seg={key}`，量尺按它逐段读真实高度。
 */
export function ImitateSegments({
    specs,
    theme,
    figureScale = 100,
    onFigureScaleStart,
    L,
}: {
    specs: readonly ImitateSegmentSpec[];
    /** 主题本体（左栏的题图从它身上取） */
    theme: ErrorItem;
    /** 主题题图的缩放百分比（100 = 版面默认） */
    figureScale?: number;
    onFigureScaleStart?: (itemId: string) => (e: ReactPointerEvent) => void;
    L: (zh: string, en: string) => string;
}) {
    const figures = useFigureImages(theme);

    return (
        <>
            {specs.map((s) => (
                <div
                    key={s.key}
                    data-imitate-seg={s.key}
                    className={`print-imitate-seg print-imitate-seg-${s.role}`}
                    style={{
                        flex: '0 0 auto',
                        paddingBottom: `${SEG_GAP_MM}mm`,
                        ...(s.kind === 'divider'
                            ? { paddingTop: `${DIVIDER_PAD_MM}mm`, paddingBottom: `${DIVIDER_PAD_MM}mm` }
                            : null),
                    }}
                >
                    {s.kind === 'divider' ? (
                        /**
                         * 遮挡线 —— 与深挖纸反面**同一个东西、同一个画法**
                         * （粗线 + 线中印"遮挡线"三字）。它把"题目"和"答案"分开，
                         * 既是给孩子的提示，也是 OCR 认版面的坐标标签。
                         */
                        <div
                            className="print-deep-occluder"
                            style={{ display: 'flex', alignItems: 'center', gap: '2mm' }}
                        >
                            <span style={{ flex: 1, height: '0.7mm', background: '#111' }} />
                            <span style={{ fontSize: '8pt', letterSpacing: '1.5px', whiteSpace: 'nowrap' }}>
                                {L('遮挡线', 'cut here')}
                            </span>
                            <span style={{ flex: 1, height: '0.7mm', background: '#111' }} />
                        </div>
                    ) : s.kind === 'figure' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2mm' }}>
                            {figures.map((url, i) => (
                                <div
                                    key={i}
                                    style={{
                                        flex: '0 0 auto',
                                        width: `${figureScale}%`,
                                        maxWidth: '100%',
                                        position: 'relative',
                                        // 手机上"按住图左右拖 = 缩放"：不让浏览器抢去当滚动
                                        touchAction: onFigureScaleStart ? 'none' : undefined,
                                    }}
                                    onPointerDown={(e) => {
                                        if (e.pointerType === 'mouse') return;
                                        onFigureScaleStart?.(theme.id)(e);
                                    }}
                                >
                                    {/* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照 */}
                                    <img
                                        src={url}
                                        alt=""
                                        style={{
                                            width: '100%',
                                            height: 'auto',
                                            maxHeight: `${REVIEW_LAYOUT_MM.figureMaxHeightMM * (figureScale / 100)}mm`,
                                            objectFit: 'contain',
                                            objectPosition: 'left top',
                                            display: 'block',
                                        }}
                                    />
                                    {onFigureScaleStart && (
                                        <span
                                            className="print-fig-handle no-print"
                                            title={L('拖动调整图片大小（左上角固定）', 'Drag to resize')}
                                            onPointerDown={(e) => {
                                                if (e.pointerType !== 'mouse') return;
                                                onFigureScaleStart(theme.id)(e);
                                            }}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div
                            /**
                             * ⚠️ 小标题（"参考答案" / "解析"）**用蓝竖条 + 粗体**，
                             *    与右栏附题的"流水号 + 题干"一眼分开 ——
                             *    左栏是"给他看的例题"，右栏是"他要动笔的题"。
                             */
                            style={
                                s.role === 'heading'
                                    ? {
                                          borderLeft: '0.8mm solid #1e40af',
                                          paddingLeft: '1.5mm',
                                          fontSize: '10pt',
                                          fontWeight: 700,
                                      }
                                    : { fontSize: '10.5pt' }
                            }
                        >
                            <MarkdownRenderer content={s.text} />
                        </div>
                    )}
                </div>
            ))}
        </>
    );
}

export interface ImitateSheetProps {
    /** 这一页的排布（左栏段 + 右栏附题块）—— 由 `paginateImitate` 按**真实高度**分好 */
    sheet: ImitateSheetLayout;
    /** key → 段的内容（`kind` / `role` / 文字都从这里取） */
    segmentByKey: Record<string, ImitateSegmentSpec>;
    /**
     * 主题本体。**传 null = 主题已被删除** —— 按他定的规矩，
     * 这时整卷作废（白纸上写主题题号 + "此卷作废，建议删除"），不再印内容。
     */
    theme: ErrorItem | null;
    /** 主题题号（快照里的那个，作废提示要用） */
    themeNo?: string | null;
    pageNo: number;
    pageCount: number;
    volumeNo: string;
    kind: VolumeKind;
    gradeText?: string;
    printDate: Date;
    emojiMark?: string | null;
    pageQr?: string;
    /** 附题本体（key = 题目 id） */
    itemByKey: Record<string, ErrorItem>;
    /** 附题被删时（快照还在）：key → 题号快照，就地印"此题已无" */
    missing?: Record<string, string | null>;
    /** 附题当前生效的留白行数（屏幕上的微调控件用） */
    blankValueOf?: (itemId: string) => number;
    onBlankChange?: (itemId: string, next: number) => void;
    figureScaleOf?: (itemId: string) => number;
    onFigureScaleStart?: (itemId: string) => (e: ReactPointerEvent) => void;
    /** 按住两题之间的虚线（调上面那道附题的留白行数） */
    onDividerDragStart?: (aboveItemId: string, startLines: number) => (e: ReactPointerEvent) => void;
    L: (zh: string, en: string) => string;
}

export function ImitateSheet({
    sheet,
    segmentByKey,
    theme,
    themeNo,
    pageNo,
    pageCount,
    volumeNo,
    kind,
    gradeText,
    printDate,
    emojiMark,
    pageQr,
    itemByKey,
    missing,
    blankValueOf,
    onBlankChange,
    figureScaleOf,
    onFigureScaleStart,
    onDividerDragStart,
    L,
}: ImitateSheetProps) {
    /** 打孔位：**奇数页留左、偶数页留右**（与复练纸同一条物理边） */
    const punchOnLeft = pageNo % 2 === 1;
    const punchVars = {
        '--punch-l': punchOnLeft ? `${REVIEW_PUNCH_GUTTER_MM}mm` : '0mm',
        '--punch-r': punchOnLeft ? '0mm' : `${REVIEW_PUNCH_GUTTER_MM}mm`,
    } as CSSProperties;

    const canDragDivider = !!onBlankChange && !!blankValueOf && !!onDividerDragStart;

    /** 页面骨架（页眉 + 左右两栏）—— 作废那一版也用它，保证"还是这张纸"。 */
    const shell = (body: ReactNode) => (
        <div
            className="print-card print-imitate-sheet"
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
                kind={kind}
                volumeNo={volumeNo}
                pageNo={pageNo}
                pageCount={pageCount}
                gradeText={gradeText}
                printDate={printDate}
                pageQr={pageQr}
                emojiMark={emojiMark}
                L={L}
            />
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>{body}</div>
        </div>
    );

    /** 主题没了 ⇒ 整卷作废（他定的："就在一张白纸上写主题题号，并后面写'此卷作废，建议删除'"） */
    if (!theme) {
        return shell(
            <div
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '3mm',
                    color: '#888',
                }}
            >
                <div style={{ fontSize: '14pt', fontWeight: 700 }}>{themeNo || L('（无题号）', '(no number)')}</div>
                <div style={{ fontSize: '11pt' }}>{L('此卷作废，建议删除', 'Void — safe to delete')}</div>
            </div>,
        );
    }

    /** 本页左栏要画的段（按分页结果筛出来，再按原顺序画） */
    const leftSpecs = sheet.left
        .map((seg) => segmentByKey[seg.key])
        .filter((s): s is ImitateSegmentSpec => !!s);

    return shell(
        <>
            {/* ===== 左栏：主题（贯通，可顺延到下一页） ===== */}
            <div
                className="print-imitate-column print-imitate-left"
                style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
            >
                <ImitateSegments
                    specs={leftSpecs}
                    theme={theme}
                    figureScale={figureScaleOf ? figureScaleOf(theme.id) : 100}
                    onFigureScaleStart={onFigureScaleStart}
                    L={L}
                />
            </div>

            <span
                className="print-imitate-col-divider"
                style={{
                    width: 0,
                    margin: `0 ${COLUMN_GAP_MM / 2}mm`,
                    borderLeft: '0.2mm solid #b5b5b5',
                    flex: '0 0 auto',
                }}
            />

            {/* ===== 右栏：附题（一道题绝不跨页） ===== */}
            <div
                className="print-imitate-column print-imitate-right"
                style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
            >
                {sheet.right.map((b, bi) => {
                    const item = itemByKey[b.key];
                    if (!item) {
                        /** 附题被删（快照还在）⇒ 就地留"此题已无"，**不重排** */
                        if (missing && b.key in missing) {
                            return (
                                <MissingQuestionBlock
                                    key={b.key}
                                    seq={b.seq}
                                    itemNo={missing[b.key]}
                                    showDivider={bi > 0}
                                    L={L}
                                />
                            );
                        }
                        return null;
                    }
                    const blank = blankValueOf ? blankValueOf(item.id) : 0;
                    const above = bi > 0 ? itemByKey[sheet.right[bi - 1].key] : null;
                    return (
                        <ReviewQuestionBlock
                            key={b.key}
                            item={item}
                            seq={b.seq}
                            blankLines={blank}
                            showDivider={bi > 0}
                            blankValue={blankValueOf ? blank : undefined}
                            onBlankChange={onBlankChange}
                            figureScale={figureScaleOf ? figureScaleOf(item.id) : 100}
                            onFigureScaleStart={onFigureScaleStart}
                            onDividerDragStart={
                                canDragDivider && above
                                    ? (e) => onDividerDragStart!(above.id, blankValueOf!(above.id))(e)
                                    : undefined
                            }
                            L={L}
                        />
                    );
                })}
            </div>
        </>,
    );
}

/** 本页左栏一共几段（"这页印了什么"这类检查用） */
export function imitateLeftCount(sheet: ImitateSheetLayout): number {
    return sheet.left.length;
}

/** 左栏可用高度（扣掉页眉）—— 与分页函数里那个 `VOLUME_COLUMN_MM` 同源 */
export const IMITATE_COLUMN_MM = VOLUME_COLUMN_MM;
