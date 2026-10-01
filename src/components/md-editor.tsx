"use client";

/**
 * 【2026-09-29】Markdown **所见即所得**编辑器（两处共用：详情页各节 + AI 校对页）。
 *
 * 选型 = Milkdown（他拍板）。核心理由只有一条：
 *   **数据库里存的是纯 md 源**，被打印流水线 / Obsidian 导出 / 净版 OCR 共用 ——
 *   Milkdown 内部就是 remark 引擎，「md 进、md 出」，保存不洗原文；
 *   TipTap 那类富文本优先的编辑器会把内容转成富文本再序列化，往返有损耗。
 *
 * 四个工程要点（都踩过或查证过，别删）：
 *   1. **Milkdown 只在浏览器加载**：用动态 import（`await import(...)`），
 *      本文件的模块顶层绝不 import 它 —— Next 的 SSR 预渲染阶段会执行客户端组件的模块体，
 *      ProseMirror 在 Node 里摸 DOM 就炸了。类型用 `import type`（会被擦除，安全）。
 *   2. **受控回环**：编辑器 onChange → 父组件 value → 本组件 [value] effect。
 *      用 `emittedRef` 记住「自己刚吐出去的 md」：值来自自己就跳过回写，
 *      否则「编辑器吐 md → 父 setState → effect 又往编辑器灌」死循环 / 光标乱跳。
 *   3. **`==高亮==` 是自写扩展**（见 lib/markdown-plugins.ts 的 remarkHighlightStrict）：
 *      Milkdown 没有这个语法；不接的话高亮显示成字面 `==`，更糟的是借用渲染端
 *      那个 emphasis 版会被序列化回 `*斜体*`（原文被静默洗掉）。
 *   4. **粘贴的 `$公式$` 要救**：remark 只在「解析 md」时识别公式，而**粘贴**走的是
 *      ProseMirror 纯文本插入 ⇒ 公式只是普通文字，保存时还会被**转义**
 *      （`$`→`\$`、`\l`→`\\l`），存进库就再也不是公式了（他实测就是这个问题）。
 *      这里用一个 ProseMirror 插件把"文本形态的成对 `$…$`"换成真正的数学节点。
 *   5. **公式节点是我们自己写的**（顶掉 `@milkdown/plugin-math` 自带的，2026-09-29）：
 *      自带那版把**整行公式**也按行内模式渲染（`displayMode` 没传 ⇒ `\begin{equation}`
 *      这类"只许整行"的环境一律报错），而且**报错就抛异常** —— 那是在 ProseMirror
 *      渲染文档途中抛的，直接把整个编辑框留成**空白**（他实测）。见下面 `renderKatexInto`。
 */

import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@milkdown/kit/core';
// 只是类型（会被编译期擦除）—— 不会把 ProseMirror 拖进 SSR
import type { Transaction } from '@milkdown/kit/prose/state';
// 样式：ProseMirror 的基础排版（contenteditable 行为），静态导入没问题；
// 正文排版复用全局的 .markdown-content（挂在编辑器根节点上，见下）。
import '@milkdown/kit/prose/view/style/prosemirror.css';
/**
 * ⚠️ **KaTeX 的样式必须在这里也引一次**（2026-09-29 他报的"公式显示成两份"就是缺它）。
 *
 * KaTeX 每个公式都会渲染**两份**：一份 HTML（可见）+ 一份 MathML（无障碍用）。
 * 后者是靠 **KaTeX 自己的 CSS**（`.katex-mathml { clip: ... }`）藏起来的 ——
 * 少了这份 CSS，浏览器就用自己的 MathML 引擎把第二份也画出来 ⇒ 屏幕上出现两个公式。
 * 以前这行只写在 `markdown-renderer.tsx` 里，而详情页在换成所见即所得后**不再引用**
 * 那个组件 ⇒ 该路由加载不到这份 CSS。放这里最稳妥：编辑器自己要渲染公式。
 */
import 'katex/dist/katex.min.css';
// `==高亮==` 的编辑器侧 remark 插件（严格版：独立节点，不借用 emphasis —— 见其文件头）
import { remarkHighlightStrict } from '@/lib/markdown-plugins';
import type { RemarkPluginRaw } from '@milkdown/kit/transformer';
// 中文 emoji 选择器：【2026-10-01】`；；眼镜：：` ⇒ 候选浮层
// ⚠️ 这两个模块**不**静态 import 那份 404KB 的 emoji 数据（见 emoji-search.ts），
//    数据只在真正用到时才 `await import()` ⇒ 不进任何一屏的初始包。
import { parseEmojiTrigger } from '@/lib/emoji-trigger';
import { loadEmojiIndex, searchEmojis, type EmojiIndexItem } from '@/lib/emoji-search';
import {
    EmojiPicker,
    EMOJI_PICKER_COLS,
    type EmojiPickerViewState,
} from '@/components/emoji-picker';
// 只用到类型（编译期擦除，不会把 ProseMirror 拖进 SSR）
import type { EditorView } from '@milkdown/kit/prose/view';

/** 触发"初始化时把纯文本公式转成数学节点"的事务标记（加载时没有改动，得靠它叫醒插件） */
const NORMALIZE_MATH_META = 'mdEditor:normalizeMathFromText';

