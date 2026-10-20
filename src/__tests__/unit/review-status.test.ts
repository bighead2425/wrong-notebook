/**
 * 【2026-10-13 他拍板的设计】题目状态（由事实算出来，不落库）—— 单测。
 *
 * 规则只有一条：**对 ⇒ 连对 +1、间隔拉长；错 ⇒ 连对清零、明天再来。**
 * 他当初纠结的"连着两次都对了要不要降档""三次都对了算不算已掌握"，
 * 在这条规则下**不需要人判** —— 这些测试就是在钉"人不用再纠结"这件事。
 *
 * ✅ 【2026-10-14】门槛已改回他批的 **4 次** —— 带时间戳的复习事件表（`ReviewEvent`）上线后，
 *    "计划格满了之后又对一次"**认得出来**了；纸面也从 3 格扩到 **4 格**（偏移 +49）。
 *    ⇒ 下面那些"连对 N 次"的用例都按 **4 格**造数据。
 */
import { describe, expect, it } from 'vitest';
import {
    RETIRE_STREAK,
    reviewEventSequence,
    reviewStatusOf,
    reviewStatusSentence,
} from '@/lib/review-status';
import { serializeReviewOutcomes } from '@/lib/review-outcomes';

const TODAY = new Date('2026-10-13T09:00:00');

/** 造一条 outcomes：planned 四格 + last */
function make(planned: ('right' | 'wrong' | null)[], last: 'right' | 'wrong' | null) {
    return serializeReviewOutcomes({ planned, last });
}

