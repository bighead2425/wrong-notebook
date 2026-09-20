import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { preprocess, remarkHardBreaks, remarkHighlight } from '@/lib/markdown-plugins';
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
                remarkPlugins={[remarkMath, remarkGfm, remarkHighlight, remarkHardBreaks]}
                rehypePlugins={[rehypeKatex]}
                components={{
                    // 自定义样式
                    h1: ({ node, ...props }) => <h1 className="text-2xl font-bold mt-6 mb-4" {...props} />,
                    h2: ({ node, ...props }) => <h2 className="text-xl font-bold mt-5 mb-3" {...props} />,
                    h3: ({ node, ...props }) => <h3 className="text-lg font-bold mt-4 mb-2" {...props} />,
                    p: ({ node, ...props }) => <p className="mb-3 leading-relaxed" {...props} />,
                    // list-outside：序号在内容块外侧，即使列表项被 <p> 包裹（loose list）
                    // 也不会出现「序号独占一行、正文另起一行」的错位
                    ul: ({ node, ...props }) => <ul className="list-disc list-outside mb-3 space-y-1 pl-5" {...props} />,
                    ol: ({ node, ...props }) => <ol className="list-decimal list-outside mb-3 space-y-1 pl-5" {...props} />,
                    li: ({ node, ...props }) => <li {...props} />,
                    blockquote: ({ node, ...props }) => (
                        <blockquote className="border-l-4 border-primary pl-4 italic my-4 text-muted-foreground" {...props} />
                    ),
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
                    table: ({ node, ...props }) => (
                        <div className="overflow-x-auto my-4">
                            <table className="min-w-full border-collapse border border-border" {...props} />
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
