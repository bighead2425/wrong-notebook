import type { CSSProperties } from 'react';
import { Fragment } from 'react';
import { ErrorItem } from '@/types/api';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import {
    COLUMN_GAP_MM,
    REVIEW_PAGE_HEIGHT_MM,
    REVIEW_PUNCH_GUTTER_MM,
    VOLUME_HEADER_MM,
    VOLUME_VARIANTS,
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
 * ── 2026-09-28 这一版改了什么（他逐条提的）─────────────────────────
 *  ① 每题上面**不再有题号/二维码/横线**，只有一条**浅浅的灰虚线**分隔；
 *     二维码搬到**页眉**（内容 = 卷号-页码），一页一个。
 *     题前只有一个**流水号**（1. 2. 3. …），它只是这份卷的排序号，不是题号。
 *  ② 页眉是一条**卷头**：阳文圆角框「复练」（暗红）/「积累」（深绿）+ 卷号
 *     + 年级·学期 + 第X/Y页 + 印于 YYYY-MM-DD，下面一条横线与本页二维码共享页宽。
 *     ⚠️ 阳文 = 白底、彩框彩字；深挖纸是**实底白字** —— 一眼分得清"卷"和"纸"。
 *  ③ 一页能排几题就排几题（不再"每页最多两题"），见 `lib/review-card.ts`。
 *  ④ **每道题**都印升降级小框（上一版只有第一题有框）。
 *  ⑤ 打孔位：**奇数页留左、偶数页留右**（与深挖纸正反面同一条物理边）。
 *
 * ── 铁律（与深挖纸同）────────────────────────────────────────────
 * **纸上零 AI 内容**：不印答案 / 解析 / 错因 / 进度，有渲染测试钉死。
 * 面标记规范：有角标就该有码，所以本组件一定同时画四角角标与页眉二维码。
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

/** 四角角标：定位用的小直角。纸歪了靠它摆正（回收程序认这个）。 */
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

/**
 * 卷头（页眉）。
 * 第一排：阳文框 + 卷号 + 年级·学期 + 第X/Y页 + 印于日期
 * 第二排：横线（撑左）+ 本页二维码（贴右）—— 两者共享页宽
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
            <div style={{ height: '9mm', display: 'flex', alignItems: 'center', gap: '2.5mm', flex: '0 0 auto' }}>
                {/* 阳文框：框与字同色、底为白 —— 与深挖纸（实底白字）恰好相反，便于一眼区分 */}
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
            </div>
            {/* 横线与二维码共享页宽：线占左侧剩下的，码贴右 */}
            <div style={{ height: '11mm', display: 'flex', alignItems: 'center', gap: '2.5mm', flex: '0 0 auto' }}>
                <span
                    className="print-volume-header-rule"
                    style={{ flex: 1, height: '0.25mm', background: '#666' }}
                />
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
        </div>
    );
}

/**
 * 一道题的块：流水号 + 题干 → 答题区（左下角题图 / 右下角升降级框）。
 *
 * ⚠️ 高度全部来自算法给的 `block.contentHeightMM`，组件不再自己夹一次。
 */
function ReviewQuestionBlock({
    item,
    block,
    kind,
    showDivider,
    blankValue,
    onBlankChange,
    L,
}: {
    item: ErrorItem;
    block: ReviewBlockLayout;
    /** 哪种卷 —— 题图宽度上限跟着它走（积累纸栏窄，图不能按复练纸的宽度印） */
    kind: VolumeKind;
    /** 本栏内不是第一题时才画那条浅虚线（跨页/跨栏处不画） */
    showDivider: boolean;
    blankValue?: number;
    onBlankChange?: (itemId: string, next: number) => void;
    L: (zh: string, en: string) => string;
}) {
    const figures = useFigureImages(item);
    const stem = item.questionText || item.ocrText;
    const canTweak = typeof blankValue === 'number' && !!onBlankChange;

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

            {/* 答题区：高度 = max(题图, 留白行数×行高)（算法算好的） */}
            <div
                className="print-review-answer"
                style={{
                    height: `${block.rowHeightMM}mm`,
                    marginTop: '1mm',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '2.5mm',
                    flex: '0 0 auto',
                    overflow: 'hidden',
                }}
            >
                {/* 题图放在题干左下角（他定的位置） */}
                {figures.length > 0 && block.figureHeightMM > 0 && (
                    <div
                        className="print-review-figures"
                        style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            alignItems: 'flex-start',
                            gap: '2mm',
                            maxHeight: `${block.figureHeightMM}mm`,
                            overflow: 'hidden',
                            flex: '0 0 auto',
                        }}
                    >
                        {figures.map((url, i) => (
                            /* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */
                            <img
                                key={i}
                                src={url}
                                alt=""
                                style={{
                                    maxWidth: `${VOLUME_VARIANTS[kind].figureMaxWidthMM}mm`,
                                    maxHeight: `${block.figureHeightMM}mm`,
                                    display: 'block',
                                }}
                            />
                        ))}
                    </div>
                )}

                {/* 右侧：留白 + 右下角的升降级小框（**每题都有**） */}
                <div
                    style={{
                        flex: 1,
                        minWidth: 0,
                        alignSelf: 'stretch',
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
                    <PromoteBox manageType={item.manageType} L={L} />
                </div>
            </div>
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
    const padding = punchOnLeft
        ? { paddingLeft: `${REVIEW_PUNCH_GUTTER_MM}mm`, paddingRight: 0 }
        : { paddingLeft: 0, paddingRight: `${REVIEW_PUNCH_GUTTER_MM}mm` };

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
            <CornerMark at="tl" />
            <CornerMark at="tr" />
            <CornerMark at="bl" />
            <CornerMark at="br" />

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
                                        kind={kind}
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
