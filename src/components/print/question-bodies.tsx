'use client';

/**
 * 题干 / 答案两段正文的渲染。
 *
 * 从 `print-preview/page.tsx` 拆出（M3）：三种版式（错题卡 / 练习卷 / 讲解卷）
 * **共用**这两段，留在页面里等于三处各写一遍，改一处漏两处。
 * 新版「T1 深挖纸」不用它们（纸上零 AI 内容，P3/P19），但练习卷/讲解卷仍然要用。
 */

import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ErrorItem } from '@/types/api';
import { stripMistakeSection } from '@/lib/print-preview';

export interface PrintBodyOptions {
    showQuestionText: boolean;
    showImage: boolean;
    showAnswers: boolean;
    showAnalysis: boolean;
    showMistake: boolean;
    /** 图片打印宽度（%） */
    imageScale: number;
    /** 中英切换 */
    L: (zh: string, en: string) => string;
}

export function QuestionBody({ item, options }: { item: ErrorItem; options: PrintBodyOptions }) {
    const { showQuestionText, showImage, imageScale, L } = options;
    const hasText = showQuestionText && !!item.questionText;
    const hasImg = showImage && !!item.originalImageUrl;
    if (!hasText && !hasImg) {
        return <div style={{ color: '#999' }}>{L('（该题没有可打印的题干）', '(nothing to print)')}</div>;
    }
    return (
        <>
            {hasText && (
                <div style={{ marginBottom: hasImg ? '2mm' : 0 }}>
                    <MarkdownRenderer content={item.questionText as string} />
                </div>
            )}
            {/* 【custom-v26】题干文字与题目原图之间加一条虚线。
                两者同处一个方框里，中间不留界的话，长题干下面接着一张图，
                一眼看过去会以为图也是题干的一部分（尤其图里还带着手写答案时）。
                用虚线而非实线：它是"同一块内容内部的分隔"，不该抢原题边框的层级。 */}
            {hasText && hasImg && (
                <div style={{ borderTop: '1px dashed #888', marginBottom: '3mm' }} />
            )}
            {hasImg && (
                <img
                    src={item.originalImageUrl as string}
                    alt=""
                    style={{ maxWidth: `${imageScale}%`, height: 'auto', display: 'block' }}
                />
            )}
        </>
    );
}

export function AnswerBody({ item, options }: { item: ErrorItem; options: PrintBodyOptions }) {
    const { showAnswers, showAnalysis, showMistake, L } = options;
    const hasMistakeField = showMistake && !!item.mistakeAnalysis;
    const analysisText = item.analysis
        ? hasMistakeField
            ? stripMistakeSection(item.analysis)
            : item.analysis
        : '';
    return (
        <>
            {showAnswers && item.answerText && (
                <div style={{ marginBottom: '2mm' }}>
                    <div className="print-sub-title" style={{ fontWeight: 600 }}>
                        {L('参考答案', 'Answer')}
                    </div>
                    <MarkdownRenderer content={item.answerText} />
                </div>
            )}
            {showAnalysis && analysisText && (
                <div style={{ marginBottom: '2mm' }}>
                    <div className="print-sub-title" style={{ fontWeight: 600 }}>
                        {L('解析', 'Analysis')}
                    </div>
                    <MarkdownRenderer content={analysisText} />
                </div>
            )}
            {hasMistakeField && (
                <div>
                    <div className="print-sub-title" style={{ fontWeight: 600 }}>
                        {L('错因分析', 'Why wrong')}
                    </div>
                    <MarkdownRenderer content={item.mistakeAnalysis as string} />
                </div>
            )}
        </>
    );
}
