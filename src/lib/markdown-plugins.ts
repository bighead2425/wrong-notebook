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
 * 【2026-10-12】把文本里的**连续多个空格**原样保留下来（题干里"括号中的留空"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 他为什么要这个
 *   选择题的题干常写成「在（    ）里填数」—— 括号里那串空格就是**给孩子写字的位置**。
 *   而 HTML 默认 `white-space: normal` 会把**任意长度的连续空白折叠成一个空格**，
 *   纸上就只剩"一个字宽"的空位，根本写不进去。
 * ══════════════════════════════════════════════════════════════════
 * 为什么不用 CSS（2026-10-12 当天试过，翻车了，别再试）
 *   当时给纸面加了 `white-space: pre-wrap`。它能保留空格 —— 但它**不是只保留空格**：
 *   它把这条链路上所有原本不可见的空白全画出来了（制表符、行内公式两侧被补的空格、
 *   只含空白的文本节点……），最坏情况"一行只由空白组成"会实打实变成一整行空行。
 *   他的原话："每段前都要渲染成前面有一个空行……这样完全不行。"
 *   ⇒ CSS 那条路**已经删干净**（globals.css 里留了警示注释，别再往回加）。
 * ══════════════════════════════════════════════════════════════════
 * 现在这条做法：只在**文本节点**里把「≥2 个连续 ASCII 空格」换成同样数量的 `U+00A0`
 *   · `U+00A0` = 不换行空格，**HTML 不会折叠它** ⇒ 宽度原样保住；
 *   · **不碰任何换行**（换行节点已经被 `remarkHardBreaks` 换成 `<br>` 了）⇒
 *     段落结构、空行、折行位置**一个都不动**，这正是上次翻车的反面；
 *   · 借 `rewriteTextNodes` 递归 ⇒ `code` / `inlineCode` / `math` 这些**只存 value、
 *     没有 children** 的节点天然被跳过（代码块和公式里的空格不受影响）。
 *   ⚠️ 只在**渲染**这一路加（`markdown-renderer.tsx`）。**绝不给编辑器加**：
 *     编辑器会把节点**写回 markdown**，那样就把源码里的普通空格换成了不换行空格
 *     —— 那是改数据，不是改显示。
 *   ⚠️ 单个空格不动（那本来就显示得出来）；制表符也不动（`\t` 在纸上会变成几个字宽，
 *     太不可控，宁可不碰）。
 *
 * ⚠️ **一份空档最多保留 24 个**（`MAX_KEEP_SPACES`）。为什么要封顶：
 *    `U+00A0` **不能折行**，一段几十个的空档会整块被推到下一行，极端情况下比一整行还宽
 *    ⇒ 横向撑出纸面、然后被裁掉（比"没留空"更糟）。超出的部分按普通空格补一个
 *    （那些会被折叠掉）：既保住了空档宽度，又不会造出"搬不动也折不断"的巨块。
 */
const MAX_KEEP_SPACES = 24;

export const remarkKeepSpaceRuns: Plugin = () => (tree) => {
    rewriteTextNodes(tree as MdNode, (value) => {
        if (!/ {2,}/.test(value)) return null;
        const fixed = value.replace(/ {2,}/g, (run) => {
            const keep = Math.min(run.length, MAX_KEEP_SPACES);
            return '\u00A0'.repeat(keep) + (run.length > keep ? ' ' : '');
        });
        return fixed === value ? null : [{ type: 'text', value: fixed }];
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

/* ============================================================================
 * 【2026-09-29 · 编辑器专用】严格版高亮：`==x==` → 独立的 `highlight` 节点。
 *
 * ⚠️ 上面渲染端的 `remarkHighlight` 把高亮**借用** emphasis 节点实现 ——
 * 那是渲染的取巧（hName 直接映射成 <mark>）。但这个形态**绝不能给编辑器用**：
 * Milkdown 编辑器内部就是 remark 引擎，它会把 emphasis 序列化回 `*x*` ——
 * 「保存一次，高亮全变斜体」，原文被静默洗掉。
 *
 * 本插件是同一段 `==` 语法的**正规实现**，parse 与 stringify 两个方向都覆盖：
 *   ① parse：文本节点里的 `==x==` 拆成**独立的** highlight 节点（复用 rewriteTextNodes）；
 *   ② stringify：注册 highlight 节点的输出 handler（`==` 包回去）——
 *      不注册的话 mdast-util-to-markdown 遇到不认识的节点类型会直接抛错。
 * 渲染端**继续用**旧的 remarkHighlight（HTML 输出等价，历史行为不变）。
 * ==========================================================================*/

/** mdast-util-to-markdown 的 State 我们只用到 containerPhrasing 一个方法 */
interface MdToMarkdownState {
    containerPhrasing: (node: MdNode, info?: { before?: string; after?: string }) => string;
}

export const remarkHighlightStrict: Plugin = function remarkHighlightStrict(this) {
    // unified 约定：remark-stringify 从 data('toMarkdownExtensions')（**数组**）里收集
    // 输出扩展 —— 与 remark-gfm 往里推的是同一个键（data.toMarkdown 是错的，编译器不读）。
    const data = this.data() as { toMarkdownExtensions?: unknown[] };
    if (!data.toMarkdownExtensions) data.toMarkdownExtensions = [];
    data.toMarkdownExtensions.push({
        handlers: {
            highlight(node: MdNode, _parent: unknown, rawState: unknown, info: unknown) {
                const marker = '==';
                const state = rawState as MdToMarkdownState;
                return marker + state.containerPhrasing(node, { ...(info as { before?: string; after?: string }), before: marker, after: marker }) + marker;
            },
        },
    });

    return (tree) => {
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
                    type: 'highlight',
                    children: [{ type: 'text', value: m[1] }],
                });
                last = m.index + m[0].length;
            }

            if (!parts.length) return null;
            if (last < value.length) {
                parts.push({ type: 'text', value: value.slice(last) });
            }
            return parts;
        });
    };
};
