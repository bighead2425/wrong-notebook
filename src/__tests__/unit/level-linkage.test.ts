/**
 * 等级 × 复习结果联动的看门测试（2026-10-03 他拍板的规则）。
 *
 * 这一组测试是**他原话的逐条翻译** —— 每条 `it` 的注释里都写着他说过的那一句，
 * 以后谁想改规则，先来这儿看看改动了哪几条。
 */

import { describe, expect, it } from 'vitest';
import {
    LEVEL_MAX,
    LEVEL_MIN,
    PLANNED_LEVEL_SLOTS,
    clampLevel,
    computeLevelLinkage,
    initialLevelForManageType,
    lastSlotDelta,
    levelDeltaForTypeSwitch,
    normalizeLevelEntry,
    plannedSlotDelta,
    serializeLevelEntry,
} from '@/lib/level-linkage';
import {
    PLANNED_REVIEW_ROUNDS,
    emptyReviewOutcomes,
    type ReviewOutcomes,
} from '@/lib/review-outcomes';

/** 快捷造一份复习结果（长度跟着 `PLANNED_REVIEW_ROUNDS` 走，别再写死 3） */
function outcomes(
    planned: (('right' | 'wrong') | null)[],
    last: ('right' | 'wrong') | null = null,
): ReviewOutcomes {
    return {
        planned: Array.from({ length: PLANNED_REVIEW_ROUNDS }, (_, i) => planned[i] ?? null),
        last,
    };
}

/** 跑一次联动（省得每个用例都写一长串参数） */
function run(opts: {
    attention: number;
    prev: ReviewOutcomes;
    next: ReviewOutcomes;
    entry?: { slot: string; delta: number } | null;
}) {
    return computeLevelLinkage({
        currentAttention: opts.attention,
        prevOutcomes: opts.prev,
        nextOutcomes: opts.next,
        prevEntry: opts.entry ?? null,
    });
}

describe('等级联动 · 初定级（一次性）', () => {
    it('深挖 ⇒ 白银(2)；复练 ⇒ 青铜(1)；未定 ⇒ 青铜', () => {
        expect(initialLevelForManageType('deep')).toBe(2);
        expect(initialLevelForManageType('review')).toBe(1);
        expect(initialLevelForManageType(null)).toBe(1);
        expect(initialLevelForManageType(undefined)).toBe(1);
    });

    it('夹在 1..5：越界/非数字都被夹回来', () => {
        expect(clampLevel(0)).toBe(LEVEL_MIN);
        expect(clampLevel(9)).toBe(LEVEL_MAX);
        expect(clampLevel(NaN)).toBe(LEVEL_MIN);
        expect(clampLevel(3.4)).toBe(3);
    });
});

describe('等级联动 · 类型切换（复练⇄深挖）', () => {
    it('复练 → 深挖 = +1；深挖 → 复练 = −1', () => {
        expect(levelDeltaForTypeSwitch('review', 'deep')).toBe(1);
        expect(levelDeltaForTypeSwitch('deep', 'review')).toBe(-1);
    });

    it('其它情形（含 未定 ⇄ 任一）一律 0 —— 不乱动等级', () => {
        expect(levelDeltaForTypeSwitch(null, 'deep')).toBe(0);
        expect(levelDeltaForTypeSwitch('deep', null)).toBe(0);
        expect(levelDeltaForTypeSwitch(null, 'review')).toBe(0);
        expect(levelDeltaForTypeSwitch('deep', 'deep')).toBe(0);
    });
});

describe('等级联动 · 第 1 次复习：无论对错都不影响等级', () => {
    it("★ 他说：\"第一次复习输入结果，无论对错，对等级都没有影响\"", () => {
        const a = run({ attention: 1, prev: outcomes([]), next: outcomes(['right'], 'right') });
        expect(a.attention).toBe(1);
        expect(a.changed).toBe(false);

        const b = run({ attention: 1, prev: outcomes([]), next: outcomes(['wrong'], 'wrong') });
        expect(b.attention).toBe(1);
        expect(b.changed).toBe(false);
    });

    it("★ 他说：\"已填了后续结果再来调整第一次，等级也不发生改变\"", () => {
        const prev = outcomes(['right', 'wrong'], 'wrong');
        const next = outcomes(['wrong', 'wrong'], 'wrong');
        const r = run({ attention: 3, prev, next, entry: { slot: 'p2', delta: 1 } });
        expect(r.attention).toBe(3);
        expect(r.changed).toBe(false);
    });
});