/**
 * 【2026-09-29】清掉 Milkdown 的历史产物：**独占一行的 `<br />`**。
 *
 * 由来：commonmark 预设的「保留空行」插件会把空段落写成字面 `<br />`
 * （`EMPTY_LINE_PLACEHOLDER`）。新编辑器已不再注入那个插件，但**库里已有的内容**
 * 还留着它 —— 渲染端（react-markdown）不开 raw HTML，会把它当普通文本印出来
 * （他看到的"一行 <br />"就是它）。
 *
 * 映射是**无损的**：由该插件产生的 `<br />` 语义上就等于一个空行，换回空行即可。
 * ⚠️ 只处理"整行只有 `<br />`"，行内出现的（真有人写 `<br />` 当内容）不动。
 */
export function normalizeMilkdownArtifacts(md: string): string {
    if (!md.includes('<br')) return md;
    return md.replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, '');
}

export interface MdEditorInstance {
    editor: Editor;
    /** 父组件主动换值（取消编辑 / 换题）：整篇替换内容，不进撤销栈 */
    setMarkdown: (next: string) => void;
    /** 取当前 md 源（保存的就是它；单测与排查也用） */
    getMarkdown: () => string;
    /**
     * 【2026-10-01】把文档里 [from, to) 这段（原文 `expected`）整体换成 emoji 字符。
     * 只在用户**真正选中候选**时被调用 —— 走一次编辑器事务（红线见本文件头）。
     * 若文档已变、`expected` 对不上，则**放弃**（宁可没反应，绝不吞错字）。
     */
    replaceEmojiRange: (from: number, to: number, expected: string, ch: string) => void;
    /** 关闭 emoji 浮层（点面板外时用）：只清状态，**不动文档** */
    closeEmojiPicker: () => void;
    destroy: () => Promise<void>;
}

/**
 * 建一个配好本项目全部扩展的 Milkdown 实例。
 *
 * 抽成独立函数是为了**组件与单测共用同一套配置** ——
 * 测试要是自己再拼一遍插件列表，两边迟早不一致（"测过了但线上不生效"就是这么来的）。
 */
