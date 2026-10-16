/**
 * 【2026-10-16 如如】新形状 `{recent:[…]}` 的看门测试。
 *
 * 三件最要紧的事，各配一条测试：
 *  ① ★★ **老形状的展开规则必须与 `reviewEventSequence()` 逐条一致** ——
 *     这是 `docs\18` §2.3 写死的**验收点**（"迁移后读出来的序列与迁移前一致"）。
 *     两个实现放在一起对撞，比各自单测更能拦住"改了一边忘了另一边"。
 *  ② **新旧形状都要认**（过渡期），且**绝不猜结果**（垃圾值 ⇒ 空，不是灰圈以外的东西）。
 *  ③ 超过 4 条时**取末尾 4 条**（末尾才是最近几次）。
 */

import { describe, expect, it } from 'vitest';
import {
    RECENT_REVIEW_LIMIT,
    appendRecentOutcome,
    deriveRecentFromEvents,
    isLegacyReviewOutcomes,
    legacyOutcomesToRecent,
    normalizeRecentOutcomes,
    serializeRecentOutcomes,
    PLANNED_REVIEW_ROUNDS,
} from '@/lib/review-outcomes';
import { reviewEventSequence } from '@/lib/review-status';

describe('复习结果 · 形状判定', () => {
    it('老形状（`{planned,last}`）认得出来 —— 对象与 JSON 串两种写法都认', () => {
        const legacy = { planned: ['right', null, null, null], last: 'right' };
        expect(isLegacyReviewOutcomes(legacy)).toBe(true);
        expect(isLegacyReviewOutcomes(JSON.stringify(legacy))).toBe(true);
        // 只要有一个键就算是老形状（老数据可能缺 last）
        expect(isLegacyReviewOutcomes({ planned: [] })).toBe(true);
        expect(isLegacyReviewOutcomes({ last: 'wrong' })).toBe(true);
    });

    it('新形状不是老形状；垃圾值也不是（`recent` 优先）', () => {
        expect(isLegacyReviewOutcomes({ recent: ['right'] })).toBe(false);
        expect(isLegacyReviewOutcomes(null)).toBe(false);
        expect(isLegacyReviewOutcomes('')).toBe(false);
        expect(isLegacyReviewOutcomes('{ 坏 json')).toBe(false);
        expect(isLegacyReviewOutcomes([1, 2, 3])).toBe(false);
    });
});

describe('复习结果 · 老形状的展开（★ 与 reviewEventSequence 对撞）', () => {
    /** 一批有代表性的老形状（含 3 格时代的、全空的、last 与末条相同的） */
    const LEGACY_CASES: unknown[] = [
        { planned: ['right', 'wrong', null, null], last: 'right' }, // 规格 §2.3 那个例子
        { planned: ['right', 'right', 'right', null], last: 'right' }, // last 与末条相同 ⇒ 不该多一条
        { planned: ['wrong', 'wrong', 'wrong', null], last: 'wrong' },
        { planned: [null, null, null, null], last: 'wrong' }, // 计划外的一次
        { planned: [null, null, null, null], last: null }, // 什么都没有
        { planned: ['right', null, null, null], last: null }, // 只落了第 1 格（老规矩会把 last 同步，但老数据未必）
        { planned: ['wrong', 'right'], last: 'wrong' }, // 3 格时代的老数据（长度 3）
        { planned: ['right', 'right', 'right', 'wrong'], last: 'wrong' },
        '{"planned":["right","wrong",null,null],"last":"right"}', // JSON 串形式
    ];

    it('★★ 逐条与 `reviewEventSequence()` 完全一致（这是验收点，不是巧合）', () => {
        for (const legacy of LEGACY_CASES) {
            expect(legacyOutcomesToRecent(legacy)).toEqual(reviewEventSequence(legacy));
        }
    });

    it('★★ **读源已切换**：`reviewEventSequence()` 现在直接读新形状（这条钉住切换本身）', () => {
        // ⚠️ 上面那条"对撞"只证明两个实现**互相一致**，不能证明序列真的读了新形状
        //    （两边都退回老实现的话，对撞照样过）⇒ 必须有这一条显式断言。
        expect(reviewEventSequence({ recent: ['wrong', 'right'] })).toEqual(['wrong', 'right']);
        // 老形状仍然读得出来（过渡期）
        expect(reviewEventSequence({ planned: ['wrong', 'right', null, null], last: 'right' })).toEqual([
            'wrong',
            'right',
        ]);
    });

    it('★ 规格里那个例子：`[right,wrong,null,null] + last=right` ⇒ `[right,wrong,right]`', () => {
        expect(legacyOutcomesToRecent({ planned: ['right', 'wrong', null, null], last: 'right' })).toEqual([
            'right',
            'wrong',
            'right',
        ]);
    });

    it('三条全对 + last=对 ⇒ 只有三条（不会凭空多出第四条）', () => {
        expect(
            legacyOutcomesToRecent({ planned: ['right', 'right', 'right', null], last: 'right' }),
        ).toEqual(['right', 'right', 'right']);
    });

    it('计划格全空、只有 last ⇒ 就是那一条', () => {
        expect(legacyOutcomesToRecent({ planned: [null, null, null, null], last: 'wrong' })).toEqual(['wrong']);
    });
});

