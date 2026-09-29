"use client";

/**
 * 【2026-09-29】Markdown **所见即所得**编辑器（两处共用：详情页各节 + AI 校对页）。
 *
 * 选型 = Milkdown（他拍板）。核心理由只有一条：
 *   **数据库里存的是纯 md 源**，被打印流水线 / Obsidian 导出 / 净版 OCR 共用 ——
 *   Milkdown 内部就是 remark 引擎，「md 进、md 出」，保存不洗原文；
 *   TipTap 那类富文本优先的编辑器会把内容转成富文本再序列化，往返有损耗。
 *
 * 三个工程要点（都踩过或查证过，别删）：
 *   1. **Milkdown 只在浏览器加载**：用 effect 里的动态 import（`await import(...)`），
 *      模块顶层绝不 import 它 —— Next 的 SSR 预渲染阶段会执行客户端组件的模块体，
 *      ProseMirror 在 Node 里摸 DOM 就炸了。类型用 `import type`（会被擦除，安全）。
 *   2. **受控回环**：编辑器 onChange → 父组件 value → 本组件 [value] effect。
 *      用 `emittedRef` 记住「自己刚吐出去的 md」：值来自自己就跳过回写，
 *      否则「编辑器吐 md → 父 setState → effect 又往编辑器灌」死循环 /
 *      光标乱跳。父组件主动换值（取消编辑、切题）时才真正回写。
 *   3. **`==高亮==` 是自写扩展**（见 lib/markdown-plugins.ts 的 remarkHighlightStrict）：
 *      Milkdown 没有这个语法；不写的话高亮会显示成字面 `==`， Worse ——
 *      借用渲染端那个 emphasis 版会把它洗成斜体。
 */

import { useEffect, useRef } from 'react';
import type { Editor } from '@milkdown/kit/core';
// 样式：ProseMirror 的基础排版（contenteditable 行为），静态导入没问题；
// 正文排版复用全局的 .markdown-content（挂在编辑器根节点上，见下）。
import '@milkdown/kit/prose/view/style/prosemirror.css';
// `==高亮==` 的编辑器侧 remark 插件（严格版：独立节点，不借用 emphasis —— 见其文件头）
import { remarkHighlightStrict } from '@/lib/markdown-plugins';
import type { RemarkPluginRaw } from '@milkdown/kit/transformer';

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

export function MdEditor({ value, onChange, placeholder, minHeightPx = 140, className = '' }: MdEditorProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<Editor | null>(null);
    /** 自己最近一次吐给父组件的 md（回环护栏的锚点） */
    const emittedRef = useRef<string | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    /** 父组件最近传进来的 value（异步初始化完成后对账用） */
    const valueRef = useRef(value);
    valueRef.current = value;
    /** 父组件主动换值时的回写函数（编辑器异步创建完成后才有） */
    const syncRef = useRef<((next: string) => void) | null>(null);

    // ---- 创建编辑器（只在挂载时一次；Milkdown 动态加载，SSR 不碰它） ----
    useEffect(() => {
        let disposed = false;
        /** 挂载瞬间的初值（defaultValueCtx 用的就是它） */
        const mountValue = valueRef.current;

        (async () => {
            const [
                { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, parserCtx, editorViewCtx },
                { commonmark },
                { gfm },
                { listener, listenerCtx },
                { history },
                { $markAttr, $markSchema, $remark, $inputRule },
                { markRule },
                { math },
            ] = await Promise.all([
                import('@milkdown/kit/core'),
                import('@milkdown/kit/preset/commonmark'),
                import('@milkdown/kit/preset/gfm'),
                import('@milkdown/kit/plugin/listener'),
                import('@milkdown/kit/plugin/history'),
                import('@milkdown/kit/utils'),
                import('@milkdown/kit/prose'),
                import('@milkdown/plugin-math'),
            ]);

            if (disposed || !containerRef.current) return;

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
            const highlightInput = $inputRule((ctx) => {
                return markRule(/(?<![\w:/])==([^=\n]+?)==(?!==)/, highlightSchema.type(ctx));
            });

            const editor = Editor.make()
                .config((ctx) => {
                    ctx.set(rootCtx, containerRef.current);
                    ctx.set(defaultValueCtx, valueRef.current);
                    ctx.update(editorViewOptionsCtx, (prev) => ({
                        ...prev,
                        attributes: {
                            ...prev.attributes,
                            class: 'milkdown-host markdown-content',
                            spellcheck: 'false',
                        },
                    }));
                    // 编辑 → 吐 md 给父组件（父组件保存的就是这个字符串）
                    ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
                        emittedRef.current = markdown;
                        onChangeRef.current(markdown);
                    });
                })
                .use(commonmark)
                .use(gfm)
                .use(listener)
                .use(history)
                .use(math)
                .use(highlightAttr)
                .use(highlightSchema)
                .use(highlightRemark)
                .use(highlightInput);

            const created = await editor.create();
            if (disposed) {
                await created.destroy();
                return;
            }
            editorRef.current = created;

            /** 父组件主动换值（取消/切题）：整篇替换编辑器内容，不进撤销栈 */
            const syncExternal = (next: string) => {
                created.action((ctx) => {
                    const doc = ctx.get(parserCtx)(next);
                    if (!doc) return;
                    const view = ctx.get(editorViewCtx);
                    view.dispatch(
                        view.state.tr
                            .replaceWith(0, view.state.doc.content.size, doc)
                            .setMeta('addToHistory', false),
                    );
                });
            };
            syncRef.current = syncExternal;

            // 初始化对账：异步加载期间父组件可能已换了 value（挂载时的初值 ≠ 现值才补灌）
            if (valueRef.current !== mountValue) {
                syncExternal(valueRef.current);
            }
        })().catch((error) => {
            // 编辑器起不来不能静默：内容还在父组件 state 里，但用户会以为在编辑一个空框
            console.error('[MdEditor] failed to initialize:', error);
        });

        return () => {
            disposed = true;
            syncRef.current = null;
            const editor = editorRef.current;
            editorRef.current = null;
            if (editor) {
                editor
                    .destroy()
                    .catch((error) => console.warn('[MdEditor] destroy failed:', error));
            }
        };
        // （依赖数组留空：编辑器只建一次；value 的回写走上面的对账 effect）
    }, []);

    // ---- 外部值对账：只有「不是自己刚吐出去的」才回写（防回环，见文件头注释 2） ----
    useEffect(() => {
        if (value === emittedRef.current) return;
        emittedRef.current = value;
        syncRef.current?.(value);
    }, [value]);

    return (
        <div
            ref={containerRef}
            data-md-editor
            className={`md-editor rounded-md border bg-background px-3 py-2 text-sm ${className}`}
            style={{ minHeight: `${minHeightPx}px` }}
            data-placeholder={placeholder}
        />
    );
}