describe('等级联动 · 第 2 次复习', () => {
    it('★ 一次对、二次错 ⇒ 升一级', () => {
        const r = run({ attention: 2, prev: outcomes(['right'], 'right'), next: outcomes(['right', 'wrong'], 'wrong') });
        expect(r.attention).toBe(3);
        expect(r.delta).toBe(1);
        expect(r.entry).toEqual({ slot: 'p2', delta: 1 });
    });

    it('★ 两次都错 ⇒ 升两级', () => {
        const r = run({ attention: 2, prev: outcomes(['wrong'], 'wrong'), next: outcomes(['wrong', 'wrong'], 'wrong') });
        expect(r.attention).toBe(4);
        expect(r.delta).toBe(2);
    });

    it('★ 两次都对 ⇒ 降一级', () => {
        const r = run({ attention: 4, prev: outcomes(['right'], 'right'), next: outcomes(['right', 'right'], 'right') });
        expect(r.attention).toBe(3);
        expect(r.delta).toBe(-1);
    });

    it('★ 一次错、二次对 ⇒ 不变', () => {
        const r = run({ attention: 3, prev: outcomes(['wrong'], 'wrong'), next: outcomes(['wrong', 'right'], 'right') });
        expect(r.changed).toBe(false);
        expect(r.attention).toBe(3);
    });

    it('★ 一次空、二次对 ⇒ 不变（等于"这是第一次结果"）', () => {
        const r = run({ attention: 3, prev: outcomes([]), next: outcomes([null, 'right'], 'right') });
        expect(r.changed).toBe(false);
        expect(r.attention).toBe(3);
    });

    it("★ 他说：\"第三次已输入时调整第二次 ⇒ 等级不变\"", () => {
        const prev = outcomes(['right', 'wrong', 'wrong'], 'wrong');
        const next = outcomes(['right', 'right', 'wrong'], 'wrong');
        const r = run({ attention: 3, prev, next, entry: { slot: 'p3', delta: 1 } });
        expect(r.attention).toBe(3);
        expect(r.changed).toBe(false);
    });
});

describe('等级联动 · 第 3 次复习', () => {
    it('★ 三次对（二次也对）⇒ 降一级', () => {
        const r = run({
            attention: 4,
            prev: outcomes(['right', 'right'], 'right'),
            next: outcomes(['right', 'right', 'right'], 'right'),
        });
        expect(r.attention).toBe(3);
    });

    it('★ 三次对、但二次错（或空）⇒ 不动', () => {
        const r = run({
            attention: 4,
            prev: outcomes(['right', null], 'right'),
            next: outcomes(['right', null, 'right'], 'right'),
        });
        expect(r.changed).toBe(false);
        expect(r.attention).toBe(4);
    });

    it('★ 三次错（一次对/空 + 二次错/空）⇒ 升一级', () => {
        const r = run({
            attention: 2,
            prev: outcomes(['right', null], 'right'),
            next: outcomes(['right', null, 'wrong'], 'wrong'),
        });
        expect(r.attention).toBe(3);
    });

    it('★ 三次全错 ⇒ 升两级', () => {
        const r = run({
            attention: 1,
            prev: outcomes(['wrong', 'wrong'], 'wrong'),
            next: outcomes(['wrong', 'wrong', 'wrong'], 'wrong'),
        });
        expect(r.attention).toBe(3);
        expect(r.delta).toBe(2);
    });

    it('★ 二次对、三次错 ⇒ 不变', () => {
        const r = run({
            attention: 3,
            prev: outcomes(['right', 'right'], 'right'),
            next: outcomes(['right', 'right', 'wrong'], 'wrong'),
        });
        expect(r.changed).toBe(false);
        expect(r.attention).toBe(3);
    });
});

