import { describe, it, expect } from 'vitest';
import { summarize, compare } from '../../../scripts/lint-baseline.mjs';

/**
 * lint 基线门禁的单测（波 0）
 *
 * 这组测试护的是一条纪律线：**债只许降、不许涨**。
 * 它自己出错的代价很具体——要么把新债放进仓库（门禁失灵），
 * 要么把正常改动误判成违约（用噪声卡住开发）。两种都是"不报错只降级"的典型，
 * 所以这里把判定逻辑钉死。
 */

/** 造一份最小可用的 eslint JSON 报告 */
function report(entries: Array<{ file?: string; severity: 1 | 2; ruleId?: string | null }>) {
    const byFile = new Map<string, { filePath: string; messages: unknown[] }>();
    for (const e of entries) {
        const filePath = e.file ?? 'src/demo.ts';
        if (!byFile.has(filePath)) byFile.set(filePath, { filePath, messages: [] });
        byFile.get(filePath)!.messages.push({ severity: e.severity, ruleId: e.ruleId ?? null });
    }
    return [...byFile.values()];
}

describe('summarize', () => {
    it('按 severity 分别统计 error 与 warning', () => {
        const s = summarize(
            report([
                { severity: 2, ruleId: 'no-explicit-any' },
                { severity: 2, ruleId: 'no-explicit-any' },
                { severity: 1, ruleId: 'no-unused-vars' },
            ])
        );
        expect(s.errors).toBe(2);
        expect(s.warnings).toBe(1);
    });

    it('按「严重度:规则名」归类，便于排查主要来源', () => {
        const s = summarize(
            report([
                { severity: 2, ruleId: 'no-explicit-any' },
                { severity: 1, ruleId: 'no-explicit-any' },
            ])
        );
        expect(s.byRule.get('error:no-explicit-any')).toBe(1);
        expect(s.byRule.get('warning:no-explicit-any')).toBe(1);
    });

    it('空报告返回 0/0', () => {
        expect(summarize([])).toMatchObject({ errors: 0, warnings: 0 });
    });

    it('ruleId 缺失（解析失败）归到 (parse)，且不抛异常', () => {
        const s = summarize(report([{ severity: 2, ruleId: null }]));
        expect(s.errors).toBe(1);
        expect(s.byRule.get('error:(parse)')).toBe(1);
    });

    it('某文件的 messages 字段缺失时按空处理，不让整条门禁崩掉', () => {
        const s = summarize([{ filePath: 'src/demo.ts' } as never]);
        expect(s).toMatchObject({ errors: 0, warnings: 0 });
    });
});

describe('compare', () => {
    const baseline = { errors: 189, warnings: 88 };

    it('error 持平 ⇒ 通过（存量欠账不阻塞）', () => {
        expect(compare(baseline, { errors: 189, warnings: 88 }).ok).toBe(true);
    });

    it('error 减少 ⇒ 通过，并提示可以收紧基线', () => {
        const r = compare(baseline, { errors: 180, warnings: 88 });
        expect(r.ok).toBe(true);
        expect(r.improvements.join()).toContain('189 → 180');
    });

    it('error 增加 ⇒ 失败，并说清涨了几条', () => {
        const r = compare(baseline, { errors: 191, warnings: 88 });
        expect(r.ok).toBe(false);
        expect(r.regressions.join()).toContain('新增 2 条');
    });

    it('增加 1 条就失败 —— 这是门禁的全部意义所在', () => {
        expect(compare(baseline, { errors: 190, warnings: 88 }).ok).toBe(false);
    });

    it('warning 上涨不影响门禁（避免用噪声卡住调试期的未用变量）', () => {
        const r = compare(baseline, { errors: 189, warnings: 95 });
        expect(r.ok).toBe(true);
    });

    it('warning 下降也不误报为回归', () => {
        const r = compare(baseline, { errors: 189, warnings: 80 });
        expect(r.ok).toBe(true);
        expect(r.regressions).toHaveLength(0);
    });
});
