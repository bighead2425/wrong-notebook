/**
 * 【2026-10-20 真真】「等级」合并筛选的键 —— 空空当天加「预掌握」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 他原话："这个等级下拉菜单中，在『已掌握』下面还是应该增加一个『预掌握』选项，
 *          有了这个预掌握，才更方便实用。"
 *
 * ⚠️ 「预掌握」**不是新的一档等级**，也不占 `masteryLevel` 的值 ——
 *    判据是 `lib/level-settle.ts` 的 `isPreMastered()`：等级 1（连对 ≥3 锁定）+ 倒数走到 0。
 *    接口那边按**同一判据**筛（`attention: 1` + `levelCountdown: { lte: 0 }` + `masteryLevel: { lt: 2 }`）。
 *
 * 这里只钉三件最容易在以后被改坏的事：
 *   ① 它在**已掌握之后**（顺序是他明确说的"下面"）；
 *   ② URL 里那一串认得它（`parseFilterKeys`）；
 *   ③ 它**不是某一档等级**（`filterKeyToLevel` 必须返回 null，
 *      否则会被当成"等级几"混进等级分支，筛出完全不相干的一批）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import {
    FILTER_KEYS,
    MASTERED_FILTER_KEY,
    PRE_MASTERED_FILTER_KEY,
    filterKeyToLevel,
    parseFilterKeys,
} from '@/lib/attention-level';

describe('等级合并筛选 · 预掌握', () => {
    it('★ 排在「已掌握」**下面**（数组里紧跟其后）', () => {
        expect(FILTER_KEYS[0]).toBe(MASTERED_FILTER_KEY);
        expect(FILTER_KEYS[1]).toBe(PRE_MASTERED_FILTER_KEY);
    });

    it('★ URL 里的 `preMastered` 认得出来（否则点完刷新就丢）', () => {
        expect(parseFilterKeys('mastered,preMastered,3')).toEqual([
            MASTERED_FILTER_KEY,
            PRE_MASTERED_FILTER_KEY,
            '3',
        ]);
    });

    it('★ 它不是某一档等级 —— `filterKeyToLevel` 必须返回 null', () => {
        expect(filterKeyToLevel(PRE_MASTERED_FILTER_KEY)).toBeNull();
        // 对照：真的等级仍然返回数字
        expect(filterKeyToLevel('3')).toBe(3);
    });
});
