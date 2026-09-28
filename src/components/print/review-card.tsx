import type { CSSProperties } from 'react';
import { ErrorItem } from '@/types/api';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { SubjectChip } from '@/components/subject-chip';
import { getNotebookPrintInfo } from '@/lib/print-preview';
import {
    REVIEW_LAYOUT_MM,
    REVIEW_PAGE_HEIGHT_MM,
    REVIEW_PUNCH_GUTTER_MM,
    type ReviewBlockLayout,
    type ReviewPageLayout,
} from '@/lib/review-card';
import { useFigureImages } from './use-print-images';
import { PromoteBox } from './promote-box';

/**
 * T2 复练纸 —— 一张纸（正/背只打一面），**一题半页、两题一页**。
 *
 * ── 与 T1 深挖纸的关系 ─────────────────────────────────────────────
 * 同一套铁律，只是更省：
 *   · **纸上零 AI 内容**（不印答案 / 解析 / 错因）——和深挖纸一样，有渲染测试钉死；
 *   · 题面 = OCR 文字 + 橙框题图（复用 `useFigureImages`，含就绪门与像素上限）；
 *   · 每题一个二维码（内容 = 裸题号，天然兼容 `/api/scan`）；
 *   · 没有十字象限、没有反面、没有遮挡线；题间一条灰色虚线。
 *
 * ── 页高与分页 ────────────────────────────────────────────────────
 * 页高是**算出来的**（`lib/review-card.ts`），本组件只负责把算好的块画出来：
 * 块高、留白高、题图实际能印多高，全部来自 `ReviewBlockLayout`，
 * **组件里不再做第二遍夹取**（两处各算一次必然出现"看着放得下、印出来溢出"）。
 *
 * ── 面标记规范（全局，T1/T2/T3/T0 都要遵守）────────────────────────
 * 四角角标负责摆正、二维码负责识别；**没有角标的页面不放二维码**。
 * 所以本组件一定同时画角标与二维码，不能只画一个。
 */

export interface ReviewSheetProps {
    /** 这一页的排布（1 或 2 块） */
    page: ReviewPageLayout;
    /** 按 key 找回题目本体（key 是 layout 里的 key） */
    itemByKey: Record<string, ErrorItem>;
    /** 二维码内容 → dataURL（打印页统一生成，与深挖纸共用同一份） */
    qrMap: Record<string, string>;
    L: (zh: string, en: string) => string;
}

