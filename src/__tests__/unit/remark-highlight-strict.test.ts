// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { remark } from 'remark';
import { remarkHighlightStrict } from '@/lib/markdown-plugins';

/**
 * 严格版 `==高亮==`（编辑器用，2026-09-29）。
 *
 * ⚠️ 这组测试守住的是一条铁律：**编辑器存回的内容不许被洗**。
 * 渲染端的旧插件把高亮"借用" emphasis 节点 —— 那个形态给编辑器用的话，
 * Milkdown 序列化时会把它写回 `*x*`（高亮变斜体），原文静默被改。
 * 严格版用独立的 highlight 节点，parse/stringify 双向都要保真。
 */
describe('remarkHighlightStrict · md 往返保真', () => {
    /** 交给编辑器 remark 引擎跑一趟（parse → stringify） */
    const roundTrip = (md: string) =>
        remark().use(remarkHighlightStrict).processSync(md).toString().trimEnd();

    it('==高亮== 进出都是 ==高亮==，不变形不变斜体', () => {
        expect(roundTrip('这个数==最小是 10.09==。')).toBe('这个数==最小是 10.09==。');
    });

    it('一段里混排：普通文字、粗体、高亮各归各位', () => {
        const src = '**验证：** 1米 = 100厘米，==等式成立==！';
        const out = roundTrip(src);
        expect(out).toContain('**验证：**');
        expect(out).toContain('==等式成立==');
        // ⚠️ 高亮绝不许被写成 *斜体*（那是旧实现的静默洗稿）
        expect(out).not.toMatch(/\*等式成立\*/);
    });

    it('公式与代码块里的 == 不受影响（LaTeX 常有连等号）', () => {
        const src = '$a == b$ 与\n\n```\nx == y\n```';
        const out = roundTrip(src);
        expect(out).toContain('$a == b$');
        expect(out).toContain('x == y');
        expect(out).not.toContain('<mark');
    });

    it('不含 == 的内容原样通过（不添乱）', () => {
        expect(roundTrip('# 标题\n\n正文一段。')).toBe('# 标题\n\n正文一段。');
    });

    it('单独一个 = 或不成对的 == 不触发（避免把算式吃进高亮）', () => {
        const src = '1米 = 100厘米';
        expect(roundTrip(src)).toBe('1米 = 100厘米');
        expect(roundTrip('开头有 == 但没有结尾')).toBe('开头有 == 但没有结尾');
    });
});
