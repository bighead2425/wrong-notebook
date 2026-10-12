/**
 * Markdown 渲染相关单测（custom-v28）。
 *
 * 覆盖两条修复：
 *   1. `==高亮==` 需真的产出 <mark>（mdast 无此节点，是靠 emphasis + data.hName 借来的）
 *   2. 单换行需产出不占空距的 <br>，且**不能再把段落抬成双换行**
 *   3. 字面 `\n` 的还原不能误伤 `\ne` `\notin` `\nabla` 这类 LaTeX 命令
 */

import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import { preprocess, remarkHighlight, remarkHardBreaks, remarkKeepSpaceRuns } from '@/lib/markdown-plugins';

/** 跑一遍与 MarkdownRenderer 相同的 remark 管道，返回 hast 树 */
function toHast(md: string) {
    const processor = unified()
        .use(remarkParse)
        .use(remarkMath)
        .use(remarkGfm)
        .use(remarkHighlight)
        .use(remarkHardBreaks)
        .use(remarkRehype);
    return processor.runSync(processor.parse(preprocess(md))) as any;
}

/** 收集树里所有元素标签名 */
function tags(node: any, out: string[] = []): string[] {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'element' && node.tagName) out.push(node.tagName);
    if (Array.isArray(node.children)) node.children.forEach((k: any) => tags(k, out));
    return out;
}

/** 取出所有 <mark> 里的纯文本 */
function markTexts(node: any, out: string[] = []): string[] {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'element' && node.tagName === 'mark') {
        const text = (node.children || [])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.value)
            .join('');
        out.push(text);
    }
    if (Array.isArray(node.children)) node.children.forEach((k: any) => markTexts(k, out));
    return out;
}

/* ========================================================================== */

describe('preprocess —— 字面 \\n 还原', () => {
    it('公式外的字面 \\n 还原成真换行', () => {
        const out = preprocess('第一行\\n第二行');
        expect(out).toBe('第一行\n第二行');
    });

    it('公式外的字面 \\n 后面跟英文也照旧还原', () => {
        const out = preprocess('前面\\nSecond line');
        expect(out).toBe('前面\nSecond line');
    });

    it('【回归】\\ne（不等于）不能被拆成换行', () => {
        const out = preprocess('$a \\ne b$');
        expect(out).toBe('$a \\ne b$');
        expect(out).not.toContain('\n');
    });

    it('【回归】\\neq / \\notin / \\nabla / \\nu / \\nleq 都不能被拆', () => {
        const cases = ['\\neq', '\\notin', '\\nabla', '\\nu', '\\nleq', '\\neg'];
        for (const cmd of cases) {
            const out = preprocess(`$${cmd} x$`);
            expect(out, `${cmd} 被误伤`).toBe(`$${cmd} x$`);
        }
    });

    it('块级公式 $$...$$ 里的命令同样受保护', () => {
        const out = preprocess('$$a \\neq b$$');
        expect(out).toBe('$$a \\neq b$$');
    });

    it('【回归】不再把标点后的单换行抬成双换行（B5 纸要紧凑）', () => {
        const out = preprocess('这是一个两位小数。\\n它的个位是0。');
        expect(out).toBe('这是一个两位小数。\n它的个位是0。');
        expect(out).not.toContain('\n\n');
    });

    it('中文标点、英文标点、①、(1) 后面都不再插空行', () => {
        expect(preprocess('甲。\\n乙')).not.toContain('\n\n');
        expect(preprocess('A.\\nB')).not.toContain('\n\n');
        expect(preprocess('①甲\\n②乙')).not.toContain('\n\n');
        expect(preprocess('(1)甲\\n(2)乙')).not.toContain('\n\n');
    });

    it('段落之间本来就有的空行保留', () => {
        const out = preprocess('第一段\\n\\n第二段');
        expect(out).toContain('\n\n');
    });

    it('去掉行首缩进（防止 ①/(1) 行被当成代码块）', () => {
        expect(preprocess('\n      ①甲')).toBe('\n①甲');
        expect(preprocess('\n      1)甲')).toBe('\n1)甲');
    });

    it('行内公式前后补空格', () => {
        expect(preprocess('价格是$5$元')).toBe('价格是 $5$ 元');
    });
});

describe('remarkHighlight —— Obsidian 的 ==高亮==', () => {
    it('单处高亮产出 <mark>', () => {
        const tree = toHast('这是==重点==内容');
        expect(tags(tree)).toContain('mark');
        expect(markTexts(tree)).toEqual(['重点']);
    });

    it('多处高亮都要产出', () => {
        expect(markTexts(toHast('==甲== 和 ==乙=='))).toEqual(['甲', '乙']);
    });

    it('单独的等号不误判', () => {
        expect(tags(toHast('a = b'))).not.toContain('mark');
        expect(tags(toHast('1 + 1 == 2 这种不算高亮，因为没有收尾'))).not.toContain('mark');
    });

    it('数学公式里的 == 不该被当成高亮', () => {
        const tree = toHast('$a == b$ 是判断相等的写法');
        expect(tags(tree)).not.toContain('mark');
    });

    it('高亮与加粗可以共存', () => {
        const tree = toHast('**==重点==**');
        expect(tags(tree)).toContain('mark');
        expect(tags(tree)).toContain('strong');
    });
});

