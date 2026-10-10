// @vitest-environment node
// 纯逻辑测试：不碰 DOM、不碰数据库。
import { describe, expect, it } from 'vitest';
import {
    childrenOf,
    linkInvariantViolations,
    planDelete,
    planLink,
    planMastery,
    planPromote,
    planRestore,
    planUnlink,
    roleOf,
    rootOf,
    type LinkNode,
} from '@/lib/item-link';

/**
 * 题间从属关系（主题 / 附题）—— 他 2026-10-10 定的规则。
 *
 * 为什么这个文件值得写这么细：这套规则的分支极碎，而且出错的形态是
 * **"操作报了成功、关系树却悄悄歪了"**（比如出现"附题的附题"）。
 * 那种错靠点界面试几乎试不出来，只能靠纯函数 + 每次操作后自检不变量。
 */

/** 造一道题（只给规则用得到的字段） */
function n(id: string, opts: Partial<LinkNode> = {}): LinkNode {
    return {
        id,
        no: `SX${id.toUpperCase()}`,
        parentId: null,
        createdAt: opts.createdAt ?? `2026-10-0${(id.charCodeAt(0) % 9) + 1}T00:00:00.000Z`,
        mastered: opts.mastered ?? false,
        ...opts,
    };
}

/** 把 ops 应用到数据上，得到操作之后的新状态（模拟接口写库） */
function apply(nodes: readonly LinkNode[], ops: { id: string; parentId: string | null }[]): LinkNode[] {
    return nodes.map((x) => {
        const hit = ops.find((o) => o.id === x.id);
        return hit ? { ...x, parentId: hit.parentId } : x;
    });
}

/** 每次操作之后都要过这一关：树还健不健康 */
function expectHealthy(nodes: readonly LinkNode[]) {
    expect(linkInvariantViolations(nodes)).toEqual([]);
}

describe('角色判定：孤题 / 主题 / 附题', () => {
    it('没有主题、也没有附题 ⇒ 孤题', () => {
        const nodes = [n('a')];
        expect(roleOf(nodes, 'a')).toBe('lone');
    });

    it('没有主题但有附题 ⇒ 主题', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' })];
        expect(roleOf(nodes, 'a')).toBe('root');
    });

    it('有主题 ⇒ 附题（不管它自己有没有附题）', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' }), n('c', { parentId: 'b' })];
        expect(roleOf(nodes, 'b')).toBe('child');
    });

    it('附题按**录入时间**升序 ⇒ "排序第一"就是第一个（删主题谁接班用它）', () => {
        const nodes = [
            n('a'),
            n('b', { parentId: 'a', createdAt: '2026-10-05T00:00:00.000Z' }),
            n('c', { parentId: 'a', createdAt: '2026-10-02T00:00:00.000Z' }),
        ];
        expect(childrenOf(nodes, 'a').map((x) => x.id)).toEqual(['c', 'b']);
    });

    it('rootOf 能追到主题，且对脏数据（多层）也不会死循环', () => {
        expect(rootOf([n('a'), n('b', { parentId: 'a' })], 'b')?.id).toBe('a');
        const dirty = [n('a'), n('b', { parentId: 'a' }), n('c', { parentId: 'b' })];
        expect(rootOf(dirty, 'c')?.id).toBe('a');
        expect(rootOf(dirty, 'a')?.id).toBe('a');
    });
});

