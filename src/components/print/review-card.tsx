import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Fragment } from 'react';
import { ErrorItem } from '@/types/api';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import {
    COLUMN_GAP_MM,
    REVIEW_FIGURE_BOX_RATIO,
    REVIEW_LAYOUT_MM,
    REVIEW_PAGE_HEIGHT_MM,
    REVIEW_PUNCH_GUTTER_MM,
    VOLUME_HEADER_MM,
    type MeasuredPageLayout,
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
 * ══════════════════════════════════════════════════════════════════
 * 【2026-09-28 第三次改版：块不再自己算高度】
 *
 * 前两版每一块都设了一个"算出来的"高度（`contentHeightMM` / `rowHeightMM`），
 * 一旦真实内容比估的高，块就被 `overflow: hidden` **切掉下半截** ——
 * 他看到的"升降级只剩半个"就是这个。
 *
 * 现在：**块不设高度**，内容多高就多高。分页改成"先量后分"（见 `lib/review-card.ts`
 * 的文件头）。本组件的 `ReviewQuestionBlock` 被**同一个**量尺容器复用，
 * 保证"量到的"就是"印出来的"。
 * ══════════════════════════════════════════════════════════════════
 *
 * 铁律（与深挖纸同）：**纸上零 AI 内容** —— 不印答案 / 解析 / 错因 / 进度。
 */

/**
 * 卷头右上角那"二维码一栏"的宽度 = 二维码 10mm + 一点间隙。
 * 第一排的文字与第二排的横线都靠它往左让位（见 VolumeHeader 里的说明）。
 */
const VOLUME_QR_COLUMN_MM = 11;

/**
 * 【2026-09-30】原题已被删除时的**占位块**（复练卷页专用）。
 *
 * 他定的规矩（原话大意）："错题本本来就该有进有出" —— 卷里某道题的原题被删了，
 * **不要**重排整页，就地把这道题换成"题号 + 此题已无"，后面的题往前移，
 * 这一页下面空出来就空着。
 * 为什么坚持"不重排"：手机扫这一页的二维码，跳出来的是**这一页**的内容；
 * 题在页之间窜来窜去，扫码就对不上了。
 *
 * ⚠️ **它就是一道普通的题**（他 2026-09-30 二改的原话："没有必要搞这么特殊"）——
 *    所以：① 自己**不画**任何虚线；② 上方那条虚线跟别的题一样，由 `showDivider`
 *    （本栏内不是第一块）决定。早先版本自己上下各画一条，结果是
 *    页首多一条线、和下一题之间多出一条**双线**。
 */
function MissingQuestionBlock({
    seq,
    itemNo,
    showDivider,
    L,
}: {
    seq: number;
    itemNo: string | null;
    showDivider: boolean;
    L: (zh: string, en: string) => string;
}) {
    return (
        <div
            style={{
                flex: '0 0 auto',
                // 与 `ReviewQuestionBlock` 完全同一条规则：虚线画在**本块顶上**、本栏第一块不画
                borderTop: showDivider ? '0.3mm dashed #cfcfcf' : undefined,
                padding: '1.5mm 0',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '2mm', color: '#999', fontSize: '9pt' }}>
                <span style={{ fontWeight: 700 }}>{seq}</span>
                {itemNo ? <span>{itemNo}</span> : null}
                <span>{L('此题已无', 'removed')}</span>
            </div>
        </div>
    );
}

export interface ReviewSheetProps {
    /** 这一页的排布（复练 1 栏 / 积累 2 栏）—— 由纯函数按**真实高度**分好 */
    page: MeasuredPageLayout;
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
    /** 这道题题图的缩放百分比（屏幕上拖右下角调的） */
    figureScaleOf?: (itemId: string) => number;
    /** 按下题图（开始缩放） */
    onFigureScaleStart?: (itemId: string) => (e: ReactPointerEvent) => void;
    /**
     * 【2026-10-01 扫码用】**每道题罩一个天蓝框 + 框中间一个蓝圆白加号**：
     * 传了这个回调，每个题块上就会盖一层框与加号（只在屏幕上画，不进打印）。
     * 点加号 ⇒ 回调拿到这道题 ⇒ 调用方据此打开"这道题的错题卡"。
     *
     * ⚠️ 框与加号**画在纸的 DOM 里面**（绝对定位在本块上），不是浮在纸外面的另一层 ——
     *    这样纸滚动/缩放时框天然跟着走，**不可能漂移**（他专门点过这条）。
     */
    onQuestionPlusClick?: (item: ErrorItem) => void;
    /** 加号的悬停提示（可选） */
    plusTitle?: string;
    /** 按住两题之间的虚线（调上面那道题的留白行数） */
    onDividerDragStart?: (aboveItemId: string, startLines: number) => (e: ReactPointerEvent) => void;
    /**
     * 【2026-09-30】原题已被删的题：key → 题号快照（题号可能是 null）。
     * 传了就在这里渲染"此题已无"占位块；不传就照旧什么都不画。
     */
    missing?: Record<string, string | null>;
    L: (zh: string, en: string) => string;
}

/**
 * 去掉题干里的 **markdown 图片语法**。
 *
 * 为什么必须去：OCR / AI 有时会在题干里留下 `![题目图片](某个地址)`。
 * 那个地址在纸面这个上下文里取不到，浏览器就画一个**破图标 + 替代文字**，
 * 又难看又占地方 —— 他说的"图显示不全"里有一半就是这种假图。
 * 真正的题图是**橙框单独裁出来**的（见 `use-print-images`），不靠这段 markdown。
 */
export function stripMarkdownImages(text: string): string {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 卷头（页眉）——**一排装完**。
 *
 * ```
 * [复练]  RE20260928002  六年级上·五年级上  ……………  第1/5页  印于 2026-09-28  [二维码]
 * ────────────────────────────────────────────────────────────────────────────────
 * ```
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
                // 二维码要绝对定位到右上角（往上提、上面不放内容）
                position: 'relative',
            }}
        >
            {/* 第一排：身份条文字。
                `paddingRight` = **二维码那一栏的宽度** —— 于是：
                  ① 页码 / 印刷时间被**往左推**（他 2026-09-30 要的）；
                  ② 二维码上方那一块自然空出来（"二维码上面不放内容"）。 */}
            <div
                style={{
                    height: '6.5mm',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2.5mm',
                    flex: '0 0 auto',
                    paddingRight: `${VOLUME_QR_COLUMN_MM}mm`,
                }}
            >
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
            </div>
            {/*
                第二排（**2026-09-30 二改**，他实测反馈）：
                  ① 二维码**往上提**（绝对定位到右上角、顶到纸面顶部）—— 它上面不再放任何内容；
                  ② 页码 / 印刷时间**往左挪**（靠第一排的 paddingRight 让位）；
                  ③ 横线**往上移**、离上面那排文字更近，右侧到二维码左边为止。
                高度仍是 6.5 + 其余 = 15mm = VOLUME_HEADER_MM ⇒ **页面总高不变、分页结果不变**。
                二维码 10mm：它已经独占右上角那一栏（不再与横线挤同一排），
                所以从上一版的 9mm 放回 10mm —— 扫码余量更足。
            */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    flex: '0 0 auto',
                    paddingRight: `${VOLUME_QR_COLUMN_MM}mm`,
                    marginTop: '1mm',
                }}
            >
                <span className="print-volume-header-rule" style={{ flex: 1, height: '0.25mm', background: '#666' }} />
            </div>
            {pageQr ? (
                /* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */
                <img
                    className="print-qr print-volume-qr"
                    src={pageQr}
                    alt=""
                    style={{ position: 'absolute', top: '1mm', right: 0, width: '10mm', height: '10mm' }}
                />
            ) : null}
        </div>
    );
}

