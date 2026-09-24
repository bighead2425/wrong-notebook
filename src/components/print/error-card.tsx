'use client';

/**
 * 【旧版错题卡】一道题占一张纸的正反两面：正面重做、背面给错因和答案（灰淡字）。
 *
 * 从 `print-preview/page.tsx` 原样搬出（M3），**行为一个字没改** ——
 * 搬家的原因只是那 661 行的页面文件违反了项目自定红线（>200 行要拆）。
 *
 * ⚠️ **它和新的「T1 深挖纸」是两套东西，别混**：
 *   本组件 = 旧卡，纸上印**解析 / 错因 / 答案**；
 *   `deep-dive-card.tsx` = 新纸（P5），纸上**零 AI 内容**（P3/P19）。
 *   新纸先与它**并存**：回收判定（M5）与回信（M6）还没做，此刻把旧卡的答案撤掉，
 *   孩子做完题会**拿不到任何反馈** —— 那不是设计意图，是断档。
 *   等 M5/M6 通了，再把默认切到深挖纸、旧卡退役。
 */

import { SubjectChip } from '@/components/subject-chip';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ErrorItem } from '@/types/api';
import { formatIsoDate } from '@/lib/date-format';
import { getNotebookPrintInfo, getTags, stripMistakeSection } from '@/lib/print-preview';
import { QuestionBody, type PrintBodyOptions } from './question-bodies';

export interface ErrorCardProps {
    item: ErrorItem;
    index: number;
    /** 题号 → 二维码 dataURL */
    qrMap: Record<string, string>;
    /** 勾了「独占页」的题 */
    soloIds: Set<string>;
    /** 是否印知识点标签 */
    showTags: boolean;
    /** 手写留白高度（mm） */
    spaceMM: number;
    /** 手动双面：打印不支持自动双面的打印机时，中间插一张翻面提示 */
    manualDuplex: boolean;
    options: PrintBodyOptions;
}

