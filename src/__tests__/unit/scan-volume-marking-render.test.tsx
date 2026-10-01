// @vitest-environment node
// 渲染冒烟测试：扫到的复练卷页上「纸面直接录入」那两组控件。
// 用 renderToStaticMarkup（react-dom/server）：不需要 jsdom，本机 4GB 内存也跑得动。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewSheet } from '@/components/print/review-card';
import type { MeasuredPageLayout } from '@/lib/review-card';
import type { ErrorItem } from '@/types/api';
import type { ReviewMark } from '@/lib/scan-marking';
import type { PromoteDirection } from '@/lib/manage-type';

/**
 * 【2026-10-02 他要求】扫到的复练卷页支持**纸面上直接录入**：
 *   一、点升降框 ⇒ 改类型（勾选态：对号 + 已降/已升 + 浅绿/粉底）；
 *   二、每题右侧一颗灰圆 ⇒ 灰数字 / 绿对号 / 粉错号，三态循环。
 *
 * 测试只需钉住**看得见、最容易事后被改坏**的几条：
 *   · 控件带 `no-print`（纸上零 AI 内容的铁律）；
 *   · 灰圆三态各自画对（数字 / ✓ / ✗），且直径 11mm（比加号那个蓝圆大）；
 *   · 升降框勾选态的文案与底色；
 *   · **不传这些回调时（打印那一路）一个都不许冒出来**。
 */

const item = (extra: Partial<ErrorItem> = {}): ErrorItem =>
    ({
        id: 'e1',
        userId: 'u1',
        originalImageUrl: '/uploads/a.jpg',
        questionText: '一个长方形的长是 8 厘米，宽是 5 厘米，求它的周长和面积。',
        answerText: '周长 26 厘米',
        manageType: 'deep',
        masteryLevel: 0,
        createdAt: '2026-09-24T10:00:00.000Z',
        updatedAt: '2026-09-24T10:00:00.000Z',
        ...extra,
    }) as unknown as ErrorItem;

const page: MeasuredPageLayout = {
    columns: [{ blocks: [{ key: 'e1', heightMM: 40, seq: 1 }] }],
};

function renderSheet(opts: {
    it?: ErrorItem;
    mark?: ReviewMark;
    promote?: { direction: PromoteDirection; checked: boolean };
    interactive?: boolean;
} = {}): string {
    const it = opts.it ?? item();
    const interactive = opts.interactive ?? true;
    return renderToStaticMarkup(
        <ReviewSheet
            page={page}
            pageNo={1}
            pageCount={1}
            volumeNo="RE20260926001"
            kind="review"
            printDate={new Date(2026, 9, 2)}
            itemByKey={{ e1: it }}
            onQuestionPlusClick={interactive ? () => undefined : undefined}
            onPromoteToggle={interactive ? () => undefined : undefined}
            promoteOverrideOf={interactive ? () => opts.promote : undefined}
            onReviewMarkTap={interactive ? () => undefined : undefined}
            reviewMarkOf={interactive ? () => opts.mark ?? 'none' : undefined}
            L={(zh) => zh}
        />,
    );
}

describe('扫卷录入 · 右侧灰圆（三态）', () => {
    it('★ 三态各画各的：灰数字 / 绿对号 / 粉错号', () => {
        const none = renderSheet({ mark: 'none' });
        expect(none).toContain('>1<'); // 灰底白**流水号**
        expect(none).not.toContain('✓');
        expect(none).not.toContain('✗');

        expect(renderSheet({ mark: 'right' })).toContain('✓');
        const wrong = renderSheet({ mark: 'wrong' });
        expect(wrong).toContain('✗');
        expect(wrong).not.toContain('✓');
    });

    it('★ 圆的直径 11mm（比加号那个 10mm 蓝圆略大）', () => {
        expect(renderSheet({ mark: 'none' })).toContain('width:11mm');
    });

    it('三态配色来自一处 token（绿=对 / 粉=错）', () => {
        expect(renderSheet({ mark: 'right' })).toContain('#6fbf8b');
        expect(renderSheet({ mark: 'wrong' })).toContain('#f6c9cf');
        expect(renderSheet({ mark: 'none' })).toContain('#9ca3af');
    });

    it('⚠️ 控件是屏幕上的东西 ⇒ 必须 no-print（绝不落纸）', () => {
        expect(renderSheet({ mark: 'right' })).toContain('no-print');
    });
});

describe('扫卷录入 · 升降框（点一下改类型）', () => {
    it('未勾选：还是印"降级"（深挖）/"升级"（复练）', () => {
        expect(renderSheet({ it: item({ manageType: 'deep' }) })).toContain('降级');
        expect(renderSheet({ it: item({ manageType: 'review' }) })).toContain('升级');
    });

    it('★ 勾选后：文字改"已降"、底色浅绿（箭头仍留着）', () => {
        const html = renderSheet({
            it: item({ manageType: 'review' }), // 已降级 ⇒ 现在类型是复练
            promote: { direction: 'demote', checked: true },
        });
        expect(html).toContain('已降');
        expect(html).toContain('#d7f0dd');
        expect(html).toContain('↓');
    });

    it('★ 勾选后：文字改"已升"、底色粉红', () => {
        const html = renderSheet({
            it: item({ manageType: 'deep' }),
            promote: { direction: 'upgrade', checked: true },
        });
        expect(html).toContain('已升');
        expect(html).toContain('#fbd7e0');
        expect(html).toContain('↑');
    });

    it('方框里出现对号（勾选态）', () => {
        const html = renderSheet({ promote: { direction: 'demote', checked: true } });
        // 对号的 svg 路径
        expect(html).toContain('M5 13l4 4L19 7');
    });
});

describe('扫卷录入 · 打印那一路一个都不许冒出来', () => {
    it('★ 不传这些回调（打印/纸面）⇒ 没有灰圆、没有"已降/已升"、没有对号', () => {
        const html = renderSheet({ interactive: false });
        expect(html).not.toContain('已降');
        expect(html).not.toContain('已升');
        expect(html).not.toContain('✗');
        expect(html).not.toContain('M5 13l4 4L19 7');
        // 但只读的升降框照旧在（纸面本来每道题都有）
        expect(html).toContain('print-promote-box');
    });
});
