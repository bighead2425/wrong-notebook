/**
 * 【2026-10-26 超长题】语文/英语那种整段材料的阅读题。
 *
 * 他的判断：这类题总量很小（模仿纸绝无可能、复练纸较低、深挖纸有一些），
 * 但一旦出现就必须能印出来 —— 原来装不下就**按一页裁掉**，题干后半截直接没了。
 *
 * 规则（他原话）：
 *   · 超长题**另起一页**，不和前面的题挤在一页
 *   · 允许**跨页**
 *   · 排完之后剩下的空间**不再安排别的题**
 */
import { describe, expect, it } from 'vitest';
import { paginateMeasured, type MeasuredBlock } from '@/lib/review-card';

describe('超长题：独占一页、允许跨页、前后不挤', () => {
    it('★ 超长题单独成一页，里面只有它', () => {
        const blocks: MeasuredBlock[] = [
            { key: 'a', heightMM: 50 },
            { key: 'long', heightMM: 300 }, // 远超一页
            { key: 'c', heightMM: 40 },
        ];
        const { pages } = paginateMeasured(blocks, 'review');

        const longPage = pages.findIndex((p) =>
            p.columns.some((c) => c.blocks.some((b) => b.key === 'long')),
        );
        expect(longPage, '没找到超长题所在的页').toBeGreaterThanOrEqual(0);

        const column = pages[longPage].columns;
        expect(column.length, '这一页应该只有一栏').toBe(1);
        expect(column[0].blocks.length, '这一页应该只有这一道题').toBe(1);
        expect(column[0].blocks[0].key).toBe('long');
        // 打上 long 标记 —— 渲染层靠它放开 break-inside
        expect(column[0].blocks[0].long).toBe(true);
    });

    it('★ 超长题前后的题各自另起一页（不挤进那半页空白）', () => {
        const blocks: MeasuredBlock[] = [
            { key: 'a', heightMM: 50 },
            { key: 'long', heightMM: 300 },
            { key: 'c', heightMM: 40 },
        ];
        const { pages } = paginateMeasured(blocks, 'review');

        const pageOf = (key: string) =>
            pages.findIndex((p) => p.columns.some((c) => c.blocks.some((b) => b.key === key)));

        const pa = pageOf('a');
        const pl = pageOf('long');
        const pc = pageOf('c');
        expect(pa).toBeLessThan(pl);
        expect(pc).toBeGreaterThan(pl);

        // 后面的题独占它自己那页的第一栏，不和超长题同页
        expect(pages[pc].columns[0].blocks[0].key).toBe('c');
    });

    it('普通题不受影响：仍然按高度装箱、不拆题', () => {
        const blocks: MeasuredBlock[] = [
            { key: 'a', heightMM: 40 },
            { key: 'b', heightMM: 40 },
            { key: 'c', heightMM: 40 },
        ];
        const { pages, overflow } = paginateMeasured(blocks, 'review');
        expect(overflow).toEqual([]);
        // 三块都矮，应该装得下同一页
        const total = pages[0].columns[0].blocks.length;
        expect(total).toBeGreaterThanOrEqual(2);
        // 没有一块被标成 long
        const anyLong = pages.some((p) => p.columns.some((c) => c.blocks.some((b) => b.long)));
        expect(anyLong).toBe(false);
    });

    it('超长题也记进 overflow（页面提示"换大纸"仍然成立）', () => {
        const blocks: MeasuredBlock[] = [{ key: 'long', heightMM: 400 }];
        const { overflow } = paginateMeasured(blocks, 'review');
        expect(overflow.map((o) => o.key)).toEqual(['long']);
    });
});
