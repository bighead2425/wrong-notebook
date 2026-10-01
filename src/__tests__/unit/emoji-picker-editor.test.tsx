// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { createMdEditorInstance } from '@/components/md-editor';
import type { EmojiPickerViewState } from '@/components/emoji-picker';
import { loadEmojiIndex } from '@/lib/emoji-search';

/**
 * 【2026-10-01】中文 emoji 的**端到端**行为测试（真在 jsdom 里跑一遍 Milkdown）。
 *
 * 纯解析逻辑在 emoji-trigger.test.ts 里钉；这里钉的是只有真编辑器才暴露的东西：
 *   ① 敲完 `；；眼镜：：` 真的会回调出面板状态（且搜索词对）；
 *   ② **选中后整段 `；；…：：` 被替换成 emoji**，且走的是编辑器事务
 *      （证明文档真变了、能导出；红线：绝不手改 DOM）；
 *   ③ 搜不到 / 主动关闭 ⇒ **文档一个字都不动**（用户最在意的那条）；
 *   ④ 粘贴进来的 `；；…：：` **不触发**（否则会吞掉用户粘贴的内容）。
 *
 * ⚠️ 输入法合成态（IME）在 jsdom 里没有，只能真机验（见评估报告第 6 节）。
 */
async function build(initial = '') {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const states: (EmojiPickerViewState | null)[] = [];
    const instance = await createMdEditorInstance({
        root,
        value: initial,
        onChange: () => undefined,
        onPickerChange: (state) => states.push(state),
    });
    const withView = <T,>(fn: (view: EditorView) => T) => instance.editor.action((ctx) => fn(ctx.get(editorViewCtx)));
    /** 模拟"用户打字"：普通事务（不带 paste / addToHistory=false 这类外部标记） */
    const type = (text: string) =>
        withView((view) => {
            const pos = TextSelection.atEnd(view.state.doc).from;
            const tr = view.state.tr.insertText(text, pos);
            tr.setSelection(TextSelection.create(tr.doc, pos + text.length));
            view.dispatch(tr);
        });
    /** 最近一次回调出去的面板状态（没回调过 ⇒ null） */
    const latest = () => states.filter((s): s is EmojiPickerViewState => s !== null).at(-1) ?? null;
    return { instance, states, type, withView, latest };
}

describe('MdEditor · 中文 emoji（`；；眼镜：：` ⇒ 候选浮层）', () => {
    it('★ 敲完 `；；眼镜：：` 弹出候选；选中后整段被替换成 emoji（走事务）', async () => {
        await loadEmojiIndex(); // 预热数据，省得等懒加载
        const { instance, type, latest } = await build('');
        type('；；眼镜：：');

        await vi.waitFor(() => expect(latest()?.query).toBe('眼镜'));
        const state = latest()!;
        expect(state.raw).toBe('；；眼镜：：');
        expect(state.items.some((i) => i.c === '👓')).toBe(true);
        expect(state.from).toBeLessThan(state.to);

        // 选中：把 `；；眼镜：：` **整段**换成 emoji
        instance.replaceEmojiRange(state.from, state.to, state.raw, '👓');
        expect(instance.getMarkdown().trim()).toBe('👓');
        expect(instance.getMarkdown()).not.toContain('；；');
    });

    it('半角 `;;眼镜::` 也认（手机输入法更容易打成半角）', async () => {
        await loadEmojiIndex();
        const { type, latest } = await build('');
        type(';;眼镜::');
        await vi.waitFor(() => expect(latest()?.query).toBe('眼镜'));
        expect(latest()!.items.some((i) => i.c === '👓')).toBe(true);
    });

    it('★ 搜不到 ⇒ 不弹面板，且文档一个字都不动', async () => {
        await loadEmojiIndex();
        const { instance, type, latest } = await build('');
        type('；；这个词肯定搜不到xyz：：');
        await new Promise((r) => setTimeout(r, 30));
        expect(latest()).toBeNull();
        // 宁可"没反应"，绝不吞掉用户打的字
        expect(instance.getMarkdown()).toContain('；；这个词肯定搜不到xyz：：');
    });

    it('★ 弹出来后主动关闭（Esc / 点别处）⇒ 文档一个字都不动', async () => {
        await loadEmojiIndex();
        const { instance, type, latest } = await build('');
        type('；；眼镜：：');
        await vi.waitFor(() => expect(latest()).not.toBeNull());
        instance.closeEmojiPicker();
        expect(instance.getMarkdown()).toContain('；；眼镜：：');
    });

    it('★ 粘贴进来的 `；；眼镜：：` 不触发（绝不吞粘贴内容）', async () => {
        await loadEmojiIndex();
        const { instance, withView, latest } = await build('');
        withView((view) => {
            const pos = TextSelection.atEnd(view.state.doc).from;
            view.dispatch(
                view.state.tr.insertText('；；眼镜：：', pos).setMeta('paste', true),
            );
        });
        await new Promise((r) => setTimeout(r, 30));
        expect(latest()).toBeNull();
        expect(instance.getMarkdown()).toContain('；；眼镜：：');
    });
});
