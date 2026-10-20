/**
 * 【2026-10-15 新】等级结算规则的单测。
 *
 * 设计：`docs\14_等级语义改造v2_完整设计_20261015.md`（§11 验收标准点名要覆盖这些）。
 * 规则实现：`src/lib/level-settle.ts`（纯函数，所以这里不需要数据库）。
 */

import { describe, expect, it } from 'vitest';

import {
    LOCKED_LEVEL,
    MAX_COUNTDOWN,
    advanceCountdown,
    intervalForOutcomes,
    isFrozen,
    isPreMastered,
    levelFromCountdown,
    planAfterReview,
    planAfterUnmaster,
    planSettlement,
    rightStreakOf,
    shouldAutoMaster,
    type SettleItem,
} from '@/lib/level-settle';

/** 造一份 `reviewOutcomes`（形状与库里一致） */
function outcomes(planned: (string | null)[], last: string | null = null): string {
    return JSON.stringify({ planned, last });
}
/** 连对 n 次 */
const rights = (n: number) => outcomes(Array.from({ length: n }, () => 'right'), 'right');
/** 连错 n 次 */
const wrongs = (n: number) => outcomes(Array.from({ length: n }, () => 'wrong'), 'wrong');
/** 没练过的新题 */
const fresh = () => outcomes([null, null, null, null], null);

describe('等级结算 · 间隔表（最近的对错 ⇒ 多少天后再练）', () => {
    it('五档逐个对（空空 2026-10-15 定的那组数）', () => {
        expect(intervalForOutcomes(fresh())).toBe(1); // 没练过
        expect(intervalForOutcomes(wrongs(2))).toBe(1); // 连错 ≥2
        expect(intervalForOutcomes(wrongs(1))).toBe(3); // 做错 1 次
        expect(intervalForOutcomes(rights(1))).toBe(7); // 连对 1
        expect(intervalForOutcomes(rights(2))).toBe(14); // 连对 2
        expect(intervalForOutcomes(rights(3))).toBe(28); // 连对 3
    });

    it('连对 4 次及以上仍按 49 天（表里最长那档）', () => {
        expect(intervalForOutcomes(rights(4))).toBe(28);
    });

    it('「最近一次错」压过更早的连对 —— 判据只看从最近往前数', () => {
        // 连对 2 次之后又错了一次 ⇒ 是"做错 1 次" ⇒ 4 天
        expect(intervalForOutcomes(outcomes(['right', 'right', 'wrong'], 'wrong'))).toBe(3);
    });

    it('形状不对/空值 ⇒ 当新题（1 天），不抛异常', () => {
        expect(intervalForOutcomes(null)).toBe(1);
        expect(intervalForOutcomes(undefined)).toBe(1);
        expect(intervalForOutcomes('{}')).toBe(1);
        expect(intervalForOutcomes('不是 json')).toBe(1);
    });
});

describe('等级结算 · 阈值表（还剩几天 ⇒ 等级）', () => {
    it('四档边界逐个对', () => {
        expect(levelFromCountdown(1, 0)).toBe(5);
        expect(levelFromCountdown(0, 0)).toBe(5);
        expect(levelFromCountdown(2, 0)).toBe(4);
        /** 【2026-10-21】4 级边界从 4 天收到 **3 天** */
        expect(levelFromCountdown(3, 0)).toBe(4);
        expect(levelFromCountdown(4, 0)).toBe(3);
        expect(levelFromCountdown(7, 0)).toBe(3);
        /** 2 级边界从 21 天收到 **14 天** */
        expect(levelFromCountdown(8, 0)).toBe(2);
        expect(levelFromCountdown(14, 0)).toBe(2);
    });

    it('还剩 49 天（最长间隔）仍是 2 档 —— 不越界、不返回 undefined', () => {
        expect(levelFromCountdown(49, 0)).toBe(2);
        expect(levelFromCountdown(999, 0)).toBe(2);
    });

    it('连对 ≥ 3 **优先于天数** —— 哪怕倒数是 49 也锁在 1 档', () => {
        expect(levelFromCountdown(49, 3)).toBe(LOCKED_LEVEL);
        expect(levelFromCountdown(0, 3)).toBe(LOCKED_LEVEL);
        expect(levelFromCountdown(0, 4)).toBe(LOCKED_LEVEL);
    });

    it('负数倒数按 0 算（不下负数）', () => {
        expect(levelFromCountdown(-5, 0)).toBe(5);
    });
});