describe('等级联动 · 最近一次（手动）', () => {
    it('对 ⇒ 降一级；错 ⇒ 升一级', () => {
        const base = outcomes(['right', 'right', 'right'], 'right');
        const toWrong: ReviewOutcomes = { ...base, last: 'wrong' };
        const r1 = run({ attention: 3, prev: base, next: toWrong });
        expect(r1.attention).toBe(4);
        expect(r1.entry).toBeNull(); // ← 最近一次不进账本

        // 再点回"对" ⇒ 就是**再动一次**（不是撤销 +1、也不是记 −2）
        const r2 = run({ attention: 4, prev: toWrong, next: base, entry: { slot: 'p2', delta: 1 } });
        expect(r2.attention).toBe(3);
        // 账本一个字没动（它只记计划三格）
        expect(r2.entry).toEqual({ slot: 'p2', delta: 1 });
    });

    it('★ 他说：\"点击成还没有结果就不变\" —— 清空不改等级、也不撤销', () => {
        const toWrong = outcomes(['right', 'right', 'right'], 'wrong');
        const cleared: ReviewOutcomes = { ...toWrong, last: null };
        const r = run({ attention: 4, prev: toWrong, next: cleared });
        expect(r.changed).toBe(false);
        expect(r.attention).toBe(4);
    });

    it('★ "误点成错、马上改回对" ⇒ 原样退回，不留残余', () => {
        const base = outcomes(['right', 'wrong', 'wrong'], 'right'); // 最近一次本来就记着"对"
        const misTap: ReviewOutcomes = { ...base, last: 'wrong' }; // 手滑点成"错"
        const fixed: ReviewOutcomes = { ...base, last: 'right' }; // 马上改回
        const tap = run({ attention: 3, prev: base, next: misTap });
        expect(tap.attention).toBe(4);
        const back = run({ attention: tap.attention, prev: misTap, next: fixed });
        expect(back.attention).toBe(3);
    });

    it('★ 前三次变化导致"最近一次"**自动**跟着变 ⇒ 不动等级', () => {
        // 填第 2 次时 last 由 right 自动变成 wrong —— 但该记的账只有 p2 那一笔
        const r = run({
            attention: 3,
            prev: outcomes(['right', null], 'right'),
            next: outcomes(['right', 'wrong'], 'wrong'),
        });
        expect(r.slot).toBe('p2');
        expect(r.entry).toEqual({ slot: 'p2', delta: 1 });
    });
});

describe('等级联动 · 最新一格可反悔（他 2026-10-03 拍板）', () => {
    it('★ 第 2 次从"错"改成"对" ⇒ 撤销旧账 + 按新组合重算（净 −2）', () => {
        const prev = outcomes(['right', 'wrong'], 'wrong');
        const next = outcomes(['right', 'right'], 'right');
        const r = run({ attention: 3, prev, next, entry: { slot: 'p2', delta: 1 } });
        // 原账 +1（一次对、二次错）⇒ 撤销后又按"两次都对 = −1"记 ⇒ 净 −2
        expect(r.delta).toBe(-2);
        expect(r.attention).toBe(1);
        expect(r.entry).toEqual({ slot: 'p2', delta: -2 });
    });

    it('★ 更早的格子不享受"反悔"（他没有第二笔账可撤）', () => {
        // 账在 p3 上；此时改 p2 ⇒ p2 不是最新的 ⇒ 不动
        const prev = outcomes(['right', 'wrong', 'wrong'], 'wrong');
        const next = outcomes(['wrong', 'wrong', 'wrong'], 'wrong');
        const r = run({ attention: 3, prev, next, entry: { slot: 'p3', delta: 1 } });
        expect(r.changed).toBe(false);
    });

    it('★ 把最新那格清空 ⇒ 撤销它记过的那笔账', () => {
        const prev = outcomes(['right', 'wrong'], 'wrong');
        const next = outcomes(['right'], 'right');
        const r = run({ attention: 3, prev, next, entry: { slot: 'p2', delta: 1 } });
        expect(r.delta).toBe(-1);
        expect(r.attention).toBe(2);
        expect(r.entry).toBeNull();
    });
});

