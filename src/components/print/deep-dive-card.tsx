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
 * ── 三个日期格 ─────────────────────────────────────────────────
 * 打印日 **+1 / +7 / +21**（P20 定案），纸面写法 **yyyy-mm-dd**。
 * 每格她自判**空 / 对 / 错** —— 原设计只记"做没做"，记不下"过没过"。
 */

import { useMemo } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { SubjectChip } from '@/components/subject-chip';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ErrorItem } from '@/types/api';
import { formatIsoDate } from '@/lib/date-format';
import { getNotebookPrintInfo, getTags } from '@/lib/print-preview';
import {
    DEEP_FIGURE_BASE_MM,
    SIDE_HEIGHT_MM,
    SLOT_COLORS,
    SLOT_SIZE_MM,
    STAMP_BOX_MM,
    T1_LAYOUT_MM,
    maxFrontPhotoHeightMM,
    reviewDateSlots,
    sidePaddingMM,
    type SlotColor,
} from '@/lib/deep-dive-card';
// 题图缩放的归一化（30–180%）与复练纸共用同一处实现，别抄一份
import { normalizeFigureScale } from '@/lib/review-card';
import { useFigureImages } from './use-print-images';
import { PromoteBox } from './promote-box';

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
    item: ErrorItem;
    index: number;
    qrMap: Record<string, string>;
    /** 打印那一刻 —— 三个日期格以它为基准，一次打印的所有题共用同一个 */
    printDate: Date;
    /** 手动双面：家里打印机不支持自动双面，插一张翻面提示 */
    manualDuplex: boolean;
    /**
     * 【2026-09-29】题图的缩放百分比（100 = 版面默认），与复练纸同一套。
     * 他要的：电脑上拖右下角小把手、手机上按住图左右拖。
     */
    figureScaleOf?: (itemId: string) => number;
    onFigureScaleStart?: (itemId: string) => (e: ReactPointerEvent) => void;
    L: (zh: string, en: string) => string;
}

export function DeepDiveCard({
    item,
    index,
    qrMap,
    printDate,
    manualDuplex,
    figureScaleOf,
    onFigureScaleStart,
    L,
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

    /** 身份条：题号 + 两个空格 + 年级学期（右端是打印日） */
    const identityBar = (
        <div
            style={{
                height: `${T1_LAYOUT_MM.identityBar}mm`,
                display: 'flex',
                alignItems: 'center',
                gap: '2mm',
                borderBottom: '0.3mm solid #c8c8c8',
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
            <span style={{ fontSize: '8pt', color: '#666', whiteSpace: 'nowrap' }}>
                {L('印于', 'Printed')} {formatIsoDate(printDate)}
            </span>
        </div>
    );

    return (
        <div className="print-card print-deep">
            {/* ================= 正面：她反思的那面（左侧留打孔位） ================= */}
            <div
                className="print-deep-side print-deep-front"
                style={{
                    height: `${SIDE_HEIGHT_MM}mm`,
                    display: 'flex',
                    flexDirection: 'column',
                    // ⚠️ 打孔位走 CSS 变量（理由同复练纸：屏幕上的"纸边"要叠在它外面）
                    ...punchVarsOf(frontPad),
                }}
            >
                {/* 二维码在正面右上（P25：正面右上 / 反面左下，各按自己那一面的视角） */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '2mm', flex: '0 0 auto' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>{identityBar}</div>
                    {qr ? (
                        <img
                            className="print-qr"
                            src={qr}
                            alt=""
                            style={{ width: '16mm', height: '16mm', flexShrink: 0 }}
                        />
                    ) : (
                        <div style={{ width: '16mm', height: '16mm', flexShrink: 0 }} />
                    )}
                </div>

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

                {/* 原题照片：带笔迹、**不带语义框，也不带外边框**（原页面的样子） */}
                <div style={{ display: 'flex', justifyContent: 'center', flex: '0 0 auto', marginTop: '1.5mm' }}>
                    <img
                        src={item.originalImageUrl}
                        alt=""
                        className="print-deep-photo"
                        style={{ maxWidth: '100%', maxHeight: `${photoMaxMM}mm`, height: 'auto', display: 'block' }}
                    />
                </div>

                {/* 她自己分析的那块 —— **外边框与四角标识都归这一块**，不归照片 */}
                <div
                    className="print-deep-analysis"
                    style={{
                        flex: 1,
                        minHeight: `${T1_LAYOUT_MM.crosshairMin}mm`,
                        position: 'relative',
                        marginTop: '1.5mm',
                        border: '0.3mm solid #d8d8d8',
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
            </div>

            {/* ================= 反面：她重做的那面（右侧留打孔位） ================= */}
            <div
                className="print-deep-side print-deep-back"
                style={{
                    height: `${SIDE_HEIGHT_MM}mm`,
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

                {/* 文字题干（OCR） */}
                <div className="print-deep-question" style={{ flexShrink: 0, marginTop: '2mm', fontSize: '10pt' }}>
                    {item.questionText || item.ocrText ? (
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
                    <span style={{ flex: 1, height: '0.7mm', background: '#111' }} />
                    <span style={{ fontSize: '8pt', letterSpacing: '1.5px', whiteSpace: 'nowrap' }}>
                        遮挡线
                    </span>
                    <span style={{ flex: 1, height: '0.7mm', background: '#111' }} />
                </div>

                {/* 她手写内容区：不加十字线（模拟真实考场）。上界=遮挡线，下界=页脚细线。
                    【2026-09-28】升降级小框放在**这块区域的最上面、靠左** ——
                    定稿的原话是"遮挡线左下（她动笔区的上方），她刚分析完、印象最深的位置"。
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
                        alignItems: 'flex-start',
                    }}
                >
                    <PromoteBox manageType={item.manageType} L={L} />
                </div>

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

                    {/* 右：上面横线（OCR 下界），下面三个日期格 + 末尾虚线框 */}
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

                        {/* 三个日期格（打印日 +1 / +7 / +21，yyyy-mm-dd）+ 末尾虚线框 */}
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
            </div>
        </div>
    );
}
