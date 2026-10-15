/**
 * 知识点 × 时间窗统计（2026-10-15 真真）—— `lib/knowledge-stats.ts` 的看门测试。
 *
 * 守五件事（前四条是任务卡的验收项，第五条是口径护栏）：
 *  ① **多对多如实计**：一题挂 2 个知识点 ⇒ 两边都算；同一题重复挂同名标签只算一次；
 *  ② **不丢数据**：没有复练结果的题进 `noEvidence`，**不是被丢掉**；
 *  ③ **分母对**：覆盖率的分母是"**这个知识点下的题数**"，不是全库题数；`all=0` 时 `pct=0` 不 NaN；
 *  ④ **稳定排序**：urgent 降序 → count 降序 → 名字，两次调用结果一致；
 *  ⑤ **纯逻辑护栏**：本模块**不许 import `@/lib/prisma`**（判据与取数必须分家）。
 *
 * ⚠️ 门槛**引用常量**（`OVERVIEW_URGENT_THRESHOLD`），不写死 4 —— 教训 #15。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildKnowledgeStats,
    NO_CATEGORY_KEY,
    NO_CATEGORY_LABEL,
    type KnowledgeStatItem,
} from '@/lib/knowledge-stats';
import { OVERVIEW_URGENT_THRESHOLD } from '@/lib/overview';

const TODAY = new Date(2026, 9, 15); // 2026-10-15

/** 造一份复习结果（形状见 `lib/review-outcomes.ts`） */
const res = (planned: ('right' | 'wrong' | null)[], last: 'right' | 'wrong' | null) =>
    JSON.stringify({ planned, last });

/**
 * 有证据、但**不急**：连对 2 次 ⇒ urgency 2（`REVIEW_INTERVAL_DAYS` 那套）。
 * 用它来区分"没数据"与"有数据但不急"——这两件事必须能分开。
 */
const HAS_EVIDENCE = res(['right', 'right', null], 'right');

/** 有证据、且**到线**：最近一次做错 ⇒ urgency 4（= `OVERVIEW_URGENT_THRESHOLD`）。 */
const DUE = res(['wrong', null, null], 'wrong');

const tag = (name: string, subject?: string) => ({ name, subject });

let seq = 0;
function item(over: Partial<KnowledgeStatItem> = {}): KnowledgeStatItem {
    seq += 1;
    return { id: `q${seq}`, ...over };
}

const names = (s: ReturnType<typeof buildKnowledgeStats>) => s.map((x) => x.name);

