// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来（jsdom worker 会因内存超时）。
import { describe, expect, it } from 'vitest';
import {
    compactDateKey,
    expandDateKey,
    formatInsightCode,
    isInsightCode,
    nextInsightSeq,
    parseInsightCode,
} from '@/lib/insight-code';

/**
 * 日积月累的编号：`JL` + `yyyymmdd` + 三位当日流水（他定的规则，例 `JL20260930001`）。
 *
 * 钉住三件事：
 *   ① 编号长什么样（日期段 + 001 起的流水）；
 *   ② 流水号怎么发（这个日期段里已用掉的最大号 + 1）；
 *   ③ 认得出 / 拆得开（将来扫码或搜索要按编号反查）。
 */
describe('日积月累 · 编号', () => {
    it('★ 他给的格式：JL + 8 位日期 + 3 位流水', () => {
        expect(formatInsightCode('2026-09-30', 1)).toBe('JL20260930001');
        expect(formatInsightCode('2026-09-30', 12)).toBe('JL20260930012');
        expect(formatInsightCode('2026-01-05', 7)).toBe('JL20260105007');
    });

    it('流水号补零到三位；超过 999 **不截断**（宁可编号变长，也不重号）', () => {
        expect(formatInsightCode('2026-09-30', 99)).toBe('JL20260930099');
        expect(formatInsightCode('2026-09-30', 999)).toBe('JL20260930999');
        expect(formatInsightCode('2026-09-30', 1000)).toBe('JL202609301000');
    });

    it('日期段压缩 / 还原（编号里是 yyyymmdd，库里存 YYYY-MM-DD）', () => {
        expect(compactDateKey('2026-09-30')).toBe('20260930');
        expect(expandDateKey('20260930')).toBe('2026-09-30');
        expect(expandDateKey('2026-9-30')).toBe(''); // 不合法就不猜
    });

    it('下一个流水号：空 ⇒ 001；有 ⇒ 最大号 + 1', () => {
        expect(nextInsightSeq(null)).toBe(1);
        expect(nextInsightSeq(undefined)).toBe(1);
        expect(nextInsightSeq(0)).toBe(1);
        expect(nextInsightSeq(1)).toBe(2);
        expect(nextInsightSeq(37)).toBe(38);
    });

    it('同一天连着建：001、002、003', () => {
        let max: number | null = null;
        const codes: string[] = [];
        for (let i = 0; i < 3; i += 1) {
            const seq = nextInsightSeq(max);
            codes.push(formatInsightCode('2026-09-30', seq));
            max = seq;
        }
        expect(codes).toEqual(['JL20260930001', 'JL20260930002', 'JL20260930003']);
    });

    it('认得出、拆得开（将来按编号反查要用）', () => {
        expect(parseInsightCode('JL20260930001')).toEqual({ dateKey: '2026-09-30', seq: 1 });
        expect(parseInsightCode(' jl20260930042 ')).toEqual({ dateKey: '2026-09-30', seq: 42 });
        expect(parseInsightCode('JL202609301000')).toEqual({ dateKey: '2026-09-30', seq: 1000 });
    });

    it('不是这个格式的一律返回 null，绝不硬猜', () => {
        for (const bad of ['', 'JL', 'SX20260930001', 'JL2026093', 'JL2026-09-30001', null, 123]) {
            expect(parseInsightCode(bad)).toBeNull();
            expect(isInsightCode(bad)).toBe(false);
        }
        expect(isInsightCode('JL20260930001')).toBe(true);
    });
});
