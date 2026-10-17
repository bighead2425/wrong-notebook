import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';
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
// 【2026-10-11】扫码那两件控件抽到共用件（模仿纸也要同一套，见该文件头的说明）
import { MasteryToggleBox, ScanBlockFrame, ScanPlusButton } from './scan-overlay';
// 【2026-10-12】题块右上角那对"上移/下移"（复练纸与模仿纸共用同一份，见该文件头）
import { MoveButtons } from './move-buttons';
import { PROMOTE_BOX, promoteDirectionFor, type PromoteDirection } from '@/lib/manage-type';
import {
    PROMOTE_APPLIED_BG,
    PROMOTE_APPLIED_LABEL_EN,
    PROMOTE_APPLIED_LABEL_ZH,
    REVIEW_MARK_COLORS,
    type ReviewMark,
} from '@/lib/scan-marking';

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
 *
 * 【2026-10-11】加 export：**模仿纸的右栏**也要用它（他定的规矩里有一模一样的一条：
 *   "如果附题中有哪道题已经删除了，就和复练卷一样，在那道题本来的位置灰色字体写
 *    题号和'此题已无'"）。理由与 `VolumeHeader` 那次相同 —— 抄第二份迟早走样。
 */
export function MissingQuestionBlock({
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
    /**
     * 【2026-10-03 需求第 10 条】这份卷的**随机 emoji 标识**（整卷所有页共用）。
     * 不传 ⇒ 页眉不画它，行为一字不变（扫码页、卷预览等调用方无需改）。
     */
    emojiMark?: string | null;
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
    /**
     * 【2026-10-01】**每题正确答案**（扫码浏览时给；见 `ReviewQuestionBlock` 的 `answerLabel`）。
     * 不传 ⇒ 纸上/卷页上完全没有这个标签，行为与之前一字不差。
     */
    answerOf?: (item: ErrorItem) => string | null;
    /** 【2026-10-17 空空第 3 条】点灰色答案框 ⇒ 弹"看/改完整答案"的对话框 */
    onAnswerClick?: (item: ErrorItem) => void;
    /**
     * 【2026-10-02 扫码录入】**纸面上直接改类型 / 记对错**这两组控件的出入口。
     *
     *   · `onPromoteToggle` 有值 ⇒ 每题的升降框画成**能点**的版本（点一下改类型）；
     *   · `onReviewMarkTap` + `reviewMarkOf` 有值 ⇒ 每题右侧画一颗**灰圆**并显示它当前态；
     *   · 都不传 ⇒ 与从前**一字不差**（打印预览/纸面那一路）。
     *
     * ⚠️ 两组都在屏幕上、都带 `no-print`，绝不落纸；且都挡住双击缩放。
     */
    onPromoteToggle?: (item: ErrorItem) => void;
    /** 升降框的"已应用（勾选）"态；返回 undefined = 未勾选 */
    promoteOverrideOf?: (item: ErrorItem) => { direction: PromoteDirection; checked: boolean } | undefined;
    /** 点右侧灰圆 ⇒ 交给调用方记录（**两态**：对 ⇄ 错） */
    onReviewMarkTap?: (item: ErrorItem) => void;
    /** 灰圆当前态（none/right/wrong）—— 记得按**这一卷上**的记录算，不是题目历史 */
    reviewMarkOf?: (item: ErrorItem) => ReviewMark;
    /** 【2026-10-16】长按 / 右键灰圆 ⇒ 交给调用方弹菜单（再录一次 / 删除这一条） */
    onReviewMarkLongPress?: (item: ErrorItem) => void;
    /** 【2026-10-16】这道题在这张卷上录过几轮（`>1` ⇒ 圈上画上标） */
    reviewRoundsOf?: (item: ErrorItem) => number;
    /** 【2026-10-16】这道题已掌握 ⇒ 圆禁用（"录不了"，`docs\18` 验收 #10） */
    reviewMarkDisabledOf?: (item: ErrorItem) => boolean;
    /**
     * 【2026-10-17 空空第 2 条】题框左侧那个「会」字方框：
     * `masteryOf` 给"现在已掌握吗"，`onMasteryToggle` 点一下切换（**不传就根本不画**）。
     */
    masteryOf?: (item: ErrorItem) => boolean;
    onMasteryToggle?: (item: ErrorItem) => void;
    /** 加号的悬停提示（可选） */
    plusTitle?: string;
    /** 按住两题之间的虚线（调上面那道题的留白行数） */
    onDividerDragStart?: (aboveItemId: string, startLines: number) => (e: ReactPointerEvent) => void;
    /**
     * 【2026-09-30】原题已被删的题：key → 题号快照（题号可能是 null）。
     * 传了就在这里渲染"此题已无"占位块；不传就照旧什么都不画。
     */
    missing?: Record<string, string | null>;
    /**
     * 【2026-10-12】某道题要**上移 / 下移一位**（与相邻那道题交换顺序与流水号）。
     *
     * 只在"还没定稿"的打印预览里给（卷管理页不给 —— 卷是印出去的凭证，
     * 页归属锁在快照里，挪题会让手机扫到的页与库里那一页对不上）。
     * ⚠️ 边界判定用 `seq`（它在**整卷**里连续），不看"这一页/这一栏里有没有邻居" ——
     *    挪位的范围是**整卷**，跨页也要能挪。
     */
    onMoveQuestion?: (item: ErrorItem, dir: -1 | 1) => void;
    /** 整卷一共几道题（判"最后一道"能不能下移）；不给 onMoveQuestion 时无所谓 */
    totalSeq?: number;
    L: (zh: string, en: string) => string;
}

/**
 * 去掉题干里的 **markdown 图片语法**。
 *
 * 为什么必须去：OCR / AI 有时会在题干里留下 `![题目图片](某个地址)`。
 * 那个地址在纸面这个上下文里取不到，浏览器就画一个**破图标 + 替代文字**，
 * 又难看又占地方 —— 他说的"图显示不全"里有一半就是这种假图。
 * 真正的题图是**橙框单独裁出来**的（见 `use-print-images`），不靠这段 markdown。
 *
 * ⚠️【2026-10-10】**实现已搬到 `lib/markdown-utils.ts`** —— 因为 `lib/imitate-card.ts`
 *    （纯逻辑）也要用它，而**纯逻辑不该 import 组件文件**。
 *    这里既 `import` 进来（本文件内部还要用）、又 `export` 出去（`insight-sheet.tsx`
 *    与渲染测试都从这儿取）⇒ 既有调用方**一行都不用改**。
 *    ⚠️ 不能写成 `export { x } from '...'`：那种写法**不会**在本地作用域引入名字，
 *       本文件里再调用它就是 `Cannot find name`（踩过一次，tsc 立刻抓到）。
 */
import { stripMarkdownImages } from '@/lib/markdown-utils';
export { stripMarkdownImages };

/**
 * 卷头（页眉）——**一排装完**。
 *
 * ```
 * [复练]  RE20260928002  六年级上·五年级上  ……………  第1/5页  印于 2026-09-28  [二维码]
 * ────────────────────────────────────────────────────────────────────────────────
 * ```
 */
/**
 * 卷头（卷号 / 年级学期 / 页码 / 印于 / 页二维码）—— **复练纸与积累纸共用同一份**。
 *
 * 【2026-10-01】加了 export：积累纸那一屏要复用它。
 * 不抄第二份的理由和错题卡那次一样 —— 页眉上"第几页"、二维码位置、打孔让位
 * 这些一旦两边各写一遍，迟早出现"积累纸页码和复练纸差一格"这种对不上的事。
 */
export function VolumeHeader({
    kind,
    volumeNo,
    pageNo,
    pageCount,
    gradeText,
    printDate,
    pageQr,
    emojiMark,
    L,
}: {
    kind: VolumeKind;
    volumeNo: string;
    pageNo: number;
    pageCount: number;
    gradeText?: string;
    printDate: Date;
    pageQr?: string;
    /**
     * 【2026-10-03 需求第 10 条】这份纸的**随机 emoji 标识**（整卷共用一个）。
     * 画在「印于 …」**左边**、与那行**同一档字号**。不传 ⇒ 什么都不画（其它调用方不变）。
     */
    emojiMark?: string | null;
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
                {/* 【2026-10-03 需求第 10 条】随机 emoji 标识：整卷共用一个，
                    画在「印于 …」**左边**、与那行同字号（8pt）。不传就没有。 */}
                {emojiMark ? (
                    <span style={{ fontSize: '8pt', lineHeight: 1, whiteSpace: 'nowrap' }}>{emojiMark}</span>
                ) : null}
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
/**
 * 【2026-10-02 他定】扫码页的**答案小标签**（灰底灰白字，刻意低对比）。
 *
 * 截断提示这次放在**开头**：答案在框里显示不全时，一上来就是 `＞…`，
 * "一开始看答案就知道答案不全了"（他原话）。原先末尾省略号的问题是 ——
 * 长答案被裁到连省略号都看不见，等于没有提示。
 *
 * 实现：渲染后量一次 `scrollWidth > clientWidth` ⇒ 溢出就加上 `＞…` 前缀、
 * 尾部直接裁掉（不用 text-overflow，它只能截尾）。
 */
function AnswerLabel({
    label,
    onClick,
    L,
}: {
    label: string;
    /**
     * 【2026-10-17 空空第 3 条】点这个灰框 ⇒ 弹对话框看/改**完整答案**。
     * 不传 ⇒ 仍是只读的一小块（打印预览那一路没有它）。
     */
    onClick?: () => void;
    L: (zh: string, en: string) => string;
}) {
    const boxRef = useRef<HTMLSpanElement | null>(null);
    const [truncated, setTruncated] = useState(false);

    /**
     * 量"放得下没有"。
     *
     * ⚠️【2026-10-02 审计时补】**必须用 ResizeObserver，不能只在 label 变化时量一次**：
     * 这一屏支持"双击纸面放大/缩小"（`SheetZoom` 改的是 CSS `zoom`），
     * 一缩放，标签的可视宽度就变了 —— 只量一次的话，
     * 放大后明明放得下却还挂着 `>…`（或反过来：缩小后放不下却不提示）。
     */
    useEffect(() => {
        const el = boxRef.current;
        if (!el) return;
        const measure = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
        measure();
        if (typeof ResizeObserver === 'undefined') return; // jsdom / 老浏览器兜底
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [label]);

    /** 【2026-10-17 空空第 3 条】灰色的答案小框 ⇒ 点它弹对话框看/改完整答案 */
    const boxStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        flex: '0 1 auto',
        minWidth: 0,
        maxWidth: '100%',
        background: '#bdbdbd',
        color: '#e6e6e6',
        fontSize: '6.5pt',
        lineHeight: 1.6,
        padding: '0.2mm 1.2mm',
        borderRadius: '0.8mm',
        overflow: 'hidden',
    };

    const inner = (
        <>
            {truncated && (
                // 【2026-10-02】用**半角** `>…`（他原话写的就是半角）——
                // 意思是"这个框里的答案不全"，一上来就能看见。
                <span style={{ flexShrink: 0, fontWeight: 700, paddingRight: '0.4mm' }}>&gt;…</span>
            )}
            {/* ⚠️【2026-10-03 修】`boxRef` **必须挂在这一层**（装着答案文字的那层）。
                它挂在外层时量不出溢出：外层是 flex 容器，其 `scrollWidth` 只统计**子元素盒子**
                的宽度，而子元素被 flex 收缩到与可用宽相等 ⇒ 恒有 `scrollWidth === clientWidth`
                ⇒ `truncated` 永远是 false ⇒ 他实测"这个功能并没有实现"（截图里长答案被裁了却没有提示）。
                挂到内容层：`clientWidth` = 分到的可视宽，`scrollWidth` = 文字真实宽 ⇒ 判断成立。 */}
            <span ref={boxRef} style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {label}
            </span>
        </>
    );

    /**
     * ⭐【2026-10-17】他决定改章程：**这个灰框要能点开看完整答案**。
     * 他的理由很实在 —— "看住了孩子不直接抄答案，但事实上也限制住了家长对答案，
     * 而且限制孩子抄答案这个过程本身也是掩耳盗铃的"。⇒ 点开即完整答案 + 可编辑。
     */
    if (onClick) {
        return (
            <button
                type="button"
                className="no-print"
                title={L('点开看完整答案（可改）', 'Open the full answer (editable)')}
                onClick={onClick}
                onDoubleClick={(e) => e.stopPropagation()}
                style={{ ...boxStyle, border: 'none', cursor: 'pointer', textAlign: 'left' }}
            >
                {inner}
            </button>
        );
    }

    return (
        <span
            className="no-print"
            title={L('这道题的正确答案（点中间的加号看完整解答）', 'Answer (tap + for the full solution)')}
            style={boxStyle}
        >
            {inner}
        </span>
    );
}

/**
 * 【2026-10-02 他要求】**能点的升降级小框**（扫码浏览那屏专用）。
 *
 * 为什么不在 `promote-box.tsx` 里加开关：那个框是**纸面印出来的样子**（给深挖纸/复练纸
 * 打印用），而这里是**屏幕上的录入控件** —— 两件事，套在一起会让打印的那份也跟着变形。
 * 所以复用它的**取值逻辑与配色 token**（`promoteDirectionFor` / `PROMOTE_BOX`），
 * 只在屏幕上另画一个可点版本。
 *
 * 交互（他定的）：
 *   · 未勾选 = 原样：空方框 + 箭头 + "升级/降级"；
 *   · 点一下 = 勾选：方框里出现**对号**，文字底色**降级浅绿 / 升级粉红**，
 *     箭头不变、文字改"已降/已升"；
 *   · 再点一下 = 取消：全部还原，后台把类型改回去。
 *
 * ⚠️ `no-print` —— 屏幕上才有的东西，绝不落纸（"纸上零 AI 内容"是铁律）。
 * ⚠️ 双击缩放要在这里**失效**（他专门点过）：`onDoubleClick` 拦住，不让它冒泡到
 *    `SheetZoom`；`touchAction: manipulation` 再挡掉手机浏览器的双击缩放。
 *    拖动平移**不受影响**（那只认 `pointerType === 'mouse'`，且本就跳过 `button`）。
 */
function InteractivePromoteBox({
    manageType,
    override,
    onToggle,
    L,
}: {
    manageType?: string | null;
    /** 已应用态（勾选）；不传 = 未勾选，方向按当前类型推 */
    override?: { direction: PromoteDirection; checked: boolean };
    onToggle: () => void;
    L: (zh: string, en: string) => string;
}) {
    const direction = override?.direction ?? promoteDirectionFor(manageType);
    const box = PROMOTE_BOX[direction];
    const checked = !!override?.checked;
    const label = checked
        ? L(PROMOTE_APPLIED_LABEL_ZH[direction], PROMOTE_APPLIED_LABEL_EN[direction])
        : L(box.label, box.labelEn);

    return (
        <button
            type="button"
            className="print-promote-box no-print"
            title={L('点一下：把这道题换成另一种（再点一下还原）', 'Tap to switch the type (tap again to undo)')}
            onClick={onToggle}
            // 双击缩放失效：别让它冒泡到 SheetZoom（拖动平移不受影响）
            onDoubleClick={(e) => e.stopPropagation()}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1.5mm',
                flexShrink: 0,
                // 触控目标撑到 ≥8mm：内边距扩大热区、负外边距抵消，布局（含题干）一动不动
                padding: '1mm',
                margin: '-1mm',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                touchAction: 'manipulation',
            }}
        >
            {/* 空方框：勾选后里面出现对号 */}
            <span
                style={{
                    position: 'relative',
                    display: 'inline-block',
                    width: '6mm',
                    height: '6mm',
                    border: '0.3mm solid #444',
                    background: '#ffffff',
                    boxSizing: 'border-box',
                    flexShrink: 0,
                }}
            >
                {checked && (
                    <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                    >
                        <path
                            d="M5 13l4 4L19 7"
                            stroke="#1f7a3f"
                            strokeWidth={3.2}
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                )}
            </span>
            {/* 文字：箭头不变；勾选后改"已降/已升"、加浅绿/粉底 */}
            <span
                style={{
                    fontSize: '9pt',
                    fontWeight: 600,
                    color: box.color,
                    whiteSpace: 'nowrap',
                    borderRadius: '0.8mm',
                    padding: checked ? '0.2mm 1mm' : 0,
                    background: checked ? PROMOTE_APPLIED_BG[direction] : 'transparent',
                }}
            >
                {box.arrow} {label}
            </span>
        </button>
    );
}

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
    answerLabel,
    onAnswerClick,
    onPromoteToggle,
    promoteOverride,
    onReviewMarkTap,
    reviewMark,
    onReviewMarkLongPress,
    reviewRounds,
    reviewMarkDisabled,
    masteryMastered,
    onMasteryToggle,
    masteryLeftMM,
    onMoveUp,
    onMoveDown,
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
    /**
     * 【2026-10-01 新增 · 扫码「对答案」】这道题的**正确答案**（纯文本，多行已由调用方用 `§` 并成一行）。
     *
     * 画成**升降框左边一个灰底灰字的小标签** —— 他 2026-10-01 的原话拆解：
     *   · 底色灰、文字灰白，**两者差异小一些** ⇒ "如果扫描二维码不是来查答案的，也不耽误，
     *     因为答案不容易辨别出来；如果有心想看答案也无妨，仔细分辨也能看见"。
     *   · 宽度**随答案长短变**，右侧抵住升降框、由左侧伸缩 ⇒ 靠右对齐。
     *   · 太长放不下（左边界顶到题号位置）⇒ 末尾用省略号；她真想看长答案就点中间的加号进详情。
     *
     * ⚠️ **只有扫码浏览那一屏会传**（其它地方不传 ⇒ 完全没有这个标签）。
     * ⚠️ 必须带 `no-print`：**纸上零 AI 内容**是铁律，答案绝不能落在纸上。
     */
    answerLabel?: string | null;
    /**
     * 【2026-10-17 空空第 3 条】点那个**灰色答案小框** ⇒ 交给调用方弹对话框（看/改完整答案）。
     * 不传 ⇒ 仍是只读（打印预览/纸面那一路）。
     */
    onAnswerClick?: () => void;
    /**
     * 【2026-10-02 扫码录入】**点升降框 ⇒ 直接改这道题的类型**。
     * 不传 ⇒ 走只读的 `PromoteBox`（纸面/打印那一路，行为一字不变）。
     */
    onPromoteToggle?: () => void;
    /** 升降框的"已应用（勾选）"态：方向 + 是否勾上；不传 = 未勾选，方向按当前类型推 */
    promoteOverride?: { direction: PromoteDirection; checked: boolean };
    /**
     * 【2026-10-02 扫码录入】**点右侧灰圆 ⇒ 记录对 / 错**（**两态**：点一下对、再点一下错）。
     * 不传 ⇒ 这颗圆根本不画（打印那一路完全没有它）。
     */
    onReviewMarkTap?: () => void;
    /** 这颗圆当前该是什么态（none/right/wrong）；由调用方按**这一卷上**的记录推 */
    reviewMark?: ReviewMark;
    /**
     * 【2026-10-16 如如】**长按 / 右键**这颗圆 ⇒ 弹菜单（"再录一次：对 / 错"、"删除这一条"）。
     * 不传 ⇒ 长按没有任何反应（行为退化成"只有点击"）。
     * 出处：`docs\18` §4.3 —— 两态循环把"撤销"挤出了点击路径，撤销只能走这个菜单。
     */
    onReviewMarkLongPress?: () => void;
    /**
     * 【2026-10-16 如如】这道题**已掌握** ⇒ 这颗圆禁用（不响应点击 / 长按，只显示当前态）。
     * 出处：`docs\18` 验收 #10"已掌握的题录不了" —— 冻住就真冻住
     * （**服务端也一样会忽略**，这里只是别让他白点一下没反应）。
     */
    reviewMarkDisabled?: boolean;
    /**
     * 【2026-10-17 如如】**已掌握吗** + 点一下切换（题框左侧那个「会」字方框）。
     *
     * 出处：空空 2026-10-17 第 2 条 —— *"所有题框（蓝色框）左侧，与右侧那个圆圈对称的地方，
     * 设置一个方形按钮……已掌握 ⇒ 绿底白字；未掌握 ⇒ 灰底白字。点一下切换，同时即时录入。"*
     *
     * 不传 `onMasteryToggle` ⇒ **这个方框根本不画**（打印预览/纸面那一路没有它）。
     */
    masteryMastered?: boolean;
    onMasteryToggle?: () => void;
    /**
     * 【2026-10-17】这个方框相对题块左缘往左多少毫米。
     * · 单栏（复练卷）：默认 `-11mm` —— 与右侧灰圆 `right:-11mm` **对称**
     * · 模仿卷的附题：由调用方给"落在中间那条分栏线上"的位置（栏距只有 4mm）
     */
    masteryLeftMM?: number;
    /**
     * 【2026-10-16 如如】这道题**在这张卷上**录过几轮 —— `>1` 时在圈左上方画一个上标数字。
     * 不传/为 1 ⇒ 不画角标。
     */
    reviewRounds?: number;
    /**
     * 【2026-10-12】右上角那对**上移 / 下移**（只在屏幕上）。
     * 不给 = 这一路不需要排序（量尺、卷管理页、扫码浏览），按钮根本不画。
     * 到边界那一头由调用方**不给相应回调** ⇒ 按钮灰着在位（见 `MoveButtons`）。
     */
    onMoveUp?: () => void;
    onMoveDown?: () => void;
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
            {/* 题干：左边一个流水号（1. 2. 3. …），它是这份卷的排序号，不是题号。
                ⚠️【2026-10-12 需求第 13 条】这里**不再**给那对上移/下移箭头留位子：
                   它们改挂到题块右缘**外面**（纸的页边距里，见 `move-buttons.tsx`），
                   题干因此拿到**和没有这个功能时一模一样**的宽度。 */}
            <div
                className="print-review-stem"
                style={{
                    position: 'relative',
                    paddingLeft: '6mm',
                    flex: '0 0 auto',
                }}
            >
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
                <MoveButtons
                    onMoveUp={onMoveUp}
                    onMoveDown={onMoveDown}
                    titleUp={L('上移一位（和上一题交换顺序与流水号）', 'Move up (swap with the previous question)')}
                    titleDown={L('下移一位（和下一题交换顺序与流水号）', 'Move down (swap with the next question)')}
                />
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
                            /**
                             * 手机上"按住图左右拖 = 缩放"：不让浏览器把手势抢去当滚动。
                             *
                             * ⚠️【2026-10-01 修】必须**只在能缩放时**才吃手势。
                             *   原来写死 `'none'` ⇒ 扫码浏览那屏（**只读**，不传 `onFigureScaleStart`）
                             *   也继承了它：手指落在题图范围内上下划，页面纹丝不动
                             *   （他实测："在题的蓝框内时似乎没有反应" —— 蓝框罩的正是题干+题图区）。
                             *   判据就用 `onFigureScaleStart` 有没有传 —— 谁能缩，谁才吃手势。
                             */
                            touchAction: onFigureScaleStart ? 'none' : undefined,
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
                        /**
                         * 【2026-10-01】这层原先是 `column`（只为把升降框推到右下角）。
                         * 现在改成**横排**，好让"答案标签"能贴在升降框**左边** ——
                         * 升降框自己 `flexShrink: 0`，所以标签只会往左伸、绝不挤到它。
                         * 留白调节器是绝对定位（`top/right`），不受排列方向影响。
                         */
                        display: 'flex',
                        flexDirection: 'row',
                        justifyContent: 'flex-end',
                        /**
                         * 内部**顶边对齐**（`flex-start`）⇒ 答案标签的顶边与升降框的顶边齐
                         * （他 2026-10-03："上边沿可以和升降框的上边沿差不多"）。
                         *
                         * ⚠️【2026-10-03 修·他报的 bug】但**光有这一条会把升降框顶到上边去**
                         * —— 这一栏被父层的 `alignItems: 'stretch'` 拉满整个答题区高度，
                         * 内容就会停在这片区域的最上面（挨着题图），而设计要的是
                         * **每道题右下角、虚线之上**。所以这一栏自己 `alignSelf: 'flex-end'`
                         * （高度收缩到内容、贴着答题区底边）—— 两者合起来：
                         * **整组沉到底部，组内标签与框顶边对齐**。
                         */
                        alignItems: 'flex-start',
                        alignSelf: 'flex-end',
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
                    {/* 【2026-10-01 · 扫码对答案】答案标签：贴在升降框**左边**。
                        ⚠️ `no-print` —— 只活在屏幕上（纸上零 AI 内容是铁律）。
                        `textOverflow` 用了**自定义字符串** `"……"`（中文省略号两个点），
                        CSS Overflow 3 支持，浏览器实测可用；不支持时退化成裁切，不影响功能。 */}
                    {answerLabel ? (
                        <AnswerLabel label={answerLabel} onClick={onAnswerClick} L={L} />
                    ) : null}
                    {/* 升降级小框：**每道题都有**（未定按复练处理）。
                        扫码那屏（传了 onPromoteToggle）换成**能点**的版本 —— 点一下直接改类型；
                        其余场合（纸面/打印）仍是原来的只读框，一字不变。 */}
                    {onPromoteToggle ? (
                        <InteractivePromoteBox
                            manageType={item.manageType}
                            override={promoteOverride}
                            onToggle={onPromoteToggle}
                            L={L}
                        />
                    ) : (
                        <PromoteBox manageType={item.manageType} L={L} />
                    )}
                </div>
            </div>

            {/* 【2026-10-02 扫码录入】**右侧灰圆**：点一下记"对"、再点记"错"（**两态**，2026-10-16 改）。
                · 位置：**天蓝框右侧、纸面右边距里**（他说的"靠近纸张边缘那一侧"），
                  **与中间蓝加号圆心在同一竖直中线**；这样它不会压在题块内的升降框/答案上；
                · 直径 11mm，比加号那个蓝圆（10mm）略大 —— 手指按得住；
                · ⚠️ `no-print`：屏幕控件，绝不落纸；
                · ⚠️ 双击缩放失效（onDoubleClick 拦截；touchAction 再挡手机双击缩放）；
                  拖动平移不受影响（它只认鼠标，且本就跳过 button）。
                · ⭐【2026-10-16】**长按 / 右键** ⇒ 弹菜单（再录一次 / 删除这一条）——
                  因为两态循环里**不再有"清空"**，撤销只能从这里走。 */}
            {onReviewMarkTap ? (
                <ReviewMarkCircle
                    mark={reviewMark ?? 'none'}
                    seq={seq}
                    rounds={reviewRounds}
                    disabled={reviewMarkDisabled}
                    onTap={onReviewMarkTap}
                    onLongPress={onReviewMarkLongPress}
                    L={L}
                />
            ) : null}

            {/* 【2026-10-17 空空第 2 条】题框**左侧**那个「会」字方框 —— 与右边那颗灰圆左右对称。
                · 已掌握 ⇒ 绿底白字；未掌握 ⇒ 灰底白字；点一下**即时**改库
                · `no-print`（屏幕控件，绝不落纸）；与灰圆同一条"跟着纸走"的绝对定位
                · 不传 `onMasteryToggle` ⇒ 根本不画（打印预览/纸面那一路没有它） */}
            {onMasteryToggle ? (
                <MasteryToggleBox
                    mastered={!!masteryMastered}
                    onClick={onMasteryToggle}
                    leftMM={masteryLeftMM}
                    title={
                        masteryMastered
                            ? L('已掌握 · 点一下改成"未掌握"', 'Mastered · tap to unmark')
                            : L('未掌握 · 点一下标成"已掌握"', 'Not mastered · tap to mark')
                    }
                />
            ) : null}
        </div>
    );
}

