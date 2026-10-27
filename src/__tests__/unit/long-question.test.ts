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

    it('★ 超长时改成按页装箱：minHeight 而不是定高（定高会把字裁掉）', () => {
        const src = read('components/print/deep-dive-card.tsx');
        // 判定仍然靠"真溢出"（scrollHeight / clientHeight），不是数字数
        expect(src).toMatch(/scrollHeight\s*>\s*el\.clientHeight/);
        /**
         * 【2026-10-27 改】
         * 原来正面高度是 `height: isLong ? 'auto'` —— 靠浏览器自己截断。
         * 现在改成软件按 225mm 装箱，且**必须**用 minHeight：
         * `.print-deep-side` 是 `overflow: hidden`，写死 height 一旦把内容估高，
         * 多出来的会被静默裁掉（不报错、不留痕）。这条是这个改动的命门。
         */
        expect(src).not.toMatch(/height:\s*isLong\s*\?\s*'auto'/);
        expect(src).toMatch(/minHeight:\s*isLong\s*\?/);
        // 正文抽成"可切片"的 renderBody；尾部只在最后一页画
        expect(src).toMatch(/const renderBody\s*=/);
        expect(src).toMatch(/slice\.tail/);
        // 页脚仍然抽成变量（正面/续页共用）
        expect(src).toMatch(/const backFooterEl\s*=/);
        // 反面仍是不超长才渲染
        expect(src).toMatch(/\{!isLong\s*&&\s*\(/);
    });

    it('★ 超长时每一页都印身份条（续页是独立一张纸，掉了要认得出）', () => {
        const src = read('components/print/deep-dive-card.tsx');
        // 页头抽成 headerEl —— 正面与续页共用同一份
        expect(src).toMatch(/const headerEl\s*=/);
        // 续页里确实引用了 headerEl
        expect(src).toMatch(/longCuts\.slice\(1\)[\s\S]{0,3000}\{headerEl\}/);
        // 续页必须另起一张纸
        expect(src).toMatch(/breakBefore:\s*'page'/);
    });

    it('★ 分页宽度/高度都取自 paper，不写死 B5（换成 A4 也成立）', () => {
        const src = read('components/print/deep-dive-card.tsx');
        expect(src).toMatch(/const pageMM\s*=\s*paper\.content\.h\s*-\s*2/);
        expect(src).toMatch(/width:\s*`\$\{paper\.content\.w\s*-\s*12\}mm`/);
    });
});
