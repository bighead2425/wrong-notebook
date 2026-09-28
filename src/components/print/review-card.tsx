import type { CSSProperties } from 'react';
import { Fragment } from 'react';
import { ErrorItem } from '@/types/api';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import {
    COLUMN_GAP_MM,
    REVIEW_FIGURE_BOX_RATIO,
    REVIEW_PAGE_HEIGHT_MM,
    REVIEW_PUNCH_GUTTER_MM,
    VOLUME_HEADER_MM,
    type ReviewBlockLayout,
    type ReviewPageLayout,
} from '@/lib/review-card';
import {
    VOLUME_KIND_COLOR,
    VOLUME_KIND_LABEL,
    VOLUME_KIND_LABEL_EN,
    buildPageCode,
    stampReadable,
    type VolumeKind,
} from '@/lib/volume-code';
import { useFigureImages } from './use-print-images';
import { PromoteBox } from './promote-box';

/**
 * T2 复练纸 / T3 积累纸 —— **卷**（不是"一题一张纸"）。
 *
 * ── 2026-09-28 第二次改版（他看完 5 页样张后提的）─────────────────
 *  ① **卷头收成一排**：阳文框 + 卷号 + 年级·学期 …… 第X/Y页 + 印于日期 + **二维码**。
 *     二维码从第二排**上移**到这一排的最右，页码与日期往左让位；
 *     下面那条横线改为**整条贯通**。页眉因此从 21mm 压到 15mm，每页多出 6mm 给题目。
 *  ② **题图不再按原始像素大小印**（那是"有的图小到看不清、有的被裁掉半截"的根因）：
 *     改成装进一个**固定比例的盒子**里按 `object-fit: contain` 缩放 ——
 *     小图放大、大图缩小、**永不裁切**。详见 `AnswerRow` 里那段注释。
 *  ③ **每道题都有升降级小框**（未定等级按"复练"处理，见 `lib/manage-type.ts`）。
 *  ④ **去掉四角角标**：它原本是给"手机拍纸摆正"用的（设计文档 P21），
 *     但现在没有任何代码认它（`doc-scan.ts` 是靠照片里的**纸边**找四角），
 *     而二维码自带三个定位角、识别根本不需要它 ⇒ 纯墨水 + 纯视觉噪音，去掉。
 *
 * ── 铁律（与深挖纸同）────────────────────────────────────────────
 * **纸上零 AI 内容**：不印答案 / 解析 / 错因 / 进度，有渲染测试钉死。
 */

export interface ReviewSheetProps {
    /** 这一页的排布（复练 1 栏 / 积累 2 栏） */
    page: ReviewPageLayout;
    /** 本页页码（1 起）—— 也是页眉二维码里那一半 */
    pageNo: number;
    /** 本卷总页数 */
    pageCount: number;
    /** 卷号，如 `RE20260926001` */
    volumeNo: string;
    /** 哪种卷（决定页眉那个阳文框的颜色与字样） */
    kind: VolumeKind;
    /** 页眉上的"年级·学期"（整卷一个值） */
    gradeText?: string;
    /** 印刷日期（页眉「印于 …」） */
    printDate: Date;
    /** 本页二维码的 dataURL（内容 = 卷号-页码） */
    pageQr?: string;
    /** 按 key（题目 id）找回题目本体 */
    itemByKey: Record<string, ErrorItem>;
    /** 这道题当前生效的留白行数（屏幕上的微调控件用） */
    blankValueOf?: (itemId: string) => number;
    /** 改某道题的留白行数 */
    onBlankChange?: (itemId: string, next: number) => void;
    L: (zh: string, en: string) => string;
}

/**
 * 卷头（页眉）——**一排装完**。
 *
 * ```
 * [复练]  RE20260928002  六年级上·五年级上  ……………  第1/5页  印于 2026-09-28  [二维码]
 * ────────────────────────────────────────────────────────────────────────────────
 * ```
 *
 * ⚠️ 二维码**必须和文字同一排**：他上一版看到二维码孤零零占第二排、上面留一大块空，
 *    原话是"页码和打印时间往左移动，使二维码可以向上挪一些，这样整个页眉才比较整洁"。
 *    所以现在的规则是：**文字占左边、二维码贴右边**，下面那条横线**整条贯通**。
 */