describe('等级结算 · 倒数递减（夹在 0）', () => {
    it('正常递减', () => {
        expect(advanceCountdown(14, 1)).toBe(13);
        expect(advanceCountdown(14, 3)).toBe(11);
    });

    it('**夹在 0，不下负数** —— 这是空空 2026-10-15 明确的一条', () => {
        expect(advanceCountdown(2, 5)).toBe(0);
        expect(advanceCountdown(0, 3)).toBe(0);
        expect(advanceCountdown(1, 1)).toBe(0);
    });

    it('减数为 0 或负数时不动（防脏数据）', () => {
        expect(advanceCountdown(7, 0)).toBe(7);
        expect(advanceCountdown(7, -2)).toBe(7);
    });
});

describe('等级结算 · 预掌握（等级 1 且 倒数到 0）', () => {
    it('等级 1 + 倒数 0 ⇒ 预掌握', () => {
        expect(isPreMastered(1, 0)).toBe(true);
    });

    it('等级 1 但倒数还没走完 ⇒ 不是预掌握', () => {
        expect(isPreMastered(1, 1)).toBe(false);
        expect(isPreMastered(1, 30)).toBe(false);
    });

    it('**别的等级 + 倒数 0 不算预掌握**（那是"早该练了"，等级 5）', () => {
        expect(isPreMastered(5, 0)).toBe(false);
        expect(isPreMastered(4, 0)).toBe(false);
        expect(isPreMastered(2, 0)).toBe(false);
    });

    it('★★ 倒数是 null/undefined 时**绝不算预掌握**（单测抓出来的真 bug）', () => {
        // `Number(null) === 0` 会让"等级 1 + 老数据没初始化"被误判成预掌握 ⇒
        // 结算时当冻结跳过 ⇒ 那道题**永远初始化不了**。
        expect(isPreMastered(1, null)).toBe(false);
        expect(isPreMastered(1, undefined)).toBe(false);
        expect(isPreMastered(1, Number.NaN)).toBe(false);
    });
});

describe('等级结算 · 等级 1 的四个出口', () => {
    it('① 又练对一次（连对 4 次）⇒ 直接已掌握', () => {
        expect(shouldAutoMaster(rights(4))).toBe(true);
        expect(shouldAutoMaster(rights(3))).toBe(false); // 连对 3 只是锁住，还不算已掌握
    });

    it('② 练错了 ⇒ 按间隔表回 4 抓紧（重新进入复习流程）', () => {
        const after = planAfterReview(outcomes(['right', 'right', 'right', 'wrong'], 'wrong'));
        /** 【2026-10-21】4 级的间隔从 4 天改成 **3 天** */
        expect(after.levelCountdown).toBe(3);
        expect(after.attention).toBe(4);
    });

    it('③ 什么都不做，倒数走到 0 ⇒ 预掌握（再由用户点成已掌握）', () => {
        // 连对 3 次：锁 1 档，倒数 49 天
        const start = planAfterReview(rights(3));
        expect(start.attention).toBe(1);
        expect(start.levelCountdown).toBe(28);
        // 走完 49 天
        const done = advanceCountdown(start.levelCountdown, 49);
        expect(done).toBe(0);
        expect(isPreMastered(levelFromCountdown(done, 3), done)).toBe(true);
    });
});