export async function createMdEditorInstance(opts: {
    root: HTMLElement;
    value: string;
    onChange: (md: string) => void;
    /**
     * 【2026-10-01】emoji 候选浮层的状态回调：插件检测到 `；；…：：` 就回调这里，
     * 由 React 决定怎么把面板画出来（插件本身不碰 React 生命周期）。
     * 传 null 表示"该关"。
     */
    onPickerChange?: (state: EmojiPickerViewState | null) => void;
}): Promise<MdEditorInstance> {
    const { root, value, onChange, onPickerChange } = opts;

    const [
        { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, parserCtx, editorViewCtx },
        { commonmark, remarkPreserveEmptyLinePlugin },
        { gfm },
        { listener, listenerCtx },
        { history },
        { $markAttr, $markSchema, $remark, $inputRule, $prose, $nodeSchema, getMarkdown },
        { markRule },
        { Plugin: ProsePlugin, TextSelection },
        { Fragment },
        { remarkMathPlugin, mathInlineInputRule, mathBlockInputRule },
        katexModule,
    ] = await Promise.all([
        import('@milkdown/kit/core'),
        import('@milkdown/kit/preset/commonmark'),
        import('@milkdown/kit/preset/gfm'),
        import('@milkdown/kit/plugin/listener'),
        import('@milkdown/kit/plugin/history'),
        import('@milkdown/kit/utils'),
        import('@milkdown/kit/prose'),
        import('@milkdown/kit/prose/state'),
        import('@milkdown/kit/prose/model'),
        import('@milkdown/plugin-math'),
        import('katex'),
    ]);

    /** KaTeX 主对象（`default ?? 命名空间`：ESM/CJS 两种打包口径都兜住） */
    const katex = katexModule.default ?? katexModule;

    /**
     * ⚠️ commonmark 默认带一个「保留空行」插件：它把**空段落**写成字面 `<br />`
     * 存进 md（`EMPTY_LINE_PLACEHOLDER`）。后果：打印/阅览用的是 react-markdown
     * （未开 raw HTML）⇒ 纸上和屏幕上都会出现一行难看的 `<br />` 文本（他实测如此）。
     * 这里把它摘掉：空行退化成普通空行，渲染端本来就按空行分段，没有损失。
     * （摘掉之后不再写新的；库里的历史 `<br />` 由 normalizeMilkdownArtifacts 兼容。）
     */
    const commonmarkSafe = commonmark.filter(
        (p) => p !== remarkPreserveEmptyLinePlugin.plugin && p !== remarkPreserveEmptyLinePlugin.options,
    );

    // ===== `==高亮==`：mark schema（参照 gfm 删除线的官方写法） =====
    const highlightAttr = $markAttr('highlight');
    const highlightSchema = $markSchema('highlight', (ctx) => ({
        parseDOM: [{ tag: 'mark' }],
        toDOM: (mark) => ['mark', ctx.get(highlightAttr.key)(mark)],
        parseMarkdown: {
            match: (node) => node.type === 'highlight',
            runner: (state, node, markType) => {
                state.openMark(markType);
                state.next(node.children);
                state.closeMark(markType);
            },
        },
        toMarkdown: {
            match: (mark) => mark.type.name === 'highlight',
            runner: (state, mark) => {
                // 'highlight' 是自定义 mdast 节点类型 —— 由 remarkHighlightStrict
                // 注册的 stringify handler 负责把它变回 `==x==`
                state.withMark(mark, 'highlight');
            },
        },
    }));
    // 编辑器侧的 remark 插件：把 `==x==` 拆成独立 highlight 节点（含 stringify handler）。
    // cast 说明：unified 的 `Plugin` 泛型口径是 mdast `Node`，Milkdown 这边要求 `Root` ——
    // 运行时是同一棵树，只是类型口径不同（ReactMarkdown 那边吃的就是同一个插件）。
    const highlightRemark = $remark(
        'remarkHighlightStrict',
        () => remarkHighlightStrict as unknown as RemarkPluginRaw<undefined>,
    );
    // 输入规则：敲 `==文字==` 出高亮（照抄删除线的 markRule 用法）
    const highlightInput = $inputRule((ctx) =>
        markRule(/(?<![\w:/])(==)([^=\n]+?)\1(?!==)/, highlightSchema.type(ctx)),
    );

    // ================= 公式：自建两个节点，**顶掉插件自带的那两个** =================
    /** mdast 的 `math` / `inlineMath` 节点把公式放在 `value` 上（类型上得自己收窄） */
    function teXOf(node: unknown): string {
        const value = (node as { value?: unknown }).value;
        return typeof value === 'string' ? value : '';
    }

    /**
     * ⚠️ **为什么不用 `@milkdown/plugin-math` 自带的节点**（2026-09-29，他报"公式变空白"）。
     *
     * 那版 `toDOM` 写的是 `katex.render(tex, el, {})` —— 两个致命默认值：
     *   1. **`displayMode` 没给 ⇒ 永远是 `false`（行内模式）**。而 `\begin{equation}`、
     *      `\begin{align}`、`\begin{gather}` 这三种环境**只允许出现在整行公式里**，
     *      KaTeX 会直接报 `{equation} can be used only in display mode`。
     *      也就是说：**整行公式（`$$…$$`）被当成行内公式渲染了**，写法没错也照样报错。
     *   2. **`throwOnError` 没给 ⇒ KaTeX 默认 `true`（抛异常）**。而 `toDOM` 是
     *      ProseMirror **渲染整篇文档**时被调的 —— 它在半路抛出去，整棵 DOM 建不完，
     *      结果就是**整个编辑框一片空白**（他看到的正是这个），线索只在控制台里。
     * 对照：渲染端（rehype-katex）两件事都做对了（块公式给 displayMode、出错退化成红字），
     * 所以打印/预览那条路一直是好的 —— 只有编辑器这条路在裸奔。
     *
     * 我们这版：`displayMode` 按「行内 / 整行」分别给对；出错**绝不抛**，
     * 用 KaTeX 自带的 `throwOnError: false` 把有问题的那一小段染红继续渲，
     * 真救不回来就退回显示原始 TeX（能看见、能复制，绝不空白）。
     */
    const renderKatexInto = (el: HTMLElement, tex: string, displayMode: boolean) => {
        try {
            katex.render(tex, el, { displayMode, throwOnError: false, strict: 'ignore' });
        } catch (error) {
            el.textContent = tex;
            el.classList.add('md-math-raw');
            el.title = `公式渲染失败：${(error as Error).message}`;
            return;
        }
        // KaTeX 会把有问题的片段染红放进 `.katex-error`（并带 title=原因）。
        // 顺手在整块公式外面加个虚线框标记 —— 他这次就是"东西没了却没有任何提示"，
        // 光靠一小段红字在长公式里容易被忽略。
        const broken = el.querySelector('.katex-error');
        if (broken) {
            el.classList.add('md-math-broken');
            el.title = broken.getAttribute('title') ?? '公式写法有误';
        }
    };

    /** 行内公式 `$…$`：TeX 存在**文本内容**里（与插件一致，往返 `$…$` 不变形） */
    const ownMathInline = $nodeSchema('math_inline', () => ({
        group: 'inline',
        content: 'text*',
        inline: true,
        atom: true,
        parseDOM: [
            {
                tag: 'span[data-type="math_inline"]',
                getContent: (dom, schema) => {
                    const value = (dom as HTMLElement).dataset.value ?? '';
                    return value ? Fragment.from(schema.text(value)) : Fragment.empty;
                },
            },
        ],
        toDOM: (node) => {
            const el = document.createElement('span');
            el.dataset.type = 'math_inline';
            el.dataset.value = node.textContent;
            renderKatexInto(el, node.textContent, false);
            return el;
        },
        parseMarkdown: {
            match: (node) => node.type === 'inlineMath',
            runner: (state, node, type) => {
                state.openNode(type).addText(teXOf(node)).closeNode();
            },
        },
        toMarkdown: {
            match: (node) => node.type.name === 'math_inline',
            runner: (state, node) => {
                state.addNode('inlineMath', undefined, node.textContent);
            },
        },
    }));

    /**
     * 整行公式 `$$ … $$`（⚠️ 两个 `$$` 必须**各占一行**，与 remark-math 的判定一致）；
     * TeX 存在 attr 里（与插件一致）。
     */
    const ownMathBlock = $nodeSchema('math_block', () => ({
        content: 'text*',
        group: 'block',
        marks: '',
        defining: true,
        atom: true,
        isolating: true,
        attrs: { value: { default: '' } },
        parseDOM: [
            {
                tag: 'div[data-type="math_block"]',
                preserveWhitespace: 'full',
                getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? '' }),
            },
        ],
        toDOM: (node) => {
            const tex = String(node.attrs.value ?? '');
            const el = document.createElement('div');
            el.dataset.type = 'math_block';
            el.dataset.value = tex;
            if (tex.trim() === '') {
                // 敲 `$$ ` 会建出一个空公式块（它是个 atom，光靠打字填不进去）——
                // 给句提示，否则就是个看不见的空盒子
                el.textContent = '（空公式：点右上角 md 切到源码模式，把 LaTeX 填进 $$ 中间）';
                el.classList.add('md-math-empty');
            } else {
                renderKatexInto(el, tex, true);
            }
            return el;
        },
        parseMarkdown: {
            match: (node) => node.type === 'math',
            runner: (state, node, type) => {
                state.addNode(type, { value: teXOf(node) });
            },
        },
        toMarkdown: {
            match: (node) => node.type.name === 'math_block',
            runner: (state, node) => {
                state.addNode('math', undefined, String(node.attrs.value ?? ''));
            },
        },
    }));

    /**
     * 【2026-09-29】把**文本形态**的 `$公式$` 换成真正的数学节点（粘贴场景的救命稻草）。
     *
     * 判定与渲染端（remark-math）**同一口径**：开头 `$` 后不能是空白、结尾 `$` 前不能是空白
     *  —— 这样「价格 $5 到 $10」这类普通文字不会被误当成公式。
     * 手敲的 `$x$` 由 math 插件自带的输入规则先接管，这里不会重复劳动。
     */
    const mathFromText = $prose((ctx) => {
        const mathType = ownMathInline.type(ctx);
        const blockType = ownMathBlock.type(ctx);
        /** 开 `$` 后不能是空白、闭 `$` 前不能是空白 —— 「价格 $5 到 $10」这类普通文字不会被误认 */
        const pair = /\$(?=\S)([^$\n]+?)(?<=\S)\$/g;
        /** 一段文字是不是"只写 `$$` 的围栏行" */
        const isFence = (text: string) => text.trim() === '$$';

        /**
         * 收集"该收成整行公式"的区间（位置基于 tr.doc）。
         * 两种形态都认 —— 粘贴在不同路径下会长成不同的样子：
         *   ① **一个段落**，整段文字就是 `$$\n…\n$$`（VSCode/网页里复制出来的那种）
         *   ② **三个以上段落**，首尾两段文字各是 `$$`，中间是公式（逐行粘进去的那种）
         * ⚠️ `$$` 必须独占一行才算整行公式 —— 写成 `$$x=1$$` 时 remark-math 认它是**行内**
         * 公式（实测如此），这里跟着它的口径走，免得编辑器与渲染端不一致。
         */
        const collectBlocks = (tr: Transaction) => {
            const doc = tr.doc;
            /** 每个顶层子节点的起始位置（先算好，免得边遍历边累加算错） */
            const starts: number[] = [];
            for (let i = 0, acc = 0; i < doc.childCount; i++) {
                starts.push(acc);
                acc += doc.child(i).nodeSize;
            }
            const endOf = (i: number) => starts[i] + doc.child(i).nodeSize;
            const spots: { from: number; to: number; tex: string }[] = [];
            let i = 0;
            while (i < doc.childCount) {
                const child = doc.child(i);
                if (child.type.name === 'paragraph') {
                    const lines = child.textContent.split('\n');
                    if (isFence(child.textContent)) {
                        // 形态②：往后找配对的收尾 `$$`
                        let j = i + 1;
                        while (j < doc.childCount && !isFence(doc.child(j).textContent)) j++;
                        if (j < doc.childCount) {
                            const inner: string[] = [];
                            for (let k = i + 1; k < j; k++) inner.push(doc.child(k).textContent);
                            spots.push({ from: starts[i], to: endOf(j), tex: inner.join('\n') });
                            i = j + 1;
                            continue;
                        }
                    } else if (lines.length >= 2 && isFence(lines[0]) && isFence(lines[lines.length - 1])) {
                        // 形态①：整段就是一段公式
                        spots.push({ from: starts[i], to: endOf(i), tex: lines.slice(1, -1).join('\n') });
                    }
                }
                i += 1;
            }
            return spots;
        };

        return new ProsePlugin({
            appendTransaction(trs, _old, next) {
                // 正常取 docChanged；另有"初始化归一化"的显式 meta（见下面的 dispatch）
                if (!trs.some((tr) => tr.docChanged || tr.getMeta(NORMALIZE_MATH_META))) return null;
                const tr = next.tr;
                let touched = false;

                // ① 先收整行公式：这是"段落级"的替换，会挪动它后面的所有位置，
                //    所以必须在行内替换**之前**做完（从后往前替换，前面的位置才不错位）
                const spots = collectBlocks(tr);
                for (let i = spots.length - 1; i >= 0; i--) {
                    const spot = spots[i];
                    tr.replaceWith(spot.from, spot.to, blockType.create({ value: spot.tex.trim() }));
                    touched = true;
                }

                // ② 再把剩下的"文本形态 `$…$`"换成行内公式（位置在①之后重新找）
                const hits: { from: number; to: number; value: string }[] = [];
                tr.doc.descendants((node, pos) => {
                    if (!node.isText || !node.text || !node.text.includes('$')) return true;
                    pair.lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = pair.exec(node.text)) !== null) {
                        hits.push({ from: pos + m.index, to: pos + m.index + m[0].length, value: m[1] });
                    }
                    return true;
                });
                const schema = tr.doc.type.schema;
                for (const hit of hits.reverse()) {
                    // ⚠️ 行内公式的公式源是**文本内容**（schema: content 'text*'），
                    //    不是 attr —— 传 { value } 会建出一个空公式（导出成 `$$`，他实测会变这样）。
                    tr.replaceWith(hit.from, hit.to, mathType.create(null, schema.text(hit.value)));
                    touched = true;
                }

                return touched ? tr.setMeta('addToHistory', false) : null;
            },
        });
    });

    // ================= 中文 emoji 选择器：`；；眼镜：：` ⇒ 候选浮层 =================
    /**
     * 【2026-10-01】用户拍板的触发方式：
     *   输入 `；；眼镜：：` —— **最后敲的 `：：` 唤醒功能**，往回找最近的 `；；`，
     *   两者之间的中文（"眼镜"）就是搜索词。半角 `;;` / `::` 也认。
     *
     * 为什么"读文档"而不是"读按键"（评估报告 2.2 的做法 C，也正是本触发方式的最佳用法）：
     *   `：` 是中文输入法常管的标点，keydown 拿不到最终字符、还要赌合成态的时序；
     *   而**只看事务提交后的文档**，"这个字是怎么进来的"（软硬键盘 / 输入法 / 语音）全都不用管，
     *   天然绕开合成态。合成期间 `view.composing` 为真时我们也不抢键盘。
     *
     * ⚠️ 红线（见本文件头 3 条 + 评估报告 2.4）：本插件**从不改文档**。
     *    检测到触发只是把状态回调给 React 去弹浮层；只有用户真正**选中某一项**时，
     *    才由 `replaceEmojiRange` 走一次事务把 `；；…：：` 整段换成 emoji。
     *    因此 Esc / 点别处 / 搜不到 ⇒ **原文一个字都不动**（`；；眼镜：：` 原样留着）。
     */
    const pickerCtl: { close: (() => void) | null } = { close: null };

    /** 命中的触发点（文档位置 + 原文），插入时要用它 */
    type PickerHit = { from: number; to: number; query: string; raw: string };

    /**
     * 唯一的"插入 emoji"通路：一次事务把 [from, to) 换成字符，光标落到字符之后。**绝不碰 DOM**。
     * `expected` 是这段的原文，对不上就放弃 —— 防的是"浮层还开着，但文档已被别处改过"。
     */
    const replaceEmojiRange = (
        view: EditorView,
        from: number,
        to: number,
        expected: string,
        ch: string,
    ) => {
        const size = view.state.doc.content.size;
        if (from < 0 || to > size || from >= to) return;
        if (view.state.doc.textBetween(from, to, '', '\n') !== expected) return;
        const tr = view.state.tr.insertText(ch, from, to);
        tr.setSelection(TextSelection.create(tr.doc, from + ch.length));
        tr.scrollIntoView();
        view.dispatch(tr);
        view.focus(); // 对应 Obsidian 版那句"插完把焦点还给编辑器"（点面板会让编辑区失焦）
    };

    const emojiPicker = $prose(() => {
        /** 当前编辑器视图（销毁后为 null） */
        let editorView: EditorView | null = null;
        /** emoji 索引（懒加载；没到位前先空着，加载完再刷新一遍） */
        let index: EmojiIndexItem[] | null = null;
        let items: EmojiIndexItem[] = [];
        let active = 0;
        let hit: PickerHit | null = null;
        /** 已回调出去的状态签名（去重：文档一变就重算是很便宜的，但没必要每次都重渲染 React） */
        let sig: string | null = null;
        /** 上一个事务是否属于"外部写入"（粘贴 / 拖拽 / 程序化换值）——这类一律不触发 */
        let skipNext = false;

        const close = () => {
            if (sig === null) return; // 本来就关着 ⇒ 别惊动 React
            sig = null;
            hit = null;
            items = [];
            active = 0;
            onPickerChange?.(null);
        };
        pickerCtl.close = close; // 供"点面板外关闭"时把插件内部状态一起复位

        const emit = () => {
            if (!editorView || !hit) return;
            const nextSig = `${hit.from}:${hit.to}:${hit.query}:${active}`;
            if (nextSig === sig) return;
            sig = nextSig;
            // 坐标只用来定位浮层：拿不到（极端环境 / 视图像 jsdom）就退回 0，不影响功能
            let rect = { left: 0, top: 0, bottom: 0 };
            try {
                const r = editorView.coordsAtPos(hit.to);
                rect = { left: r.left, top: r.top, bottom: r.bottom };
            } catch {
                /* 定位失败不影响"弹/不弹"与"插/不插" */
            }
            onPickerChange?.({
                from: hit.from,
                to: hit.to,
                query: hit.query,
                raw: hit.raw,
                items,
                activeIndex: active,
                anchor: rect,
            });
        };

        /**
         * 取"光标前"的文本，并记下**每个字符对应的文档位置**。
         * 为什么要位置映射：父节点里可能有 hard_break 这类叶子节点（一个节点的 nodeSize=1，
         * 却不对应一个普通字符），直接拿 parentOffset 当坐标会错位 ⇒ 那就会替换错地方、吞错字。
         */
        const collectBeforeCursor = (view: EditorView) => {
            const parent = view.state.selection.$from.parent;
            const limit = view.state.selection.$from.parentOffset;
            let text = '';
            const map: number[] = [];
            let pos = view.state.selection.$from.start();
            for (let i = 0; i < parent.childCount && text.length < limit; i++) {
                const child = parent.child(i);
                const childText = child.text;
                if (child.isText && childText) {
                    const take = Math.min(childText.length, limit - text.length);
                    for (let j = 0; j < take; j++) {
                        text += childText[j];
                        map.push(pos + j);
                    }
                    pos += childText.length;
                } else if (child.isLeaf) {
                    text += '\n'; // 叶子（如 Shift+Enter 的软换行）当换行看
                    map.push(pos);
                    pos += child.nodeSize;
                } else {
                    pos += child.nodeSize;
                }
            }
            return text.length === limit ? { text, map } : null;
        };

        /** 检测当前光标位置是不是正好在一个"完整的 `；；…：：`"之后 */
        const detect = (view: EditorView): PickerHit | null => {
            const { state } = view;
            if (!state.selection.empty) return null;
            const parent = state.selection.$from.parent;
            // 守卫：代码块 / 行内公式里不触发（`:：` 会把 TeX 或代码污染成垃圾）
            if (parent.type.spec.code) return null;
            if (parent.type.name === 'math_inline') return null;

            const collected = collectBeforeCursor(view);
            if (!collected) return null;

            const parsed = parseEmojiTrigger(collected.text); // ← 判定核心，纯函数、单测覆盖
            if (!parsed) return null;

            const from = collected.map[parsed.start];
            const to = collected.map[parsed.end - 1] + 1;
            if (typeof from !== 'number' || typeof to !== 'number' || from >= to) return null;
            // 双保险：文档里这段原文必须与解析结果逐字一致（防内联节点导致的错位）
            if (state.doc.textBetween(from, to, '', '\n') !== parsed.raw) return null;
            return { from, to, query: parsed.query, raw: parsed.raw };
        };

        /** 用文档现状刷新"该不该弹、弹什么、弹在哪" */
        const refresh = () => {
            const view = editorView;
            if (!view) return close();
            const found = detect(view);
            if (!found) return close();
            if (!index) {
                // 数据还没到位：先拉（动态 import，不进首屏包），拉完再刷一次
                void loadEmojiIndex()
                    .then((loaded) => {
                        index = loaded;
                        refresh();
                    })
                    .catch(() => undefined);
                return;
            }
            items = searchEmojis(index, found.query);
            if (items.length === 0) return close(); // 搜不到 ⇒ 不弹、也不动文档
            if (!hit || hit.query !== found.query || hit.from !== found.from) active = 0;
            hit = found;
            emit();
        };

        /** 把当前高亮项插进去（唯一的"落字"动作，走事务） */
        const insertActive = () => {
            const view = editorView;
            if (!view || !hit || items.length === 0) return;
            const item = items[Math.min(active, items.length - 1)];
            replaceEmojiRange(view, hit.from, hit.to, hit.raw, item.c);
            close();
        };

        /** 网格里挪高亮（不环绕，到边就停） */
        const move = (delta: number) => {
            if (items.length === 0) return;
            const next = active + delta;
            if (next < 0 || next >= items.length) return;
            active = next;
            emit();
        };

        return new ProsePlugin({
            props: {
                handleKeyDown(view, event) {
                    if (!hit || items.length === 0) return false;
                    if (view.composing) return false; // 合成态：方向键在选输入法候选词，绝不抢
                    editorView = view;
                    switch (event.key) {
                        case 'Escape':
                            close();
                            return true; // 吃掉：别让它再被别处处理
                        case 'Enter':
                            insertActive();
                            return true;
                        case 'ArrowRight':
                            move(1);
                            return true;
                        case 'ArrowLeft':
                            move(-1);
                            return true;
                        case 'ArrowDown':
                            move(EMOJI_PICKER_COLS);
                            return true;
                        case 'ArrowUp':
                            move(-EMOJI_PICKER_COLS);
                            return true;
                        default:
                            return false; // 其余键放行 ⇒ 字正常落进文档，成为新的搜索词
                    }
                },
            },
            /**
             * 守卫来源（评估报告 2.3 / 5）：ProseMirror 粘贴时会打 `paste` meta
             * （`prosemirror-view` 的 `readDOMChange`/`handlePaste` 路径），拖拽是 `uiEvent: 'drop'`，
             * 程序化换值（我们的 setMarkdown / 初始化归一化）用 `addToHistory: false`。
             * 这三类都**不许**触发 —— 否则会去吃掉人家粘贴进来的内容（数据丢失）。
             */
            appendTransaction(trs) {
                if (!trs.some((tr) => tr.docChanged)) return null;
                const external = trs.some(
                    (tr) =>
                        tr.getMeta('paste') ||
                        tr.getMeta('uiEvent') === 'drop' ||
                        tr.getMeta('addToHistory') === false,
                );
                if (external) skipNext = true;
                return null; // 本插件不产生任何补充事务（不改文档）
            },
            view(viewInstance) {
                editorView = viewInstance;
                return {
                    update: (_view, prevState) => {
                        const skip = skipNext;
                        skipNext = false;
                        if (!prevState || !editorView) return;
                        // 文档没变（只是移光标等）⇒ 没必要重算
                        if (prevState.doc.eq(editorView.state.doc)) return;
                        if (skip) {
                            close();
                            return;
                        }
                        // 合成态先不动：等 compositionend 那次更新再看文档（同官方斜杠菜单的做法，
                        // 避免用户还在选输入法候选词时面板就闪出来）
                        if (editorView.composing) return;
                        refresh();
                    },
                    destroy: () => {
                        editorView = null;
                        close(); // 源码模式切换会销毁重建编辑器 ⇒ 别把浮层留成孤儿
                    },
                };
            },
        });
    });

    const created = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, normalizeMilkdownArtifacts(value));
            ctx.update(editorViewOptionsCtx, (prev) => ({
                ...prev,
                attributes: {
                    ...prev.attributes,
                    class: 'milkdown-host markdown-content',
                    spellcheck: 'false',
                },
            }));
            // 编辑 → 吐 md 给调用方（保存的就是这个字符串）
            ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => onChange(markdown));
        })
        .use(commonmarkSafe)
        .use(gfm)
        .use(listener)
        .use(history)
        // 公式：只借插件的「md ↔ 公式节点」解析与输入规则，**节点本身用我们自己的**
        //（自带那两个把整行公式按行内渲染、出错还会把编辑框整片搞白 —— 见上面注释）
        .use(remarkMathPlugin)
        .use(mathInlineInputRule)
        .use(mathBlockInputRule)
        .use(ownMathInline)
        .use(ownMathBlock)
        .use(mathFromText)
        .use(emojiPicker)
        .use(highlightAttr)
        .use(highlightSchema)
        .use(highlightRemark)
        .use(highlightInput)
        .create();

    const setMarkdown = (next: string) => {
        created.action((ctx) => {
            const doc = ctx.get(parserCtx)(normalizeMilkdownArtifacts(next));
            if (!doc) return;
            const view = ctx.get(editorViewCtx);
            view.dispatch(
                view.state.tr
                    .replaceWith(0, view.state.doc.content.size, doc)
                    .setMeta('addToHistory', false),
            );
        });
    };

    /**
     * 初始化归一化：加载时没有事务，appendTransaction 不会跑 ——
     * 手动派发一个带 meta 的空事务，让历史数据里以**纯文本**存着的 `$公式$`
     * 在第一次显示时就变成真正的数学节点（不进撤销栈）。
     */
    created.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setMeta(NORMALIZE_MATH_META, true).setMeta('addToHistory', false));
    });

    return {
        editor: created,
        setMarkdown,
        getMarkdown: () => created.action(getMarkdown()),
        replaceEmojiRange: (from, to, expected, ch) => {
            created.action((ctx) => replaceEmojiRange(ctx.get(editorViewCtx), from, to, expected, ch));
        },
        closeEmojiPicker: () => pickerCtl.close?.(),
        destroy: () => created.destroy().then(() => undefined),
    };
}