describe('建立关联', () => {
    it('★ 常规：孤题挂到另一道孤题下 —— 被关联的那个当主题', () => {
        const nodes = [n('a'), n('b')];
        const plan = planLink(nodes, 'b', 'a');
        expect(plan.ok).toBe(true);
        expect(plan.ops).toEqual([{ id: 'b', parentId: 'a' }]);
        expectHealthy(apply(nodes, plan.ops));
    });

    it('★ 扫到的是**附题** ⇒ 新题挂到它所属的**主题**上（他的原话："实际记录是将题C关联到题A"）', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' }), n('c')];
        const plan = planLink(nodes, 'c', 'b'); // 在附题 B 上扫到 C
        expect(plan.ok).toBe(true);
        expect(plan.ops).toEqual([{ id: 'c', parentId: 'a' }]); // 挂到 A，不是 B
        expectHealthy(apply(nodes, plan.ops));
    });

    it('★ 已经在同一棵树里 ⇒ 明确说"不必再关联"（不重复建、不报错）', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' }), n('c', { parentId: 'a' })];
        const plan = planLink(nodes, 'c', 'b');
        expect(plan.ok).toBe(false);
        expect(plan.ops).toEqual([]);
        expect(plan.message).toContain('不必再关联');
    });

    it('同一道题 ⇒ 拒绝', () => {
        expect(planLink([n('a')], 'a', 'a').ok).toBe(false);
    });

    it('★ 两边都已经各自是主题 ⇒ 不擅自决定，返回"谁当主题"的选项并**推荐原来那棵**', () => {
        const nodes = [
            n('a'),
            n('b', { parentId: 'a' }),
            n('c'),
            n('d', { parentId: 'c' }),
            n('e', { parentId: 'c' }),
        ];
        const plan = planLink(nodes, 'd', 'b'); // D 属于 C 那棵；B 属于 A 那棵
        expect(plan.ok).toBe(false);
        expect(plan.choice?.candidates.map((x) => x.id).sort()).toEqual(['a', 'c']);
        expect(plan.choice?.candidates.find((x) => x.id === 'c')?.childCount).toBe(2);
        expect(plan.choice?.recommended).toBe('c'); // 推荐"要关联的那道题原本所属的主题"
    });

    it('★ 他拍板选 A 当主题 ⇒ C 那棵（含 C 自己）整体并进来，且**不出现附题的附题**', () => {
        const nodes = [
            n('a'),
            n('b', { parentId: 'a' }),
            n('c'),
            n('d', { parentId: 'c' }),
            n('e', { parentId: 'c' }),
        ];
        const plan = planLink(nodes, 'd', 'b', 'a');
        expect(plan.ok).toBe(true);
        expect(plan.ops).toHaveLength(3); // C + D + E
        const after = apply(nodes, plan.ops);
        expect(after.find((x) => x.id === 'c')?.parentId).toBe('a');
        expect(after.find((x) => x.id === 'd')?.parentId).toBe('a');
        expect(after.find((x) => x.id === 'e')?.parentId).toBe('a');
        expectHealthy(after); // ← 关键：整棵接过来也不能有"附题的附题"
    });

    it('★ 他拍板选 C 当主题 ⇒ 原主题 A 降为附题，A 名下的 B 也改挂到 C', () => {
        const nodes = [
            n('a'),
            n('b', { parentId: 'a' }),
            n('c'),
            n('d', { parentId: 'c' }),
        ];
        const plan = planLink(nodes, 'd', 'b', 'c');
        const after = apply(nodes, plan.ops);
        expect(after.find((x) => x.id === 'c')?.parentId).toBeNull();
        expect(after.find((x) => x.id === 'a')?.parentId).toBe('c');
        expect(after.find((x) => x.id === 'b')?.parentId).toBe('c');
        expect(after.find((x) => x.id === 'd')?.parentId).toBe('c');
        expectHealthy(after);
    });

    it('★ 反过来：一个已经有附题的"主题"去挂到孤题下 ⇒ 它仍是主题，孤题变成它的附题', () => {
        // 附题不能有附题 ⇒ 有附题的那一方必须保持主题身份
        const nodes = [n('a'), n('b', { parentId: 'a' }), n('c')];
        const plan = planLink(nodes, 'c', 'b'); // 这其实就是"挂到 A"
        const after = apply(nodes, plan.ops);
        expect(after.find((x) => x.id === 'a')?.parentId).toBeNull();
        expect(after.find((x) => x.id === 'c')?.parentId).toBe('a');
        expectHealthy(after);
    });

    it('题不存在 / 缺数据时给一句人话，不抛异常', () => {
        expect(planLink([n('a')], 'zzz', 'a').ok).toBe(false);
        expect(planLink([n('a')], 'a', 'zzz').ok).toBe(false);
    });
});

describe('取关', () => {
    it('★ 附题取关 ⇒ 变孤题（主题那边自然少一条）', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' }), n('c', { parentId: 'a' })];
        const plan = planUnlink(nodes, 'b');
        expect(plan.ok).toBe(true);
        const after = apply(nodes, plan.ops);
        expect(roleOf(after, 'b')).toBe('lone');
        expect(childrenOf(after, 'a').map((x) => x.id)).toEqual(['c']);
        expectHealthy(after);
    });

    it('本来就是孤题/主题 ⇒ 拒绝（点了没反应要说清为什么）', () => {
        expect(planUnlink([n('a')], 'a').ok).toBe(false);
        expect(planUnlink([n('a'), n('b', { parentId: 'a' })], 'a').ok).toBe(false);
    });

    it('⚠️ 脏数据兜底：自己还挂着附题时**拒绝**取关（不然会造出"附题的附题"）', () => {
        const dirty = [n('a'), n('b', { parentId: 'a' }), n('c', { parentId: 'b' })];
        const plan = planUnlink(dirty, 'b');
        expect(plan.ok).toBe(false);
        expect(plan.message).toContain('还挂着');
    });
});

