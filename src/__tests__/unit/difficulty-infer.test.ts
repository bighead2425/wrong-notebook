import { describe, it, expect } from 'vitest';
import { inferFromOutcomes } from '@/lib/difficulty-infer';

/**
 * 【2026-10-30】难度推断的判据。
 *
 * 入参是**按时间倒序**的结果序列（最新在前）——顺序搞反，所有结论都会反过来，
 * 所以这里第一组用例专门钉"顺序语义"。
 */
describe('难度推断 · 只看结果序列', () => {
    describe('顺序语义（错了会全盘反过来）', () => {
        it('["right","wrong"] = 先错后对 ⇒ 吃力（高置信）', () => {
            const r = inferFromOutcomes(['right', 'wrong']);
            expect(r).toEqual({ level: 'hard', confidence: 'high', evidence: ['错过之后做对了'] });
        });

        it('["wrong","right"] = 先对后错 ⇒ 吃力（中置信，不是"不会"）', () => {
            const r = inferFromOutcomes(['wrong', 'right']);
            expect(r?.level).toBe('hard');
            expect(r?.confidence).toBe('medium');
        });
    });

    it('没有任何记录 ⇒ null（刚录入 ≠ 不会）', () => {
        expect(inferFromOutcomes([])).toBeNull();
    });

    it('连续错 2 次 ⇒ 不会（高置信）', () => {
        const r = inferFromOutcomes(['wrong', 'wrong', 'right']);
        expect(r?.level).toBe('fail');
        expect(r?.confidence).toBe('high');
        expect(r?.evidence[0]).toContain('2');
    });

    it('连续错 3 次 ⇒ 不会，证据里是 3', () => {
        const r = inferFromOutcomes(['wrong', 'wrong', 'wrong']);
        expect(r?.level).toBe('fail');
        expect(r?.evidence[0]).toContain('3');
    });

    it('只错 1 次 ⇒ 吃力，不下"不会"的结论', () => {
        const r = inferFromOutcomes(['wrong']);
        expect(r?.level).toBe('hard');
        expect(r?.confidence).toBe('medium');
    });

    it('第一次就做对 ⇒ 轻松（中置信）', () => {
        const r = inferFromOutcomes(['right']);
        expect(r?.level).toBe('easy');
        expect(r?.confidence).toBe('medium');
    });

    it('连对多次 ⇒ 仍是轻松', () => {
        expect(inferFromOutcomes(['right', 'right', 'right'])?.level).toBe('easy');
    });

    it('连续错被一次对打断 ⇒ 不算连续（降为吃力）', () => {
        const r = inferFromOutcomes(['right', 'wrong', 'wrong']);
        expect(r?.level).toBe('hard');
    });
});
