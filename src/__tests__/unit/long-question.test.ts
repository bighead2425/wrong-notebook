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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('深挖纸：超长时从正面印 OCR（静态护栏）', () => {
    const read = (rel: string) =>
        readFileSync(join(__dirname, '..', '..', '..', 'src', rel), 'utf8');

    it('★ 判定靠"真溢出"（scrollHeight / clientHeight），不是数字数', () => {
        const src = read('components/print/deep-dive-card.tsx');
        expect(src).toMatch(/scrollHeight\s*>\s*el\.clientHeight/);
    });

    it('★ 超长时正面高度放开、内容组搬进正面、反面整块不渲染', () => {
        const src = read('components/print/deep-dive-card.tsx');
        // 正面高度按 isLong 切换
        expect(src).toMatch(/height:\s*isLong\s*\?\s*'auto'/);
        // 正面有"超长才渲染"的分支（内容组 + 页脚）
        expect(src).toMatch(/\{isLong\s*&&\s*\(/);
        // 反面有"不超长才渲染"的分支
        expect(src).toMatch(/\{!isLong\s*&&\s*\(/);
        // 内容组和页脚确实被抽成了变量（否则搬不过去）
        expect(src).toMatch(/const backBodyEl\s*=/);
        expect(src).toMatch(/const backFooterEl\s*=/);
    });
});