describe('等级结算 · 记下复习结果时写什么（planAfterReview）', () => {
    it('新录入 ⇒ 等级 5、倒数 1 天（没练过 = 最急）', () => {
        expect(planAfterReview(fresh())).toEqual({ levelCountdown: 1, attention: 5 });
    });

    it('做对一次 ⇒ 倒数 7、等级 3', () => {
        expect(planAfterReview(rights(1))).toEqual({ levelCountdown: 7, attention: 3 });
    });

    it('连对两次 ⇒ 倒数 21、等级 2', () => {
        expect(planAfterReview(rights(2))).toEqual({ levelCountdown: 14, attention: 2 });
    });

    it('连对三次 ⇒ 倒数 49、等级 1（锁）', () => {
        expect(planAfterReview(rights(3))).toEqual({ levelCountdown: 28, attention: 1 });
    });

    it('做错一次 ⇒ 倒数 3、等级 4（2026-10-21：间隔 4 → 3 天）', () => {
        expect(planAfterReview(wrongs(1))).toEqual({ levelCountdown: 3, attention: 4 });
    });

    it('连错两次 ⇒ 倒数 1、等级 5', () => {
        expect(planAfterReview(wrongs(2))).toEqual({ levelCountdown: 1, attention: 5 });
    });

    it('录入时倒数与等级**必须同时写对** —— 不许出现"倒数 7 但等级还是 5"', () => {
        const r = planAfterReview(rights(1));
        // 用刚写下的倒数反算等级，必须等于刚写下的等级
        expect(levelFromCountdown(r.levelCountdown, rightStreakOf(rights(1)))).toBe(r.attention);
    });
});

describe('等级结算 · 冻结（三类题不参与结算）', () => {
    const base: SettleItem = { id: 'x', reviewOutcomes: rights(1), attention: 3, levelCountdown: 7 };

    it('未掌握的普通题**不冻结**', () => {
        expect(isFrozen(base)).toBe(false);
        expect(isFrozen({ ...base, masteryLevel: 0 })).toBe(false);
        expect(isFrozen({ ...base, masteryLevel: 1 })).toBe(false);
    });

    it('① 已掌握（masteryLevel = 2）⇒ 冻结', () => {
        expect(isFrozen({ ...base, masteryLevel: 2 })).toBe(true);
    });

    it('② 预掌握（等级 1 + 倒数 0）⇒ 冻结', () => {
        expect(isFrozen({ ...base, attention: 1, levelCountdown: 0 })).toBe(true);
        // 但等级 1 且倒数还有 ⇒ 不冻结（倒数还得往下走）
        expect(isFrozen({ ...base, attention: 1, levelCountdown: 30 })).toBe(false);
    });

    it('③ **归档本里的题**（空空的"封印"）⇒ 冻结', () => {
        expect(isFrozen({ ...base, notebookArchived: true })).toBe(true);
        // ⚠️ 这条最容易漏：归档题本来就不在主库，但"重算"照样会把它改活
        expect(isFrozen({ ...base, notebookArchived: true, masteryLevel: 0 })).toBe(true);
    });
});

describe('等级结算 · "已掌握"退回"未掌握"（planAfterUnmaster）', () => {
    it('回到 **4 抓紧 + 倒数 3 天**（2026-10-21 整表改档位后）', () => {
        expect(planAfterUnmaster()).toEqual({ levelCountdown: 3, attention: 4 });
    });

    it('倒数和等级**互相自洽** —— 用刚写下的倒数反算等级，必须等于刚写下的等级', () => {
        const r = planAfterUnmaster();
        expect(levelFromCountdown(r.levelCountdown, 0)).toBe(r.attention);
    });

    it('⚠️ 不能是 7 天 —— 7 天按阈值表会落到 3 档，与"转 4 抓紧"自相矛盾', () => {
        expect(planAfterUnmaster().levelCountdown).not.toBe(7);
        expect(levelFromCountdown(7, 0)).toBe(3); // 这就是为什么不能用 7
    });
});