describe('等级联动 · 边界', () => {
    it('王者封顶：该升也升不上去，且不留下"虚假的账"', () => {
        const r = run({
            attention: LEVEL_MAX,
            prev: outcomes(['wrong'], 'wrong'),
            next: outcomes(['wrong', 'wrong'], 'wrong'),
        });
        expect(r.attention).toBe(LEVEL_MAX);
        expect(r.changed).toBe(false);
        expect(r.entry).toBeNull();
    });

    it('青铜封底：该降也降不下去', () => {
        const r = run({
            attention: LEVEL_MIN,
            prev: outcomes(['right'], 'right'),
            next: outcomes(['right', 'right'], 'right'),
        });
        expect(r.attention).toBe(LEVEL_MIN);
        expect(r.changed).toBe(false);
    });

    it('什么都没变 ⇒ 原样返回，且不动账', () => {
        const same = outcomes(['right', 'wrong'], 'wrong');
        const r = run({ attention: 3, prev: same, next: same, entry: { slot: 'p2', delta: 1 } });
        expect(r.changed).toBe(false);
        expect(r.entryChanged).toBe(false);
        expect(r.entry).toEqual({ slot: 'p2', delta: 1 });
    });

    it('库里存的是 JSON 字符串也能读', () => {
        const r = run({
            attention: 2,
            prev: outcomes(['right'], 'right'),
            next: JSON.parse(JSON.stringify(outcomes(['right', 'wrong'], 'wrong'))),
        });
        expect(r.attention).toBe(3);
    });

    it('账的形状不对 ⇒ 当成没有账，绝不猜', () => {
        expect(normalizeLevelEntry('{"slot":"p9","delta":2}')).toBeNull();
        expect(normalizeLevelEntry('乱七八糟')).toBeNull();
        expect(normalizeLevelEntry('')).toBeNull();
        expect(normalizeLevelEntry({ slot: 'p2', delta: '1' })).toEqual({ slot: 'p2', delta: 1 });
        expect(serializeLevelEntry({ slot: 'last', delta: -1 })).toBe('{"slot":"last","delta":-1}');
        expect(serializeLevelEntry(null)).toBeNull();
    });

    it('plannedSlotDelta 直接查表（他定的那几种组合）', () => {
        expect(plannedSlotDelta(outcomes(['right', 'wrong']), 1)).toBe(1);
        expect(plannedSlotDelta(outcomes(['wrong', 'wrong']), 1)).toBe(2);
        expect(plannedSlotDelta(outcomes(['right', 'right']), 1)).toBe(-1);
        expect(plannedSlotDelta(outcomes(['wrong', 'right']), 1)).toBe(0);
        expect(plannedSlotDelta(outcomes(['right', 'right', 'right']), 2)).toBe(-1);
        expect(plannedSlotDelta(outcomes(['right', null, 'right']), 2)).toBe(0);
        expect(plannedSlotDelta(outcomes(['wrong', 'wrong', 'wrong']), 2)).toBe(2);
        expect(plannedSlotDelta(outcomes(['right', 'right', 'wrong']), 2)).toBe(0);
        expect(lastSlotDelta('right')).toBe(-1);
        expect(lastSlotDelta('wrong')).toBe(1);
        expect(lastSlotDelta(null)).toBe(0);
    });

    it('空复习结果也能跑（新题刚录入时）', () => {
        const r = computeLevelLinkage({
            currentAttention: 2,
            prevOutcomes: null,
            nextOutcomes: emptyReviewOutcomes(),
            prevEntry: null,
        });
        expect(r.changed).toBe(false);
        expect(r.attention).toBe(2);
    });
});

/* ==========================================================================
 * 【2026-10-14 加第 4 格】把当天那个**线上 bug** 钉住：
 *
 *   现象：详情页点**第 4 个**复习结果圆圈 ⇒ 界面弹"更新失败"（接口 500）。
 *   根因：`computeLevelLinkage` 里的槽位名表还是 3 格时代的 `['p1','p2','p3']`
 *         ⇒ 下标 3 取到 `undefined` ⇒ ① 清空那格时 `prevEntry.delta` 撞 null（500）；
 *         ② 就算不崩，账也会写成 `{"delta":N}`（**没有 slot**）⇒ 账本失效。
 * ========================================================================== */