/** 长按多久算长按（毫秒）—— 太短会跟"点击"打架，太长按着累 */
const REVIEW_MARK_LONG_PRESS_MS = 550;

/**
 * 【2026-10-16 如如】卷页上那颗**记录对错的圆**（抽出来是因为多了长按那套状态）。
 *
 * 手势（`docs\18` §4.3）：
 *   · **点一下** ⇒ 对 ⇄ 错 两态切换（**永远不经过"清空"**）
 *   · **长按 / 右键** ⇒ 交给调用方弹菜单（再录一次：对 / 错 / 删除这一条）
 *
 * ⚠️ **长按触发后，松手那一次 click 必须吞掉** —— 否则"长按"会顺带当成一次点击、
 *    把他刚要看的东西又改了一次。用一个 ref 标记"这次长按已经生效"。
 * ⚠️ 这块在**缩放过的纸面**里 ⇒ 角标用 mm 单位跟着纸缩放（与圆的尺寸同一套单位）。
 */
function ReviewMarkCircle({
    mark,
    seq,
    rounds,
    disabled,
    onTap,
    onLongPress,
    L,
}: {
    mark: ReviewMark;
    /** 还没记录时圆里显示的那个**流水号**（灰底白数字） */
    seq: number;
    rounds?: number;
    /** 已掌握 ⇒ 禁用（不响应任何手势；服务端也一样会忽略） */
    disabled?: boolean;
    onTap: () => void;
    onLongPress?: () => void;
    L: (zh: string, en: string) => string;
}) {
    const timer = useRef<number | null>(null);
    const fired = useRef(false);

    const clearTimer = () => {
        if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
        }
    };

    const startPress = () => {
        if (!onLongPress || disabled) return;
        fired.current = false;
        clearTimer();
        timer.current = window.setTimeout(() => {
            fired.current = true;
            onLongPress();
        }, REVIEW_MARK_LONG_PRESS_MS);
    };

    // 组件卸载时别把定时器留着（下一题、翻页都会重建）
    useEffect(() => clearTimer, []);

    const color = REVIEW_MARK_COLORS[mark];

    return (
        <button
            type="button"
            className="no-print"
            disabled={disabled}
            title={
                disabled
                    ? L('这道题已掌握 ⇒ 录不了（先取消已掌握）', 'Mastered — unmark it first to record')
                    : onLongPress
                      ? L(
                            '点一下：对 ⇄ 错；长按：再录一次 / 删除这一条',
                            'Tap: correct ⇄ wrong · Long-press: record again / delete',
                        )
                      : L('点一下：对 ⇄ 错', 'Tap: correct ⇄ wrong')
            }
            aria-label={L('记录这道题的对错', 'Record correct or wrong')}
            onClick={() => {
                if (disabled) return;
                if (fired.current) {
                    fired.current = false; // 这次是长按带出来的，别当成点击
                    return;
                }
                onTap();
            }}
            onPointerDown={startPress}
            onPointerUp={clearTimer}
            onPointerLeave={clearTimer}
            onPointerCancel={clearTimer}
            onContextMenu={(e) => {
                if (!onLongPress || disabled) return;
                e.preventDefault();
                onLongPress();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{
                position: 'absolute',
                // 落在纸面右边距里（正好贴着题块右缘往外一格），不与块内控件重叠
                right: '-11mm',
                top: '50%',
                transform: 'translateY(-50%)',
                width: '11mm',
                height: '11mm',
                borderRadius: '9999px',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: disabled ? 'not-allowed' : 'pointer',
                zIndex: 7,
                boxShadow: '0 0.4mm 1.2mm rgba(0,0,0,0.25)',
                background: color.bg,
                color: color.fg,
                fontSize: '11pt',
                fontWeight: 700,
                lineHeight: 1,
                touchAction: 'manipulation',
                // 已掌握：压暗一点，一眼看出"这颗点不动"
                opacity: disabled ? 0.45 : 1,
            }}
        >
            {mark === 'right' ? '✓' : mark === 'wrong' ? '✗' : seq}
            {/* 轮次角标：这道题**在这张卷上**录过 2 轮以上才标（1 不标）——
                样式做成"次幂"那样的小号上标，位置在圆的**左上方**（他 2026-10-16 22:43 定）。 */}
            {typeof rounds === 'number' && rounds > 1 ? (
                <span
                    aria-hidden="true"
                    style={{
                        position: 'absolute',
                        left: '-1.6mm',
                        top: '-1.6mm',
                        minWidth: '4mm',
                        height: '4mm',
                        padding: '0 0.6mm',
                        borderRadius: '9999px',
                        background: '#ffffff',
                        color: '#374151',
                        border: '0.25mm solid #d1d5db',
                        fontSize: '6.5pt',
                        fontWeight: 700,
                        lineHeight: '3.4mm',
                        textAlign: 'center',
                    }}
                >
                    {rounds}
                </span>
            ) : null}
        </button>
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
    emojiMark,
    itemByKey,
    blankValueOf,
    onBlankChange,
    figureScaleOf,
    onFigureScaleStart,
    onDividerDragStart,
    missing,
    onQuestionPlusClick,
    plusTitle,
    answerOf,
    onAnswerClick,
    onPromoteToggle,
    promoteOverrideOf,
    onReviewMarkTap,
    reviewMarkOf,
    onReviewMarkLongPress,
    reviewRoundsOf,
    reviewMarkDisabledOf,
    masteryOf,
    onMasteryToggle,
    onMoveQuestion,
    totalSeq,
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

    /**
     * 这道题能不能上移 / 下移 —— **只看它在整卷里的流水号**。
     * 边界那一头**不给回调**（按钮灰着在位，他能一眼看出"到头了"）。
     * ⚠️ 判据是 `seq` 而不是"这一栏里有没有邻居"：挪位的范围是整卷，跨页也要能挪
     *    （第 1 页第 1 道点"上移"没反应、第 2 页第 1 道却挪得动，那才叫怪）。
     */
    const movePropsFor = (item: ErrorItem, seq: number) =>
        onMoveQuestion
            ? {
                  onMoveUp: seq > 1 ? () => onMoveQuestion(item, -1) : undefined,
                  onMoveDown: !totalSeq || seq < totalSeq ? () => onMoveQuestion(item, 1) : undefined,
              }
            : {};

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
                emojiMark={emojiMark}
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
                                            answerLabel={answerOf ? answerOf(item) : undefined}
                                            onAnswerClick={
                                                onAnswerClick ? () => onAnswerClick(item) : undefined
                                            }
                                            onPromoteToggle={
                                                onPromoteToggle ? () => onPromoteToggle(item) : undefined
                                            }
                                            promoteOverride={promoteOverrideOf ? promoteOverrideOf(item) : undefined}
                                            onReviewMarkTap={
                                                onReviewMarkTap ? () => onReviewMarkTap(item) : undefined
                                            }
                                            reviewMark={reviewMarkOf ? reviewMarkOf(item) : undefined}
                                            onReviewMarkLongPress={
                                                onReviewMarkLongPress
                                                    ? () => onReviewMarkLongPress(item)
                                                    : undefined
                                            }
                                            reviewRounds={reviewRoundsOf ? reviewRoundsOf(item) : undefined}
                                            reviewMarkDisabled={
                                                reviewMarkDisabledOf ? reviewMarkDisabledOf(item) : undefined
                                            }
                                            masteryMastered={masteryOf ? masteryOf(item) : undefined}
                                            onMasteryToggle={
                                                onMasteryToggle ? () => onMasteryToggle(item) : undefined
                                            }
                                            {...movePropsFor(item, b.seq)}
                                            L={L}
                                        />
                                        <ScanBlockFrame />
                                        <ScanPlusButton
                                            onClick={() => onQuestionPlusClick(item)}
                                            title={plusTitle}
                                        />
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
                                            {...movePropsFor(item, b.seq)}
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