describe('等级结算 · planSettlement（幂等 / 只写变了的）', () => {
    const item = (over: Partial<SettleItem> = {}): SettleItem => ({
        id: 'q1',
        reviewOutcomes: rights(2), // 连对 2 ⇒ 间隔 21
        attention: 2,
        levelCountdown: 14,
        masteryLevel: 0,
        ...over,
    });

    it('正常推进：倒数 14 走 1 天 ⇒ 13，等级不变（都还在 2 档区间）', () => {
        const changes = planSettlement([item()], 1);
        // 14 → 13 变了，所以会写
        expect(changes).toHaveLength(1);
        expect(changes[0].levelCountdown).toBe(13);
        expect(changes[0].attention).toBe(2);
    });

    it('★ **幂等**：漏跑 3 天，一次减 3（不是只减 1）', () => {
        const changes = planSettlement([item({ levelCountdown: 14 })], 3);
        expect(changes[0].levelCountdown).toBe(11);
    });

    it('★ 漏跑到过期：倒数 2、漏跑 10 天 ⇒ 夹在 0，等级升到 5', () => {
        const changes = planSettlement([item({ levelCountdown: 2, attention: 4 })], 10);
        expect(changes[0].levelCountdown).toBe(0);
        expect(changes[0].attention).toBe(5);
    });

    it('跨档时等级会跟着变（倒数 7 → 6 仍是 3 档；走到 3 才进 4 档）', () => {
        const a = planSettlement([item({ levelCountdown: 7, attention: 3 })], 1);
        expect(a[0].attention).toBe(3); // 6 天，还在 ≤7 区间
        /** 【2026-10-21】4 档的上界从 4 天收到 3 天 ⇒ 要从 7 减 4 天才跨过去 */
        const b = planSettlement([item({ levelCountdown: 7, attention: 3 })], 4);
        expect(b[0].levelCountdown).toBe(3);
        expect(b[0].attention).toBe(4); // ≤3 ⇒ 4 档
    });

    it('**没变的题不写库**（省 IO）', () => {
        // 倒数 0、等级 5：再减还是 0、还是 5 ⇒ 不该产生写
        const changes = planSettlement([item({ levelCountdown: 0, attention: 5 })], 1);
        expect(changes).toHaveLength(0);
    });

    it('冻结的题一律跳过（三类各验一遍）', () => {
        const changes = planSettlement(
            [
                item({ id: 'a', masteryLevel: 2 }),
                item({ id: 'b', attention: 1, levelCountdown: 0 }),
                item({ id: 'c', notebookArchived: true }),
            ],
            5,
        );
        expect(changes).toHaveLength(0);
    });

    it('老数据初始化：倒数 null ⇒ 按最近的对错补一个间隔，且**当次不再扣**', () => {
        const changes = planSettlement([item({ levelCountdown: null, attention: 1 })], 5);
        expect(changes).toHaveLength(1);
        expect(changes[0].initialized).toBe(true);
        expect(changes[0].levelCountdown).toBe(14); // 连对 2 ⇒ 21，不是 21-5
        expect(changes[0].attention).toBe(2);
    });

    it('老数据初始化时，若等级恰好已经对得上 ⇒ 仍然要写（把 null 补上）', () => {
        const changes = planSettlement([item({ levelCountdown: null, attention: 2 })], 1);
        expect(changes).toHaveLength(1);
        expect(changes[0].initialized).toBe(true);
        expect(changes[0].levelCountdown).toBe(14);
    });

    it('★★ 老数据里"等级恰好是 1"的题**也必须能初始化**（不被误判成预掌握）', () => {
        const changes = planSettlement([item({ levelCountdown: null, attention: 1 })], 0);
        expect(changes).toHaveLength(1);
        expect(changes[0].initialized).toBe(true);
        expect(changes[0].levelCountdown).toBe(14); // 连对 2 ⇒ 21
        expect(changes[0].attention).toBe(2); // 按规则重算成 2 档
    });

    it('减数为 0 时**仍会初始化**老数据（初始化与天数无关）', () => {
        const changes = planSettlement([item({ levelCountdown: null })], 0);
        expect(changes).toHaveLength(1);
        expect(changes[0].initialized).toBe(true);
    });

    it('减数 ≤ 0 或非法 ⇒ 什么都不做（防脏数据把等级推歪）', () => {
        expect(planSettlement([item()], 0)).toHaveLength(0);
        expect(planSettlement([item()], -1)).toHaveLength(0);
        expect(planSettlement([item()], Number.NaN)).toHaveLength(0);
    });

    it('上限不越界：倒数永远不超过 49', () => {
        const r = planAfterReview(rights(5));
        expect(r.levelCountdown).toBeLessThanOrEqual(MAX_COUNTDOWN);
    });
});
