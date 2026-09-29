// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editorViewCtx } from '@milkdown/kit/core';
import { createMdEditorInstance, normalizeMilkdownArtifacts } from '@/components/md-editor';

/**
 * 编辑器的**行为**测试（2026-09-29，他实测反馈后补）。
 *
 * 为什么要在 jsdom 里真跑一遍编辑器：这三件事都是"往返"性质的问题，
 * 只有真过一遍 remark 引擎才暴露得出来 —— 他报的三个症状全在这里复现/钉死：
 *   ① 空段落被写成字面 `<br />`（commonmark 的"保留空行"插件干的）
 *   ② 粘贴进来的 `$公式$` 只是普通文字，保存时还被**转义**（`\$`、`\\l`）⇒ 从此不再是公式
 *   ③ 列表序号（这一条是 CSS 问题，不在这里测；见 globals.css 里 .md-editor 的注释）
 *
 * ⚠️ 必须用 `createMdEditorInstance`（与页面同一个函数）—— 测试自己再拼一遍插件列表，
 * 两边迟早不一致（"测过了但线上不生效"就是这么来的）。
 */
async function build(src: string) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const instance = await createMdEditorInstance({ root, value: src, onChange: () => undefined });
    /** 文档里的节点类型清单（比只看 md 更能定位问题） */
    const docTypes = () => {
        const out: string[] = [];
        instance.editor.action((ctx) => {
            ctx.get(editorViewCtx).state.doc.descendants((node) => {
                if (!node.isText) out.push(node.type.name);
            });
        });
        return out;
    };
    return { instance, docTypes, root };
}

describe('MdEditor · 空行不再写成 <br />', () => {
    it('文档里出现空段落时，导出为普通空行而不是 `<br />`', async () => {
        const { instance } = await build('甲\n\n乙');
        // 在末尾补一个空段落（等价于用户连按两次回车）
        instance.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create()));
        });
        const md = instance.getMarkdown();
        expect(md).not.toContain('<br');
        expect(md).toContain('甲');
        expect(md).toContain('乙');
    });

    it('历史数据里的整行 `<br />` 载入后被清掉（不然会当正文印出来）', async () => {
        const { instance } = await build('甲\n\n<br />\n\n乙');
        expect(instance.getMarkdown()).not.toContain('<br');
    });
});

describe('MdEditor · 公式（粘贴进来的那种）', () => {
    it('★ 纯文本 `$x^2+1$` 会被转成数学节点，导出仍是 `$x^2+1$`（不再被转义）', async () => {
        // 用转义美元号喂进去 ⇒ 解析成"普通文字"，等价于用户粘贴一段带公式的文字
        const { instance, docTypes } = await build('结果是 \\$x^2+1\\$ 对不对');
        expect(docTypes()).toContain('math_inline');
        expect(instance.getMarkdown()).toBe('结果是 $x^2+1$ 对不对\n');
    });

    it('钱数这种"两个美元号"的写法：与渲染端**行为一致**（都是 remark-math 的判定）', async () => {
        // ⚠️ 实测（2026-09-29）：`价格 $5 到 $10 之间` 里的 `$5 到 $` 会**被当成公式** ——
        // 这不是我们引入的：渲染端用的 remark-math 同样这么判（拿它直接跑一遍也是一样的
        // inlineMath 节点）。编辑器与渲染端保持一致，就是"所见即所得"要的东西；
        // 真要写钱数，把 `$` 转义（\$）即可 —— 这与 Obsidian 的行为也一样。
        const { instance, docTypes } = await build('价格 $5 到 $10 之间');
        expect(docTypes()).toContain('math_inline');
        // 关键：往返之后**原文没变**（不会被转义成 `\$`、也不会丢内容）
        expect(instance.getMarkdown()).toBe('价格 $5 到 $10 之间\n');
    });

    it('md 里本来就写好的公式，往返不变形', async () => {
        const { instance } = await build('$\\left| 2x-1 \\right|$');
        expect(instance.getMarkdown()).toBe('$\\left| 2x-1 \\right|$\n');
    });
});

describe('MdEditor · 列表与高亮', () => {
    it('有序列表往返保住序号（编辑器里序号由 CSS 画，见 globals.css）', async () => {
        const { instance, docTypes } = await build('1. 测试1\n2. 测试2');
        expect(docTypes()).toContain('ordered_list');
        expect(instance.getMarkdown()).toBe('1. 测试1\n2. 测试2\n');
    });

    it('`==高亮==` 往返不变形、也不会变成斜体', async () => {
        const { instance } = await build('这个数 ==最小是 10.09==。');
        const md = instance.getMarkdown();
        expect(md).toContain('==最小是 10.09==');
        expect(md).not.toMatch(/\*最小是 10\.09\*/);
    });
});

describe('MdEditor · 公式样式（他报的"显示成两份"）', () => {
    it('★ 编辑器自己必须引 KaTeX 的 CSS', async () => {
        // 为什么查源码：KaTeX 每个公式会渲染 HTML + MathML **两份**，
        // 后者靠 KaTeX 自己的 CSS 藏起来。少了这份 CSS，浏览器会把 MathML 也画出来
        // ⇒ 屏幕上出现两个公式（他 2026-09-29 实测）。
        // 这份 CSS 原先只挂在 markdown-renderer 上，而详情页换成所见即所得后
        // 不再引用它 ⇒ 该路由就没样式了。这个探测式断言就是防止它被再次删掉。
        const { readFile } = await import('node:fs/promises');
        const src = await readFile('src/components/md-editor.tsx', 'utf-8');
        expect(src).toContain("import 'katex/dist/katex.min.css'");
    });
});

describe('normalizeMilkdownArtifacts（纯函数）', () => {
    it('整行的 `<br />` 换回空行；行内的不动', () => {
        expect(normalizeMilkdownArtifacts('甲\n\n<br />\n\n乙')).toBe('甲\n\n\n\n乙');
        expect(normalizeMilkdownArtifacts('甲<br />乙')).toBe('甲<br />乙');
        expect(normalizeMilkdownArtifacts('没有 br 的正文')).toBe('没有 br 的正文');
        expect(normalizeMilkdownArtifacts('  <br/>  ')).toBe('');
    });
});