describe('复习结果 · 归一化（新旧都认）', () => {
    it('新形状原样返回（正序不动）', () => {
        expect(normalizeRecentOutcomes({ recent: ['wrong', 'right', 'right', 'right'] })).toEqual([
            'wrong',
            'right',
            'right',
            'right',
        ]);
    });

    it('★ 超过 4 条 ⇒ 取**末尾** 4 条（末尾才是最近几次）', () => {
        const six = { recent: ['right', 'wrong', 'right', 'wrong', 'right', 'right'] };
        expect(normalizeRecentOutcomes(six)).toEqual(['right', 'wrong', 'right', 'right']);
    });

    it('★ 非法值被丢掉，不猜（不许把 `null` 当成"错"之类）', () => {
        expect(normalizeRecentOutcomes({ recent: ['right', null, 'nope', 'wrong', 7] })).toEqual(['right', 'wrong']);
    });

    it('空数组 = 没录过；垃圾输入也一律当"没录过"', () => {
        expect(normalizeRecentOutcomes({ recent: [] })).toEqual([]);
        expect(normalizeRecentOutcomes(null)).toEqual([]);
        expect(normalizeRecentOutcomes(undefined)).toEqual([]);
        expect(normalizeRecentOutcomes('')).toEqual([]);
        expect(normalizeRecentOutcomes('{ 坏 json')).toEqual([]);
        expect(normalizeRecentOutcomes({})).toEqual([]);
        expect(normalizeRecentOutcomes('[]')).toEqual([]);
    });

    it('老形状从这条路进来也能读（过渡期最关键的一条）', () => {
        expect(normalizeRecentOutcomes({ planned: ['right', 'wrong', null, null], last: 'right' })).toEqual([
            'right',
            'wrong',
            'right',
        ]);
    });
});

describe('复习结果 · 追加与序列化', () => {
    it('★ 追加到**末尾**（末尾 = 最近一次）', () => {
        expect(appendRecentOutcome(['right'], 'wrong')).toEqual(['right', 'wrong']);
    });

    it('★ 追加后裁到 4 条 —— 顶掉的是**最老**那条', () => {
        const four = ['right', 'right', 'wrong', 'wrong'];
        expect(appendRecentOutcome(four, 'right')).toEqual(['right', 'wrong', 'wrong', 'right']);
        expect(appendRecentOutcome(four, 'right')).toHaveLength(RECENT_REVIEW_LIMIT);
    });

    it('★ 序列化出来的形状带 `recent` 键，且能原样读回来（round-trip）', () => {
        const json = serializeRecentOutcomes(['right', 'wrong']);
        expect(JSON.parse(json)).toEqual({ recent: ['right', 'wrong'] });
        expect(normalizeRecentOutcomes(json)).toEqual(['right', 'wrong']);
    });

    it('序列化也裁到 4 条（免得有人绕过追加直接塞 6 条）', () => {
        const json = serializeRecentOutcomes(['right', 'wrong', 'right', 'wrong', 'right', 'right']);
        expect(normalizeRecentOutcomes(json)).toEqual(['right', 'wrong', 'right', 'right']);
    });
});

describe('复习结果 · 从流水派生', () => {
    it('按调用方给的顺序取结果（正序；非法的丢掉）', () => {
        const events = [{ outcome: 'wrong' }, { outcome: 'right' }, { outcome: 'x' }, { outcome: 'right' }];
        expect(deriveRecentFromEvents(events)).toEqual(['wrong', 'right', 'right']);
    });

    it('★ 流水很多也只留末尾 4 条（判等级够用：规则里连对 ≥3 就封顶）', () => {
        const many = Array.from({ length: 9 }, (_, i) => ({ outcome: i < 5 ? 'wrong' : 'right' }));
        const recent = deriveRecentFromEvents(many);
        expect(recent).toEqual(['right', 'right', 'right', 'right']);
        expect(recent).toHaveLength(RECENT_REVIEW_LIMIT);
    });

    it('空流水 ⇒ 空数组（= 没录过，错题卡画 4 个灰圈）', () => {
        expect(deriveRecentFromEvents([])).toEqual([]);
    });

    it('📌 记一条备注：`RECENT_REVIEW_LIMIT` 与纸面计划格数**现在都是 4，但含义不同**', () => {
        // 纸上 4 个格子是"计划节点"，错题卡 4 个圈是"最近 4 次结果" ⇒ 两者各自独立，
        // **不要**为了"看起来统一"把它们绑成一个常量（那样改纸就会动到卡片）。
        expect(RECENT_REVIEW_LIMIT).toBe(4);
        expect(PLANNED_REVIEW_ROUNDS).toBe(4);
    });
});
