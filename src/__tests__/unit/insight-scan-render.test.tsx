// @vitest-environment node
// 渲染冒烟测试：扫到的**积累纸**上，每条中间那个「圆圈加号」（需求第 11 条）。
// 用 renderToStaticMarkup（react-dom/server）：不需要 jsdom，本机内存小也跑得动。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InsightSheet, type InsightPrintRow } from '@/components/print/insight-sheet';
import type { MeasuredPageLayout } from '@/lib/review-card';

/**
 * 钉住四条最容易事后被改坏的：
 *   · 未关联错题 ⇒ 框与圆 棕黄（`#b8860b`）、加号白；
 *   · 关联了错题 ⇒ 框与圆 紫（`#7c3aed`）；
 *   · 控件是屏幕上的东西 ⇒ 必须 `no-print`（纸上零装饰是铁律）；
 *   · **不传回调（打印那一路）⇒ 一个框、一个加号都不许冒出来**。
 */

const row: InsightPrintRow = {
    id: 'i1',
    code: 'JL20261003001',
    content: '一个积累条目',
};

const page: MeasuredPageLayout = {
    columns: [{ blocks: [{ key: 'i1', heightMM: 20, seq: 1 }] }],
};

function renderSheet(opts: { interactive?: boolean; linked?: boolean } = {}): string {
    const interactive = opts.interactive ?? true;
    return renderToStaticMarkup(
        <InsightSheet
            page={page}
            pageNo={1}
            pageCount={1}
            volumeNo="BU20261003001"
            rowByKey={{ i1: row }}
            blankLines={1}
            onItemPlusClick={interactive ? () => undefined : undefined}
            linkedOf={interactive ? () => opts.linked ?? false : undefined}
            L={(zh) => zh}
        />,
    );
}

describe('积累纸 · 圆圈加号（需求第 11 条）', () => {
    it('★ 未关联错题 ⇒ 棕黄', () => {
        const html = renderSheet({ linked: false });
        expect(html).toContain('#b8860b');
        expect(html).not.toContain('#7c3aed');
    });

    it('★ 关联了错题 ⇒ 紫', () => {
        const html = renderSheet({ linked: true });
        expect(html).toContain('#7c3aed');
        expect(html).not.toContain('#b8860b');
    });

    it('★ 加号一律白色、圆点 10mm（≥9mm，防误触）', () => {
        const html = renderSheet({ linked: true });
        expect(html).toContain('#ffffff'); // 加号描边
        expect(html).toContain('width:10mm');
        expect(html).toContain('M12 5v14M5 12h14'); // 加号的 svg 路径
    });

    it('⚠️ 是屏幕上的东西 ⇒ 必须 no-print（绝不落纸）', () => {
        expect(renderSheet({ linked: true })).toContain('no-print');
    });

    it('★ 不传回调（打印/纸面那一路）⇒ 框和加号一个都不许冒出来', () => {
        const html = renderSheet({ interactive: false });
        expect(html).not.toContain('#b8860b');
        expect(html).not.toContain('#7c3aed');
        expect(html).not.toContain('M12 5v14M5 12h14');
        expect(html).not.toContain('width:10mm');
    });
});