/**
 * 一道题的块 —— **不设高度，内容多高就多高**。
 *
 * 结构：`流水号 + 题干` → `答题区（左题图 / 右下角升降级小框）`。
 *
 * ⚠️ **这个组件同时被"量尺容器"和"正式版面"用**（见 print-preview 的隐藏量尺）。
 *    两处必须**同宽同内容**，否则"量到的"就不是"印出来的"。
 *
 * 题图：`width: 100%` 铺满图列（宽 = 答题区的 55%），高度按原长宽比自然推出来、
 * 只受 `max-height` 限制，再叠 `object-fit: contain` ——
 * **小的会放大、大的会缩小、竖长的不会被拉变形、永远不会被裁切**。
 */
export function ReviewQuestionBlock({
    item,
    seq,
    blankLines,
    showDivider,
    blankValue,
    onBlankChange,
    figureScale = 100,
    onFigureScaleStart,
    onDividerDragStart,
    L,
}: {
    item: ErrorItem;
    /** 流水号（1 起）—— 这份卷里的排序号，不是题号 */
    seq: number;
    /** 这道题生效的留白行数 */
    blankLines: number;
    /** 本栏内不是第一题时才画那条浅虚线（跨页/跨栏处不画） */
    showDivider: boolean;
    /** 屏幕上的微调控件要显示的行数（不给就不渲染控件） */
    blankValue?: number;
    onBlankChange?: (itemId: string, next: number) => void;
    /**
     * 这道题**题图**的缩放百分比（100 = 版面默认）。
     * 他要的调法：**左上角固定、拖右下角、等比缩放** —— 因为有的图上纸后偏大/偏小。
     */
    figureScale?: number;
    /**
     * 按下题图（手机：手指按在图上；电脑：右下角小把手）开始缩放。
     * 拖拽逻辑在打印页，这里只负责把"起点"交出去。
     */
    onFigureScaleStart?: (itemId: string) => (e: ReactPointerEvent) => void;
    /**
     * 按住本块顶上那条**虚线**上下拖 ⇒ 调**上面那道题**的留白行数（整行增减）。
     * 打印页已经把"上面是哪道题、现在几行"包好了，这里只管把事件交出去。
     */
    onDividerDragStart?: (e: ReactPointerEvent) => void;
    L: (zh: string, en: string) => string;
}) {
    const figures = useFigureImages(item);
    const rawStem = item.questionText || item.ocrText || '';
    const stem = stripMarkdownImages(rawStem);
    const blankMM = blankLines * REVIEW_LAYOUT_MM.blankLineMM;
    const canTweak = typeof blankValue === 'number' && !!onBlankChange;

    return (
        <div
            className="print-review-block"
            data-review-block={item.id}
            style={{
                display: 'flex',
                flexDirection: 'column',
                flex: '0 0 auto',
                position: 'relative',
                borderTop: showDivider ? '0.3mm dashed #cfcfcf' : undefined,
            }}
        >
            {/* 拖虚线调留白：一条**绝对定位**的透明条，盖在本块顶上的虚线上。
                ⚠️ 必须 absolute —— 它不参与布局，量出来的高度才不会因为它变来变去。
                调的是**上面那道题**（虚线在它脚底下）。 */}
            {showDivider && onDividerDragStart && (
                <span
                    className="print-review-divider-handle no-print"
                    title={L('上下拖动：调整上面那道题的留白行数', 'Drag to change the blank lines above')}
                    onPointerDown={onDividerDragStart}
                />
            )}
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
                    {seq}.
                </span>
                {stem ? (
                    <MarkdownRenderer content={stem} />
                ) : (
                    <span style={{ fontSize: '9pt', color: '#777' }}>
                        {L('（这题没有可打印的题干）——翻回原题看', '(nothing to print)')}
                    </span>
                )}
            </div>

            {/* 答题区：左边题图、右边留白。
                高度 = max(题图实际高度, 留白行数×行高, 小框那一行) —— 全由内容自然决定。
                右上角 = 留白调节器（固定不动，点完加减号不用挪鼠标）、右下角 = 升降级小框。 */}
            <div
                className="print-review-answer"
                style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: '2.5mm',
                    marginTop: '1mm',
                    minHeight: `${Math.max(blankMM, REVIEW_LAYOUT_MM.answerRowMinMM)}mm`,
                    flex: '0 0 auto',
                    position: 'relative',
                }}
            >
                {figures.length > 0 && (
                    <div
                        className="print-review-figures"
                        style={{
                            // 缩放就作用在这条宽度上：55% × 百分比（上限 180 ⇒ 最多占满整行）
                            flex: '0 0 auto',
                            width: `${REVIEW_FIGURE_BOX_RATIO * figureScale}%`,
                            minWidth: 0,
                            maxWidth: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2mm',
                            position: 'relative',
                            // 手机上"按住图左右拖 = 缩放"：不让浏览器把手势抢去当滚动
                            touchAction: 'none',
                        }}
                        // 手指/笔直接按在图上就能拖（电脑用右下角小把手，免得误拖）
                        onPointerDown={(e) => {
                            if (e.pointerType === 'mouse') return;
                            onFigureScaleStart?.(item.id)(e);
                        }}
                    >
                        {figures.map((url, i) => (
                            /* eslint-disable-next-line @next/next/no-img-element -- 打印页必须用原生 img：src 是 dataURL，要交给浏览器打印快照；next/image 会插一层优化/懒加载，反而可能打不出来 */
                            <img
                                key={i}
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
                        ))}
                        {/* 拖拽把手：**只在屏幕上**（打印时被 CSS 隐藏），右下角、等比缩放。
                            类名 .print-fig-handle 与深挖纸共用（2026-09-29 深挖纸也加了这功能） */}
                        {onFigureScaleStart && (
                            <span
                                className="print-fig-handle no-print"
                                title={L('拖动调整图片大小（左上角固定）', 'Drag to resize')}
                                onPointerDown={(e) => {
                                    // 鼠标只认这个把手；手指已经在图上直接拖了（见外层）
                                    if (e.pointerType !== 'mouse') return;
                                    onFigureScaleStart(item.id)(e);
                                }}
                            />
                        )}
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
                    {/* 留白微调：**钉在空白区右上角**（绝对定位），加减号不会跟着空白跑 ——
                        他反馈"点完减号想点下一次还得挪鼠标"就是因为原来贴在空白底下。
                        只在屏幕上出现，打印时被 CSS 隐藏。 */}
                    {canTweak && (
                        <span className="print-review-tweak" style={{ position: 'absolute', top: 0, right: 0 }}>
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
    figureScaleOf,
    onFigureScaleStart,
    onDividerDragStart,
    missing,
    onQuestionPlusClick,
    plusTitle,
    L,
}: ReviewSheetProps) {
    /**
     * 打孔位：**奇数页留左、偶数页留右**。
     * 道理和深挖纸"正面左、反面右"一样 —— 家里活页夹按一个物理边打孔，
     * 单面卷页页翻过去，孔位就在左右之间交替。
     */
    const punchOnLeft = pageNo % 2 === 1;
    /**
     * ⚠️ 打孔位走 **CSS 变量**，不直接写 padding ——
     * 因为屏幕上还要在外面再套一圈"纸边"（`@media screen` 里 `calc(15mm + var(--punch-l))`）。
     * 直接写 padding，内联样式会盖掉纸边那 15mm，纸就一边宽一边窄、也不像 B5 了；
     * 而 `@media print` 里一句 `padding:0 !important` 又会把打孔位一起清掉（真打出来就没孔位了）。
     * 打孔位 = 12mm，与深挖纸 `PUNCH_GUTTER_MM` 同一个数（他要求两种纸一致）。
     */
    const punchVars = {
        '--punch-l': punchOnLeft ? `${REVIEW_PUNCH_GUTTER_MM}mm` : '0mm',
        '--punch-r': punchOnLeft ? '0mm' : `${REVIEW_PUNCH_GUTTER_MM}mm`,
    } as CSSProperties;

    /** 拖虚线调留白只在"能改"时才有（量尺/正式打印那两处没有 onBlankChange） */
    const canDragDivider = !!onBlankChange && !!blankValueOf && !!onDividerDragStart;

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
                            style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
                        >
                            {col.blocks.map((b, bi) => {
                                const item = itemByKey[b.key];
                                if (!item) {
                                    // 原题已被删（快照还在）⇒ 就地留"此题已无"占位，**不重排整页**
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
                                // 虚线画在本块顶上，所以"虚线上面那道题"是**前一块**
                                const above = bi > 0 ? itemByKey[col.blocks[bi - 1].key] : null;
                                return onQuestionPlusClick ? (
                                    /**
                                     * 【2026-10-01 扫码浏览】每道题罩一层**天蓝框** + 框中间一个**蓝圆白加号**。
                                     * ⚠️ 框/加号都是**本块内的绝对定位元素**（不是浮在纸外面的另一层）——
                                     *    纸滚动、缩放时它们天然跟着走，不会漂移（他明说的要求）。
                                     * 外面这层 div 只是为了给绝对定位一个参照系，尺寸与题块一致 ⇒ 布局不变。
                                     */
                                    <div key={b.key} style={{ position: 'relative', flex: '0 0 auto' }}>
                                        <ReviewQuestionBlock
                                            item={item}
                                            seq={b.seq}
                                            blankLines={blank}
                                            showDivider={bi > 0}
                                            figureScale={figureScaleOf ? figureScaleOf(item.id) : 100}
                                            L={L}
                                        />
                                        <span
                                            aria-hidden="true"
                                            className="no-print"
                                            style={{
                                                position: 'absolute',
                                                inset: '0.8mm 1mm',
                                                border: '0.45mm solid #38bdf8',
                                                borderRadius: '1.6mm',
                                                boxSizing: 'border-box',
                                                pointerEvents: 'none',
                                            }}
                                        />
                                        <button
                                            type="button"
                                            className="no-print"
                                            title={plusTitle}
                                            onClick={() => onQuestionPlusClick(item)}
                                            style={{
                                                position: 'absolute',
                                                left: '50%',
                                                top: '50%',
                                                transform: 'translate(-50%, -50%)',
                                                width: '10mm',
                                                height: '10mm',
                                                borderRadius: '9999px',
                                                background: '#2563eb',
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
                                                    stroke="#ffffff"
                                                    strokeWidth={3.4}
                                                    strokeLinecap="round"
                                                    fill="none"
                                                />
                                            </svg>
                                        </button>
                                    </div>
                                ) : (
                                    <Fragment key={b.key}>
                                        <ReviewQuestionBlock
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
                                    </Fragment>
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
export function totalBlocks(page: MeasuredPageLayout): number {
    return page.columns.reduce((n, c) => n + c.blocks.length, 0);
}