describe('buildKnowledgeStats —— 知识点 × 时间窗', () => {
    it('空输入：空数组，不抛错、不出现 NaN', () => {
        expect(buildKnowledgeStats([], TODAY)).toEqual([]);
    });

    it('★ 一道题挂 2 个知识点 ⇒ 两边都算（题不劈开，多对多如实计）', () => {
        const s = buildKnowledgeStats(
            [item({ tags: [tag('分数计算', 'math'), tag('通分', 'math')] })],
            TODAY,
        );
        expect(names(s).sort()).toEqual(['分数计算', '通分']);
        expect(s.every((x) => x.count === 1)).toBe(true);
    });

    it('★ 没有复练结果的题 ⇒ 进 noEvidence，**不是被丢掉**', () => {
        const s = buildKnowledgeStats([item({ tags: [tag('分数计算', 'math')] })], TODAY);
        expect(s).toHaveLength(1);
        expect(s[0].count).toBe(1);
        expect(s[0].noEvidence).toBe(1);
        expect(s[0].coverage).toEqual({ have: 0, all: 1, pct: 0 });
    });

    it('★ 覆盖率的分母是"这个知识点下的题数"，不是全库题数', () => {
        const s = buildKnowledgeStats(
            [
                item({ tags: [tag('分数计算', 'math')], reviewOutcomes: HAS_EVIDENCE }),
                item({ tags: [tag('分数计算', 'math')] }), // 同一知识点，无结果
                item({ tags: [tag('通分', 'math')] }), // 另一个知识点，无结果
                item({ tags: [tag('三角形', 'math')], reviewOutcomes: HAS_EVIDENCE }), // 不该算进上面两个
            ],
            TODAY,
        );

        const frac = s.find((x) => x.name === '分数计算')!;
        expect(frac.coverage).toEqual({ have: 1, all: 2, pct: 50 });

        const tong = s.find((x) => x.name === '通分')!;
        expect(tong.coverage).toEqual({ have: 0, all: 1, pct: 0 });
        expect(Number.isNaN(tong.coverage.pct)).toBe(false);
    });

    it('tag 为空 / null / 全是空格 / 整个 tags 缺失 ⇒ 不进统计，且不抛错', () => {
        const s = buildKnowledgeStats(
            [
                item(), // 没有 tags 字段
                item({ tags: null }),
                item({ tags: [] }),
                item({ tags: [tag('   ', 'math')] }), // 全是空格
                item({ tags: [{ name: '勾股定理' }] }), // 有名字、缺学科 ⇒ 照常算
            ],
            TODAY,
        );
        expect(names(s)).toEqual(['勾股定理']);
        expect(s[0].subject).toBeNull();
        expect(s[0].count).toBe(1);
    });

    it('★ 口径：一题多知识点时各记 1（不劈开）；同一题重复挂同名标签只算一次', () => {
        const s = buildKnowledgeStats(
            [item({ tags: [tag('通分', 'math'), tag('通分', 'math'), tag('分数计算', 'math')] })],
            TODAY,
        );
        // 两个知识点各自 count=1（同一题挂两个知识点 ⇒ 各算一道，这是有意口径）
        expect(s.find((x) => x.name === '通分')!.count).toBe(1);
        expect(s.find((x) => x.name === '分数计算')!.count).toBe(1);
        // 总数之和 = 2 > 题数 1 —— 多对多的正常结果，不是重复计数
        expect(s.reduce((n, x) => n + x.count, 0)).toBe(2);
    });

    it('★ 口径①：同名知识点挂在不同学科 ⇒ 分成两条，不合并（schema 的 @@unique 允许同名跨学科）', () => {
        const s = buildKnowledgeStats(
            [item({ tags: [tag('计算', 'math')] }), item({ tags: [tag('计算', 'physics')] })],
            TODAY,
        );
        expect(s).toHaveLength(2);
        expect(s.map((x) => x.subject).sort()).toEqual(['math', 'physics']);
        expect(s.every((x) => x.name === '计算' && x.count === 1)).toBe(true);
    });

    it('★ urgent 与门槛同一条线，且"已掌握"的不算急', () => {
        const s = buildKnowledgeStats(
            [
                item({ tags: [tag('分数计算', 'math')] }), // 新题 ⇒ urgency 5 ⇒ 急
                item({ tags: [tag('分数计算', 'math')], reviewOutcomes: DUE }), // 刚错 ⇒ urgency 4 ⇒ 急
                item({ tags: [tag('分数计算', 'math')], reviewOutcomes: HAS_EVIDENCE }), // 连对 2 ⇒ 不急
                item({ tags: [tag('分数计算', 'math')], masteryLevel: 2 }), // 已掌握 ⇒ 不算急
            ],
            TODAY,
        );
        expect(s).toHaveLength(1);
        expect(s[0].count).toBe(4);
        expect(s[0].urgent).toBe(2);
        expect(s[0].mastered).toBe(1);
        expect(s[0].noEvidence).toBe(2); // 新题 + 已掌握那道（都没结果）
        expect(s[0].coverage).toEqual({ have: 2, all: 4, pct: 50 });
    });

    it('门槛是 OVERVIEW_URGENT_THRESHOLD 本身（改常量这里跟着变，不写死 4）', () => {
        const s = buildKnowledgeStats(
            [
                item({ tags: [tag('刚好到线', 'math')], reviewOutcomes: DUE }), // urgency 4
                item({ tags: [tag('没到线', 'math')], reviewOutcomes: HAS_EVIDENCE }), // urgency 2
            ],
            TODAY,
        );
        expect(s.find((x) => x.name === '刚好到线')!.urgent).toBe(
            OVERVIEW_URGENT_THRESHOLD <= 4 ? 1 : 0,
        );
        expect(s.find((x) => x.name === '没到线')!.urgent).toBe(
            OVERVIEW_URGENT_THRESHOLD <= 2 ? 1 : 0,
        );
    });

    it('错因分布：按数量降序；没打错因的进 __none__（沿用 overview 的同一字面量）', () => {
        const s = buildKnowledgeStats(
            [
                item({ tags: [tag('分数计算', 'math')], mistakeCategory: 'calc_slip' }),
                item({ tags: [tag('分数计算', 'math')], mistakeCategory: 'calc_slip' }),
                item({ tags: [tag('分数计算', 'math')], mistakeCategory: 'concept_vague' }),
                item({ tags: [tag('分数计算', 'math')] }),
            ],
            TODAY,
        );
        expect(s[0].byMistakeCategory).toEqual([
            { key: 'calc_slip', label: '计算失误', count: 2 },
            { key: 'concept_vague', label: '概念模糊', count: 1 },
            { key: NO_CATEGORY_KEY, label: NO_CATEGORY_LABEL, count: 1 },
        ]);
    });

    it('★ 排序确定性：urgent 降序 → count 降序 → 名字；两次调用结果一致', () => {
        const items = [
            item({ tags: [tag('乙', 'math')] }),
            item({ tags: [tag('甲', 'math')] }),
            item({ tags: [tag('甲', 'math')] }),
            item({ tags: [tag('丙', 'math')], reviewOutcomes: HAS_EVIDENCE }),
        ];
        const a = buildKnowledgeStats(items, TODAY);
        const b = buildKnowledgeStats(items, TODAY);

        expect(names(a)).toEqual(names(b)); // 稳定：同输入同输出
        // 甲：2 道都急（2）｜乙：1 道急（1）｜丙：有结果不急（0）
        expect(names(a)).toEqual(['甲', '乙', '丙']);
        expect(a.map((x) => x.urgent)).toEqual([2, 1, 0]);
    });

    it('★ 纯逻辑护栏：本模块不 import @/lib/prisma（判据与取数分家）', () => {
        const src = readFileSync(join(process.cwd(), 'src', 'lib', 'knowledge-stats.ts'), 'utf8');
        expect(src).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
        expect(src).not.toMatch(/from\s+['"]\.\/prisma['"]/);
    });
});
