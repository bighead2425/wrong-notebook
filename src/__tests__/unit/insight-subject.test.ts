/**
 * 日积月累 · AI 顺手判学科（2026-10-19 空空第 2 条）
 *
 * 钉住的是三件事：
 *  ① 标记**取得出来、剥得干净**（不许留在正文里被印到纸上）；
 *  ② 认不出就**返回 null，绝不猜**（猜错一次 = 这条归错学科）；
 *  ③ "其他"**不许覆盖**已有学科（它既是"真的其他"也是"判不出来"）。
 */

import { describe, it, expect } from 'vitest';
import { takeSubjectMark, resolveSubjectKey, nextSubjectByAi } from '@/lib/insight-subject';

describe('takeSubjectMark', () => {
    it('末尾一行标记 ⇒ 取出 key，正文里不留痕迹', () => {
        const r = takeSubjectMark('#### 🧠 分母越大每份越小\n\n- 正文\n\n[[学科:数学]]');
        expect(r.subject).toBe('math');
        expect(r.text).toBe('#### 🧠 分母越大每份越小\n\n- 正文');
        expect(r.text).not.toContain('学科');
    });

    it('模型写了 key 而不是中文（math）⇒ 也认', () => {
        expect(takeSubjectMark('正文\n[[学科:math]]').subject).toBe('math');
    });

    it('全角冒号也认（模型很爱写中文标点）', () => {
        expect(takeSubjectMark('正文\n[[学科：语文]]').subject).toBe('chinese');
    });

    it('标记混在正文中间 ⇒ 也剥掉（别让它印到纸上）', () => {
        const r = takeSubjectMark('第一段\n[[学科:英语]]\n第二段');
        expect(r.subject).toBe('english');
        expect(r.text).toBe('第一段\n\n第二段');
    });

    it('写了两次 ⇒ 以**最后**那个为准（模型改口）', () => {
        expect(takeSubjectMark('[[学科:语文]]\n正文\n[[学科:数学]]').subject).toBe('math');
    });

    it('没有标记 ⇒ subject 为 null，正文原样', () => {
        const r = takeSubjectMark('#### 🧠 一句话\n\n正文');
        expect(r.subject).toBeNull();
        expect(r.text).toBe('#### 🧠 一句话\n\n正文');
    });

    it('标记里是认不出的词 ⇒ 不猜，subject 为 null，但标记仍被剥掉', () => {
        const r = takeSubjectMark('正文\n[[学科:体育]]');
        expect(r.subject).toBeNull();
        expect(r.text).toBe('正文');
    });

    it('空串 / null 不炸', () => {
        expect(takeSubjectMark('').subject).toBeNull();
        expect(takeSubjectMark(null as unknown as string).text).toBe('');
    });
});

describe('resolveSubjectKey', () => {
    it('中文标签 / key / 单字简称 三种都认', () => {
        expect(resolveSubjectKey('数学')).toBe('math');
        expect(resolveSubjectKey('math')).toBe('math');
        expect(resolveSubjectKey('MATH')).toBe('math');
        expect(resolveSubjectKey('数')).toBe('math');
    });

    it('认不出 ⇒ null（不落到"其他"）', () => {
        expect(resolveSubjectKey('体育')).toBeNull();
        expect(resolveSubjectKey('')).toBeNull();
        expect(resolveSubjectKey(null)).toBeNull();
    });
});

describe('nextSubjectByAi —— 他第 2 条那两句话的落地', () => {
    it('★ 没指定 ⇒ 填上', () => {
        expect(nextSubjectByAi('', 'math')).toBe('math');
        expect(nextSubjectByAi(null, 'chinese')).toBe('chinese');
    });

    it('★ 已指定且不一致 ⇒ 改成 AI 判的', () => {
        expect(nextSubjectByAi('chinese', 'math')).toBe('math');
    });

    it('一致 ⇒ 不动（返回 null 表示"不用改"）', () => {
        expect(nextSubjectByAi('math', 'math')).toBeNull();
    });

    it('★ AI 判成"其他" ⇒ 绝不覆盖已有学科（"其他"= 判不出来的兜底）', () => {
        expect(nextSubjectByAi('math', 'other')).toBeNull();
        expect(nextSubjectByAi('', 'other')).toBeNull();
    });

    it('AI 没判出 ⇒ 不动', () => {
        expect(nextSubjectByAi('math', null)).toBeNull();
        expect(nextSubjectByAi('math', '')).toBeNull();
    });
});