export interface MdEditorProps {
    /** md 源（数据库里的原样字符串） */
    value: string;
    /** 用户编辑后吐回的 md 源（保存的就是它） */
    onChange: (md: string) => void;
    placeholder?: string;
    /** 编辑区最小高度（px），默认 140 */
    minHeightPx?: number;
    className?: string;
    /**
     * 【2026-09-29】框里有**未保存的改动**（由父组件判定 —— 它同时掌握"基准值"和
     * "保存/取消按钮出不出来"，两边用同一个判断才不会打架）。
     * 为 true 时给框加橙黄边框 + 淡橙光晕，提醒"别忘了点保存"；
     * 保存或取消后父组件的判断变回 false，颜色自动恢复。
     */
    dirty?: boolean;
}

/**
 * 【2026-09-29】所见即所得编辑器 + **源码模式开关**。
 *
 * 为什么要这个开关（他问过"能不能像 Obsidian 那样，光标所在处显示 `**粗体**` 源码"）：
 *   Obsidian 的"实时预览"是**在源码上做装饰**（CodeMirror 6，光标进到某个语法片段里
 *   就把标记露出来）。Milkdown/ProseMirror 是**富文本模型**，根本没有"源码层"，
 *   所以"光标处显示标记"这种效果它天然做不到 —— 那不是配置问题，是两种编辑器的模型差异。
 *   真要做到，得换 CodeMirror 6 一整套自己画（工作量数倍，公式/表格/粘贴全要自己接）。
 *
 * 折中：给一个**源码模式**小开关（悬停在编辑区时右上角出现）——
 * 需要看/改原始 md（比如排查转义、手工微调空格）时切过去，改完切回来。
 * 日常书写仍在所见即所得里，这就是他要的"输入感受"。
 */
