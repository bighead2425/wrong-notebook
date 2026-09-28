// @vitest-environment node
// 渲染冒烟测试用 renderToStaticMarkup（react-dom/server），不需要 jsdom —— 跑 node 快得多。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewSheet } from '@/components/print/review-card';
import { REVIEW_PAGE_HEIGHT_MM, VOLUME_HEADER_MM, layoutReviewSheets } from '@/lib/review-card';
import type { VolumeKind } from '@/lib/volume-code';
import type { ErrorItem } from '@/types/api';

/**
 * 卷（复练纸 T2 / 积累纸 T3）的渲染冒烟测试。
 *
 * 验收标准是"打出来好不好看"，但有几条**肉眼很难发现、后果严重**的，必须由测试兜住：
 *   ① **纸上混进 AI 内容**（解析/答案/错因）——与深挖纸同一条铁律；
 *   ② **该印的没印**（卷头、页码、页二维码、四角角标）；
 *   ③ **不该印的印了**（"做几遍"进度勾格；以及那个留白微调的小胶囊**绝不能上纸**）；
 *   ④ 升降级小框**每一道题都要有**（2026-09-28 修：上一版只有第一题有）。
 */

const item = (extra: Partial<ErrorItem> = {}): ErrorItem =>
    ({
        id: 'e1',
        userId: 'u1',
        originalImageUrl: '/uploads/a.jpg',
        questionText: '一个长方形的长是 8 厘米，宽是 5 厘米，求它的周长和面积。',
        ocrText: '（OCR 原文）',
        answerText: '参考答案不该上纸',
        analysis: '解析不该上纸',
        mistakeAnalysis: '错因不该上纸',
        source: 'SX20260916001',
        masteryLevel: 0,
        tags: [{ name: '周长' }],
        notebook: { grade: '五年级', semester: '上', displayName: '小五上数学', subject: 'sx' },
        createdAt: '2026-09-24T10:00:00.000Z',
        updatedAt: '2026-09-24T10:00:00.000Z',
        ...extra,
    }) as unknown as ErrorItem;

interface RenderOptions {
    kind?: VolumeKind;
    volumeNo?: string;
    pageQr?: string;
    gradeText?: string;
    withTweak?: boolean;
}

function renderSheets(items: ErrorItem[], opts: RenderOptions = {}): string {
    const kind = opts.kind ?? 'review';
    const layout = layoutReviewSheets(
        items.map((i) => ({ key: i.id, questionText: i.questionText, figureHeightMM: 0 })),
        kind,
    );
    const itemByKey: Record<string, ErrorItem> = {};
    for (const i of items) itemByKey[i.id] = i;
    return layout.pages
        .map((page, idx) =>
            renderToStaticMarkup(
                <ReviewSheet
                    page={page}
                    pageNo={idx + 1}
                    pageCount={layout.pages.length}
                    volumeNo={opts.volumeNo ?? 'RE20260926001'}
                    kind={kind}
                    gradeText={opts.gradeText ?? '五上'}
                    printDate={new Date(2026, 8, 26)}
                    pageQr={opts.pageQr ?? 'data:image/png;base64,AAAA'}
                    itemByKey={itemByKey}
                    blankValueOf={opts.withTweak ? () => 5 : undefined}
                    onBlankChange={opts.withTweak ? () => undefined : undefined}
                    L={(zh) => zh}
                />,
            ),
        )
        .join('\n');
}

describe('卷 · 纸上零 AI 内容', () => {
    it('解析 / 错因 / 参考答案一个字都不许出现', () => {
        const html = renderSheets([item()]);
        expect(html).not.toContain('参考答案');
        expect(html).not.toContain('解析');
        expect(html).not.toContain('错因');
        expect(html).not.toContain('不该上纸');
    });
});

describe('卷 · 卷头（页眉）', () => {
    it('阳文框的字样：复练纸印「复练」、积累纸印「积累」', () => {
        expect(renderSheets([item()], { kind: 'review' })).toContain('复练');
        expect(renderSheets([item()], { kind: 'build' })).toContain('积累');
        // 阳文 = 白底 + 彩框彩字（与深挖纸的"实底白字"恰好相反，一眼能分开"卷"和"纸"）
        expect(renderSheets([item()], { kind: 'review' })).toContain('background:#ffffff');
    });

    it('卷号、页码「第X/Y页」、印刷日期都在', () => {
        const html = renderSheets([item()], { volumeNo: 'RE20260926001' });
        expect(html).toContain('RE20260926001');
        expect(html).toContain('1/1');
        expect(html).toContain('2026-09-26');
    });

    it('年级·学期在页眉上', () => {
        expect(renderSheets([item()], { gradeText: '五上' })).toContain('五上');
    });

    it('横线与页二维码共享页宽（两者都在）', () => {
        const html = renderSheets([item()]);
        expect(html).toContain('print-volume-header-rule');
        expect(html).toContain('print-qr');
    });

    it('⚠️ 页眉**不写知识点**（复练/积累纸与深挖纸在这点上不同）', () => {
        // 用一个绝不会出现在题干里的知识点名，免得把"题干里有这个词"误判成"知识点印上去了"
        const html = renderSheets([
            item({ tags: [{ name: '□仅知识点占位□' }] } as Partial<ErrorItem>),
        ]);
        expect(html).not.toContain('□仅知识点占位□');
    });
});

