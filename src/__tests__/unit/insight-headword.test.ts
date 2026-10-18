/**
 * 日积月累 · 同词头归并（2026-10-18）
 *
 * 钉住的是一条**设计判断**：主附关系靠"同一个词头"，不靠手动连线；
 * 而且**宁可少并，不可错并** —— 语序不同就是两个词头。
 */

import { describe, it, expect } from 'vitest';
import {
    extractHeadword,
    groupByHeadword,
    headwordKey,
    occurrenceOf,
    type HeadwordItem,
} from '@/lib/insight-headword';

const item = (id: string, content: string, day: number): HeadwordItem => ({
    id,
    content,
    createdAt: new Date(2026, 9, day), // 2026-10-day
});

describe('extractHeadword', () => {
    it('四级标题 + emoji ⇒ 只留词头文字', () => {
        expect(extractHeadword('#### 🧠 分母越大，每份越小\n\n正文')).toBe('分母越大，每份越小');
    });

    it('第一行是正文（没有标题）⇒ 不猜，返回 null', () => {
        expect(extractHeadword('我今天发现了一件很有意思的事……')).toBeNull();
    });

    it('三级标题不算词头（格式统一走十一级之外的四级）', () => {
        expect(extractHeadword('### 三级标题\n正文')).toBeNull();
    });

    it('空内容 / null ⇒ null', () => {
        expect(extractHeadword('')).toBeNull();
        expect(extractHeadword(null)).toBeNull();
    });
});

describe('headwordKey', () => {
    it('标点、空白、emoji 都不参与比较', () => {
        expect(headwordKey('中心思想，怎么写')).toBe(headwordKey('中心思想 怎么写'));
        expect(headwordKey('📌 中心思想')).toBe(headwordKey('中心思想'));
    });

    it('大小写不参与比较', () => {
        expect(headwordKey('Center Idea')).toBe(headwordKey('center idea'));
    });

    it('语序不同 ⇒ 不同的词头（宁可少并，不可错并）', () => {
        expect(headwordKey('中心思想怎么写')).not.toBe(headwordKey('怎么写中心思想'));
    });
});

describe('groupByHeadword', () => {
    it('同一个词头攒三次 ⇒ 一组，主积累是最早那条', () => {
        const groups = groupByHeadword([
            item('c', '#### 📌 中心思想怎么写\n\n第三次：先找抒情句。', 20),
            item('a', '#### 📌 中心思想怎么写\n\n第一次：老师说要看开头结尾。', 3),
            item('b', '#### 📌 中心思想怎么写\n\n第二次：还要看反复出现的词。', 11),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0].items.map((x) => x.id)).toEqual(['a', 'b', 'c']); // 时间正序
        expect(groups[0].mainId).toBe('a'); // 主 = 最早
        expect(groups[0].headword).toBe('中心思想怎么写'); // 显示她的原话
    });

    it('没有词头的条目（摘抄、一段感受）不进任何组', () => {
        const groups = groupByHeadword([
            item('a', '#### 📌 中心思想怎么写\n正文', 3),
            item('b', '> 书上一段话，没有标题。', 4),
            item('c', '今天有点难过，说不清为什么。', 5),
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].items.map((x) => x.id)).toEqual(['a']);
    });

    it('标点/空格不同但词头相同 ⇒ 并；语序不同 ⇒ 不并', () => {
        const groups = groupByHeadword([
            item('a', '#### 📌 中心思想，怎么写\n正文 A', 3),
            item('b', '#### 📌 中心思想 怎么写\n正文 B', 4),
            item('c', '#### 📌 怎么写中心思想\n正文 C', 5),
        ]);
        expect(groups).toHaveLength(2);
        const merged = groups.find((g) => g.items.length === 2);
        expect(merged?.items.map((x) => x.id)).toEqual(['a', 'b']);
    });

    it('组与组之间按"最早那条"排（老的词在前）', () => {
        const groups = groupByHeadword([
            item('late', '#### 📌 后来才遇到的词\n正文', 30),
            item('early', '#### 📌 先遇到的词\n正文', 2),
        ]);
        expect(groups.map((g) => g.headword)).toEqual(['先遇到的词', '后来才遇到的词']);
    });
});

describe('occurrenceOf', () => {
    it('第二次记同一个词 ⇒ 第 2 次 / 共 3 次', () => {
        const b = item('b', '#### 📌 中心思想怎么写\n第二次', 11);
        const groups = groupByHeadword([
            item('a', '#### 📌 中心思想怎么写\n第一次', 3),
            b,
            item('c', '#### 📌 中心思想怎么写\n第三次', 20),
        ]);
        expect(occurrenceOf(b, groups)).toMatchObject({ index: 2, total: 3 });
    });

    it('没有词头的条目 ⇒ null（不显示序号）', () => {
        const quote = item('q', '> 一段摘抄', 5);
        expect(occurrenceOf(quote, groupByHeadword([quote]))).toBeNull();
    });
});
