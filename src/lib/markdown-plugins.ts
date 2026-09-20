/**
 * Markdown 渲染的自定义 remark 插件与正文预处理（custom-v28）。
 *
 * 从 `components/markdown-renderer.tsx` 抽出来成独立模块，为的是能被单测直接
 * 引入验证（组件文件里带着 JSX 和 katex 样式导入，测试起来太重）。
 *
 * 【为什么自己写插件而不是装包】这里只需要两个很小的 AST 变换，自己写**零新依赖**，
 * 也不必把 `unist-util-visit` 这种传递依赖提升成直接依赖（传递依赖随时可能随上游
 * 升级而消失）。
 *
 * 【plugin 写成箭头常量而不是 `function`】unified 的 `Plugin` 是
 * `(this: Processor, ...settings) => Transformer | void` 的形状，用
 * `function xxx(): Plugin { return (tree) => {...} }` 会因为 Transformer 的三参数
 * 签名而报 TS2322。写成 `const xxx: Plugin = () => (tree) => {...}` 让 `tree`
 * 从 Transformer 上下文推断，类型直接对齐，调用处仍然只传函数引用。
 */

import type { Plugin } from 'unified';

/** 只用到 type / value / children / data 这几个字段的极简 mdast 节点 */
export interface MdNode {
    type: string;
    value?: string;
    children?: MdNode[];
    data?: Record<string, unknown>;
}

/**
 * 递归重写整棵 mdast 里的叶子 `text` 节点。
 *
 * 不进入 `code` / `inlineCode` / `math` / `inlineMath`：这些节点的内容存在 `value`
 * 上、本来就没有 children，递归到它们自然停止，所以不会误改代码块与公式。
 *
 * @param rewrite 返回 null 表示「这个 text 不动」；返回节点数组表示替换掉它。
 */
export function rewriteTextNodes(
    node: MdNode,
    rewrite: (value: string) => MdNode[] | null,
): void {
    if (!node || !Array.isArray(node.children)) return;

    const next: MdNode[] = [];
    for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
            const replaced = rewrite(child.value);
            if (replaced) {
                next.push(...replaced);
                continue;
            }
        } else {
            rewriteTextNodes(child, rewrite);
        }
        next.push(child);
    }
    node.children = next;
}

/**
 * Obsidian 语法 `==高亮==` → `<mark>`。
 *
 * mdast 里没有「高亮」这种节点，借 `emphasis` 节点 + `data.hName = 'mark'`
 * 让 mdast-util-to-hast 生成 `<mark>`（不必开 rehype-raw 透传 HTML）。
 *
 * `[^=\n]+?` 里排除换行：跨行的高亮当作没写，避免把半段解析撑乱。
 */
export const remarkHighlight: Plugin = () => (tree) => {
    rewriteTextNodes(tree as MdNode, (value) => {
        if (!value.includes('==')) return null;

        const re = /==([^=\n]+?)==/g;
        const parts: MdNode[] = [];
        let last = 0;
        let m: RegExpExecArray | null;

        while ((m = re.exec(value)) !== null) {
            if (m.index > last) {
                parts.push({ type: 'text', value: value.slice(last, m.index) });
            }
            parts.push({
                type: 'emphasis',
                data: { hName: 'mark' },
                children: [{ type: 'text', value: m[1] }],
            });
            last = m.index + m[0].length;
        }

        if (!parts.length) return null; // 一个完整的 ==对== 都没有
        if (last < value.length) {
            parts.push({ type: 'text', value: value.slice(last) });
        }
        return parts;
    });
};

/**
 * 段落内的单换行 → 硬换行（mdast `break` 节点 → `<br>`）。
 *
 * 【为什么需要】custom-v27 及之前，渲染器把「标点后的单换行」**抬成双换行**
 * （新起一个段落），段落之间自带空距。用户在 B5 纸上排版觉得太占地方，要求取消。
 *
 * 但也不能什么都不做 —— 单换行在 markdown 里是「软换行」，HTML 里会被折叠成一个
 * 空格，AI 分行写的算式会挤成一长串（如「S = a×b = 5×3 = 15」全连在一起）。
 * 折中办法就是硬换行：**照样换行，但不产生段间空距**，正是「紧凑」的诉求。
 *
 * 段落之间的空行不在本插件范围内 —— micromark 早已把它切成两个 paragraph 节点，
 * 单个 text 节点的 value 里不会出现 `\n\n`。
 */
export const remarkHardBreaks: Plugin = () => (tree) => {
    rewriteTextNodes(tree as MdNode, (value) => {
        if (!value.includes('\n')) return null;

        const parts: MdNode[] = [];
        const segs = value.split('\n');
        segs.forEach((seg, i) => {
            if (i > 0) parts.push({ type: 'break' });
            if (seg) parts.push({ type: 'text', value: seg });
        });
        return parts;
    });
};

/**
 * 正文预处理：把 AI 吐出的**字面** `\n`（两个字符：反斜杠 + n）还原成真换行。
 *
 * ⚠️ 这里有一个踩过的坑：原实现是无差别的 `content.replace(/\\n/g, '\n')`，
 * 会把 `\ne`（不等于）、`\neq`、`\neg`（逻辑非）、`\notin`（不属于）、
 * `\nabla`（梯度）、`\nu`（ν）、`\nleq` 这些**以 \n 开头的 LaTeX 命令**一并
 * 打断成「换行 + 残余字母」，公式直接碎掉。数学题解析里 `\ne` / `\notin`
 * 是高频符号。
 *
 * 解法：**先把 `$$...$$` / `$...$` 公式片段整段换成占位符**，做完 `\n` 替换再还原。
 * 公式里的反斜杠命令因此完全不受影响；公式外的字面 `\n` 照旧还原。
 * （prompt 已强制要求公式用 `$` 包裹，覆盖面足够。）
 *
 * 另外取消了两条旧改写：把「标点后的单换行抬成双换行」的规则去掉了 ——
 * 用户要在 B5 纸上排版，段落空距太占地方。单换行改由 remarkHardBreaks 渲染成
 * 不占空距的硬换行。
 */
export function preprocess(content: string): string {
    let s = content;

    // ① 保护公式片段（先块级 $$...$$，再行内 $...$，顺序不能反）
    const mathTokens: string[] = [];
    const stash = (m: string) => `\u0000M${mathTokens.push(m) - 1}\u0000`;
    s = s.replace(/\$\$[\s\S]*?\$\$/g, stash);
    s = s.replace(/\$[^$\n]*?\$/g, stash);

    // ② 字面 \n → 真换行（此时公式已被保护，不会误伤 LaTeX 命令）
    s = s.replace(/\\n/g, '\n');

    // ③ 还原公式
    s = s.replace(/\u0000M(\d+)\u0000/g, (_, i) => mathTokens[Number(i)]);

    // ④ 去掉行首缩进：裸缩进会被 markdown 判成代码块，把 ①/② 这类编号行吞掉
    s = s.replace(/\n\s+([\u2460-\u2473])/g, '\n$1');
    s = s.replace(/\n\s+(\d+\))/g, '\n$1');

    // ⑤ 行内公式前后补空格，避免 `$` 与正文粘连导致 KaTeX 不识别
    s = s.replace(/([^\s$])(\$[^$]+\$)([^\s$])/g, '$1 $2 $3');

    return s;
}