describe('等级联动 · 计划第 4 格（2026-10-14 加的格）', () => {
    it('★ 看门测试：计划槽位名表的长度**必须**等于 PLANNED_REVIEW_ROUNDS', () => {
        // 再加格/减格时，这条会先红 —— 免得又是"有人加了格、忘了改槽位表"
        expect(PLANNED_LEVEL_SLOTS).toHaveLength(PLANNED_REVIEW_ROUNDS);
    });

    it('★★ 清空第 4 格**不许崩**（修复前：`slot = undefined` ⇒ 读 `prevEntry.delta` 撞 null ⇒ 接口 500）', () => {
        const prev = outcomes(['right', 'right', 'right', 'right'], 'right');
        const next = outcomes(['right', 'right', 'right', null], 'right'); // 倒着找 ⇒ last 仍是 right
        expect(() => run({ attention: 3, prev, next })).not.toThrow();
    });

    it('★★ 账本是空的时候清空第 4 格同样不许崩（修复前就是这条路径炸的）', () => {
        const prev = outcomes(['wrong', 'wrong', 'wrong', 'wrong'], 'wrong');
        const next = outcomes(['wrong', 'wrong', 'wrong', null], 'wrong');
        expect(() => run({ attention: 5, prev, next, entry: null })).not.toThrow();
    });

    it('★ 【临时口径】改第 4 格**不动等级、也不动账本**（"第 4 次加减多少"他还没定）', () => {
        const prev = outcomes(['right', 'right', 'right', null], 'right');
        const next = outcomes(['right', 'right', 'right', 'right'], 'right');
        const r = run({ attention: 3, prev, next, entry: { slot: 'p2', delta: 1 } });
        expect(r.changed).toBe(false); // 等级不动
        expect(r.attention).toBe(3);
        expect(r.entryChanged).toBe(false);
        expect(r.entry).toEqual({ slot: 'p2', delta: 1 }); // ← 旧账**不许被顺手清掉**
        expect(r.slot).toBeNull();
    });

    it('★ 【临时口径】把第 4 格改成"错"也一样：不动等级', () => {
        const prev = outcomes(['right', 'right', 'right', 'right'], 'right');
        const next = outcomes(['right', 'right', 'right', 'wrong'], 'wrong');
        const r = run({ attention: 3, prev, next });
        expect(r.changed).toBe(false);
        expect(r.attention).toBe(3);
    });

    it('⚠️ 但**不许**"顺手沿用第 3 格的规则" —— 那会撤掉第 3 格刚记的账（第 4 次错 ⇒ 等级反而降）', () => {
        // 这条替"规则必须是**他定的**"站岗：将来有人删掉临时口径、直接让 index===3 走
        // index===2 的分支，这里立刻会红。
        const prev = outcomes(['wrong', 'wrong', 'wrong', null], 'wrong');
        const next = outcomes(['wrong', 'wrong', 'wrong', 'wrong'], 'wrong');
        const r = run({ attention: 5, prev, next, entry: { slot: 'p3', delta: 2 } });
        expect(r.delta).toBe(0);
        expect(r.entry).toEqual({ slot: 'p3', delta: 2 }); // 没有变成 -1
    });

    it('★ 账本被写坏成 `{"delta":N}`（没有 slot）时当作"没有账"，不崩也不乱撤', () => {
        expect(normalizeLevelEntry('{"delta":-1}')).toBeNull();
    });

    it('★ 前三格的规则一个字没变（回归）', () => {
        const prev = outcomes(['right', null, null], null);
        const next = outcomes(['right', 'wrong', null], 'wrong');
        const r = run({ attention: 2, prev, next });
        expect(r.changed).toBe(true);
        expect(r.attention).toBe(3); // 一次对、二次错 ⇒ +1
        expect(r.slot).toBe('p2');
    });
});
