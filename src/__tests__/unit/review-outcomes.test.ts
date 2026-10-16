// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来（jsdom worker 会因内存超时）。
import { describe, expect, it } from 'vitest';
import {
    emptyReviewOutcomes,
    normalizeRecentOutcomes,
    normalizeReviewOutcomes,
    PLANNED_REVIEW_OFFSET_DAYS,
    PLANNED_REVIEW_ROUNDS,
    RECENT_REVIEW_LIMIT,
    REVIEW_DOT_COUNT,
    reviewDots,
    serializeReviewOutcomes,
} from '@/lib/review-outcomes';

/**
 * 复习结果 —— **错题卡底部那四个圆圈**的数据与规则。
 *
 * ⭐【2026-10-16 如如】判据换了（`docs\18` §2.2 / §4.1）：
 *   以前 = 真相就是这个字段，形状 `{planned:[…],last}`（4 计划格 + 最近一次）；
 *   现在 = 真相是 **`ReviewEvent` 流水**，这个字段降级成派生缓存
 *          （形状 `{recent:[…]}`，正序、最多 4 条）⇒ 卡片上 **4 个圈 = 最近 4 条**。
 *
 *   ⇒ 本文件也跟着分工：
 *     · **老形状**：只剩"**读**得出来"这件事要钉（过渡期老数据不能崩）——
 *       写老形状的三个入口（`setPlannedOutcome` / `setLastOutcome` / `recordReviewResult`）
 *       已于 2026-10-16 删除，对应的测试也一并删掉（**改行为必须改对应测试**）。
 *     · **新形状**：归一化 + 派生 + 画圈。
 */
describe('复习结果 · 归一化（老形状，只读不写）', () => {
    it('空值 / 坏 JSON / 非对象 ⇒ 所有圈都是"没结果"，绝不猜', () => {
        for (const v of [null, undefined, '', '   ', '不是 json', '{}', '[]', 123]) {
            const o = normalizeReviewOutcomes(v);
            expect(o).toEqual(emptyReviewOutcomes());
            expect(o.planned).toEqual([null, null, null, null]);
            expect(o.last).toBeNull();
        }
    });

    it('认 JSON 字符串（库里存的样子）也认对象（写入侧手里的样子）', () => {
        expect(
            normalizeReviewOutcomes('{"planned":["right",null,null,null],"last":"wrong"}')
        ).toEqual({
            planned: ['right', null, null, null],
            last: 'wrong',
        });
        expect(normalizeReviewOutcomes({ planned: ['wrong'], last: 'right' })).toEqual({
            planned: ['wrong', null, null, null],
            last: 'right',
        });
    });

    it('计划位多出来的忽略、缺的补 null；不认识的取值一律当"没结果"', () => {
        expect(
            normalizeReviewOutcomes({ planned: ['right', 'wrong', null, 'right', 'wrong'] }).planned
        ).toEqual(['right', 'wrong', null, 'right']);
        expect(normalizeReviewOutcomes({ planned: ['yes', 'no', 'right'] }).planned).toEqual([
            null,
            null,
            'right',
            null,
        ]);
        expect(normalizeReviewOutcomes({ planned: 'right' }).planned).toEqual([
            null,
            null,
            null,
            null,
        ]);
    });

    it('★ 老的 3 格数据读进来会被补成 4 格（扩格不用写迁移脚本）', () => {
        expect(normalizeReviewOutcomes({ planned: ['right', 'wrong', 'right'], last: 'right' })).toEqual({
            planned: ['right', 'wrong', 'right', null],
            last: 'right',
        });
    });

    it('存库字符串能原样读回来（往返保真）', () => {
        const o = { planned: ['right', 'wrong', null, null] as const, last: 'wrong' as const };
        expect(
            normalizeReviewOutcomes(serializeReviewOutcomes({ planned: [...o.planned], last: o.last }))
        ).toEqual({ planned: ['right', 'wrong', null, null], last: 'wrong' });
    });

    it('计划格就是 4 个（纸张背面印着四个日期框，这是纸面的事）', () => {
        expect(PLANNED_REVIEW_ROUNDS).toBe(4);
        expect(PLANNED_REVIEW_OFFSET_DAYS).toEqual([1, 7, 21, 49]);
    });
});