describe('升变：附题顶掉原主题', () => {
    it('★ 指针对调，原主题及其余附题全改挂到新主题下', () => {
        // ⚠️ 这里**显式给录入时间**：附题是"按录入时间排"的（删主题谁接班靠它），
        //    不给就会用到 helper 的默认值、断言的顺序会变成猜谜。
        const nodes = [
            n('a', { createdAt: '2026-10-01T00:00:00.000Z' }),
            n('b', { parentId: 'a', createdAt: '2026-10-02T00:00:00.000Z' }),
            n('c', { parentId: 'a', createdAt: '2026-10-03T00:00:00.000Z' }),
            n('d', { parentId: 'a', createdAt: '2026-10-04T00:00:00.000Z' }),
        ];
        const plan = planPromote(nodes, 'c');
        expect(plan.ok).toBe(true);
        const after = apply(nodes, plan.ops);
        expect(after.find((x) => x.id === 'c')?.parentId).toBeNull();
        expect(after.find((x) => x.id === 'a')?.parentId).toBe('c');
        expect(after.find((x) => x.id === 'b')?.parentId).toBe('c');
        expect(after.find((x) => x.id === 'd')?.parentId).toBe('c');
        expect(roleOf(after, 'c')).toBe('root');
        expect(childrenOf(after, 'c').map((x) => x.id)).toEqual(['a', 'b', 'd']);
        expectHealthy(after);
    });

    it('主题/孤题不能升变', () => {
        expect(planPromote([n('a')], 'a').ok).toBe(false);
        expect(planPromote([n('a'), n('b', { parentId: 'a' })], 'a').ok).toBe(false);
    });

    it('原主题已经不在了 ⇒ 至少把它自己立起来（别让它悬着）', () => {
        const orphan = [n('b', { parentId: 'a-gone' })];
        const plan = planPromote(orphan, 'b');
        expect(plan.ok).toBe(true);
        expect(plan.ops).toEqual([{ id: 'b', parentId: null }]);
    });
});

describe('已掌握：只有人工标记才断开（他 2026-10-10 拍板）', () => {
    it('★ 人工把**附题**标已掌握 ⇒ 断开关联，并记下"原来挂在谁下面"（供一键恢复）', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' })];
        const plan = planMastery(nodes, 'b', true, { manual: true });
        expect(plan.ops).toEqual([{ id: 'b', parentId: null }]);
        expect(plan.detachedFrom).toBe('a');
        expect(plan.masteryIds).toEqual(['b']);
        expectHealthy(apply(nodes, plan.ops));
    });

    it('★ **系统**判定（manual=false）绝不断开 —— 否则主题传一次就把树拆了', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' })];
        const plan = planMastery(nodes, 'b', true, { manual: false });
        expect(plan.ops).toEqual([]);
        expect(plan.masteryIds).toEqual(['b']);
    });

    it('★ 主题标已掌握 ⇒ 名下附题一并标已掌握，但**关系一动不动**', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' }), n('c', { parentId: 'a' })];
        const plan = planMastery(nodes, 'a', true, { manual: true });
        expect(plan.ops).toEqual([]);
        expect(plan.masteryIds.sort()).toEqual(['a', 'b', 'c']);
        expect(plan.message).toContain('2 道附题');
    });

    it('★ 主题改回未掌握 ⇒ 附题一并改回', () => {
        const nodes = [n('a', { mastered: true }), n('b', { parentId: 'a', mastered: true })];
        const plan = planMastery(nodes, 'a', false, { manual: true });
        expect(plan.masteryIds.sort()).toEqual(['a', 'b']);
        expect(plan.ops).toEqual([]);
    });

    it('孤题：只有它自己变', () => {
        const plan = planMastery([n('a')], 'a', true, { manual: true });
        expect(plan.masteryIds).toEqual(['a']);
        expect(plan.detachedFrom).toBeNull();
    });
});

