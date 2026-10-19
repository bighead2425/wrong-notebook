import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { preprocess, remarkHardBreaks, remarkHighlight, remarkKeepSpaceRuns } from '@/lib/markdown-plugins';
import 'katex/dist/katex.min.css';

interface MarkdownRendererProps {
    content: string;
    className?: string;
}

/**
 * 题目文本 / 答案解析的 Markdown 渲染。
 *
 * 【custom-v28 两处修复，都写在 src/lib/markdown-plugins.ts 里，那边有单测】
 *   1. 行内代码 vs 代码块 —— react-markdown 10.x 删掉了 code 组件的 `inline`
 *      参数，旧写法导致**任何反引号都被渲染成独占一行的大灰块**。
 *      现在改由「`pre` 包 `code`」的结构区分（见下方 components）。
 *   2. 正文里的字面 `\n` 还原 —— 旧写法无差别全局替换，会把 `\ne` `\notin`
 *      `\nabla` 这类 LaTeX 命令打断。现在先保护公式片段再替换。
 */
export function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
    const processedContent = preprocess(content);

    return (
        <div className={`markdown-content overflow-x-auto min-w-0 ${className}`}>
            <ReactMarkdown
                /* 【2026-10-12】`remarkKeepSpaceRuns` 放在 `remarkHighlight` **之后**、
                   `remarkHardBreaks` **之前**都行（它只认"纯空格"，两条互不干扰）——
                   这里挑"最后一环"，离 `remarkHardBreaks` 最近，读起来最清楚：
                   先把换行规整好，再管空格。 */
                remarkPlugins={[remarkMath, remarkGfm, remarkHighlight, remarkKeepSpaceRuns, remarkHardBreaks]}
                rehypePlugins={[rehypeKatex]}
                components={{
                    // 自定义样式
                    h1: ({ node, ...props }) => <h1 className="text-2xl font-bold mt-6 mb-4" {...props} />,
                    h2: ({ node, ...props }) => <h2 className="text-xl font-bold mt-5 mb-3" {...props} />,
                    h3: ({ node, ...props }) => <h3 className="text-lg font-bold mt-4 mb-2" {...props} />,
                    /**
                     * 【2026-10-03 他要求】补四、五、六级的渲染。
                     * 原话："之前我们对 md 文件编辑的一、二、三级标题的渲染已经进行了规范，
                     * 我那时说只要三级标签就够了，现在我后悔了，请继续开发出四、五、六级的标题渲染。"
                     * 档差顺着 h1(text-2xl) → h2(text-xl) → h3(text-lg) 继续往下走；
                     * h5/h6 再小就与正文无异，用**字号 + 颜色**一起拉开层次。
                     */
                    h4: ({ node, ...props }) => <h4 className="text-base font-bold mt-3 mb-2" {...props} />,
                    h5: ({ node, ...props }) => <h5 className="text-sm font-bold mt-3 mb-1" {...props} />,
                    h6: ({ node, ...props }) => (
                        <h6 className="text-xs font-bold mt-3 mb-1 text-muted-foreground" {...props} />
                    ),
                    p: ({ node, ...props }) => <p className="mb-3 leading-relaxed" {...props} />,
                    // list-outside：序号在内容块外侧，即使列表项被 <p> 包裹（loose list）
                    // 也不会出现「序号独占一行、正文另起一行」的错位
                    ul: ({ node, ...props }) => <ul className="list-disc list-outside mb-3 space-y-1 pl-5" {...props} />,
                    ol: ({ node, ...props }) => <ol className="list-decimal list-outside mb-3 space-y-1 pl-5" {...props} />,
                    li: ({ node, ...props }) => <li {...props} />,
                    /**
                     * 【2026-10-18】引用块的样式**只留一处**。
                     *
                     * 原来这里写着 `border-l-4 border-primary pl-4 italic my-4`，
                     * 而 `globals.css` 的 `.markdown-content blockquote` 写的是
                     * 浅灰 `#d0d0d4` + 12px 缩进 + 0.75em 间距 —— **两套值在打架**，
                     * 谁赢取决于优先级（目前是 CSS 那份赢，但这是运气，不是设计）。
                     *
                     * 空空 10-18 的原话："引用左侧的竖线改成浅灰，太黑了影响积累纸的观感。"
                     * ⇒ 把 Tailwind 那一串删掉，交给 `.markdown-content blockquote` 统一管，
                     *   编辑器和纸上才是同一个观感（那条注释里写的就是这个要求）。
                     * ⚠️ 别再往这里加颜色/间距：加一次就又变成两份实现。
                     */
                    blockquote: ({ node, ...props }) => <blockquote {...props} />,
                    /**
                     * 块级代码块：样式全在这层。react-markdown 10.x 已无 `code` 的
                     * inline 参数，只能靠「pre 包 code」的结构来区分行内/块级。
                     * pre 内部那份重复的行内底色由 globals.css 的
                     * `.markdown-content pre code` 规则抹掉。
                     */
                    pre: ({ node, ...props }) => (
                        <pre
                            className="block bg-muted p-4 rounded-lg overflow-x-auto my-3 font-mono text-sm"
                            {...props}
                        />
                    ),
                    // 行内代码：小灰块，与 Obsidian 一致（不再撑成整行）
                    code: ({ node, ...props }: any) => (
                        <code
                            className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono text-foreground"
                            {...props}
                        />
                    ),
                    // Obsidian 的 ==高亮==。底色/打印适配统一交给 globals.css
                    // （浅色与深色主题需要不同的半透明度）
                    mark: ({ node, ...props }) => <mark {...props} />,
                    /**
                     * 【2026-10-19 手机版面第 1 批】表格**允许横向滚动**（空空拍板第 3 条）。
                     *
                     * 外面那层 `overflow-x-auto` 本来就有，但表格是 `min-w-full`：
                     * 手机上"最小宽度 = 屏宽"，列一多就**把每一列压到 50px**、字挤成竖排。
                     * 加 `w-max` ⇒ 表格按**内容**撑开，撑不下才让外层滚。
                     * ⚠️ 只对表格这么做；其他元素仍然不许横向滚（`docs\27` §六-3）。
                     */
                    table: ({ node, ...props }) => (
                        <div className="overflow-x-auto my-4">
                            <table className="w-max min-w-full border-collapse border border-border" {...props} />
                        </div>
                    ),
                    th: ({ node, ...props }) => (
                        <th className="border border-border px-4 py-2 bg-muted font-semibold text-left" {...props} />
                    ),
                    td: ({ node, ...props }) => (
                        <td className="border border-border px-4 py-2" {...props} />
                    ),
                    strong: ({ node, ...props }) => <strong className="font-bold text-foreground" {...props} />,
                    em: ({ node, ...props }) => <em className="italic" {...props} />,
                }}
            >
                {processedContent}
            </ReactMarkdown>
        </div>
    );
}