export function ErrorCard({
    item,
    index,
    qrMap,
    soloIds,
    showTags,
    spaceMM,
    manualDuplex,
    options,
}: ErrorCardProps) {
    const { L, showMistake, showAnswers } = options;
    const tags = getTags(item);
    const { gradeText, subjectKey } = getNotebookPrintInfo(item, L('未分本', 'Unfiled'));
    const questionNo = item.source || `#${index + 1}`;
    const hasCause = showMistake && !!item.mistakeAnalysis;

    return (
        <div className={`print-card ${soloIds.has(item.id) ? '' : ''}`}>
            {/* ---------- 正面：题头 + 原题 + 原图 + 两栏 ---------- */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '3mm', marginBottom: '2mm' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '2mm', minWidth: 0 }}>
                    {/* 【custom-v24】showCode={false}：色块只印「语文」，不再印「语文YW」。
                        紧跟在后面的题号本身就以学科简拼开头（如 YW20260919001），不必印两遍。 */}
                    <SubjectChip subjectKey={subjectKey} variant="print" showCode={false} />
                    <span style={{ fontSize: '12pt', fontWeight: 700, letterSpacing: '0.5px' }}>{questionNo}</span>
                </div>
                {qrMap[item.id] ? (
                    <img
                        className="print-qr"
                        src={qrMap[item.id]}
                        alt={questionNo}
                        style={{ width: '18mm', height: '18mm', flexShrink: 0 }}
                    />
                ) : (
                    <div style={{ width: '18mm', height: '18mm', flexShrink: 0 }} />
                )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4mm', fontSize: '9pt', color: '#444', marginBottom: '2.5mm' }}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {L('第', 'No.')} {index + 1} {L('题', '')} ｜ {gradeText}
                    {showTags && tags.length > 0 ? ` ｜ ${tags.join('；')}` : ''}
                </span>
                <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {formatIsoDate(new Date())}{' '}
                    {typeof item.printCount === 'number' && item.printCount > 0
                        ? `｜${L('已打', 'Printed')} ${item.printCount}${L('次', '×')}`
                        : ''}
                </span>
            </div>

            {/* 原题：圆角框 */}
            <div
                className="print-rounded-box"
                style={{ border: '1.5px solid #333', borderRadius: '2mm', padding: '2.5mm', marginBottom: '3mm' }}
            >
                <QuestionBody item={item} options={options} />
            </div>

            {/* 解析左 / 空白右（B9），内容延伸到背面 */}
            <div className="print-two-col" style={{ display: 'flex', gap: '3mm', alignItems: 'flex-start' }}>
                <div style={{ flex: '1 1 52%', minWidth: 0 }}>
                    {options.showAnalysis && item.analysis && (
                        <div className="print-sub-title" style={{ fontWeight: 600, fontSize: '10pt', marginBottom: '1mm' }}>
                            {L('解析', 'Analysis')}
                        </div>
                    )}
                    {options.showAnalysis && item.analysis && (
                        <div style={{ fontSize: '10pt' }}>
                            <MarkdownRenderer content={stripMistakeSection(item.analysis)} />
                        </div>
                    )}
                </div>
                {/* 【custom-v26】解析区与重做区之间加一条深灰竖线。
                    用 borderLeft 而不是插一个空 div 当线：空 div 在 flex 里高度靠 stretch 撑，
                    一旦这一栏跨页断开就会印出一条断头线；挂在右栏上，线必然与右栏同高。
                    alignSelf:stretch 让竖线跟到两栏中较高的那一栏（通常是重做区）。 */}
                <div
                    style={{
                        flex: '1 1 48%',
                        minWidth: 0,
                        alignSelf: 'stretch',
                        borderLeft: '2px solid #555',
                        paddingLeft: '3mm',
                    }}
                >
                    <div style={{ fontSize: '9pt', color: '#666', marginBottom: '1mm' }}>
                        {L('重做区', 'Redo here')}
                    </div>
                    <div className="print-answer-space" style={{ height: `${Math.max(spaceMM, 30)}mm` }} />
                </div>
            </div>

            {/* ---------- 背面：继续重做 + 从后往前的错因/答案 ---------- */}
            <div className="print-tail" style={{ marginTop: '6mm' }}>
                {manualDuplex && (
                    <div
                        className="print-flip-hint"
                        style={{ border: '1px dashed #888', borderRadius: '2mm', padding: '2.5mm', marginBottom: '4mm', fontSize: '9pt', color: '#555' }}
                    >
                        ↩ {L('请在此处翻面', 'Flip the page here')} —— {L('下面是本题的背面（把纸按「短边翻转」放回纸盒）', 'below is the back side of this question (flip short-edge)')}
                    </div>
                )}
                <div style={{ fontSize: '9pt', color: '#666', marginBottom: '1mm' }}>
                    {L('重做区（续）', 'More room to redo')}
                </div>
                <div className="print-answer-space" style={{ height: `${Math.max(spaceMM, 30)}mm`, marginBottom: '4mm' }} />

                {hasCause && (
                    <div
                        className="print-rounded-box"
                        style={{ border: '1.5px solid #999', borderRadius: '2mm', padding: '2.5mm', marginBottom: '3mm' }}
                    >
                        <div className="print-sub-title" style={{ fontWeight: 600, fontSize: '10pt', marginBottom: '1mm' }}>
                            {L('错因分析', 'Why wrong')}
                        </div>
                        <div style={{ fontSize: '10pt' }}>
                            <MarkdownRenderer content={item.mistakeAnalysis as string} />
                        </div>
                    </div>
                )}

                {showAnswers && item.answerText && (
                    <div className="print-faint" style={{ fontSize: '11pt' }}>
                        <div className="print-sub-title" style={{ fontWeight: 700, marginBottom: '1mm' }}>
                            {L('参考答案', 'Answer')}
                        </div>
                        <MarkdownRenderer content={item.answerText} />
                    </div>
                )}
            </div>
        </div>
    );
}