describe('复习结果 · 新形状（recent = 流水派生出来的那 4 条）', () => {
    it('★ 新形状直接读：正序，末尾 = 最近一次', () => {
        expect(normalizeRecentOutcomes('{"recent":["wrong","right","right"]}')).toEqual([
            'wrong',
            'right',
            'right',
        ]);
        expect(normalizeRecentOutcomes({ recent: ['right'] })).toEqual(['right']);
    });

    it('★ **老形状也能读出来**（过渡期：库里还是老数据时不能崩、不能显示成全灰）', () => {
        // 展开规则 = `planned` 非空值按序留下 + `last` 与最后一条不同才追加
        expect(
            normalizeRecentOutcomes({ planned: ['right', 'wrong', null, null], last: 'right' })
        ).toEqual(['right', 'wrong', 'right']);
        // 三次全对 + last 也是对 ⇒ 不会多出一条"第四次"
        expect(
            normalizeRecentOutcomes({ planned: ['right', 'right', 'right', null], last: 'right' })
        ).toEqual(['right', 'right', 'right']);
        // 只有 last（计划格没填）⇒ 就一条
        expect(normalizeRecentOutcomes({ planned: [null, null, null, null], last: 'wrong' })).toEqual([
            'wrong',
        ]);
    });

    it('超出 4 条 ⇒ **取末尾 4 条**（末尾才是最近几次）', () => {
        // 5 条：最早那条（right）被挤掉，留下末尾 4 条
        expect(
            normalizeRecentOutcomes({ recent: ['right', 'right', 'wrong', 'wrong', 'right'] })
        ).toEqual(['right', 'wrong', 'wrong', 'right']);
        expect(RECENT_REVIEW_LIMIT).toBe(4);
    });

    it('坏值 / 空对象 ⇒ 空数组（不是"猜成对"）', () => {
        for (const v of [null, undefined, '', '乱码', '{}', '[]', { recent: 'right' }, 7]) {
            expect(normalizeRecentOutcomes(v)).toEqual([]);
        }
        expect(normalizeRecentOutcomes({ recent: ['yes', 'right', 3] })).toEqual(['right']);
    });
});

describe('复习结果 · 卡片上那四个圈', () => {
    it('★★ 四个圈 —— 顺序即 recent，不足 4 条后面画灰圈；**没有 `|`、没有日期**', () => {
        const dots = reviewDots({ recent: ['right', 'wrong'] });
        expect(dots).toHaveLength(REVIEW_DOT_COUNT);
        expect(dots.map((d) => d.state)).toEqual(['right', 'wrong', 'none', 'none']);
    });

    it('满 4 条 ⇒ 四个圈各有状态', () => {
        const dots = reviewDots({ recent: ['right', 'wrong', 'wrong', 'right'] });
        expect(dots.map((d) => d.state)).toEqual(['right', 'wrong', 'wrong', 'right']);
    });

    it('★ 悬停说明：最后一个有结果的圈是"最近一次"，往前是"倒数第 N 次"', () => {
        const dots = reviewDots({ recent: ['right', 'wrong'] });
        expect(dots[1].zh).toContain('最近一次');
        expect(dots[0].zh).toContain('倒数第 2 次');
        expect(dots[2].zh).toContain('还没有结果');
    });

    it('★ 老形状（库里还没迁移的题）⇒ 圈**照样有值**，不能全灰', () => {
        // 验收 #11：老题（迁移前录过结果的）错题卡的圈还在
        const dots = reviewDots({ planned: ['right', 'wrong', 'right', null], last: 'right' });
        expect(dots.map((d) => d.state)).toEqual(['right', 'wrong', 'right', 'none']);
    });

    it('空值也返回四个圈（画面上不能少一个，否则"最近几个"就对不上了）', () => {
        const dots = reviewDots(undefined);
        expect(dots).toHaveLength(REVIEW_DOT_COUNT);
        expect(dots.every((d) => d.state === 'none')).toBe(true);
        expect(dots.every((d) => d.zh.includes('还没有结果'))).toBe(true);
    });
});
