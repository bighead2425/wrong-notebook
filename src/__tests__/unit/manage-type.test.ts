// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来（jsdom worker 会因内存超时）。
import { describe, expect, it } from 'vitest';
import { MISTAKE_CATEGORIES } from '@/lib/mistake-category';
import {
    canAutoRewrite,
    getManageTypeLabel,
    MANAGE_TYPE_DEFAULT,
    MANAGE_TYPES,
    normalizeManageType,
    normalizeManageTypeSource,
    PROMOTE_BOX,
    promoteDirectionFor,
    suggestManageType,
} from '@/lib/manage-type';

/**
 * 错题等级（深挖 / 复练）。
 *
 * 钉住的是几条**已定稿的规矩**，不是实现细节：
 *   ① 只有两个值 ——「积累」不在这一层（它背后可以没有错题，将来自立一表）
 *   ② 默认 = **复练**（不是深挖：全默认深挖 = 平均用力）
 *   ③ 派生 + 落定快照：人定过的（manual / ai / upgrade）不许被自动改写
 *   ④ 纸面上的升降级小框**按题的类型印**，且**必须带文字**（黑白复印不能丢信息）
 */
describe('manage-type · 错题等级', () => {
    it('只有两个值：深挖 / 复练（「积累」不在这一层）', () => {
        expect(MANAGE_TYPES).toEqual(['deep', 'review']);
        expect(MANAGE_TYPES).not.toContain('build');
        expect(getManageTypeLabel('build')).toBe('未定');
    });

    it('⚠️ 默认是**复练**，不是深挖（改了这条就等于把"平均用力"改回来）', () => {
        expect(MANAGE_TYPE_DEFAULT).toBe('review');
    });

    it('认得出合法值（大小写与空白都容错）', () => {
        expect(normalizeManageType('deep')).toBe('deep');
        expect(normalizeManageType(' REVIEW ')).toBe('review');
    });

    it('空值与不认识的值一律当"未定"，**不猜**（等级猜错＝按错误规格对待这道题）', () => {
        for (const v of [null, undefined, '', '   ', 'a', 'A', 'Other', '深挖']) {
            expect(normalizeManageType(v)).toBeNull();
        }
        expect(getManageTypeLabel(null)).toBe('未定');
    });
});

describe('manage-type · 落定快照（谁能被自动改写）', () => {
    it('没定过 / 只是录入默认 ⇒ 允许自动派生', () => {
        expect(canAutoRewrite(null)).toBe(true);
        expect(canAutoRewrite('default')).toBe(true);
    });

    it('⚠️ 已经派生过一次（derived）= 已落定，**不许再自动改**', () => {
        // 定稿：「错因以后变了，已定类型不变」——派生只发生一次，派完快照住。
        expect(canAutoRewrite('derived')).toBe(false);
    });

    it('人定过 / 采纳过 AI / 被行为升过级 ⇒ **一律不许**自动改写', () => {
        expect(canAutoRewrite('manual')).toBe(false);
        expect(canAutoRewrite('ai')).toBe(false);
        expect(canAutoRewrite('upgrade')).toBe(false);
    });

    it('来源字段容错归一化', () => {
        expect(normalizeManageTypeSource(' manual ')).toBe('manual');
        expect(normalizeManageTypeSource('不认识')).toBeNull();
        expect(normalizeManageTypeSource('')).toBeNull();
    });
});

describe('manage-type · 从错因派生（只建议，不落定）', () => {
    it('概念不清 / 完全不会 / 方法没想到 ⇒ 建议深挖', () => {
        for (const c of ['concept', 'blank', 'no_method']) {
            const s = suggestManageType(c);
            expect(s.type).toBe('deep');
            expect(s.reason.length).toBeGreaterThan(0);
        }
    });

    it('算错写错 / 看漏条件 ⇒ 建议复练', () => {
        for (const c of ['computation', 'missed_condition']) {
            const s = suggestManageType(c);
            expect(s.type).toBe('review');
            expect(s.reason.length).toBeGreaterThan(0);
        }
    });

    it('错因是"其他" ⇒ 不硬猜，保持未定', () => {
        expect(suggestManageType('other').type).toBeNull();
    });

    it('还没打错因 ⇒ 未定，并说明"打了错因才会给建议"', () => {
        const s = suggestManageType(null);
        expect(s.type).toBeNull();
        expect(s.from).toBeNull();
        expect(s.reason).toContain('错因');
    });

    it('每个受控错因都有明确意见（新增类目时不许留"没想好"的洞）', () => {
        for (const c of MISTAKE_CATEGORIES) {
            const s = suggestManageType(c);
            expect(s.reason.length).toBeGreaterThan(0);
            expect(s.from).toBe(c);
        }
    });
});

describe('manage-type · 纸面上的升降级小框', () => {
    it('**按题的类型印，不按纸印**：复练题印升级、深挖题印降级', () => {
        expect(promoteDirectionFor('review')).toBe('upgrade');
        expect(promoteDirectionFor('deep')).toBe('demote');
    });

    it('★ 没定等级 ⇒ **按复练处理**（印"升级"），保证纸上每道题都有框', () => {
        // 2026-09-28 改。原先写的是"未定不印（没有方向可指）"，概念上没错，
        // 但 manageType 是 2026-09-28 才加的字段 ⇒ 所有老题都是空的 ⇒
        // 实际效果变成"**大部分题都不印框**"。他一眼看样张就发现了。
        // 依据 L0 规则：录入默认 = 复练，所以"空"应当读作"还没被特殊对待"，即复练。
        expect(promoteDirectionFor(null)).toBe('upgrade');
        expect(promoteDirectionFor(undefined)).toBe('upgrade');
        expect(promoteDirectionFor('')).toBe('upgrade');
        expect(promoteDirectionFor('build')).toBe('upgrade'); // 不是受控值 ⇒ 也走同一兜底
    });

    it('⚠️ 必须带文字，且颜色是 红升 / 灰蓝降（黑白复印时颜色会丢）', () => {
        expect(PROMOTE_BOX.upgrade.label).toBe('升级');
        expect(PROMOTE_BOX.demote.label).toBe('降级');
        expect(PROMOTE_BOX.upgrade.color.toLowerCase()).toBe('#c0392b');
        expect(PROMOTE_BOX.demote.color.toLowerCase()).toBe('#7f8c9b');
        // 降级**不许用绿**：复习三格里的绿＝向上长，会打架
        expect(PROMOTE_BOX.demote.color.toLowerCase()).not.toContain('green');
    });
});