function VolumeHeader({
    kind,
    volumeNo,
    pageNo,
    pageCount,
    gradeText,
    printDate,
    pageQr,
    L,
}: {
    kind: VolumeKind;
    volumeNo: string;
    pageNo: number;
    pageCount: number;
    gradeText?: string;
    printDate: Date;
    pageQr?: string;
    L: (zh: string, en: string) => string;
}) {
    const color = VOLUME_KIND_COLOR[kind];
    return (
        <div
            className="print-volume-header"
            style={{
                height: `${VOLUME_HEADER_MM}mm`,
                flex: '0 0 auto',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
            }}
        >
            <div style={{ height: '12mm', display: 'flex', alignItems: 'center', gap: '2.5mm', flex: '0 0 auto' }}>
                {/* 阳文框：框与字同色、底为白 —— 与深挖纸（实底白字）恰好相反，一眼能分开"卷"和"纸" */}
                <span
                    className={`print-volume-badge print-volume-badge-${kind}`}
                    style={{
                        border: `0.5mm solid ${color}`,
                        color,
                        background: '#ffffff',
                        borderRadius: '1mm',
                        padding: '0.4mm 2mm',
                        fontSize: '10pt',
                        fontWeight: 700,
                        lineHeight: 1.25,
                        whiteSpace: 'nowrap',
                        flex: '0 0 auto',
                    }}
                >
                    {L(VOLUME_KIND_LABEL[kind], VOLUME_KIND_LABEL_EN[kind])}
                </span>
                <span style={{ fontSize: '10pt', fontWeight: 700, letterSpacing: '0.3px', whiteSpace: 'nowrap' }}>
                    {volumeNo}
                </span>
                {gradeText ? (
                    <span style={{ fontSize: '8pt', color: '#555', whiteSpace: 'nowrap' }}>{gradeText}</span>
                ) : null}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: '9pt', whiteSpace: 'nowrap' }}>
                    {L('第', 'p.')}
                    {pageNo}/{pageCount}
                    {L('页', '')}
                </span>
                <span style={{ fontSize: '8pt', color: '#555', whiteSpace: 'nowrap' }}>
                    {L('印于', 'printed')} {stampReadable(printDate)}
                </span>
                {pageQr ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */
                    <img
                        className="print-qr print-volume-qr"
                        src={pageQr}
                        alt=""
                        style={{ width: '10mm', height: '10mm', flex: '0 0 auto' }}
                    />
                ) : null}
            </div>
            {/* 横线：整条贯通（二维码已经上移到上面那一排，不再与它分宽度） */}
            <div style={{ height: '2mm', display: 'flex', alignItems: 'center', flex: '0 0 auto' }}>
                <span
                    className="print-volume-header-rule"
                    style={{ flex: 1, height: '0.25mm', background: '#666' }}
                />
            </div>
        </div>
    );
}

/**
 * 答题区：左边题图、右边留白（右下角是升降级小框）。
 *
 * ── 题图为什么改成"盒子 + contain"（2026-09-28）────────────────────
 * 上一版是 `<img maxWidth maxHeight>`：它**按图片自己的像素尺寸**排版，只在超限时才缩。
 * 后果是他看到的两种坏样子：
 *   · 原图里那块区域本来就小 ⇒ 印出来是一条 30mm×6mm 的**碎片**；
 *   · 多张图挤一行、容器又限高 ⇒ 后面的图被**裁掉半截**。
 *
 * 现在：给图一个**固定比例的盒子**（答题区宽度的 55% × 行高），
 * 图按 `object-fit: contain` 装进去 —— 等比缩放，**小的放大、大的缩小、永不裁切**。
 * 于是"图多大"不再取决于原图有多少像素，只取决于版面对它的安排。
 *
 * ⚠️ 这只解决**排版**。若某道题的框本身就框歪了（裁出来只是原图的一条边），
 *    放大出来仍是那条边 —— 那是数据问题，由组卷时的"疑似框歪"提示去暴露。
 */
function AnswerRow({
    item,
    block,
    blankValue,
    onBlankChange,
    L,
}: {
    item: ErrorItem;
    block: ReviewBlockLayout;
    blankValue?: number;
    onBlankChange?: (itemId: string, next: number) => void;
    L: (zh: string, en: string) => string;
}) {
    const figures = useFigureImages(item);
    const showFigures = figures.length > 0 && block.figureHeightMM > 0;
    const canTweak = typeof blankValue === 'number' && !!onBlankChange;

    return (
        <div
            className="print-review-answer"
            style={{
                height: `${block.rowHeightMM}mm`,
                marginTop: '1mm',
                display: 'flex',
                alignItems: 'stretch',
                gap: '2.5mm',
                flex: '0 0 auto',
                overflow: 'hidden',
            }}
        >
            {showFigures && (
                <div
                    className="print-review-figures"
                    style={{
                        flex: `0 1 ${REVIEW_FIGURE_BOX_RATIO * 100}%`,
                        minWidth: 0,
                        display: 'flex',
                        gap: '2mm',
                        alignItems: 'stretch',
                    }}
                >
                    {figures.map((url, i) => (
                        /* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */
                        <img
                            key={i}
                            src={url}
                            alt=""
                            style={{
                                flex: '1 1 0',
                                minWidth: 0,
                                width: '100%',
                                height: '100%',
                                objectFit: 'contain',
                                objectPosition: 'left center',
                                display: 'block',
                            }}
                        />
                    ))}
                </div>
            )}

            <div
                style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    alignItems: 'flex-end',
                    gap: '1mm',
                }}
            >
                {/* 留白微调：**只在屏幕上出现**，打印时被 CSS 隐藏（他只让它在阅览页能用） */}
                {canTweak && (
                    <span className="print-review-tweak">
                        <button type="button" onClick={() => onBlankChange!(item.id, blankValue! - 1)}>
                            −
                        </button>
                        <span className="print-review-tweak-value">
                            {blankValue}
                            {L('行', '')}
                        </span>
                        <button type="button" onClick={() => onBlankChange!(item.id, blankValue! + 1)}>
                            ＋
                        </button>
                    </span>
                )}
                {/* 升降级小框：**每道题都有**（未定按复练处理） */}
                <PromoteBox manageType={item.manageType} L={L} />
            </div>
        </div>
    );
}

