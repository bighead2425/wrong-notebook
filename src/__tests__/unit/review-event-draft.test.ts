/**
 * 【2026-10-16 如如】复习事件**草稿构造器**的看门测试。
 *
 * 为什么要单测一个"拼 JSON"的小函数：它的输出**直接决定服务端认不认**
 * （`parseReviewEventInput()` 形状不对就整个丢掉，而且**静默丢掉**——
 *  这正是 `ReviewEvent` 表此前空着的那个 bug 的同一类危险）。所以这里要钉住：
 *  · **字段名与形状**（改一个名就红）
 *  · **日期是本地日**（与服务端那条时区铁律一致）
 *  · **`'last'` 要变成 `null`**（服务端把 null 解释成"计划外的额外复习"）
 */

import { describe, expect, it } from 'vitest';
import { reviewEventDraft } from '@/lib/review-event-draft';
import { dayKey } from '@/lib/calendar-grid';
import { REVIEW_OFFSETS_DAYS } from '@/lib/deep-dive-card';

describe('复习事件草稿 · 形状（服务端认不认）', () => {
    it('★ 字段名必须**正好**是这三个（多一个少一个都会让服务端整条丢掉）', () => {
        const draft = reviewEventDraft({ outcome: 'right', plannedIndex: 0 });
        expect(Object.keys(draft).sort()).toEqual(['occurredOn', 'outcome', 'plannedIndex']);
    });

    it('★ 给了 volumeId 才出现这个键（空值不许塞进去）', () => {
        expect(reviewEventDraft({ outcome: 'wrong', plannedIndex: 1, volumeId: 'vol-1' }).volumeId).toBe('vol-1');
        expect('volumeId' in reviewEventDraft({ outcome: 'wrong', plannedIndex: 1, volumeId: null })).toBe(false);
        expect('volumeId' in reviewEventDraft({ outcome: 'wrong', plannedIndex: 1, volumeId: '' })).toBe(false);
    });

    it('★ occurredOn 形状必须是 `YYYY-MM-DD`（服务端只认这个形状）', () => {
        expect(reviewEventDraft({ outcome: 'right', plannedIndex: 0 }).occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('复习事件草稿 · 日期口径（本地日，不是 UTC）', () => {
    it('★ 与 `dayKey()` 同源 —— 就是"这台机器上的今天"', () => {
        const d = new Date(2026, 2, 5, 7, 0, 0); // 本地 03-05 07:00
        expect(reviewEventDraft({ outcome: 'right', plannedIndex: 0, today: d }).occurredOn).toBe(dayKey(d));
    });

    it('★ 深夜 23:59 仍算**当天**（不许跑到次日）', () => {
        const d = new Date(2026, 2, 5, 23, 59, 59);
        expect(reviewEventDraft({ outcome: 'right', plannedIndex: 0, today: d }).occurredOn).toBe(dayKey(d));
    });

    it('★ 凌晨 00:00 算**新的一天**（不许赖在昨天）', () => {
        const d = new Date(2026, 2, 5, 0, 0, 0);
        const before = new Date(2026, 2, 4, 23, 59, 59);
        expect(reviewEventDraft({ outcome: 'right', plannedIndex: 0, today: d }).occurredOn).not.toBe(
            reviewEventDraft({ outcome: 'right', plannedIndex: 0, today: before }).occurredOn,
        );
    });
});

describe('复习事件草稿 · plannedIndex 的三种可能', () => {
    it("★ 计划格 0..3 原样保留（长度跟着 `REVIEW_OFFSETS_DAYS` 走）", () => {
        for (let i = 0; i < REVIEW_OFFSETS_DAYS.length; i += 1) {
            expect(reviewEventDraft({ outcome: 'right', plannedIndex: i }).plannedIndex).toBe(i);
        }
    });

    it("★ `'last'`（最近一次那一行）⇒ `null`（服务端把 null 当“计划外”）", () => {
        expect(reviewEventDraft({ outcome: 'wrong', plannedIndex: 'last' }).plannedIndex).toBeNull();
    });

    it('★ 没给 / 给了奇怪的值 ⇒ 一律 `null`（宁可当"计划外"，也不编一个格子号）', () => {
        expect(reviewEventDraft({ outcome: 'wrong', plannedIndex: null }).plannedIndex).toBeNull();
        expect(reviewEventDraft({ outcome: 'wrong', plannedIndex: 1.5 }).plannedIndex).toBeNull();
        expect(reviewEventDraft({ outcome: 'wrong', plannedIndex: Number.NaN }).plannedIndex).toBeNull();
    });

    it('outcome 原样透传（对/错不在这里转换）', () => {
        expect(reviewEventDraft({ outcome: 'right', plannedIndex: 0 }).outcome).toBe('right');
        expect(reviewEventDraft({ outcome: 'wrong', plannedIndex: 0 }).outcome).toBe('wrong');
    });
});
