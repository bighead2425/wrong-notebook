/**
 * 日积月累卡片 · 结构规范化与体检（2026-10-18）
 *
 * 这些断言钉的不是"AI 写得好不好"（那归提示词），而是**纸面结构**：
 * 标题必须是 `#### `、AI 补充必须是 `> *AI: …*`。
 * 因为纸上一行只有约 16 个汉字的宽度 ⇒ **错一个字符就是破版**，不能靠模型自觉。
 */
import { describe, expect, it } from 'vitest';
import {
    INSIGHT_TITLE_MAX_CHARS,
    inspectInsightNote,
    normalizeInsightMarkdown,
} from '@/lib/insight-note';

const NORMAL = `#### 🧠 分母越大每份越小

- 分子一样时，**分母越大，分数反而越小**。
- 我原来的错：以为分子大就大。

> *AI: 记住"分的人越多，拿到的越少"。*`;

describe('normalizeInsightMarkdown · 结构兜底', () => {
    it('★ 模型写 `###` ⇒ 统一成 `####`', () => {
        const out = normalizeInsightMarkdown('### 🧠 标题\n\n正文');
        expect(out.startsWith('#### 🧠 标题')).toBe(true);
    });

    it('★ 模型用 `#` / `##` 也同样收成 `####`', () => {
        expect(normalizeInsightMarkdown('# 🧠 A')).toMatch(/^#### 🧠 A/);
        expect(normalizeInsightMarkdown('## 🧠 B')).toMatch(/^#### 🧠 B/);
    });

    it('★ 完全没写标题、但第一行很短 ⇒ 把第一行当标题（不编内容）', () => {
        const out = normalizeInsightMarkdown('分母越大每份越小\n\n正文一段');
        expect(out.startsWith('#### ')).toBe(true);
        expect(out).toContain('分母越大每份越小');
    });

    it('★★ 第一行是一大段正文 ⇒ **不许吞掉它**，插一个占位标题', () => {
        const long = '这是一段很长的正文'.repeat(6);
        const out = normalizeInsightMarkdown(`${long}\n\n第二段`);
        expect(out).toContain(long); // 原文一个字都不能少
        expect(out.split('\n')[0]).toMatch(/^#### /);
    });

    it('★ 标题里没有 emoji ⇒ 补一个中性标记（不猜语义）', () => {
        const out = normalizeInsightMarkdown('#### 分母越大每份越小\n\n正文');
        expect(out.split('\n')[0]).toMatch(/^#### 📌 /);
    });

    it('★★ `> **AI**: xxx` ⇒ 统一成 `> *AI: xxx*`', () => {
        const out = normalizeInsightMarkdown('#### 🧠 T\n\n正文\n\n> **AI**: 补充一句');
        expect(out).toContain('> *AI: 补充一句*');
        expect(out).not.toContain('**AI**');
    });

    it('★★ 没带引用符的 `AI: xxx` ⇒ 也补成引用 + 斜体', () => {
        const out = normalizeInsightMarkdown('#### 🧠 T\n\n正文\n\nAI: 补充一句');
        expect(out).toContain('> *AI: 补充一句*');
    });

    it('★ 正文里提到 AI 但不是"行首 AI:" ⇒ 一个字都不改', () => {
        const line = 'AI 也可以帮我检查，但我要自己先想一遍。';
        const out = normalizeInsightMarkdown(`#### 🧠 T\n\n${line}`);
        expect(out).toContain(line);
    });

    it('★ 被 ``` 包起来 ⇒ 脱掉围栏', () => {
        const out = normalizeInsightMarkdown('```markdown\n#### 🧠 T\n\n正文\n```');
        expect(out.startsWith('#### 🧠 T')).toBe(true);
        expect(out).not.toContain('```');
    });

    it('★ 连续空行压成 1 个（纸面行距不能被撑开）', () => {
        const out = normalizeInsightMarkdown('#### 🧠 T\n\n\n\n\n正文');
        expect(out).not.toMatch(/\n{3,}/);
    });

    it('★ 已经合规的卡片 ⇒ 原样通过（幂等）', () => {
        expect(normalizeInsightMarkdown(NORMAL)).toBe(NORMAL);
        expect(normalizeInsightMarkdown(normalizeInsightMarkdown(NORMAL))).toBe(NORMAL);
    });
});

describe('inspectInsightNote · 体检（只报告，不改）', () => {
    it('★ 合规卡片 ⇒ 没有 warning，字数统计对得上', () => {
        const r = inspectInsightNote(NORMAL);
        expect(r.hasTitle).toBe(true);
        expect(r.warnings).toEqual([]);
        expect(r.titleChars).toBeLessThanOrEqual(INSIGHT_TITLE_MAX_CHARS);
    });

    it('★★ 标题超长 ⇒ 给出 warning，但**不擅自截断**（截断会切断一句话）', () => {
        const md = '#### 🧠 这是一个明显超过十二个汉字的标题啊\n\n正文';
        const r = inspectInsightNote(md);
        expect(r.titleChars).toBeGreaterThan(INSIGHT_TITLE_MAX_CHARS);
        expect(r.warnings.some((w) => w.includes('标题'))).toBe(true);
        // 内容没被改
        expect(normalizeInsightMarkdown(md)).toContain('这是一个明显超过十二个汉字的标题啊');
    });

    it('★★ 正文超 120 字 ⇒ warning（同样不硬截）', () => {
        const body = '这一句也算正文内容'.repeat(20);
        const r = inspectInsightNote(`#### 🧠 T\n\n${body}`);
        expect(r.bodyChars).toBeGreaterThan(120);
        expect(r.warnings.some((w) => w.includes('正文'))).toBe(true);
    });

    it('★ 没有 AI 段 ⇒ aiChars = 0（"宁缺勿滥"是允许的）', () => {
        const r = inspectInsightNote('#### 🧠 T\n\n正文');
        expect(r.aiChars).toBe(0);
        expect(r.warnings.some((w) => w.includes('AI'))).toBe(false);
    });

    it('★ emoji 超过 4 个 ⇒ warning（他要求"不花哨"）', () => {
        const r = inspectInsightNote('#### 🧠 T\n\n😀 😀 😀 😀 正文');
        expect(r.emojiCount).toBeGreaterThan(4);
        expect(r.warnings.some((w) => w.includes('emoji'))).toBe(true);
    });
});
