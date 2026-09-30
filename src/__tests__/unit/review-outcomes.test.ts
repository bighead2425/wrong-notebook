// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来（jsdom worker 会因内存超时）。
import { describe, expect, it } from 'vitest';
import {
    emptyReviewOutcomes,
    normalizeReviewOutcomes,
    PLANNED_REVIEW_ROUNDS,
    recordReviewResult,
    reviewDots,
    serializeReviewOutcomes,
} from '@/lib/review-outcomes';

/**
 * 复习结果（错题卡底部那**四个圆圈**）。
 *
 * 钉住的是他专门解释过的两条规矩：
 *   ① 计划内做完一次 ⇒ **第四个圈（最近一次）同步成同一结果**
 *      （"只复习了一次做对了，第一个圈是绿勾，第四个圈也是绿勾"）
 *   ② 计划外再复习 ⇒ **前三个圈纹丝不动**，只有第四个圈变成这一次的结果
 *      （"前三个圈都是绿勾，后来有一次做错了 ⇒ 前三个不动，第四个变粉叉"）
 */
describe('复习结果 · 归一化', () => {
    it('空值 / 坏 JSON / 非对象 ⇒ 四个圈都是"没结果"，绝不猜', () => {
        for (const v of [null, undefined, '', '   ', '不是 json', '{}', '[]', 123]) {
            const o = normalizeReviewOutcomes(v);
            expect(o).toEqual(emptyReviewOutcomes());
            expect(o.planned).toEqual([null, null, null]);
            expect(o.last).toBeNull();
        }
    });

    it('认 JSON 字符串（库里存的样子）也认对象（写入侧手里的样子）', () => {
        expect(normalizeReviewOutcomes('{"planned":["right",null,null],"last":"wrong"}')).toEqual({
            planned: ['right', null, null],
            last: 'wrong',
        });
        expect(normalizeReviewOutcomes({ planned: ['wrong'], last: 'right' })).toEqual({
            planned: ['wrong', null, null],
            last: 'right',
        });
    });

    it('计划位多出来的忽略、缺的补 null；不认识的取值一律当"没结果"', () => {
        expect(normalizeReviewOutcomes({ planned: ['right', 'wrong', null, 'right', 'wrong'] }).planned)
            .toEqual(['right', 'wrong', null]);
        expect(normalizeReviewOutcomes({ planned: ['yes', 'no', 'right'] }).planned)
            .toEqual([null, null, 'right']);
        expect(normalizeReviewOutcomes({ planned: 'right' }).planned).toEqual([null, null, null]);
    });

    it('存库字符串能原样读回来（往返保真）', () => {
        const o = { planned: ['right', 'wrong', null] as const, last: 'wrong' as const };
        expect(normalizeReviewOutcomes(serializeReviewOutcomes({ planned: [...o.planned], last: o.last })))
            .toEqual({ planned: ['right', 'wrong', null], last: 'wrong' });
    });
});

describe('复习结果 · 记一次结果', () => {
    it('★ 第一次计划复习做对 ⇒ 第 1 个圈绿、**第 4 个圈也绿**', () => {
        const o = recordReviewResult(null, 'right', 0);
        expect(o.planned).toEqual(['right', null, null]);
        expect(o.last).toBe('right');
    });

    it('计划内的一次做错 ⇒ 同样同步到"最近一次"', () => {
        const o = recordReviewResult({ planned: ['right', null, null], last: 'right' }, 'wrong', 1);
        expect(o.planned).toEqual(['right', 'wrong', null]);
        expect(o.last).toBe('wrong');
    });

    it('★ 计划外再复习 ⇒ 前三个圈**纹丝不动**，只有第 4 个圈变', () => {
        const before = { planned: ['right', 'right', 'right'], last: 'right' };
        const o = recordReviewResult(before, 'wrong'); // 不传 plannedIndex = 计划外
        expect(o.planned).toEqual(['right', 'right', 'right']);
        expect(o.last).toBe('wrong');
    });

    it('反复记只动该动的那一格（第 3 次计划复习）', () => {
        const o = recordReviewResult(
            { planned: ['right', 'wrong', null], last: 'wrong' },
            'right',
            2,
        );
        expect(o.planned).toEqual(['right', 'wrong', 'right']);
        expect(o.last).toBe('right');
    });

    it('三次计划位就是三个（多了没地方放，这是计划本身的定义）', () => {
        expect(PLANNED_REVIEW_ROUNDS).toBe(3);
    });
});

describe('复习结果 · 四个圈的画法', () => {
    it('顺序：第 1 天 / 第 7 天 / 第 21 天 / 最近一次', () => {
        const dots = reviewDots({ planned: ['right', null, 'wrong'], last: 'wrong' });
        expect(dots.map((d) => d.key)).toEqual(['p1', 'p2', 'p3', 'last']);
        expect(dots.map((d) => d.state)).toEqual(['right', 'none', 'wrong', 'wrong']);
    });

    it('每个圈都带一句人话的悬停说明（中文里有"第 7 天"这种可核对的字）', () => {
        const dots = reviewDots(null);
        expect(dots[1].zh).toContain('第 7 天');
        expect(dots[3].zh).toContain('最近一次');
        expect(dots[0].zh).toContain('还没有结果');
    });

    it('空值也返回四个圈（画面上不能少一个，否则"第几个"就对不上了）', () => {
        expect(reviewDots(undefined)).toHaveLength(4);
    });
});
