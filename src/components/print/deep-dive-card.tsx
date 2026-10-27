'use client';

/**
 * T1 深挖纸（P5 / P9 / P20 / P24）—— 本轮唯一在做的纸型。
 *
 * ── 纸上只有三样东西：题、她写的区、身份条（P3 / P19）──────────────────
 * 这是它和旧版「错题卡」最根本的区别：**纸上零 AI 内容**。
 * 解析、错因、参考答案**一律不印** —— AI 的活全部挪到回收之后（P19）。
 *
 * ── 一张纸的两个面（2026-09-24 晚定稿）──────────────────────────────
 *
 *   正面（她反思的那面）              ← 左侧留打孔位
 *     身份条：[学科色标] [题号  年级学期] … [打印日] [二维码 · 右上]
 *     横线下面**靠左**：知识点，各知识点用 · 隔开
 *     原题照片 ← **带笔迹、不带框、不带外边框**（原页面的样子）
 *     ┌─────────────────────────────┐
 *     │ 她自己分析的那块（十字象限）      │  ← **外边框 + 四角标识都在这块上**
 *     └─────────────────────────────┘
 *
 *   反面（她重做的那面）              ← 右侧留打孔位（同一条物理边）
 *     （没有身份条 —— 有身份条就分不清正反了）
 *     文字题干（OCR）
 *     题图 ← 橙框圈出的图挂在题干**下方、靠左**（文字 + 图 = 真题）
 *     ══════「遮挡线」══════  粗线 · **线中印"遮挡线"三字** · 位置随题目浮动
 *     ┌──────────────────┐
 *     │  她手写内容区（不加十字线：模拟真实考场）      │
 *     └──────────────────┘
 *     页脚（2026-09-26 改，做成正面的**镜像**）：
 *       [二维码 · 左] ───────────────────  ← 二维码与横线**共享页宽**
 *       [□ 2026-09-25] [□ 2026-10-01] [□ 2026-10-15] ┈┈┈┈
 *                                          └ 虚线框：**不印用途**（盖章 / 手写"已会"）
 *
 * ── 为什么"遮挡线"三个字要印出来 ────────────────────────────────
 * 它同时是**给孩子看的**（说明这条线是干什么的）和**给机器看的**：
 * OCR 认出这三个汉字 = 直接拿到手写内容区的**上界**；下界由那条固定位置的细线给出。
 *
 * ── 四个日期格 ─────────────────────────────────────────────────
 * 打印日 **+1 / +7 / +21**（P20 定案），纸面写法 **yyyy-mm-dd**。
 * 每格她自判**空 / 对 / 错** —— 原设计只记"做没做"，记不下"过没过"。
 */

import { DEFAULT_PAPER_ID, PAPERS, type PaperSpec } from '@/lib/paper';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { SubjectChip } from '@/components/subject-chip';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ErrorItem } from '@/types/api';
import { formatIsoDate } from '@/lib/date-format';
import { getNotebookPrintInfo, getTags } from '@/lib/print-preview';
import {
    DEEP_CROSSHAIR_FLOOR_MM,
    DEEP_FIGURE_BASE_MM,
    SLOT_COLORS,
    SLOT_SIZE_MM,
    STAMP_BOX_MM,
    T1_LAYOUT_MM,
    maxFrontPhotoHeightMM,
    maxFrontPhotoHeightHardMM,
    reviewDateSlots,
    sidePaddingMM,
    type SlotColor,
} from '@/lib/deep-dive-card';
// 题图缩放的归一化（30–180%）与复练纸共用同一处实现，别抄一份
import { normalizeFigureScale } from '@/lib/review-card';
import { useFigureImages } from './use-print-images';
import { PromoteBox } from './promote-box';

/**
 * 【2026-10-27 超长题分页】把题干按"空行"切成若干块。
 *
 * 为什么按空行：Markdown 里 `\n\n` 就是块边界（新段落/新列表/新图），
 * 按它切**不会把一段话劈成两半**；拼回去用 `join('\n\n')` 语义完全等价。
 *
 * ⚠️ 代码围栏（```）里的空行不是块边界 —— 围栏没闭合时把后续合并回去，
 *    否则一段代码会被切到两页去。
 */
