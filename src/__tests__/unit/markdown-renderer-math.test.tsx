// @vitest-environment node
// 渲染冒烟测试（react-dom/server），与 review-card-render 同一套路：跑 node，不需要 jsdom。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownRenderer } from '@/components/markdown-renderer';

/**
 * 打印 / 预览那条路的公式渲染（2026-09-29 顺带钉住）。
 *
 * 他报"详情页框里空白"时，我顺路核了一遍这条路 —— **它一直是对的**：
 * rehype-katex 会按节点类型给 `displayMode`（整行 `math-display` → true），
 * 出错时先重试一次 `throwOnError: false`，再不行才自己捏一个红色 span。
 * 这条测试的价值是"以后别把这两条再弄丢"——编辑器与渲染端必须同口径，
 * 不然会出现"编辑器里能看、印出来是错"这种最难查的分歧。
 */
const USER_FORMULA = [
    '$$',
    '\\begin{equation}',
    '\\begin{aligned}',
    'Z & = \\int_{-\\infty}^{\\infty} \\left( \\sum_{n=1}^{N} \\frac{\\alpha_n e^{i \\beta_n x}}{1 + x^2} \\right) \\, dx + \\lim_{x \\to 0} \\left( \\frac{\\sin x}{x} \\right) \\\\',
    '& + \\sum_{k=0}^{\\infty} \\left( \\frac{1}{k!} \\left( \\frac{d^k}{dx^k} \\left( e^{x^2} \\right) \\Bigg|_{x=0} \\right) \\right) + \\left| \\begin{matrix} a & b & c \\\\ d & e & f \\\\ g & h & i \\end{matrix} \\right|',
    '\\end{aligned}',
    '\\end{equation}',
    '$$',
].join('\n');

describe('MarkdownRenderer · 公式（打印/预览那条路）', () => {
    it('★ 整行公式（$$）按 display 渲染：`\\begin{equation}` 不报错', () => {
        const html = renderToStaticMarkup(<MarkdownRenderer content={USER_FORMULA} />);
        expect(html).toContain('katex-display');
        expect(html).not.toContain('katex-error');
    });

    it('行内公式（单个 $）照旧能渲染', () => {
        const html = renderToStaticMarkup(<MarkdownRenderer content={'结果是 $x^2+1$ 对不对'} />);
        expect(html).toContain('class="katex"');
        expect(html).not.toContain('katex-display'); // 行内不该占整行样式
        expect(html).not.toContain('katex-error');
    });

    it('★ 写法有错时退化成红字（不让整个版面炸掉）', () => {
        // 单个 `$` 装不下 `\begin{equation}` —— 这是 KaTeX 的规矩，失败方式要"看得见"
        const html = renderToStaticMarkup(<MarkdownRenderer content={'$\\begin{equation}x=1\\end{equation}$'} />);
        expect(html).toContain('katex-error');
    });
});
