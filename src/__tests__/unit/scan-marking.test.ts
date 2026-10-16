// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：扫到的卷页「纸面直接录入」那两组控件的规则。
import { describe, expect, it } from 'vitest';
import {
    EMPTY_VOLUME_MARK,
    nextReviewMark,
    normalizeVolumeMark,
    PROMOTE_APPLIED_BG,
    PROMOTE_APPLIED_LABEL_EN,
    PROMOTE_APPLIED_LABEL_ZH,
    promoteToggleFor,
    REVIEW_MARK_COLORS,
    reviewMarkFromOutcomes,
    volumeMarkMap,
    volumeMarkOf,
} from '@/lib/scan-marking';

/**
 * 【2026-10-16 如如】灰圆的循环 —— **从三态改成两态**。
 *
 * ⚠️ 这是他亲自定的改造核心：旧的三态（灰 → 对 → 错 → 灰）让
 *    "**错改对**"必须经过"**清空**"，而且那个中间态还会落一次库。
 *    现在：**点一下就在"对 ⇄ 错"之间换**，灰只代表"这张卷上还没录"。
 *    ⇒ 撤销不再靠点击，改走**长按菜单的"删除这一条"**。
 */
describe('扫卷录入 · 灰圆两态循环', () => {
    it('★★ 对 ⇄ 错 来回换 —— **永远不回到 none**（那正是"错改对"不再需要两次点击的原因）', () => {
        // 灰圈点一下 ⇒ 对
        expect(nextReviewMark('none')).toBe('right');
        // 已经是对 ⇒ 点一下变错
        expect(nextReviewMark('right')).toBe('wrong');
        // 已经是错 ⇒ 点一下**回到对**（旧行为是回到灰 ⇒ 必须点两次才能"错改对"）
        expect(nextReviewMark('wrong')).toBe('right');
        // 连着点**两次** ⇒ 回到原态（两态循环的定义）
        expect(nextReviewMark(nextReviewMark('wrong'))).toBe('wrong');
        expect(nextReviewMark(nextReviewMark('right'))).toBe('right');
    });

    it('★ 圆现在的态由"最近一次复习结果"还原（保留的另一个问题：卡片/详情用得上）', () => {
        expect(reviewMarkFromOutcomes(null)).toBe('none');
        expect(reviewMarkFromOutcomes('{"planned":["right","wrong",null],"last":"right"}')).toBe('right');
        expect(reviewMarkFromOutcomes({ planned: [null, null, null], last: 'wrong' })).toBe('wrong');
        // last 为空 ⇒ 灰（哪怕计划位里有值）
        expect(reviewMarkFromOutcomes({ planned: ['right', null, null], last: null })).toBe('none');
    });

    it('两态配色与错题卡的圈**同一份常量**（同一屏不许两套红绿）', () => {
        expect(REVIEW_MARK_COLORS.right.bg).toBe('#6fbf8b');
        expect(REVIEW_MARK_COLORS.wrong.bg).toBe('#f6c9cf');
        expect(REVIEW_MARK_COLORS.none.bg).toBe('#9ca3af');
        expect(REVIEW_MARK_COLORS.right.fg).toBe('#ffffff');
        expect(REVIEW_MARK_COLORS.wrong.fg).toBe('#8a8a8a');
    });
});

/**
 * 【2026-10-02 他定的】圆态**按卷**判断 —— 这一组是那条要求的看门测试。
 *
 * 场景（他原话）："如果扫的是另外一个**没有扫描过**的新卷，
 * 即使有这道题**还是应该给灰圈**。"
 * ⇒ 同一道题在 A 卷标了"对"，换到没扫过的 B 卷打开，B 卷里那道题必须是灰的。
 *
 * ⭐【2026-10-16】读源换成"**这一卷上最近一条流水**"（`ReviewEvent`）——
 *    "哪一卷"这个维度由服务端那次查询保证（`volumeId = 这张卷`），
 *    所以下面用"两张卷各自的 map"来表达同一件事。
 */
describe('扫卷录入 · 圆态按卷记（换新卷要给灰圈）', () => {
    const mark = (outcome: 'right' | 'wrong' | null, rounds = 1) => ({
        errorItemId: 'e1',
        mark: outcome,
        eventId: outcome ? 'ev-1' : null,
        rounds,
    });

    it('★ 同一道题：A 卷录过 ⇒ 在 A 卷显示绿；在没录过的 B 卷显示灰', () => {
        const volA = volumeMarkMap([mark('right')]);
        expect(volumeMarkOf('e1', {}, volA).mark).toBe('right');
        // B 卷里也有这道题（卷里根本没这一行记录）⇒ 灰
        expect(volumeMarkOf('e1', {}, {}).mark).toBe('none');
    });

    it('记的是 wrong 就画粉；值不认识（脏数据）一律当灰', () => {
        expect(volumeMarkOf('e1', {}, volumeMarkMap([mark('wrong')])).mark).toBe('wrong');
        expect(normalizeVolumeMark({ errorItemId: 'e1', mark: 'WHAT' }).mark).toBe('none');
        expect(normalizeVolumeMark({ errorItemId: 'e1' }).mark).toBe('none');
        expect(normalizeVolumeMark(null)).toEqual(EMPTY_VOLUME_MARK);
    });

    it('本地（乐观）覆盖最优先 —— 刚点完还没重拉时立刻反映', () => {
        const server = volumeMarkMap([mark('right')]);
        expect(
            volumeMarkOf('e1', { e1: { mark: 'wrong', eventId: 'ev-1', rounds: 2 } }, server).mark,
        ).toBe('wrong');
    });

    it('卷里根本没有这道题（题被删 / 换了卷）⇒ 灰，不是绿也不是粉', () => {
        expect(volumeMarkOf('e9', {}, volumeMarkMap([mark('right')])).mark).toBe('none');
    });

    it('★ 轮次角标要的数（`rounds`）来自服务端：几轮就是几条', () => {
        expect(volumeMarkOf('e1', {}, volumeMarkMap([mark('right', 3)])).rounds).toBe(3);
        expect(volumeMarkOf('e1', {}, {}).rounds).toBe(0);
    });

    it('★ "删除这一条"要的那个 id 也在同一份数据里（没有记录 ⇒ null）', () => {
        expect(volumeMarkOf('e1', {}, volumeMarkMap([mark('right')])).eventId).toBe('ev-1');
        expect(volumeMarkOf('e1', {}, {}).eventId).toBeNull();
    });

    it('接口那串数组按题 id 建表；缺 id / 非对象的行直接跳过（不炸）', () => {
        const map = volumeMarkMap([
            { errorItemId: 'a', mark: 'right', eventId: 'x', rounds: 1 },
            { errorItemId: '', mark: 'wrong' },
            null,
            'nope',
        ]);
        expect(Object.keys(map)).toEqual(['a']);
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