export function MdEditor({
    value,
    onChange,
    placeholder,
    minHeightPx = 140,
    className = '',
    dirty = false,
}: MdEditorProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    /** 源码模式的 textarea（要按内容"量身高"，见下面的 effect） */
    const sourceRef = useRef<HTMLTextAreaElement | null>(null);
    const instanceRef = useRef<MdEditorInstance | null>(null);
    /** 自己最近一次吐给父组件的 md（回环护栏的锚点） */
    const emittedRef = useRef<string | null>(null);
    const onChangeRef = useRef(onChange);
    /** 父组件最近传进来的 value（异步初始化完成后对账用） */
    const valueRef = useRef(value);
    /** 源码模式：显示原始 md 文本域（不是"编辑态"，只是一个查看/微调的口子） */
    const [sourceMode, setSourceMode] = useState(false);
    /** 【2026-10-01】emoji 候选浮层的状态（由编辑器插件回调，见 createMdEditorInstance） */
    const [picker, setPicker] = useState<EmojiPickerViewState | null>(null);
    /** 浮层状态的**同步副本**：点选是在事件回调里读的，state 可能还是上一帧的 */
    const pickerRef = useRef<EmojiPickerViewState | null>(null);

    // ⚠️ 这两个 ref 的同步必须放在 effect 里：在渲染期写 ref 会被
    //    react-hooks/refs 规则拦下（渲染期有副作用本来也不对）。
    //    第一个 effect 声明在最前 ⇒ 每次渲染后它先跑，下面依赖它的逻辑读到的都是新值。
    useEffect(() => {
        onChangeRef.current = onChange;
        valueRef.current = value;
    }, [onChange, value]);

    useEffect(() => {
        if (sourceMode) return;
        let disposed = false;
        const mountValue = valueRef.current;

        createMdEditorInstance({
            root: containerRef.current as HTMLElement,
            value: mountValue,
            onChange: (md) => {
                emittedRef.current = md;
                onChangeRef.current(md);
            },
            onPickerChange: (next) => {
                pickerRef.current = next;
                setPicker(next);
            },
        })
            .then((instance) => {
                if (disposed) {
                    return instance.destroy();
                }
                instanceRef.current = instance;
                // 异步加载期间父组件可能已换了 value（挂载初值 ≠ 现值才补灌）
                if (valueRef.current !== mountValue) {
                    instance.setMarkdown(valueRef.current);
                }
            })
            .catch((error) => {
                // 起不来不能静默：内容还在父组件 state 里，但用户会以为在编辑一个空框
                console.error('[MdEditor] failed to initialize:', error);
            });

        return () => {
            disposed = true;
            const instance = instanceRef.current;
            instanceRef.current = null;
            if (instance) {
                instance.destroy().catch((error) => console.warn('[MdEditor] destroy failed:', error));
            }
        };
        // （依赖数组：sourceMode 切换时重建 —— 纯 md 模式不需要 ProseMirror 实例）
    }, [sourceMode]);

    // ---- 外部值对账：只有「不是自己刚吐出去的」才回写（防回环，见文件头注释 2） ----
    useEffect(() => {
        if (value === emittedRef.current) return;
        emittedRef.current = value;
        if (sourceMode) return; // 源码模式吃的是同一个 value，不用回写编辑器
        instanceRef.current?.setMarkdown(value);
    }, [value, sourceMode]);

    /**
     * 【2026-09-29】源码框**按内容自动长高**（他实测提的：切到 md 后框变矮、出现滚动条，
     * 想要"一眼看全，不用滚、也不用拖右下角把手"）。
     *
     * 为什么要单独办：`<textarea>` 的高度是**固定值**（这里只有 min-height），内容一长就出滚动条；
     * 而所见即所得那侧 ProseMirror 的高度天然等于内容高度 ⇒ 两边一切换就一高一矮。
     * 做法：先把高度清成 `auto` 再读 `scrollHeight`（不清就只会变高、不会变矮）。
     * 高度写在元素 style 上，CSS 的 min-height 仍然兜底 ⇒ 内容很短时框还是原来那么高。
     *
     * ⚠️ 这属于**浏览器布局行为**：jsdom 里 `scrollHeight` 恒为 0，单测测不到，只能真机看。
     */
    useEffect(() => {
        if (!sourceMode) return;
        const grow = () => {
            const el = sourceRef.current;
            if (!el) return;
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
        };
        grow();
        // 宽度变了 ⇒ 换行位置变了 ⇒ 高度得重算（拖窗口、手机转屏都会碰到）
        window.addEventListener('resize', grow);
        return () => window.removeEventListener('resize', grow);
    }, [sourceMode, value]);

    /**
     * 【2026-10-01】选中 emoji 候选：把 `；；…：：` **整段**换成 emoji 字符。
     * 插入走编辑器事务（`instance.replaceEmojiRange`，见其注释）—— **绝不手改 DOM**。
     */
    const handleEmojiSelect = (item: EmojiIndexItem) => {
        const current = pickerRef.current;
        pickerRef.current = null;
        setPicker(null);
        const instance = instanceRef.current;
        if (!current || !instance) return;
        instance.replaceEmojiRange(current.from, current.to, current.raw, item.c);
    };

    /** 关闭浮层（点面板外 / Esc）：只关面板，**文档一个字都不动** */
    const handleEmojiClose = () => {
        pickerRef.current = null;
        setPicker(null);
        instanceRef.current?.closeEmojiPicker();
    };

    return (
        // `data-dirty` 而不是给框加类：两种模式（所见即所得 / 源码 textarea）的边框
        // 在两个不同元素上，用父级属性选择器一句话就能同时管住，见 globals.css。
        <div className={`md-editor-wrap relative ${className}`} data-dirty={dirty ? 'true' : undefined}>
            {/* 源码模式开关：悬停才显形，不干扰日常书写 */}
            <button
                type="button"
                className="md-editor-src-toggle"
                title={sourceMode ? '回到所见即所得' : '看/改原始 markdown（源码）'}
                onClick={() => setSourceMode((v) => !v)}
            >
                {sourceMode ? '预览' : 'md'}
            </button>

            {sourceMode ? (
                <textarea
                    ref={sourceRef}
                    className="md-editor-source w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                    style={{ minHeight: `${minHeightPx}px` }}
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => {
                        emittedRef.current = e.target.value;
                        onChange(e.target.value);
                    }}
                />
            ) : (
                <div
                    ref={containerRef}
                    data-md-editor
                    className="md-editor rounded-md border bg-background px-3 py-2 text-sm"
                    style={{ minHeight: `${minHeightPx}px` }}
                    data-placeholder={placeholder}
                />
            )}

            {/* emoji 候选浮层：portal 到 body（避开编辑区 overflow 裁剪），源码模式下不显示 */}
            <EmojiPicker
                state={sourceMode ? null : picker}
                onSelect={handleEmojiSelect}
                onClose={handleEmojiClose}
            />
        </div>
    );
}
