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
 */

import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@milkdown/kit/core';
// 样式：ProseMirror 的基础排版（contenteditable 行为），静态导入没问题；
// 正文排版复用全局的 .markdown-content（挂在编辑器根节点上，见下）。
import '@milkdown/kit/prose/view/style/prosemirror.css';
// `==高亮==` 的编辑器侧 remark 插件（严格版：独立节点，不借用 emphasis —— 见其文件头）
import { remarkHighlightStrict } from '@/lib/markdown-plugins';
import type { RemarkPluginRaw } from '@milkdown/kit/transformer';

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
}): Promise<MdEditorInstance> {
    const { root, value, onChange } = opts;

    const [
        { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, parserCtx, editorViewCtx },
        { commonmark, remarkPreserveEmptyLinePlugin },
        { gfm },
        { listener, listenerCtx },
        { history },
        { $markAttr, $markSchema, $remark, $inputRule, $prose, getMarkdown },
        { markRule },
        { Plugin: ProsePlugin },
        { math, mathInlineSchema },
    ] = await Promise.all([
        import('@milkdown/kit/core'),
        import('@milkdown/kit/preset/commonmark'),
        import('@milkdown/kit/preset/gfm'),
        import('@milkdown/kit/plugin/listener'),
        import('@milkdown/kit/plugin/history'),
        import('@milkdown/kit/utils'),
        import('@milkdown/kit/prose'),
        import('@milkdown/kit/prose/state'),
        import('@milkdown/plugin-math'),
    ]);

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

    /**
     * 【2026-09-29】把**文本形态**的 `$公式$` 换成真正的数学节点（粘贴场景的救命稻草）。
     *
     * 判定与渲染端（remark-math）**同一口径**：开头 `$` 后不能是空白、结尾 `$` 前不能是空白
     *  —— 这样「价格 $5 到 $10」这类普通文字不会被误当成公式。
     * 手敲的 `$x$` 由 math 插件自带的输入规则先接管，这里不会重复劳动。
     */
    const mathFromText = $prose((ctx) => {
        const mathType = mathInlineSchema.type(ctx);
        const pair = /\$(?=\S)([^$\n]+?)(?<=\S)\$/g;
        return new ProsePlugin({
            appendTransaction(trs, _old, next) {
                // 正常取 docChanged；另有"初始化归一化"的显式 meta（见下面的 dispatch）
                if (!trs.some((tr) => tr.docChanged || tr.getMeta(NORMALIZE_MATH_META))) return null;
                // 先收集全部命中（边遍历边改会打乱位置），再从后往前替换
                const hits: { from: number; to: number; value: string }[] = [];
                next.doc.descendants((node, pos) => {
                    if (!node.isText || !node.text || !node.text.includes('$')) return true;
                    pair.lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = pair.exec(node.text)) !== null) {
                        hits.push({ from: pos + m.index, to: pos + m.index + m[0].length, value: m[1] });
                    }
                    return true;
                });
                if (hits.length === 0) return null;
                const tr = next.tr;
                const schema = next.doc.type.schema;
                for (const hit of hits.reverse()) {
                    // ⚠️ 数学节点的公式源是**文本内容**（schema: content 'text*'），
                    //    不是 attr —— 传 { value } 会建出一个空公式（导出成 `$$`，他实测会变这样）。
                    tr.replaceWith(hit.from, hit.to, mathType.create(null, schema.text(hit.value)));
                }
                return tr.setMeta('addToHistory', false);
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
        .use(math)
        .use(mathFromText)
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
export function MdEditor({ value, onChange, placeholder, minHeightPx = 140, className = '' }: MdEditorProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const instanceRef = useRef<MdEditorInstance | null>(null);
    /** 自己最近一次吐给父组件的 md（回环护栏的锚点） */
    const emittedRef = useRef<string | null>(null);
    const onChangeRef = useRef(onChange);
    /** 父组件最近传进来的 value（异步初始化完成后对账用） */
    const valueRef = useRef(value);
    /** 源码模式：显示原始 md 文本域（不是"编辑态"，只是一个查看/微调的口子） */
    const [sourceMode, setSourceMode] = useState(false);

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

    return (
        <div className={`md-editor-wrap relative ${className}`}>
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
        </div>
    );
}
