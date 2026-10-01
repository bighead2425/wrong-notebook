// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：扫到的复练卷页「纸面直接录入」那两组控件的规则。
import { describe, expect, it } from 'vitest';
import {
    nextReviewMark,
    nextReviewOutcomes,
    PROMOTE_APPLIED_BG,
    PROMOTE_APPLIED_LABEL_EN,
    PROMOTE_APPLIED_LABEL_ZH,
    promoteToggleFor,
    REVIEW_MARK_COLORS,
    markForItem,
    reviewMarkFromOutcomes,
} from '@/lib/scan-marking';

/**
 * 【2026-10-02 他定的规则】复习结果写哪一格 —— **按顺序填第一个空位**，且永远同步 `last`。
 *
 *   没有记录 → planned[0]；只有第一次 → planned[1]；有第二次没第三次 → planned[2]；
 *   有第三次 → last。
 */
describe('扫卷录入 · 复习结果写哪一格', () => {
    it('★ 没有复习记录 ⇒ 写第一次（planned[0]），并同步 last', () => {
        const w = nextReviewOutcomes(null, 'right');
        expect(w.slot).toBe(0);
        expect(w.outcomes.planned).toEqual(['right', null, null]);
        expect(w.outcomes.last).toBe('right');
    });

    it('★ 只有第一次 ⇒ 写第二次（planned[1]），last 同步成这一次', () => {
        const w = nextReviewOutcomes({ planned: ['right', null, null], last: 'right' }, 'wrong');
        expect(w.slot).toBe(1);
        expect(w.outcomes.planned).toEqual(['right', 'wrong', null]);
        expect(w.outcomes.last).toBe('wrong');
    });

    it('★ 有第二次而没有第三次 ⇒ 写第三次（planned[2]）', () => {
        const w = nextReviewOutcomes({ planned: ['right', 'wrong', null], last: 'wrong' }, 'right');
        expect(w.slot).toBe(2);
        expect(w.outcomes.planned).toEqual(['right', 'wrong', 'right']);
        expect(w.outcomes.last).toBe('right');
    });

    it('★ 有第三次 ⇒ 只写最近一次（last），三个计划位一个字都不许动', () => {
        const w = nextReviewOutcomes({ planned: ['right', 'wrong', 'right'], last: 'right' }, 'wrong');
        expect(w.slot).toBe('last');
        expect(w.outcomes.planned).toEqual(['right', 'wrong', 'right']);
        expect(w.outcomes.last).toBe('wrong');
    });

    it('中间空、后面有值 ⇒ 仍然填**第一个**空位（从左往右）', () => {
        const w = nextReviewOutcomes({ planned: ['right', null, 'wrong'], last: 'wrong' }, 'right');
        expect(w.slot).toBe(1);
        expect(w.outcomes.planned).toEqual(['right', 'right', 'wrong']);
        expect(w.outcomes.last).toBe('right');
    });

    it('★ 库里存的是 JSON 字符串也照收（扫码列表拿到的就是字符串）', () => {
        const w = nextReviewOutcomes('{"planned":["right",null,null],"last":"right"}', 'wrong');
        expect(w.slot).toBe(1);
        expect(w.outcomes.planned).toEqual(['right', 'wrong', null]);
    });

    it('坏数据（坏 JSON / 非对象）一律当"没有记录"，不猜历史', () => {
        for (const bad of ['不是 json', '{}', 123, undefined]) {
            expect(nextReviewOutcomes(bad, 'right').outcomes.planned).toEqual(['right', null, null]);
        }
    });

    it('不改动传入的对象（纯函数，返回的是新数组）', () => {
        const before = { planned: ['right', null, null] as ('right' | 'wrong' | null)[], last: 'right' as const };
        nextReviewOutcomes(before, 'wrong');
        expect(before.planned).toEqual(['right', null, null]);
        expect(before.last).toBe('right');
    });

    it('★ 同一轮里改对错 = 修正同一格（从同一份快照重算，落点不变、不是新增一条）', () => {
        // 库里已有第一次(right)、计划位还剩一个空位；这一轮先标绿、再改成粉
        const snapshot = '{"planned":["right",null,null],"last":"right"}';
        const green = nextReviewOutcomes(snapshot, 'right');
        const pink = nextReviewOutcomes(snapshot, 'wrong');
        expect(green.slot).toBe(1);
        expect(pink.slot).toBe(1); // 同一个落点
        expect(pink.outcomes.planned).toEqual(['right', 'wrong', null]); // 不是 ['right','right','wrong']
        expect(pink.outcomes.last).toBe('wrong');
    });
});

/**
 * 灰圆的三态循环：灰底白数字 → 绿底白对号 → 粉底灰错号 → 灰底白数字。
 */