/** 四角角标：定位用的小直角。纸歪了靠它摆正（`scripts`/回收程序都认这个）。 */
function CornerMark({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
    const common: CSSProperties = {
        position: 'absolute',
        width: '4mm',
        height: '4mm',
        borderColor: '#111',
        borderStyle: 'solid',
        borderWidth: 0,
        pointerEvents: 'none',
    };
    const byCorner: Record<string, CSSProperties> = {
        tl: { top: 0, left: 0, borderTopWidth: '0.5mm', borderLeftWidth: '0.5mm' },
        tr: { top: 0, right: 0, borderTopWidth: '0.5mm', borderRightWidth: '0.5mm' },
        bl: { bottom: 0, left: 0, borderBottomWidth: '0.5mm', borderLeftWidth: '0.5mm' },
        br: { bottom: 0, right: 0, borderBottomWidth: '0.5mm', borderRightWidth: '0.5mm' },
    };
    return <span className={`print-review-corner print-review-corner-${at}`} style={{ ...common, ...byCorner[at] }} />;
}

/** 一道题的块：题目行 → 题干 → 题图 → 答题留白（右下角带升降级小框） */
function ReviewQuestionBlock({
    item,
    block,
    qr,
    L,
}: {
    item: ErrorItem;
    block: ReviewBlockLayout;
    qr?: string;
    L: (zh: string, en: string) => string;
}) {
    const figures = useFigureImages(item);
    const { gradeText, subjectKey } = getNotebookPrintInfo(item, L('未分本', 'Unfiled'));
    const questionNo = item.source || '';

    return (
        <div
            className="print-review-block"
            style={{
                height: `${block.blockHeightMM}mm`,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
            }}
        >
            {/* 题目行：学科色标 + 题号 + 年级 + 二维码（右侧） */}
            <div
                style={{
                    height: `${REVIEW_LAYOUT_MM.headerRow}mm`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2mm',
                    flex: '0 0 auto',
                }}
            >
                <SubjectChip subjectKey={subjectKey} variant="print" showCode={false} />
                <span style={{ fontSize: '11pt', fontWeight: 700, letterSpacing: '0.4px', whiteSpace: 'nowrap' }}>
                    {questionNo}
                    {gradeText ? (
                        <span style={{ fontSize: '8pt', fontWeight: 400, color: '#555' }}>{'  '}{gradeText}</span>
                    ) : null}
                </span>
                <span style={{ flex: 1 }} />
                {qr ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */
                    <img className="print-qr" src={qr} alt="" style={{ width: '12mm', height: '12mm', flexShrink: 0 }} />
                ) : null}
            </div>
            <div style={{ height: '0.3mm', background: '#c8c8c8', flex: '0 0 auto' }} />

            {/* 题干文字（OCR）—— 纸上零 AI 内容，这里只有题面 */}
            <div className="print-review-question" style={{ flex: '0 0 auto', marginTop: '1.5mm', fontSize: '10pt' }}>
                {item.questionText || item.ocrText ? (
                    <MarkdownRenderer content={(item.questionText || item.ocrText) as string} />
                ) : (
                    <span style={{ fontSize: '9pt', color: '#777' }}>
                        {L('（这题没有可打印的题干）——翻回原题看', '(nothing to print)')}
                    </span>
                )}
            </div>

            {/* 题图：高度取算法给的值（已按"整页装得下"夹过），组件不再二次夹取 */}
            {figures.length > 0 && block.figureHeightMM > 0 && (
                <div
                    className="print-review-figures"
                    style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'flex-start',
                        gap: '2mm',
                        marginTop: '1.5mm',
                        flex: '0 0 auto',
                        maxHeight: `${block.figureHeightMM}mm`,
                        overflow: 'hidden',
                    }}
                >
                    {figures.map((url, i) => (
                        /* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */
                        <img
                            key={i}
                            src={url}
                            alt=""
                            style={{
                                maxWidth: `${REVIEW_LAYOUT_MM.figureMaxWidthMM}mm`,
                                maxHeight: `${block.figureHeightMM}mm`,
                                display: 'block',
                            }}
                        />
                    ))}
                </div>
            )}

            {/* 答题留白：弹性吃掉剩下的高度；右下角放升降级小框（定稿位置：留白区内、虚线之上） */}
            <div
                className="print-review-writing"
                style={{
                    flex: 1,
                    minHeight: `${REVIEW_LAYOUT_MM.blankMinLines * REVIEW_LAYOUT_MM.blankLineMM}mm`,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    alignItems: 'flex-end',
                    marginTop: '1.5mm',
                }}
            >
                <PromoteBox manageType={item.manageType} L={L} />
            </div>
        </div>
    );
}

export function ReviewSheet({ page, itemByKey, qrMap, L }: ReviewSheetProps) {
    const blocks = page.blocks.map((b) => ({ block: b, item: itemByKey[b.key] })).filter((x) => x.item);

    return (
        <div
            className="print-card print-review-sheet"
            style={{
                height: `${REVIEW_PAGE_HEIGHT_MM}mm`,
                display: 'flex',
                flexDirection: 'column',
                paddingLeft: `${REVIEW_PUNCH_GUTTER_MM}mm`,
                position: 'relative',
                overflow: 'hidden',
            }}
        >
            <CornerMark at="tl" />
            <CornerMark at="tr" />
            <CornerMark at="bl" />
            <CornerMark at="br" />

            {blocks.map((x, i) => (
                <div key={x.block.key} style={{ display: 'contents' }}>
                    {i > 0 && (
                        // 题间：灰色虚线（定稿：同页题间灰色虚线）
                        <div
                            className="print-review-divider"
                            style={{ borderTop: '0.3mm dashed #b9b9b9', flex: '0 0 auto' }}
                        />
                    )}
                    <ReviewQuestionBlock
                        item={x.item as ErrorItem}
                        block={x.block}
                        qr={qrMap[x.block.key]}
                        L={L}
                    />
                </div>
            ))}
        </div>
    );
}
