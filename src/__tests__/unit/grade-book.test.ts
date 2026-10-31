/**
 * 册名归一的单测。
 *
 * 背景（都是线上库里的真实写法，不是编的）：
 *   '五年级上'(64) / '六年级上'(33) / '五年级/上学期'(3) / '四年级上'(1)
 *   '五年级下'(1) / '五年级'(1) / 'Grade 6, 1st Semester'(1)
 * 词表只认 '五年级上' —— 认不出就等于"没有当前册"，整册候选全丢。
 */

import { describe, it, expect } from 'vitest';
import { normalizeGradeBook, bookFromNotebook, isKnownBook } from '@/lib/grade-book';

describe('normalizeGradeBook', () => {
    it('已经规范的写法原样返回', () => {
        expect(normalizeGradeBook('五年级上')).toBe('五年级上');
        expect(normalizeGradeBook('六年级下')).toBe('六年级下');
        expect(normalizeGradeBook('八年级上')).toBe('八年级上');
    });

    it('斜杠写法（线上实际存在）', () => {
        expect(normalizeGradeBook('五年级/上学期')).toBe('五年级上');
        expect(normalizeGradeBook('五年级/下学期')).toBe('五年级下');
    });

    it('"上学期" / 空格 / 括号 都能认', () => {
        expect(normalizeGradeBook('五年级 上学期')).toBe('五年级上');
        expect(normalizeGradeBook('五年级（上）')).toBe('五年级上');
        expect(normalizeGradeBook(' 四年级上 ')).toBe('四年级上');
    });

    it('英文写法', () => {
        expect(normalizeGradeBook('Grade 6, 1st Semester')).toBe('六年级上');
        expect(normalizeGradeBook('Grade 6, 2nd Semester')).toBe('六年级下');
    });

    it('高中：高三在词表里就只有一册，不分上下', () => {
        expect(normalizeGradeBook('高三上')).toBe('高三');
        expect(normalizeGradeBook('高二上')).toBe('高二上');
        expect(normalizeGradeBook('高二下')).toBe('高二下');
    });

    it('只有年级、认不出哪一册 ⇒ 返回 null，不猜', () => {
        expect(normalizeGradeBook('五年级')).toBeNull();
        expect(normalizeGradeBook('')).toBeNull();
        expect(normalizeGradeBook(null)).toBeNull();
        expect(normalizeGradeBook('不知道')).toBeNull();
    });
});

describe('bookFromNotebook', () => {
    it('本子的 grade + semester 拼起来（线上真实值：五年级 + 上）', () => {
        expect(bookFromNotebook('五年级', '上')).toBe('五年级上');
        expect(bookFromNotebook('五年级', '下')).toBe('五年级下');
    });

    it('本子年级是空串 ⇒ 不拼出个"上"来', () => {
        expect(bookFromNotebook('', '上')).toBeNull();
        expect(bookFromNotebook(null, '上')).toBeNull();
    });

    it('本子的 grade 本身就带学期（历史数据）', () => {
        expect(bookFromNotebook('五年级上', '上')).toBe('五年级上');
        expect(bookFromNotebook('五年级上', '')).toBe('五年级上');
    });
});

describe('isKnownBook', () => {
    it('词表里有的册', () => {
        expect(isKnownBook('五年级上')).toBe(true);
        expect(isKnownBook('九年级下')).toBe(true);
        expect(isKnownBook('高二下')).toBe(true);
        expect(isKnownBook('高三')).toBe(true);
    });

    it('词表里没有的不认', () => {
        expect(isKnownBook('五年级')).toBe(false);
        expect(isKnownBook('高四上')).toBe(false);
        expect(isKnownBook('')).toBe(false);
        expect(isKnownBook(null)).toBe(false);
    });
});