describe('扫卷录入 · 灰圆三态循环', () => {
    it('★ 一圈走完回到原点：none → right → wrong → none → right', () => {
        expect(nextReviewMark('none')).toBe('right');
        expect(nextReviewMark('right')).toBe('wrong');
        expect(nextReviewMark('wrong')).toBe('none');
        expect(nextReviewMark(nextReviewMark(nextReviewMark('none')))).toBe('none');
    });

    it('★ 圆现在的态由"最近一次复习结果"还原（刷新后也说得通）', () => {
        expect(reviewMarkFromOutcomes(null)).toBe('none');
        expect(reviewMarkFromOutcomes('{"planned":["right","wrong",null],"last":"right"}')).toBe('right');
        expect(reviewMarkFromOutcomes({ planned: [null, null, null], last: 'wrong' })).toBe('wrong');
        // last 为空 ⇒ 灰底白数字（哪怕计划位里有值）
        expect(reviewMarkFromOutcomes({ planned: ['right', null, null], last: null })).toBe('none');
    });

    it('三态配色齐全，绿=对 / 粉=错（与错题卡四圆点同色，不另立一套）', () => {
        expect(REVIEW_MARK_COLORS.right.bg).toBe('#6fbf8b');
        expect(REVIEW_MARK_COLORS.wrong.bg).toBe('#f6c9cf');
        expect(REVIEW_MARK_COLORS.none.bg).toBe('#9ca3af');
        expect(REVIEW_MARK_COLORS.right.fg).toBe('#ffffff');
        expect(REVIEW_MARK_COLORS.wrong.fg).toBe('#8a8a8a');
    });
});

/**
 * 升降级小框：点一下 ⇒ 深挖变复练 / 复练变深挖；再点 ⇒ 原样还原。
 *
 * ⚠️ "未定"必须**按复练处理**（既有规矩，见 `lib/manage-type.ts` 的 `promoteDirectionFor`）：
 *    未定的题框指向"升级"、点下去变深挖，再点时**还原成 null（未定）**而不是复练。
 */
describe('扫卷录入 · 升降级框改类型', () => {
    it('深挖 ⇒ 框是"降级"，点下去变复练', () => {
        const t = promoteToggleFor('deep');
        expect(t.direction).toBe('demote');
        expect(t.nextType).toBe('review');
        expect(t.originalType).toBe('deep');
    });

    it('复练 ⇒ 框是"升级"，点下去变深挖', () => {
        const t = promoteToggleFor('review');
        expect(t.direction).toBe('upgrade');
        expect(t.nextType).toBe('deep');
        expect(t.originalType).toBe('review');
    });

    it('★ 未定 ⇒ 按复练处理（印"升级"、点下去变深挖），还原时回到未定', () => {
        const t = promoteToggleFor(null);
        expect(t.direction).toBe('upgrade');
        expect(t.nextType).toBe('deep');
        expect(t.originalType).toBeNull();
    });

    it('不认识的取值也当未定（宁可退回未定，也不猜一个等级压到数据上）', () => {
        expect(promoteToggleFor('野值').originalType).toBeNull();
        expect(promoteToggleFor('野值').direction).toBe('upgrade');
    });

    it('★ 勾选后文字与底色：降级=浅绿+"已降"；升级=粉红+"已升"', () => {
        expect(PROMOTE_APPLIED_LABEL_ZH.demote).toBe('已降');
        expect(PROMOTE_APPLIED_LABEL_ZH.upgrade).toBe('已升');
        expect(PROMOTE_APPLIED_BG.demote).toBe('#d7f0dd');
        expect(PROMOTE_APPLIED_BG.upgrade).toBe('#fbd7e0');
        expect(PROMOTE_APPLIED_LABEL_EN.demote).toBeTruthy();
        expect(PROMOTE_APPLIED_LABEL_EN.upgrade).toBeTruthy();
    });
});

/**
 * 【2026-10-02 他定的】圆态**按卷**判断 —— 这一组是那条要求的看门测试。
 *
 * 场景（他原话）："如果扫的是另外一个**没有扫描过**的新卷，
 * 即使有这道题**还是应该给灰圈**。"
 * ⇒ 同一道题在 A 卷标了"对"，换到没扫过的 B 卷打开，B 卷里那道题必须是灰的。
 */
describe('扫卷录入 · 圆态按卷记（换新卷要给灰圈）', () => {
    it('★ 同一道题：A 卷标过 ⇒ 在 A 卷显示绿；在没标过的 B 卷显示灰', () => {
        const rowA = { errorItemId: 'e1', markState: 'right' };
        expect(markForItem('e1', {}, [rowA])).toBe('right');
        // B 卷里也有这道题，但那一行没标过（markState = null）⇒ 灰
        const rowB = { errorItemId: 'e1', markState: null };
        expect(markForItem('e1', {}, [rowB])).toBe('none');
    });

    it('卷行上是 wrong 就画粉；值不认识（含脏数据）一律当灰', () => {
        expect(markForItem('e1', {}, [{ errorItemId: 'e1', markState: 'wrong' }])).toBe('wrong');
        expect(markForItem('e1', {}, [{ errorItemId: 'e1', markState: 'WHAT' }])).toBe('none');
        expect(markForItem('e1', {}, [{ errorItemId: 'e1' }])).toBe('none');
    });

    it('本次会话的本地覆盖最优先（刚点完还没刷新时立刻反映）', () => {
        const rows = [{ errorItemId: 'e1', markState: null }];
        expect(markForItem('e1', { e1: 'wrong' }, rows)).toBe('wrong');
        // 本地是 none（刚点回灰数字）⇒ 即便库里还写着 right 也要显示灰
        expect(markForItem('e1', { e1: 'none' }, [{ errorItemId: 'e1', markState: 'right' }])).toBe('none');
    });

    it('卷里根本没有这道题（题被删/换了卷）⇒ 灰，不是绿也不是粉', () => {
        expect(markForItem('e9', {}, [{ errorItemId: 'e1', markState: 'right' }])).toBe('none');
    });
});