describe('卷 · 面的标记规范', () => {
    it('★ **不印四角角标**（2026-09-28 去掉：没有代码认它，二维码自带定位角）', () => {
        const html = renderSheets([item()]);
        for (const at of ['tl', 'tr', 'bl', 'br']) {
            expect(html).not.toContain(`print-review-corner-${at}`);
        }
    });

    it('卷头收成一排、总高 15mm，二维码在卷头里（不再单占一排）', () => {
        const html = renderSheets([item()], { volumeNo: 'RE20260928002' });
        expect(html).toContain('print-volume-header');
        expect(html).toContain(`height:${VOLUME_HEADER_MM}mm`);
        expect(html).toContain('print-volume-qr');
        expect(html).toContain('print-volume-header-rule');
    });

    it('⚠️ 每题**不再**印题号与二维码（2026-09-28 他提的第 1 条：只留一条浅虚线）', () => {
        const html = renderSheets([item(), item({ id: 'e2', source: 'SX20260916002' })]);
        // 题号不再逐题出现（它只活在软件里；扫码走页眉的卷号-页码）
        expect(html).not.toContain('SX20260916001');
        expect(html).not.toContain('SX20260916002');
        // 每页只有一个二维码（页眉那个）
        expect(html.split('print-qr').length - 1).toBe(1);
    });

    it('题与题之间是一条**浅灰虚线**，且只有第一条不画', () => {
        const html = renderSheets([item(), item({ id: 'e2' }), item({ id: 'e3' })]);
        // 3 道题在同一页/同一栏时，虚线数 = 2（第一题不画）
        expect(html.split('dashed').length - 1).toBe(2);
        expect(html).toContain('#cfcfcf');
    });

    it('流水号从 1 开始，逐题累加', () => {
        const html = renderSheets([item(), item({ id: 'e2' }), item({ id: 'e3' })]);
        for (const n of ['1.', '2.', '3.']) {
            expect(html).toContain(`>${n}<`);
        }
    });
});

describe('卷 · 打孔位（奇左偶右）', () => {
    it('第 1 页留左、第 2 页留右（与深挖纸正反面同一条物理边）', () => {
        const many = Array.from({ length: 40 }, (_, i) => item({ id: `e${i}` }));
        const html = renderSheets(many);
        expect(html).toContain('padding-left:12mm');
        expect(html).toContain('padding-right:12mm');
    });
});

describe('卷 · 该有的与不该有的', () => {
    it('⚠️ **不印"做几遍"的进度勾格** —— 进度走扫码回收后记在题上', () => {
        const html = renderSheets([item({ manageType: 'review' } as Partial<ErrorItem>)]);
        for (const word of ['第1遍', '第 1 遍', '做几遍', '遍数', '进度格']) {
            expect(html).not.toContain(word);
        }
    });

    it('★ 每道题都有一个升降级小框（不是只有第一题）', () => {
        const html = renderSheets([
            item({ manageType: 'review' } as Partial<ErrorItem>),
            item({ id: 'e2', manageType: 'review' } as Partial<ErrorItem>),
            item({ id: 'e3', manageType: 'deep' } as Partial<ErrorItem>),
        ]);
        expect(html.split('print-promote-box').length - 1).toBe(3);
        expect(html).toContain('升级');
        expect(html).toContain('降级');
    });

    it('★ 未定等级的行**也印框**（按复练 ⇒ 升级）—— 保证每道题都有', () => {
        // 2026-09-28 改：原先"未定不印"，但老题的 manageType 都是空的 ⇒
        // 实际效果是"大部分题不印框"。他一看样张就看出来了。
        const html = renderSheets([item(), item({ id: 'e2' })]);
        expect(html.split('print-promote-box').length - 1).toBe(2);
        expect(html).toContain('升级');
    });

    it('留白微调只在**被要求时**渲染，且带 print-review-tweak 类名（打印时由 CSS 隐藏）', () => {
        expect(renderSheets([item()])).not.toContain('print-review-tweak');
        const withTweak = renderSheets([item()], { withTweak: true });
        expect(withTweak).toContain('print-review-tweak');
        expect(withTweak).toContain('5行');
    });

    it('整张纸的高度是算出来的那个值（含 2mm 松量）', () => {
        const html = renderSheets([item()]);
        expect(html).toContain('print-review-sheet');
        expect(html).toContain(`height:${REVIEW_PAGE_HEIGHT_MM}mm`);
    });
});
