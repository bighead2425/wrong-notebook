/**
 * 【2026-10-16 如如】复习结果**来源**枚举的看门测试。
 *
 * 钉三件事：
 *  ① ★ **深挖纸并入 `single_scan`**（他 21:35 拍板：来源不必细分）—— 别有人"好心"给深挖纸单开一个值。
 *  ② ★ **卷号只在复练纸/模仿纸那两行出现**（`volumeId` 那一半）。
 *  ③ ★ `legacy`（老数据补的流水）的显示 —— 界面靠它决定"不显示日期"。
 */

import { describe, expect, it } from 'vitest';
import {
    REVIEW_EVENT_SOURCES,
    isLegacySource,
    isReviewEventSource,
    normalizeReviewEventSource,
    reviewEventSourceLabel,
} from '@/lib/review-event-source';

describe('复习结果来源 · 取值集合', () => {
    it('★ 只有这五个（加值要改这里 + 界面 + 规格，别偷偷加）', () => {
        expect([...REVIEW_EVENT_SOURCES]).toEqual([
            'review_paper',
            'imitate_paper',
            'single_scan',
            'detail_page',
            'legacy',
        ]);
    });

    it('★ 没有 `deep_paper` 这个值 —— 深挖纸**并入** `single_scan`', () => {
        expect(isReviewEventSource('deep_paper')).toBe(false);
        expect(normalizeReviewEventSource('deep_paper')).toBe('single_scan');
    });

    it('认得出合法值；垃圾值一律归到 `single_scan`（绝不猜成"某张卷"）', () => {
        expect(isReviewEventSource('review_paper')).toBe(true);
        expect(normalizeReviewEventSource(null)).toBe('single_scan');
        expect(normalizeReviewEventSource('')).toBe('single_scan');
        expect(normalizeReviewEventSource(123)).toBe('single_scan');
    });
});

describe('复习结果来源 · 显示文字', () => {
    it('★ 复练纸/模仿纸**带卷号**（卷号是"真的需要用回去"的那一半）', () => {
        expect(reviewEventSourceLabel('review_paper', { volumeCode: 'RE20261016001' })).toBe(
            '复练纸 RE20261016001',
        );
        expect(reviewEventSourceLabel('imitate_paper', { volumeCode: 'IM20261016002' })).toBe(
            '模仿纸 IM20261016002',
        );
    });

    it('没给卷号时只显示纸型（不留一个空括号）', () => {
        expect(reviewEventSourceLabel('review_paper')).toBe('复练纸');
        expect(reviewEventSourceLabel('imitate_paper', { volumeCode: '  ' })).toBe('模仿纸');
    });

    it('★ 单题扫描录入 / 本页录入 —— 与他定的四个词一一对应', () => {
        expect(reviewEventSourceLabel('single_scan')).toBe('单题扫描录入');
        expect(reviewEventSourceLabel('detail_page')).toBe('本页录入');
    });

    it('★ legacy 显示"迁移前"（配合"时间列也写迁移前" —— 老数据没有可信日期）', () => {
        expect(reviewEventSourceLabel('legacy')).toBe('迁移前');
        expect(isLegacySource('legacy')).toBe(true);
        expect(isLegacySource('review_paper')).toBe(false);
    });

    it('英文也给（全站双语，别只写中文）', () => {
        expect(reviewEventSourceLabel('detail_page', { zh: false })).toBe('Entered here');
        expect(reviewEventSourceLabel('review_paper', { volumeCode: 'RE1', zh: false })).toBe('Review paper RE1');
        expect(reviewEventSourceLabel('legacy', { zh: false })).toBe('Before migration');
    });
});
