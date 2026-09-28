// @vitest-environment node
// 渲染冒烟测试用 renderToStaticMarkup（react-dom/server），不需要 jsdom —— 跑 node 快得多。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewSheet } from '@/components/print/review-card';
import { layoutReviewSheets, REVIEW_HALF_BLOCK_MM, REVIEW_PAGE_HEIGHT_MM } from '@/lib/review-card';
import type { ErrorItem } from '@/types/api';

/**
 * T2 复练纸的渲染冒烟测试。
 *
 * 验收标准是"打出来好不好看"，但有几条**肉眼很难发现、后果严重**的，必须由测试兜住：
 *   ① **纸上混进 AI 内容**（解析/答案/错因）——与深挖纸同一条铁律；
 *   ② **该印的没印**（二维码、四角角标）——面标记规范要求两者成对，缺了回收程序认不出；
 *   ③ **不该印的印了**（他有明确说过的"做几遍"进度勾格 —— 进度走扫码回收后记在题上，
 *      不印在纸上：纸面会乱，也没必要让孩子自己判断自己的进度）；
 *   ④ 升降级小框**按题的类型印**。
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

function renderSheets(items: ErrorItem[]): string {
    const layout = layoutReviewSheets(
        items.map((i) => ({ key: i.id, questionText: i.questionText, figureHeightMM: 0 })),
    );
    const itemByKey: Record<string, ErrorItem> = {};
    for (const i of items) itemByKey[i.id] = i;
    return layout.pages
        .map((page) =>
            renderToStaticMarkup(
                <ReviewSheet
                    page={page}
                    itemByKey={itemByKey}
                    qrMap={{ [items[0].id]: 'data:image/png;base64,AAAA' }}
                    L={(zh) => zh}
                />,
            ),
        )
        .join('\n');
}

describe('复练纸 · 纸上零 AI 内容', () => {
    it('解析 / 错因 / 参考答案一个字都不许出现', () => {
        const html = renderSheets([item()]);
        expect(html).not.toContain('参考答案');
        expect(html).not.toContain('解析');
        expect(html).not.toContain('错因');
        expect(html).not.toContain('不该上纸');
    });
});

describe('复练纸 · 面标记规范（二维码 + 四角角标）', () => {
    it('二维码与四个角标都要在（缺一个回收程序都认不出）', () => {
        const html = renderSheets([item()]);
        expect(html).toContain('print-qr');
        for (const at of ['tl', 'tr', 'bl', 'br']) {
            expect(html).toContain(`print-review-corner-${at}`);
        }
    });

    it('题号印在纸面上（扫不出来时人工也能对）', () => {
        expect(renderSheets([item()])).toContain('SX20260916001');
    });
});

describe('复练纸 · 一题半页 / 两题一页', () => {
    it('两道短题 ⇒ 一张纸、两块、各半页高', () => {
        const html = renderSheets([item(), item({ id: 'e2', source: 'SX20260916002' })]);
        expect(html).toContain(`height:${REVIEW_HALF_BLOCK_MM}mm`);
        // 题间灰色虚线
        expect(html).toContain('print-review-divider');
        expect(html).toContain('dashed');
    });

    it('整张纸的高度是算出来的那个值（含 2mm 松量，防"前面多一张白纸"）', () => {
        const html = renderSheets([item()]);
        expect(html).toContain('print-review-sheet');
        expect(html).toContain(`height:${REVIEW_PAGE_HEIGHT_MM}mm`);
    });
});

describe('复练纸 · 该有的与不该有的', () => {
    it('⚠️ **不印"做几遍"的进度勾格** —— 进度走扫码回收后记在题上，不让孩子在纸上自评', () => {
        const html = renderSheets([item({ manageType: 'review' } as Partial<ErrorItem>)]);
        for (const word of ['第1遍', '第 1 遍', '做几遍', '遍数', '进度格']) {
            expect(html).not.toContain(word);
        }
    });

    it('升降级小框按**题的类型**印：复练题印"升级"', () => {
        const html = renderSheets([item({ manageType: 'review' } as Partial<ErrorItem>)]);
        expect(html).toContain('print-promote-box');
        expect(html).toContain('升级');
    });

    it('深挖题印在复练纸上也只印"降级"（按题印，不按纸印）', () => {
        const html = renderSheets([item({ manageType: 'deep' } as Partial<ErrorItem>)]);
        expect(html).toContain('降级');
        expect(html).not.toContain('升级');
    });

    it('未定等级 ⇒ 不印升降级小框', () => {
        const html = renderSheets([item()]);
        expect(html).not.toContain('print-promote-box');
    });
});