describe('remarkHardBreaks —— 单换行变硬换行', () => {
    it('段落内单换行产出 <br>', () => {
        const tree = toHast('S = a×b\n= 5×3\n= 15');
        expect(tags(tree)).toContain('br');
    });

    it('空行仍是分段，不产出 <br>', () => {
        const tree = toHast('第一段\n\n第二段');
        const ps = tags(tree).filter(t => t === 'p');
        expect(ps.length).toBe(2);
        expect(tags(tree)).not.toContain('br');
    });

    it('代码块内的换行不被改（code 节点的内容存在 value 上，本就不遍历）', () => {
        const tree = toHast('```\nline1\nline2\n```');
        expect(tags(tree)).toContain('code');
        expect(tags(tree)).not.toContain('br');
    });

    it('多行算式逐行断开', () => {
        const tree = toHast('甲\n乙\n丙');
        const brs = tags(tree).filter(t => t === 'br');
        expect(brs.length).toBe(2);
    });
});

describe('行内代码 vs 代码块（react-markdown 10 的 inline 参数已失效）', () => {
    it('行内反引号产出 p > code，而不是 pre', () => {
        const tree = toHast('个位是`0`，两位小数');
        expect(tags(tree)).toContain('code');
        expect(tags(tree)).not.toContain('pre');
    });

    it('三个反引号才产出 pre > code', () => {
        const tree = toHast('```\nconst a = 1;\n```');
        expect(tags(tree)).toContain('pre');
        expect(tags(tree)).toContain('code');
    });
});

/* ==========================================================================
 * 【2026-10-12 需求第 17 条（他当晚改成"源码级"的那一版）】连续空格要留住
 *
 * 背景：CSS 那条路（`white-space: pre-wrap`）当天试过、翻车了 —— 它不止保留空格，
 * 还会把这条链路上所有原本不可见的空白全画出来（他："每段前都要渲染成前面有一个空行"）。
 * 现在改成只在**文本节点**里把「≥2 个连续空格」换成不换行空格（`\u00A0`）：
 * 不碰换行 ⇒ 段落结构与折行位置一个都不动。
 * ========================================================================== */

/** 这一小段用得着的树形状（不引第三方类型，免得又欠一个 `any`） */
interface MiniNode {
    type?: string;
    value?: string;
    tagName?: string;
    children?: MiniNode[];
}

/** 只跑"连续空格"这一环 + 到 hast，断言用 */
function toHastWithSpaces(md: string): MiniNode {
    const processor = unified()
        .use(remarkParse)
        .use(remarkMath)
        .use(remarkGfm)
        .use(remarkKeepSpaceRuns)
        .use(remarkHardBreaks)
        .use(remarkRehype);
    return processor.runSync(processor.parse(preprocess(md))) as unknown as MiniNode;
}

/** 把树里所有文本节点的 value 收起来（断言"到底渲染出了什么字"） */
function allText(node: MiniNode, out: string[] = []): string[] {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'text' && typeof node.value === 'string') out.push(node.value);
    if (Array.isArray(node.children)) node.children.forEach((k) => allText(k, out));
    return out;
}

describe('remarkKeepSpaceRuns —— 括号里的多个空格要留住（2026-10-12）', () => {
    const NBSP = '\u00A0';

    it('★ 括号里的 4 个空格 ⇒ 4 个不换行空格（宽度原样保住）', () => {
        const texts = allText(toHastWithSpaces('在（    ）里填数'));
        expect(texts.some((t) => t.includes(`（${NBSP.repeat(4)}）`))).toBe(true);
        // 断言"确实不是普通空格"（普通空格会被 HTML 折叠成一个）
        expect(texts.join('')).not.toContain('（    ）');
    });

    it('★ 一个空格不动（那本来就显示得出来，没必要改）', () => {
        const texts = allText(toHastWithSpaces('甲 乙'));
        expect(texts).toContain('甲 乙');
    });

    it('★ 行首缩进照旧交给 markdown 处理（不能把它变成可见空格）', () => {
        const texts = allText(toHastWithSpaces('甲\n  乙'));
        expect(texts.join('')).not.toContain(NBSP);
    });

    it('★ 换行结构一个都不动（这是上一版翻车的反面）', () => {
        const withFix = tags(toHastWithSpaces('甲\n乙\n\n丙\n丁'));
        const brs = withFix.filter((t) => t === 'br');
        expect(brs.length).toBe(2); // 单换行 → 两个 <br>，空行 → 段落切开
        expect(withFix.filter((t) => t === 'p').length).toBe(2);
    });

    it('★ 行内代码里的空格不许碰（那是代码，改了就不是原文了）', () => {
        const texts = allText(toHastWithSpaces('看这段 `a    b` 结束'));
        expect(texts.some((t) => t.includes('a    b'))).toBe(true);
    });

    it('★ 公式里的空格不许碰（`\u00A0` 会被 KaTeX 当成奇怪的字符）', () => {
        const texts = allText(toHastWithSpaces('已知 $a    b$ 求 c'));
        expect(texts.join('')).not.toContain(NBSP);
    });

    it('超长空格串封顶（不然那段不能折行，会把整行撑出纸面）', () => {
        const texts = allText(toHastWithSpaces(`甲${' '.repeat(30)}乙`));
        const hit = texts.find((t) => t.includes('甲'))!;
        expect(hit).toContain(NBSP.repeat(24));
        expect(hit).not.toContain(NBSP.repeat(25));
    });
});