describe('reviewStatusOf —— 状态、连对、紧迫度、下次该什么时候练', () => {
    it('★ 一条结果都没有 ⇒ 新 / 最急（5）/ 明天', () => {
        const s = reviewStatusOf(make([null, null, null], null), TODAY);
        expect(s.state).toBe('new');
        expect(s.urgency).toBe(5);
        expect(s.nextDueKey).toBe('2026-10-14'); // 今天 +1 天
        expect(s.evidenceCount).toBe(0);
    });

    it('★ 做错一次 ⇒ 要练 / 紧迫 4 / **3 天**后再练（2026-10-21 改：4 级原 4 天 → 3 天）', () => {
        const s = reviewStatusOf(make([null, null, null], 'wrong'), TODAY);
        expect(s.state).toBe('due');
        expect(s.wrongStreak).toBe(1);
        expect(s.rightStreak).toBe(0);
        expect(s.urgency).toBe(4);
        expect(s.nextDueKey).toBe('2026-10-16');
    });

    it('★ 连着错两次以上 ⇒ 紧迫升到 5（不是偶然，要格外注意）', () => {
        // 计划内两格是错 + 最近一次也是错（与最后一个计划格相同 ⇒ 不重复计数，见事件序列那条）
        const s = reviewStatusOf(make(['wrong', 'wrong', null], 'wrong'), TODAY);
        expect(s.state).toBe('due');
        expect(s.wrongStreak).toBe(2);
        expect(s.urgency).toBe(5);
    });

    it('⚠️ 同一族的"认不出来"：计划外又出**同一个结果**时，看不出来（只算计划内那一次）', () => {
        // planned=[对,错,空] + last=错 —— 到底是"第 7 天错了"还是"第 7 天错了、之后计划外又错一次"，
        // 没有时间戳分不开 ⇒ 一律按 1 次算。**方向是保守的**（错没被多算 ⇒ 紧迫度不会虚高）
        const s = reviewStatusOf(make(['right', 'wrong', null], 'wrong'), TODAY);
        expect(reviewEventSequence(make(['right', 'wrong', null], 'wrong'))).toEqual(['right', 'wrong']);
        expect(s.wrongStreak).toBe(1);
        expect(s.state).toBe('due');
        expect(s.urgency).toBe(4);
    });

    it('★ 连对 1 次 ⇒ 复练中 / 紧迫 3 / **7 天**后再练（3 级）', () => {
        const s = reviewStatusOf(make([null, null, null], 'right'), TODAY);
        expect(s.state).toBe('practicing');
        expect(s.rightStreak).toBe(1);
        expect(s.urgency).toBe(3);
        expect(s.nextDueKey).toBe('2026-10-20'); // +7
    });

    it('★ 连对 2 次 ⇒ 复练中 / 紧迫 2 / **14 天**后再练（2 级，原 21 天）', () => {
        const s = reviewStatusOf(make(['right', 'right', null], 'right'), TODAY);
        expect(s.state).toBe('practicing');
        expect(s.rightStreak).toBe(2);
        expect(s.urgency).toBe(2);
        expect(s.nextDueKey).toBe('2026-10-27'); // +14
    });

    it('★ 连对 3 次 ⇒ **1 级（锁定）** / **28 天**后再练（2026-10-21 新增这一档，原 49 天）', () => {
        const s = reviewStatusOf(make(['right', 'right', 'right', null], 'right'), TODAY);
        expect(s.state).toBe('practicing');
        expect(s.rightStreak).toBe(3);
        expect(s.nextDueKey).toBe('2026-11-10'); // +28
    });

    it(`★ 连对 ${RETIRE_STREAK} 次（计划内四格全对）⇒ 退休、不再排进复练`, () => {
        const s = reviewStatusOf(make(['right', 'right', 'right', 'right'], 'right'), TODAY);
        expect(s.rightStreak).toBe(RETIRE_STREAK);
        expect(s.state).toBe('retired');
        expect(s.urgency).toBe(1);
        expect(s.nextDueKey).toBeNull();
        expect(reviewStatusSentence(s, true)).toContain('不必再排');
    });

    it('★ 退休之后再错一次 ⇒ 立刻回到"要练"、连对清零（没有一劳永逸）', () => {
        const s = reviewStatusOf(make(['right', 'right', 'right', 'right'], 'wrong'), TODAY);
        expect(s.state).toBe('due');
        expect(s.rightStreak).toBe(0);
        expect(s.wrongStreak).toBe(1);
        expect(s.urgency).toBe(4);
    });

    it('★ 计划内做完 ⇒ 最后一格同步，不会被重复数成两次（他 09-30 定的规矩 ①）', () => {
        const s = reviewStatusOf(make(['right', null, null], 'right'), TODAY);
        expect(s.rightStreak).toBe(1);
        expect(s.evidenceCount).toBe(1);
        /**
         * 【2026-10-16 如如】原来这里断言 `s.plannedDone` —— 那个字段**全仓只有这条测试在读**
         * （生产代码一处都没有）⇒ 本轮"流水为真相"改造时**直接删掉**它，不换成
         * `events.length` 再养一个没人用的字段。
         * ⇒ 断言的**意图**保留下来：老形状与新形状读出来必须一样（过渡期最关键的一条）。
         */
        const same = reviewStatusOf({ recent: ['right'] }, TODAY);
        expect(same.rightStreak).toBe(1);
        expect(same.evidenceCount).toBe(1);
    });

    it('★ 计划外的复习接在计划内后面（规矩 ②：计划格不动、只动最近一次）', () => {
        expect(reviewEventSequence(make(['right', 'right', null], 'wrong'))).toEqual(['right', 'right', 'wrong']);
        const s = reviewStatusOf(make(['right', 'right', null], 'wrong'), TODAY);
        expect(s.state).toBe('due');
        expect(s.wrongStreak).toBe(1);
    });

    it('✅ 四格全对 ⇒ 数到 4（2026-10-14：门槛回到 4，从前的"只数到 3"已解除）', () => {
        const s = reviewStatusOf(make(['right', 'right', 'right', 'right'], 'right'), TODAY);
        // 纸面扩到 4 格后，"四格全对"就是货真价实的 4 次 ⇒ 正好达到 RETIRE_STREAK。
        // ⚠️ 但"四格满了之后**又**计划外对了一次"仍认不出来（那要靠 `ReviewEvent` 表来数）——
        //    所以状态机目前仍以 `reviewOutcomes` 为准（**切读源是后续的事**）。
        expect(s.evidenceCount).toBe(4);
        expect(s.state).toBe('retired');
    });

    it('脏数据不崩（空串 / 乱 JSON / 非法值一律当"没结果"）', () => {
        for (const bad of ['', '   ', '{oops', null, undefined, '{"planned":["x",1,false],"last":"?"}']) {
            const s = reviewStatusOf(bad, TODAY);
            expect(s.state).toBe('new');
            expect(s.urgency).toBe(5);
        }
    });

    it('紧迫度就是"能不能排序"的那个数：退休 1 < 连对2次 2 < 连对1次 3 < 刚错 4 < 新/连错 5', () => {
        expect(reviewStatusOf(make(['right', 'right', 'right', 'right'], 'right'), TODAY).urgency).toBe(1);
        expect(reviewStatusOf(make(['right', 'right', null], 'right'), TODAY).urgency).toBe(2);
        expect(reviewStatusOf(make([null, null, null], 'right'), TODAY).urgency).toBe(3);
        expect(reviewStatusOf(make([null, null, null], 'wrong'), TODAY).urgency).toBe(4);
        expect(reviewStatusOf(make([null, null, null], null), TODAY).urgency).toBe(5);
    });

    it('一句话说明里**必须带上证据条数**（判断有多准要看得见）', () => {
        const s = reviewStatusOf(make([null, null, null], 'right'), TODAY);
        expect(reviewStatusSentence(s, true)).toContain('已有 1 次复练结果');
        expect(reviewStatusSentence(s, false)).toContain('1 result(s)');
    });
});