/** 一道题的块：流水号 + 题干 → 答题区（左题图 / 右下角小框） */
function ReviewQuestionBlock({
    item,
    block,
    showDivider,
    blankValue,
    onBlankChange,
    L,
}: {
    item: ErrorItem;
    block: ReviewBlockLayout;
    /** 本栏内不是第一题时才画那条浅虚线（跨页/跨栏处不画） */
    showDivider: boolean;
    blankValue?: number;
    onBlankChange?: (itemId: string, next: number) => void;
    L: (zh: string, en: string) => string;
}) {
    const stem = item.questionText || item.ocrText;

    return (
        <div
            className="print-review-block"
            style={{
                height: `${block.contentHeightMM}mm`,
                display: 'flex',
                flexDirection: 'column',
                flex: '0 0 auto',
                overflow: 'hidden',
                borderTop: showDivider ? '0.3mm dashed #cfcfcf' : undefined,
            }}
        >
            {/* 题干：左边一个流水号（1. 2. 3. …），它是这份卷的排序号，不是题号 */}
            <div className="print-review-stem" style={{ position: 'relative', paddingLeft: '6mm', flex: '0 0 auto' }}>
                <span
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        fontSize: '10pt',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {block.seq}.
                </span>
                {stem ? (
                    <MarkdownRenderer content={stem as string} />
                ) : (
                    <span style={{ fontSize: '9pt', color: '#777' }}>
                        {L('（这题没有可打印的题干）——翻回原题看', '(nothing to print)')}
                    </span>
                )}
            </div>

            <AnswerRow
                item={item}
                block={block}
                blankValue={blankValue}
                onBlankChange={onBlankChange}
                L={L}
            />
        </div>
    );
}

export function ReviewSheet({
    page,
    pageNo,
    pageCount,
    volumeNo,
    kind,
    gradeText,
    printDate,
    pageQr,
    itemByKey,
    blankValueOf,
    onBlankChange,
    L,
}: ReviewSheetProps) {
    /**
     * 打孔位：**奇数页留左、偶数页留右**。
     * 道理和深挖纸"正面左、反面右"一样 —— 家里活页夹按一个物理边打孔，
     * 单面卷页页翻过去，孔位就在左右之间交替。
     */
    const punchOnLeft = pageNo % 2 === 1;
    const padding: CSSProperties = punchOnLeft
        ? { paddingLeft: `${REVIEW_PUNCH_GUTTER_MM}mm` }
        : { paddingRight: `${REVIEW_PUNCH_GUTTER_MM}mm` };

    return (
        <div
            className="print-card print-review-sheet"
            style={{
                height: `${REVIEW_PAGE_HEIGHT_MM}mm`,
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                overflow: 'hidden',
                ...padding,
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
                L={L}
            />

            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                {page.columns.map((col, ci) => (
                    <Fragment key={ci}>
                        {ci > 0 && (
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
                            style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
                        >
                            {col.blocks.map((b, bi) => {
                                const item = itemByKey[b.key];
                                if (!item) return null;
                                return (
                                    <ReviewQuestionBlock
                                        key={b.key}
                                        item={item}
                                        block={b}
                                        showDivider={bi > 0}
                                        blankValue={blankValueOf ? blankValueOf(item.id) : undefined}
                                        onBlankChange={onBlankChange}
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

/** 本页二维码内容（页眉要用的那串）—— 拼法只有 `lib/volume-code.ts` 一处实现 */
export function pageQrPayload(volumeNo: string, pageNo: number): string {
    return buildPageCode(volumeNo, pageNo);
}

/** 本页一共几道题（"第几页排了几题"这类检查用） */
export function totalBlocks(page: ReviewPageLayout): number {
    return page.columns.reduce((n, c) => n + c.blocks.length, 0);
}