export function splitMarkdownBlocks(text: string): string[] {
    const raw = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    let buf = '';
    for (const seg of raw) {
        buf = buf ? `${buf}\n\n${seg}` : seg;
        // 围栏数量为奇数 = 还在一段代码里，先不切
        const fences = (buf.match(/```/g) || []).length;
        if (fences % 2 === 0) {
            out.push(buf);
            buf = '';
        }
    }
    if (buf) out.push(buf);
    return out.length ? out : text.trim() ? [text.trim()] : [];
}

/** 四角定位标识。用**形状**而不是四种颜色 —— 黑白复印/灰度扫描下颜色全变灰。 */
const CORNER_SIZE = '5mm';
const CORNER_WEIGHT = '0.5mm';
const CORNER_COLOR = '#3a3a3a';

function CornerMark({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
    const base: React.CSSProperties = {
        position: 'absolute',
        width: CORNER_SIZE,
        height: CORNER_SIZE,
        borderStyle: 'solid',
        borderColor: CORNER_COLOR,
        borderWidth: 0,
    };
    const at3: Record<string, React.CSSProperties> = {
        tl: { top: 0, left: 0, borderTopWidth: CORNER_WEIGHT, borderLeftWidth: CORNER_WEIGHT },
        tr: { top: 0, right: 0, borderTopWidth: CORNER_WEIGHT, borderRightWidth: CORNER_WEIGHT },
        bl: { bottom: 0, left: 0, borderBottomWidth: CORNER_WEIGHT, borderLeftWidth: CORNER_WEIGHT },
        // 右下角多一小段实心块 ⇒ 四个角里三个一样、一个不同，扫进来就能定方向
        br: { bottom: 0, right: 0, borderBottomWidth: CORNER_WEIGHT, borderRightWidth: CORNER_WEIGHT },
    };

    return (
        <span style={{ ...base, ...at3[at] }}>
            {at === 'br' && (
                <span
                    style={{
                        position: 'absolute',
                        right: '1.2mm',
                        bottom: '1.2mm',
                        width: '2mm',
                        height: '2mm',
                        background: CORNER_COLOR,
                    }}
                />
            )}
        </span>
    );
}

/**
 * 第 n 格用哪个色。索引从 1 起；越界（不该发生）退回首色 ——
 * 用**首色**而不是 undefined，是为了"宁可颜色错，也不要渲染出没有颜色的格子"。
 */
function slotColor(index: number): SlotColor {
    return SLOT_COLORS[index - 1] ?? SLOT_COLORS[0];
}

/**
 * 打孔位写成 **CSS 变量**（`--punch-l` / `--punch-r`），而不是直接写 padding。
 *
 * 为什么：屏幕上每一面还要再套一圈"纸边"（`@media screen` 里
 * `calc(15mm + var(--punch-l))`）。直接写内联 padding 有两个后果 ——
 *   ① 内联盖掉纸边 ⇒ 纸一边宽一边窄，不像 B5；
 *   ② `@media print` 里那句 `padding:0 !important`（去掉纸边用）会把打孔位一起清掉，
 *      真打出来就没孔位了。
 * 用变量之后：打印时纸边为 0、打孔位照旧；屏幕上两者叠加。
 */
function punchVarsOf(pad: { left: number; right: number }): CSSProperties {
    return {
        '--punch-l': `${pad.left}mm`,
        '--punch-r': `${pad.right}mm`,
    } as CSSProperties;
}

export interface DeepDiveCardProps {
    /**
     * 用哪张纸（不传 = B5）。只管**面高**和身份条下边框的**颜色**
     * （A4 用蓝 —— 拍一张照就能看出这张纸是什么幅面）。
     */
    paper?: PaperSpec;
    item: ErrorItem;
    index: number;
    qrMap: Record<string, string>;
    /** 打印那一刻 —— 四个日期格以它为基准，一次打印的所有题共用同一个 */
    printDate: Date;
    /**
     * 【2026-10-03 需求第 10 条】这张深挖纸的**随机 emoji 标识**（一题一张纸，给一个）。
     * 画在身份条「印于 …」**左边**、与那行同字号。不传 ⇒ 不画，行为一字不变。
     */
    emojiMark?: string | null;
    /** 手动双面：家里打印机不支持自动双面，插一张翻面提示 */
    manualDuplex: boolean;
    /**
     * 【2026-09-29】题图的缩放百分比（100 = 版面默认），与复练纸同一套。
     * 他要的：电脑上拖右下角小把手、手机上按住图左右拖。
     */
    figureScaleOf?: (itemId: string) => number;
    onFigureScaleStart?: (itemId: string) => (e: ReactPointerEvent) => void;
    /**
     * 【2026-09-29】正面**原题照片**的缩放百分比（100 = 版面默认）。
     * 与反面题图各算各的：正面那张是整页照片，反面那些是橙框裁出来的题图。
     */
    photoScaleOf?: (itemId: string) => number;
    onPhotoScaleStart?: (itemId: string) => (e: ReactPointerEvent) => void;
    L: (zh: string, en: string) => string;
}

export function DeepDiveCard({
    item,
    index,
    qrMap,
    printDate,
    emojiMark,
    manualDuplex,
    figureScaleOf,
    onFigureScaleStart,
    photoScaleOf,
    onPhotoScaleStart,
    L,
    paper = PAPERS[DEFAULT_PAPER_ID],
}: DeepDiveCardProps) {
    const figures = useFigureImages(item);
    const { gradeText, subjectKey } = getNotebookPrintInfo(item, L('未分本', 'Unfiled'));
    const tags = getTags(item);
    const questionNo = item.source || `#${index + 1}`;
    const slots = useMemo(() => reviewDateSlots(printDate), [printDate]);
    const photoMaxMM = maxFrontPhotoHeightMM();
    const qr = qrMap[item.id];

    const frontPad = sidePaddingMM('front');
    const backPad = sidePaddingMM('back');

    /** 这道题的题图缩放（没调过 = 100%） */
    const figureScale = normalizeFigureScale(figureScaleOf ? figureScaleOf(item.id) : 100);

    /**
     * 正面**原题照片**的缩放（2026-09-29）。100% = 版面默认（= `photoMaxMM`，P9 定的 95mm）。
     * 往上放的**天花板**是 `maxFrontPhotoHeightHardMM()`（2026-10-10 抬到约 183mm）：
     * 放大时会**吃掉下面的空白**，只给分析区留一个 20mm 的小底 ——
     * 他 2026-10-10 的原话："阅读类题目的图片本来就很大，如果不能持续调整大小，
     * 就会出现完全看不清的问题"。
     */
    const photoScale = normalizeFigureScale(photoScaleOf ? photoScaleOf(item.id) : 100);
    const photoHeightMM = Math.max(
        T1_LAYOUT_MM.photoMin / 2,
        Math.min(photoMaxMM * (photoScale / 100), maxFrontPhotoHeightHardMM()),
    );
    /** 宽度上限跟着缩放走（缩小时图真的变小；放大到 100% 以上就不再超出栏宽） */
    const photoWidthLimitPct = Math.min(100, photoScale);

    /** 身份条：题号 + 两个空格 + 年级学期（右端是打印日） */
    const identityBar = (
        <div
            style={{
                height: `${T1_LAYOUT_MM.identityBar}mm`,
                display: 'flex',
                alignItems: 'center',
                gap: '2mm',
                borderBottom: `0.3mm solid ${paper.id === 'A4' ? '#1c7ed6' : '#cfc9bd'}`,
                flex: '0 0 auto',
            }}
        >
            <SubjectChip subjectKey={subjectKey} variant="print" showCode={false} />
            <span style={{ fontSize: '12pt', fontWeight: 700, letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
                {questionNo}
                {'  '}
                <span style={{ fontSize: '9pt', fontWeight: 400, color: '#555' }}>{gradeText}</span>
            </span>
            <span style={{ flex: 1 }} />
            {/* 【2026-10-03 需求第 10 条】随机 emoji 标识：画在「印于 …」**左边**、
                与那行同字号（8pt）。深挖纸只有正面有印刷时间 ⇒ 只给一个。不传就没有。 */}
            {emojiMark ? (
                <span style={{ fontSize: '15pt', lineHeight: 1, whiteSpace: 'nowrap' }}>{emojiMark}</span>
            ) : null}
            <span style={{ fontSize: '8pt', color: '#666', whiteSpace: 'nowrap' }}>
                {L('印于', 'Printed')} {formatIsoDate(printDate)}
            </span>
        </div>
    );

    /**
     * 【2026-10-26 超长题】**这一题一页装得下吗。**
     *
     * 判据就是"反面内容组会不会被裁"：它 `overflow: hidden`，
     * 内容比版心高时 `scrollHeight > clientHeight` —— 这一条不用另算字数、
     * 也算得准图片和公式，比按字符估可靠。
     *
     * 判定之后（`isLong = true`）结构与原来不同：
     *   · 正面**不印原卷照片、不印分析区**（他原话："原来正面的内容不打印了"）
     *   · 反过来把`内容组`（OCR + 图 + 遮挡线 + 手写区）从正面开始印
     *   · 正面高度改成 auto ⇒ 装不下就自己翻到反面，后面的空白就空着
     *
     * ⚠️ 只在第一次测；判定成立后 body 变成 `overflow: visible`，
     *    再测就永远量不出溢出了。
     */
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const [isLong, setIsLong] = useState(false);
    useEffect(() => {
        if (isLong) return;
        const el = bodyRef.current;
        if (!el) return;
        if (el.scrollHeight > el.clientHeight + 2) setIsLong(true);
    }, [isLong, item.id]);

    /* ===== 【2026-10-27 超长题分页】 =====
       超长时不再"把纸拉长、让浏览器自己截"，改成软件自己按 225mm 装页。

       规矩（空空 2026-10-27 定）：
         · **每页都印身份条** —— 续页是另外一张物理纸，掉了要一眼认得出是哪道题；
           传统"反面"不印，是因为它和正面是同一张纸的两面，超长续页不是。
         · **最后一页加页脚**（二维码 + 四个日期格 + 虚线框），并靠书写区 `flex:1` 顶到纸底。
         · **宁可多一页，不可少一字** —— 页高用 minHeight，量高了就往下长。

       ⚠️ 页高绝不能写死 height：`.print-deep-side` 是 `overflow: hidden`，
          一旦写死并把内容估高，多出来的会被**静默裁掉**（不报错、不留痕）。 */
    const qText = (item.questionText || item.ocrText || '').trim();
    const qBlocks = useMemo(() => splitMarkdownBlocks(qText), [qText]);
    /** 每页**结束**的块索引（不含本身）；null = 还没量完，先按老办法渲染 */
    const [longCuts, setLongCuts] = useState<number[] | null>(null);
    const measureRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!isLong || longCuts) return;
        const box = measureRef.current;
        if (!box) return;
        const kids = Array.from(box.children) as HTMLElement[];
        if (!kids.length || kids.length !== qBlocks.length) return;
        const toMM = (px: number) => (px * 25.4) / 96;
        /* ⚠️ `getBoundingClientRect().height` **不含外边距**，而段落之间本来就有 4~5mm 的间距。
           不算进去就会低估、每页多塞一块，结果是被顶出去。
           每块统一加 5mm 当"段间距"，宁可少装一块。 */
        const heights = kids.map((k) => toMM(k.getBoundingClientRect().height) + 5);

        const pageMM = paper.content.h - 2;
        /** 页眉：身份条 + 一点间隙 */
        const headMM = T1_LAYOUT_MM.identityBar + 3;
        /** 第一页还多一行知识点（按两行算，宁多不少） */
        const knowMM = T1_LAYOUT_MM.knowledgeRowMax + 1;
        /** 最后一页要给"题图 + 遮挡线 + 手写区 + 页脚"让地方 —— 按经验上限预留 */
        const TAIL_MM = 95;
        /** 量高必然有误差，每页留 4mm 安全垫：估小会被裁，估大只是多一页 */
        const SAFE = 4;

        /** 每一页**起始**的块索引。允许以 `heights.length` 结尾 ——
         *  那表示"最后一页只剩尾部（题图/遮挡线/手写区/页脚），没有正文"。 */
        const starts: number[] = [0];
        let used = 0;
        let cap = pageMM - headMM - knowMM - SAFE;
        for (let i = 0; i < heights.length; i++) {
            if (used > 0 && used + heights[i] > cap) {
                starts.push(i);
                used = 0;
                cap = pageMM - headMM - SAFE;
            }
            used += heights[i];
        }
        // 本页剩下的空间放不下尾部 ⇒ 尾部另起一页（正文到此为止）
        if (used + TAIL_MM > cap) starts.push(heights.length);

        /* 放到下一帧再落状态：effect 里同步 setState 会触发级联渲染（lint 会拦）。 */
        const raf = requestAnimationFrame(() => setLongCuts(starts));
        return () => cancelAnimationFrame(raf);
    }, [isLong, longCuts, qBlocks, paper]);

    /**
     * 【2026-10-26 超长题】**反面的「内容组」：OCR + 题图 + 遮挡线 + 手写区。**
     *
     * 抽成变量的原因：语文/英语那种整段材料的阅读题，一页装不下。
     * 他把规则定成 —— **正面不再印原卷照片和分析区，直接把这一组从正面开始印，
     * 装不下就流到反面**（"原来正面的内容不打印了"）。
     *
     * 内容一字未动，只是从"写在反面里"变成"可以被两个分支共用"。
     */
    const renderBody = (slice?: { text: string; tail: boolean }) => (
                <div
                    /* 分页渲染时这一块只是"本页的正文"，不再当超长探针 */
                    ref={slice ? undefined : bodyRef}
                    className="print-deep-body"
                    style={{
                        /* 超长时不再"抢剩余空间"，也不再裁 —— 让它自然长、自己翻页 */
                        flex: isLong ? '0 0 auto' : '1 1 auto',
                        minHeight: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: isLong ? 'visible' : 'hidden',
                    }}
                >
                    {/* 文字题干（OCR） */}
                    <div className="print-deep-question" style={{ flexShrink: 0, marginTop: '2mm', fontSize: '10pt' }}>
                    {slice ? (
                        /* 分页渲染：只画本页这几块（拼回去与原 Markdown 语义等价） */
                        <MarkdownRenderer content={slice.text} />
                    ) : item.questionText || item.ocrText ? (
                        <MarkdownRenderer content={(item.questionText || item.ocrText) as string} />
                    ) : (
                        <div
                            style={{
                                border: '0.3mm dashed #b0b0b0',
                                padding: '2mm',
                                fontSize: '9pt',
                                color: '#777',
                            }}
                        >
                            {L('（这题没有可打印的题干）——翻回正面看题', '(nothing to print) — flip back')}
                        </div>
                    )}
                </div>

                {/* 【2026-10-27 分页】题图 / 遮挡线 / 手写区 = "尾部"，只在**最后一页**画。
                    Fragment 包不改变布局（不是盒子），正常单页那张纸一字不动。 */}
                {(!slice || slice.tail) && (<>
                {/* 题图：橙框圈出来的那块，挂在题干**下方、靠左**。
                    文字题干 + 题图 = 真题。没有橙框（大多数题）就什么都不挂。 */}
                {figures.length > 0 && (
                    <div
                        className="print-deep-figures"
                        style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            alignItems: 'flex-start',
                            gap: '2mm',
                            marginTop: '2mm',
                            flexShrink: 0,
                        }}
                    >
                        {figures.map((url, i) => (
                            <div
                                key={i}
                                style={{
                                    // 缩放作用在这个盒子的**宽度**上（左上角固定 ⇒ 图只往右下长）
                                    flex: '0 0 auto',
                                    width: `${DEEP_FIGURE_BASE_MM.w * (figureScale / 100)}mm`,
                                    maxWidth: '100%',
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
                                <img
                                    src={url}
                                    alt=""
                                    style={{
                                        // ⚠️ 陷阱 35：只写 max-* 的话**小图不会放大**（按像素排）。
                                        // width:100% + height:auto 负责等比放大/缩小；
                                        // max-height 限竖长图，contain 保证被限高时只留白、不变形。
                                        width: '100%',
                                        height: 'auto',
                                        maxHeight: `${DEEP_FIGURE_BASE_MM.h * (figureScale / 100)}mm`,
                                        objectFit: 'contain',
                                        objectPosition: 'left top',
                                        display: 'block',
                                    }}
                                />
                                {/* 拖拽把手：**只在屏幕上**（打印时被 CSS 隐藏），右下角、等比缩放 */}
                                {onFigureScaleStart && (
                                    <span
                                        className="print-fig-handle no-print"
                                        title={L('拖动调整图片大小（左上角固定）', 'Drag to resize')}
                                        onPointerDown={(e) => {
                                            if (e.pointerType !== 'mouse') return;
                                            onFigureScaleStart(item.id)(e);
                                        }}
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* 遮挡线：粗线 + **线中印"遮挡线"三字**（给孩子看，也给 OCR 当坐标标签） */}
                <div
                    className="print-deep-occluder"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '2mm',
                        marginTop: '3mm',
                        flexShrink: 0,
                    }}
                >
                    {/* 【2026-10-27 透印】原来是 0.7mm 纯黑 `#111`：
                        80g 道林纸上这条带会**整条透到正面**（背面就这一处最显眼）。
                        改成中灰 + 细一点 —— 它的作用是"把题目和答案分开"和给 OCR 当坐标，
                        这两件事浅灰照样成立；真正需要认得出的是中间那三个字，所以文字仍是深色。 */}
                    <span style={{ flex: 1, height: '0.5mm', background: '#8a8a8a' }} />
                    <span style={{ fontSize: '8pt', letterSpacing: '1.5px', whiteSpace: 'nowrap' }}>
                        遮挡线
                    </span>
                    <span style={{ flex: 1, height: '0.5mm', background: '#8a8a8a' }} />
                </div>

                {/* 她手写内容区：不加十字线（模拟真实考场）。上界=遮挡线，下界=页脚细线。
                    【2026-09-28】升降级小框放在这块区域的**最上面**。
                    【2026-09-29】他要求**从左边挪到右边**，原话："左边耽误一开始写题时的心情"。
                    （更早的定稿曾写"遮挡线左下"，以这次为准；框的内容与语义没变，只是靠右。）
                    ⚠️ 放进这一块内部（而不是塞在遮挡线之上）：反面高度是死的，
                       小框若占独立一行就会从"写字的地方"里扣掉 7mm，
                       长题 + 有大题图时可能把页脚挤出纸外。放进来只吃这一块自己的空间。 */}
                <div
                    className="print-deep-writing"
                    style={{
                        flex: 1,
                        minHeight: `${T1_LAYOUT_MM.writingMin}mm`,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                    }}
                >
                    <PromoteBox manageType={item.manageType} L={L} />
                </div>
                </>)}
                </div>
    );

    /** 【2026-10-26 超长题】反面页脚（二维码 / 横线 / 四个日期格）。
     *  超长时它跟内容组一起搬到正面末尾 —— 页脚永远留在纸内，这条规矩不变。 */
    const backFooterEl = (
                <div
                    className="print-deep-footer"
                    style={{
                        height: `${T1_LAYOUT_MM.footer}mm`,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '2.5mm',
                        flexShrink: 0,
                    }}
                >
                    {/* 左：二维码（整块居中） */}
                    {qr ? (
                        <img
                            className="print-qr"
                            src={qr}
                            alt=""
                            style={{ width: '14mm', height: '14mm', flexShrink: 0 }}
                        />
                    ) : (
                        <div style={{ width: '14mm', height: '14mm', flexShrink: 0 }} />
                    )}

                    {/* 右：上面横线（OCR 下界），下面四个日期格 + 末尾虚线框 */}
                    <div
                        style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'flex-end',
                            gap: '2mm',
                        }}
                    >
                        <span
                            className="print-deep-footer-rule"
                            style={{ width: '100%', height: '0.2mm', background: '#666' }}
                        />

                        {/* 四个日期格（打印日 +1 / +7 / +21 / +49，**纸面写 MM-DD**）+ 末尾虚线框
                            【2026-10-14】① 加第 4 格（偏移 +49、色「淡紫」）；
                            ② 日期由 `yyyy-mm-dd` 缩成 `MM-DD` —— 页脚右区约 123.5mm，
                               四组全写会超 10~15mm（见 lib/deep-dive-card.ts 的注释）。
                            ③ 第 1 格**前面加年份**（方案 A）—— 页脚宽度实测：
                               右区 123.5mm，加年份前已用 111.6mm，**只余 11.9mm**；
                               一个 `2026`（9pt）≈ 8.1mm + 内间距 1.2mm ⇒ 加完仍余约 2.6mm。
                               ⚠️ **改动这条带之前先读 `docs\11_纸面尺寸账_深挖纸页脚.md`**，
                                  里面有复量脚本（`tools\_measure_footer2.py`）。 */}
                        <div
                            className="print-deep-slots"
                            style={{ display: 'flex', alignItems: 'center', gap: '5mm', flexShrink: 0 }}
                        >
                            {slots.map((s) => {
                                const c = slotColor(s.index);
                                return (
                                    <span
                                        key={s.index}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '1.2mm',
                                        }}
                                    >
                                        {/* 【2026-10-14 方案 A】年份只写在第 1 格**前面**，用该格颜色。
                                            为什么需要：日期格只写 `MM-DD`（宽度所限），而
                                            **反面这一页没有第二处年份**（身份条「印于 …」在正面）。
                                            ⚠️ 年末那几格其实已跨年（`12-22` 后面跟 `01-05`），
                                               空空 2026-10-14 明确接受："跨年总量小，日期先大后小，自然读得出"。
                                               （要严格补的做法见 `date-format.ts` 的 `formatYear()`。） */}
                                        {s.yearLabel && (
                                            <span style={{ fontSize: '9pt', color: c.text, fontWeight: 600 }}>
                                                {s.yearLabel}
                                            </span>
                                        )}
                                        {/* 一格里三种状态：空着 / 打勾 / 打叉 —— 打勾打叉是她的任务 */}
                                        <span
                                            className="print-deep-slot"
                                            style={{
                                                display: 'inline-block',
                                                width: `${SLOT_SIZE_MM}mm`,
                                                height: `${SLOT_SIZE_MM}mm`,
                                                border: `0.35mm solid ${c.border}`,
                                                background: c.fill,
                                            }}
                                        />
                                        <span style={{ fontSize: '9pt', color: c.text, fontWeight: 600 }}>
                                            {s.label}
                                        </span>
                                    </span>
                                );
                            })}
                            {/* 虚线框：**不印用途**。盖章 / 手写"已会" / 画勾，随她。 */}
                            <span
                                className="print-deep-stamp"
                                style={{
                                    display: 'inline-block',
                                    width: `${STAMP_BOX_MM.w}mm`,
                                    height: `${STAMP_BOX_MM.h}mm`,
                                    border: '0.3mm dashed #b6b6b0',
                                    borderRadius: `${STAMP_BOX_MM.radius}mm`,
                                    background: '#fafaf6',
                                }}
                            />
                        </div>
                    </div>
                </div>
    );

    /** 【2026-10-27 超长题分页】页头（身份条 + 二维码）—— **每一页都印**。
     *  续页是另外一张物理纸，掉了要一眼认得出是哪道题，所以不能只在第一页有。 */
    const headerEl = (
        <div style={{ display: 'flex', alignItems: 'center', gap: '2mm', flex: '0 0 auto' }}>
            <div style={{ flex: 1, minWidth: 0 }}>{identityBar}</div>
            {qr ? (
                <img className="print-qr" src={qr} alt="" style={{ width: '16mm', height: '16mm', flexShrink: 0 }} />
            ) : (
                <div style={{ width: '16mm', height: '16mm', flexShrink: 0 }} />
            )}
        </div>
    );

    return (
        <div className="print-card print-deep">
            {/* ================= 正面：她反思的那面（左侧留打孔位） ================= */}
            <div
                className="print-deep-side print-deep-front"
                style={{
                    /* 【2026-10-27】超长题改成 minHeight：按页装箱后，估高了就往下长（不裁字）；
                       普通单页仍是**定高**，版式靠它锁死，不能动。 */
                    height: isLong ? undefined : `${paper.content.h - 2}mm`,
                    minHeight: isLong ? `${paper.content.h - 2}mm` : undefined,
                    /* 【2026-10-24 幅面】宽度与纸边负距由 CSS 变量驱动（见 globals.css） */
                    ['--paper-content-w' as string]: `${paper.content.w}mm`,
                    ['--paper-pad-x' as string]: `${-(paper.w - PAPERS.B5.content.w) / 2}mm`,
                    display: 'flex',
                    flexDirection: 'column',
                    // ⚠️ 打孔位走 CSS 变量（理由同复练纸：屏幕上的"纸边"要叠在它外面）
                    ...punchVarsOf(frontPad),
                }}
            >
                {/* 二维码在正面右上（P25：正面右上 / 反面左下，各按自己那一面的视角） */}
                {headerEl}

                {/*
                    身份条横线**下面、靠左**：知识点，各知识点用 · 隔开。

                    2026-09-26 他的两条意见，一起落在这块上：
                      ① **贴着上面的横线**：原来 6mm 的盒子垂直居中，上下各空 1.6mm，
                         看着"知识点掉下来了"；改成 `flex-start` + 0.4mm 上内边距。
                      ② **写不下就折行，但绝不在某个知识点中间折**：
                         所以每个知识点是**一个 nowrap 的整体**（`·` 也跟着前一个走），
                         容器 `flex-wrap: wrap` —— 折点只会落在知识点之间的缝隙上。
                      ③ 最多两行（容器 `maxHeight` 锁住），多出的宁可不印：
                         两行还放不下 = 知识点标签打得太碎，该合并而不是挤第三行。

                    ⚠️ 高度用 `minHeight` 而不是 `height`：绝大多数题**一行就够**，
                       此时这一块仍是 6mm，上面横线和下面题图的位置**一动不动**。
                */}
                {tags.length > 0 && (
                    <div
                        className="print-deep-tags"
                        style={{
                            minHeight: `${T1_LAYOUT_MM.knowledgeRow}mm`,
                            maxHeight: `${T1_LAYOUT_MM.knowledgeRowMax}mm`,
                            display: 'flex',
                            flexWrap: 'wrap',
                            alignItems: 'flex-start',
                            columnGap: '1.6mm',
                            rowGap: 0,
                            paddingTop: '0.4mm',
                            fontSize: '8pt',
                            lineHeight: 1.35,
                            color: '#555',
                            overflow: 'hidden',
                            flex: '0 0 auto',
                        }}
                    >
                        {tags.map((t, i) => (
                            <span
                                key={`${t}-${i}`}
                                style={{ display: 'inline-flex', whiteSpace: 'nowrap' }}
                            >
                                {i > 0 && <span style={{ marginRight: '1.6mm' }}>·</span>}
                                {t}
                            </span>
                        ))}
                    </div>
                )}

                {/* 【2026-10-26 超长题】超长时不印照片、不印分析区 —— 见下面那个分支 */}
                {!isLong && (<>
                {/* 原题照片：带笔迹、**不带语义框，也不带外边框**（原页面的样子）。
                    【2026-09-29】他要求这张也能拖右下角把手调大小（跟反面题图一样）：
                    外层盒子 `position: relative` 托住把手，宽度/高度上限都跟着缩放百分比走。 */}
                <div style={{ display: 'flex', justifyContent: 'center', flex: '0 0 auto', marginTop: '1.5mm' }}>
                    <div
                        className="print-deep-photo-box"
                        style={{
                            position: 'relative',
                            width: `${photoWidthLimitPct}%`,
                            maxWidth: '100%',
                            // 手机上"按住照片左右拖 = 缩放"：别让浏览器把手势抢去当滚动
                            touchAction: 'none',
                        }}
                        onPointerDown={(e) => {
                            if (e.pointerType === 'mouse') return;
                            onPhotoScaleStart?.(item.id)(e);
                        }}
                    >
                        <img
                            src={item.originalImageUrl}
                            alt=""
                            className="print-deep-photo"
                            style={{
                                width: '100%',
                                height: 'auto',
                                maxHeight: `${photoHeightMM}mm`,
                                // 被 maxHeight 限住时只留白、不拉变形
                                objectFit: 'contain',
                                display: 'block',
                            }}
                        />
                        {/* 拖拽把手：**只在屏幕上**（打印时被 CSS 隐藏），右下角、等比缩放 */}
                        {onPhotoScaleStart && (
                            <span
                                className="print-fig-handle no-print"
                                title={L('拖动调整原题照片大小', 'Drag to resize the photo')}
                                onPointerDown={(e) => {
                                    if (e.pointerType !== 'mouse') return;
                                    onPhotoScaleStart(item.id)(e);
                                }}
                            />
                        )}
                    </div>
                </div>

                {/* 她自己分析的那块 —— **外边框与四角标识都归这一块**，不归照片 */}
                <div
                    className="print-deep-analysis"
                    style={{
                        flex: 1,
                        /**
                         * 【2026-10-10】下限从 `crosshairMin`(110mm) 改成"一个小底"(20mm)。
                         *
                         * 原来写 110mm ⇒ 照片一放大，这一块就撑住 110mm 不肯让，
                         * 整面必然溢出纸外（溢出的部分被裁掉）。
                         * 现在它先让，照片才能真正长到纸面极限；默认尺寸下它
                         * 本来就分到 110mm（`flex: 1` 撑满剩余空间），所以**表现不变**。
                         */
                        minHeight: `${DEEP_CROSSHAIR_FLOOR_MM}mm`,
                        position: 'relative',
                        marginTop: '1.5mm',
                        border: '0.3mm solid #ded8ca',
                    }}
                >
                    {/* 十字象限：只是"参考位置"，不赋四格语义（P6）。
                        竖线在黄金比 61.8% 处 = 左略大右略小。 */}
                    <div
                        className="print-deep-cross-h"
                        style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: '0.3mm' }}
                    />
                    <div
                        className="print-deep-cross-v"
                        style={{ position: 'absolute', top: 0, bottom: 0, left: '61.8%', width: '0.3mm' }}
                    />
                    <CornerMark at="tl" />
                    <CornerMark at="tr" />
                    <CornerMark at="bl" />
                    <CornerMark at="br" />
                </div>
                </>)}

                {/* 【2026-10-27 分页】量高用的隐形容器：只量，不占位（绝对定位）。 */}
                {isLong && !longCuts && qBlocks.length > 1 && (
                    <div
                        ref={measureRef}
                        aria-hidden
                        style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            width: `${paper.content.w - 12}mm`,
                            height: 0,
                            overflow: 'hidden',
                            visibility: 'hidden',
                            pointerEvents: 'none',
                        }}
                    >
                        {qBlocks.map((b, i) => (
                            <div key={i} className="print-deep-question" style={{ fontSize: '10pt' }}>
                                <MarkdownRenderer content={b} />
                            </div>
                        ))}
                    </div>
                )}

                {/* 【2026-10-26 超长题】把反面的内容组从正面开始印，装不下自己翻到反面。
                    之后剩下的空间就是空白，不再塞东西（他的规则）。
                    【2026-10-27 分页】还没量完时先按老办法（拉长纸面），至少不丢内容。 */}
                {isLong && !longCuts && (
                    <>
                        {renderBody()}
                        {backFooterEl}
                    </>
                )}
                {isLong && longCuts && (
                    <>
                        {renderBody({
                            text: qBlocks.slice(longCuts[0], longCuts[1] ?? qBlocks.length).join('\n\n'),
                            tail: longCuts.length === 1,
                        })}
                        {longCuts.length === 1 && backFooterEl}
                    </>
                )}
            </div>

            {/* 【2026-10-27 分页】续页：**每页都印身份条**，最后一页带页脚。
                minHeight 而不是 height —— 量高了往下长，宁可多一页，不可少一字。 */}
            {isLong && longCuts && longCuts.slice(1).map((_v, i) => {
                const start = longCuts[i + 1];
                const end = longCuts[i + 2] ?? qBlocks.length;
                const isLast = i === longCuts.length - 2;
                return (
                    <div
                        key={`deep-page-${i + 2}`}
                        className="print-deep-side print-deep-front"
                        style={{
                            minHeight: `${paper.content.h - 2}mm`,
                            breakBefore: 'page',
                            ['--paper-content-w' as string]: `${paper.content.w}mm`,
                            ['--paper-pad-x' as string]: `${-(paper.w - PAPERS.B5.content.w) / 2}mm`,
                            display: 'flex',
                            flexDirection: 'column',
                            ...punchVarsOf(frontPad),
                        }}
                    >
                        {headerEl}
                        {renderBody({
                            text: qBlocks.slice(start, end).join('\n\n'),
                            tail: isLast,
                        })}
                        {isLast && backFooterEl}
                    </div>
                );
            })}

            {/* ================= 反面：她重做的那面（右侧留打孔位） ================= */}
            {/* 【2026-10-26 超长题】超长时内容组已经搬到正面了，这一面不再渲染 */}
            {!isLong && (
            <div
                className="print-deep-side print-deep-back"
                style={{
                    height: `${paper.content.h - 2}mm`,
                    /* 【2026-10-24 幅面】宽度与纸边负距由 CSS 变量驱动（见 globals.css） */
                    ['--paper-content-w' as string]: `${paper.content.w}mm`,
                    ['--paper-pad-x' as string]: `${-(paper.w - PAPERS.B5.content.w) / 2}mm`,
                    display: 'flex',
                    flexDirection: 'column',
                    ...punchVarsOf(backPad),
                }}
            >
                {manualDuplex && (
                    <div
                        className="print-flip-hint"
                        style={{
                            border: '1px dashed #888',
                            borderRadius: '2mm',
                            padding: '2mm',
                            marginBottom: '2mm',
                            fontSize: '9pt',
                            color: '#555',
                            flexShrink: 0,
                        }}
                    >
                        ↩ {L('请在此处翻面', 'Flip the page here')}
                    </div>
                )}

                {/* ⚠️ 反面**没有身份条**：有身份条就分不清哪面是正、哪面是反了 */}

                {/*
                    【2026-10-10】反面**内容组**：题干 + 题图 + 遮挡线 + 手写区 全包在里面。
                    它 `flex: 1 1 auto + minHeight: 0 + overflow: hidden`，
                    页脚（26mm）在外面、`flexShrink: 0`。

                    为什么非这么包一层：他拿一道英语阅读题试印，**整块页脚不见了**
                    （二维码 / 横线 / 四个日期格 / 虚线框全没了）。原因是旧结构里
                    各块按"手写区先占 60mm"的顺序排，题干一长，60 + 26 就把一面吃满，
                    页脚被顶到纸外、打印时被切掉。
                    他的裁定："**留白部分是最后保障的**" ⇒ 空间不够时**先让留白**。
                    包一层之后优先级就固定了：先扣出页脚，剩下的给内容组，
                    内容组装不下就**裁自己**（裁掉的是最下面的手写区，不是页脚）。
                */}
                {renderBody()}
                {/* ↑ 反面"内容组"到此为止（题干 + 图 + 遮挡线 + 手写区）；
                    它下面是页脚，**永远留在纸内** —— 详见上面那一大段注释。 */}

                {/*
                    页脚（2026-09-28 二改：上下结构 → **左右结构**）——
                    他的原话：左边二维码，右边"上面是横线，下面是三个框和三个时间以及虚线框"，
                    这样"结构更加紧凑、干净、利索"。

                    演变史：
                      · 09-26 前：整幅横线在上、二维码在左下；
                      · 09-26：镜像正面 → 上行"二维码+横线"、下行"日期格+虚线框"（上下两行）；
                      · 09-28（本次）：左右两块 —— 左=二维码，右=横线在上、日期格在下。

                    ⚠️ 那条横线的**位置仍然固定** —— 它和上面的遮挡线一起夹出她的手写区，
                       是 OCR 取的**下界**。页脚总高度（26mm）不变，上面的版面不受影响。
                */}
                {backFooterEl}
            </div>
            )}
        </div>
    );
}
