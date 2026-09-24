import { describe, expect, it } from 'vitest';
import {
    buildPrintInstanceCode,
    isPrintSide,
    isValidQuestionNo,
    oppositeSide,
    parsePrintInstanceCode,
} from '@/lib/print-instance';

describe('打印实例码（二维码内容，P25.1 三层）', () => {
    it('应该组装出 <题号>-R<实例>-<面> 的格式', () => {
        expect(buildPrintInstanceCode('SX20260916001', 1, 'F')).toBe('SX20260916001-R1-F');
        expect(buildPrintInstanceCode('SX20260916001', 2, 'B')).toBe('SX20260916001-R2-B');
    });

    it('题号应统一大写并去掉首尾空白（P10：全链路统一大写）', () => {
        expect(buildPrintInstanceCode(' sx20260916001 ', 3, 'F')).toBe('SX20260916001-R3-F');
    });

    it('组装与解析必须严格往返一致', () => {
        const cases = [
            { q: 'SX20260916001', n: 1, s: 'F' as const },
            { q: 'YW20260101999', n: 21, s: 'B' as const },
            { q: 'OT20261231001', n: 100, s: 'F' as const },
        ];

        for (const c of cases) {
            const code = buildPrintInstanceCode(c.q, c.n, c.s);
            expect(parsePrintInstanceCode(code)).toEqual({
                questionNo: c.q,
                instanceNo: c.n,
                side: c.s,
            });
        }
    });

    it('非法题号不应产出坏码，而应直接报错', () => {
        expect(() => buildPrintInstanceCode('SX2026', 1, 'F')).toThrow();
        expect(() => buildPrintInstanceCode('', 1, 'F')).toThrow();
        expect(() => buildPrintInstanceCode('SX2026091600', 1, 'F')).toThrow();
    });

    it('实例号必须是大于等于 1 的整数', () => {
        expect(() => buildPrintInstanceCode('SX20260916001', 0, 'F')).toThrow();
        expect(() => buildPrintInstanceCode('SX20260916001', -1, 'F')).toThrow();
        expect(() => buildPrintInstanceCode('SX20260916001', 1.5, 'F')).toThrow();
        expect(() => buildPrintInstanceCode('SX20260916001', Number.NaN, 'F')).toThrow();
    });

    it('解析读不出的输入应返回 null，而不是猜一个编号出来', () => {
        expect(parsePrintInstanceCode('')).toBeNull();
        expect(parsePrintInstanceCode(null)).toBeNull();
        expect(parsePrintInstanceCode(undefined)).toBeNull();
        expect(parsePrintInstanceCode(12345)).toBeNull();
        // 旧版二维码里只有题号，没有实例层
        expect(parsePrintInstanceCode('SX20260916001')).toBeNull();
        // 实例号不能是 0
        expect(parsePrintInstanceCode('SX20260916001-R0-F')).toBeNull();
        // 面只认 F / B
        expect(parsePrintInstanceCode('SX20260916001-R1-X')).toBeNull();
        expect(parsePrintInstanceCode('SX20260916001-R1-F-extra')).toBeNull();
        expect(parsePrintInstanceCode('随手涂的字')).toBeNull();
    });

    it('解析应容忍大小写与首尾空白（扫描端拿到的字符串不可控）', () => {
        expect(parsePrintInstanceCode(' sx20260916001-r2-b ')).toEqual({
            questionNo: 'SX20260916001',
            instanceNo: 2,
            side: 'B',
        });
    });

    it('同一张纸的另一面应当可推导（配对与"只扫到一面"兜底的判据）', () => {
        expect(oppositeSide('F')).toBe('B');
        expect(oppositeSide('B')).toBe('F');
    });

    it('题号与面各有自己的合法性判定', () => {
        expect(isValidQuestionNo('SX20260916001')).toBe(true);
        expect(isValidQuestionNo('sx20260916001')).toBe(false);
        expect(isValidQuestionNo('SX2026091600')).toBe(false);
        expect(isPrintSide('F')).toBe(true);
        expect(isPrintSide('B')).toBe(true);
        expect(isPrintSide('f')).toBe(false);
        expect(isPrintSide('FB')).toBe(false);
    });
});