describe('恢复关联（一键）', () => {
    it('★ 断开之后能一键恢复（不需要翻日志、不占额外字段 —— 依据留痕里那一句）', () => {
        const nodes = [n('a'), n('b')]; // b 已是孤题（之前被断开）
        const plan = planRestore(nodes, 'b', 'a');
        expect(plan.ok).toBe(true);
        expect(plan.ops).toEqual([{ id: 'b', parentId: 'a' }]);
    });

    it('⚠️ 已经有主题了 ⇒ 不恢复（不能拿旧账覆盖新账）', () => {
        const nodes = [n('a'), n('c'), n('b', { parentId: 'c' })];
        expect(planRestore(nodes, 'b', 'a').ok).toBe(false);
    });

    it('⚠️ 原主题已被删 ⇒ 明确说"恢复不了"，别硬挂', () => {
        expect(planRestore([n('b')], 'b', 'a-gone').ok).toBe(false);
    });

    it('原主题后来变成了附题 ⇒ 恢复到它现在所属的主题上（不造出"附题的附题"）', () => {
        const nodes = [n('x'), n('a', { parentId: 'x' }), n('b')];
        const plan = planRestore(nodes, 'b', 'a');
        expect(plan.ops).toEqual([{ id: 'b', parentId: 'x' }]);
        expectHealthy(apply(nodes, plan.ops));
    });
});

describe('删除主题：附题怎么处理', () => {
    it('★ 未掌握 ⇒ 录入最早的附题**接班**当主题，其余改挂到它下面', () => {
        const nodes = [
            n('a'),
            n('b', { parentId: 'a', createdAt: '2026-10-05T00:00:00.000Z' }),
            n('c', { parentId: 'a', createdAt: '2026-10-02T00:00:00.000Z' }),
            n('d', { parentId: 'a', createdAt: '2026-10-08T00:00:00.000Z' }),
        ];
        const plan = planDelete(nodes, 'a');
        expect(plan.trashIds).toEqual(['a']);
        expect(plan.ops).toEqual([
            { id: 'c', parentId: null }, // C 录入最早 ⇒ 接班
            { id: 'b', parentId: 'c' },
            { id: 'd', parentId: 'c' },
        ]);
        expectHealthy(apply(nodes, plan.ops));
    });

    it('★ 已掌握 ⇒ 连同名下所有附题一起进回收箱，且提示里**写明几道**', () => {
        const nodes = [n('a', { mastered: true }), n('b', { parentId: 'a' }), n('c', { parentId: 'a' })];
        const plan = planDelete(nodes, 'a');
        expect(plan.trashIds.sort()).toEqual(['a', 'b', 'c']);
        expect(plan.message).toContain('2 道');
    });

    it('没有附题 ⇒ 只有它自己进回收箱', () => {
        const plan = planDelete([n('a')], 'a');
        expect(plan.trashIds).toEqual(['a']);
        expect(plan.ops).toEqual([]);
    });
});

describe('不变量自检（这套规则最该有的看门测试）', () => {
    it('能抓出"附题的附题"', () => {
        const dirty = [n('a'), n('b', { parentId: 'a' }), n('c', { parentId: 'b' })];
        expect(linkInvariantViolations(dirty).join()).toContain('附题的附题');
    });

    it('能抓出悬空指针（主题不存在）', () => {
        expect(linkInvariantViolations([n('b', { parentId: 'gone' })]).join()).toContain('悬空');
    });

    it('健康的树 ⇒ 没有问题', () => {
        const nodes = [n('a'), n('b', { parentId: 'a' }), n('c')];
        expect(linkInvariantViolations(nodes)).toEqual([]);
    });

    it('★ 把所有操作串起来跑一遍，每一步之后都要仍然健康', () => {
        let nodes: LinkNode[] = [n('a', { createdAt: '2026-10-01T00:00:00.000Z' }), n('b'), n('c'), n('d')];
        const steps: Array<{ do: () => { ok: boolean; ops: { id: string; parentId: string | null }[] } }> = [
            { do: () => planLink(nodes, 'b', 'a') },
            { do: () => planLink(nodes, 'c', 'b') },
            { do: () => planLink(nodes, 'd', 'b') },
            { do: () => planPromote(nodes, 'c') },
            { do: () => planUnlink(nodes, 'd') },
        ];
        for (const s of steps) {
            const plan = s.do();
            nodes = apply(nodes, plan.ops);
            expectHealthy(nodes);
        }
        // 串完之后：C 是主题，A、B、D 各归其位（D 已取关成孤题）
        expect(roleOf(nodes, 'c')).toBe('root');
        expect(roleOf(nodes, 'd')).toBe('lone');
        expect(childrenOf(nodes, 'c').map((x) => x.id).sort()).toEqual(['a', 'b']);
    });
});
