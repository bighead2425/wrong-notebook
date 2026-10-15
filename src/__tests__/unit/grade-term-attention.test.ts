import { describe, expect, it } from 'vitest';
import { GRADE_TERMS, normalizeTerm, splitGradeText, termLabel, termSearchVariants, volumeMatchesTerm } from '@/lib/grade-term';
import { ATTENTION_LEVELS, FILTER_KEYS, attentionFullName, attentionLabel, attentionLevelOf, cycleAttentionLevel, filterKeyToLevel, isAttentionUnfiltered, isFilterUnfiltered, parseFilterKeys, toggleAttentionLevel, toggleFilterKey } from '@/lib/attention-level';

/**
 * 年级·学期的归一（复练卷页"年级/学期"筛选用）。
 *
 * 为什么需要归一：库里存的是 `六年级上`（打印页眉上见到的就是它），
 * 他嘴上说的是 `小六上`；初中还有 `初一` / `七年级` 两套写法。
 * 直接字符串比就会"明明有卷却筛不出来"。
 */
describe('年级·学期 · 选项表', () => {
    it('24 个学期：小学 6 + 初中 3 + 高中 3，每个 上/下 —— 从 小一上 到 高三下', () => {
        expect(GRADE_TERMS).toHaveLength(24);
        expect(GRADE_TERMS[0]).toEqual({ key: '一年级上', label: '小一上' });
        expect(GRADE_TERMS[23]).toEqual({ key: '高三下', label: '高三下' });
        // 顺序就是他说的那串：小一上 小一下 小二上 …… 高三下
        expect(GRADE_TERMS.slice(0, 4).map((t) => t.label)).toEqual(['小一上', '小一下', '小二上', '小二下']);
    });

    it('termLabel：规范键 → 他习惯的短名（认不出就原样返回，不抛）', () => {
        expect(termLabel('六年级上')).toBe('小六上');
        expect(termLabel('初一上')).toBe('初一上');
        expect(termLabel('火星上')).toBe('火星上');
    });
});

describe('年级·学期 · 归一', () => {
    it('★ 三种写法都归到同一个键：小六上 / 六年级上 / 6年级上', () => {
        expect(normalizeTerm('小六上')).toBe('六年级上');
        expect(normalizeTerm('六年级上')).toBe('六年级上');
        expect(normalizeTerm('6年级上')).toBe('六年级上');
    });

    it('初中两套叫法互通：七年级下 ≡ 初一下', () => {
        expect(normalizeTerm('七年级下')).toBe('初一下');
        expect(normalizeTerm('初一下')).toBe('初一下');
    });

    it('认不出的一律 null（**不猜** —— 猜错会筛出空列表，让人以为卷丢了）', () => {
        expect(normalizeTerm('六年级')).toBeNull(); // 缺学期
        expect(normalizeTerm('2026-秋')).toBeNull();
        expect(normalizeTerm('')).toBeNull();
        expect(normalizeTerm(null)).toBeNull();
    });
});

describe('年级·学期 · 卷的匹配', () => {
    it('跨本组卷（六年级上·五年级上）：命中任一部分就算', () => {
        expect(splitGradeText('六年级上·五年级上')).toEqual(['六年级上', '五年级上']);
        expect(volumeMatchesTerm('六年级上·五年级上', '五年级上')).toBe(true);
        expect(volumeMatchesTerm('六年级上·五年级上', '三年级上')).toBe(false);
    });

    it('写法不同也能命中（卷里存"六年级上"、筛的是"小六上"）', () => {
        expect(volumeMatchesTerm('六年级上', normalizeTerm('小六上')!)).toBe(true);
        expect(volumeMatchesTerm('六年级上，五年级上', '六年级上')).toBe(true);
    });

    it('空值/脏值不匹配，也不抛', () => {
        expect(volumeMatchesTerm(null, '六年级上')).toBe(false);
        expect(volumeMatchesTerm('乱写的', '六年级上')).toBe(false);
    });
});

/**
 * 等级（关注档 1-5 → 🍜🥘🥐🥥🥗 / D C B A S）。
 * 【2026-10-15 换内容】1-5 的**语义从"等级"变成"紧迫度"**（越大越急），
 * 图标换成花生自己提的那一版。只测显示映射，数据语义（1-5）不变。
 */
describe('等级 · 图标映射', () => {
    it('1-5 对应 花生那套图标 + D/C/B/A/S', () => {
        expect(ATTENTION_LEVELS.map((l) => l.medal)).toEqual(['🍜', '🥘', '🥐', '🥥', '🥗']);
        expect(ATTENTION_LEVELS.map((l) => l.grade)).toEqual(['D', 'C', 'B', 'A', 'S']);
        expect(attentionLevelOf(1).zh).toBe('稳了');
        expect(attentionLevelOf(3).zh).toBe('该练');
        expect(attentionLevelOf(5).zh).toBe('此刻');
    });

    it('越界/空值兜底到最不急那档（🍜 稳了），绝不返回 undefined', () => {
        expect(attentionLevelOf(0).zh).toBe('稳了');
        expect(attentionLevelOf(9).zh).toBe('此刻');
        expect(attentionLevelOf(null).zh).toBe('稳了');
        expect(attentionLevelOf(undefined).zh).toBe('稳了');
    });

    it('显示串：徽章 + 名称（中/英）', () => {
        expect(attentionLabel(3, true)).toBe('🥐 该练');
        expect(attentionLabel(3, false)).toBe('🥐 To practice');
    });

    it('字母 + 名称，如「B该练」（详情页顶栏第二行用）', () => {
        expect(attentionFullName(1)).toBe('D稳了');
        expect(attentionFullName(3)).toBe('B该练');
        expect(attentionFullName(5)).toBe('S此刻');
    });
});

/**
 * 【2026-09-30】等级在界面上有两个动作，两条规则都写进 lib（唯一实现）：
 *   ① 卡片右边那枚图标点一下：**升一级，最后一档之后回第一档**
 *   ② 「等级」多选下拉点一下：切换勾选，但**至少留一个勾**
 *
 * ⚠️【2026-10-15】**① 已停用**（等级收回系统管理，UI 无入口）——
 *    但函数体与这些断言**都保留**：它们钉着"1→5 递增、5 之后回 1"这条不变量，
 *    将来若要恢复人工入口，这就是现成的规格。
 */
describe('等级 · 点一下升一级（卡片上的奖牌）', () => {
    it('1→2→3→4→5，5 之后回 1', () => {
        expect(cycleAttentionLevel(1)).toBe(2);
        expect(cycleAttentionLevel(2)).toBe(3);
        expect(cycleAttentionLevel(3)).toBe(4);
        expect(cycleAttentionLevel(4)).toBe(5);
        expect(cycleAttentionLevel(5)).toBe(1);
    });

    it('空值 / 越界值也能安全升（老数据没有这道坎）', () => {
        expect(cycleAttentionLevel(null)).toBe(2); // 空按第 1 档(🍜 稳了) 算 ⇒ 升到第 2 档
        expect(cycleAttentionLevel(9)).toBe(1); // 越界按第 5 档(🥗 此刻) 算 ⇒ 回第 1 档
    });
});

describe('等级 · 多选下拉的勾选', () => {
    it('点没勾的 ⇒ 勾上，并按 1→5 排序（URL 参数才是稳定的 1,3,5）', () => {
        expect(toggleAttentionLevel([1, 5], 3)).toEqual([1, 3, 5]);
        expect(toggleAttentionLevel([4], 2)).toEqual([2, 4]);
    });

    it('点已勾的 ⇒ 取消它', () => {
        expect(toggleAttentionLevel([1, 3, 5], 3)).toEqual([1, 5]);
    });

    it('★ 只剩一个勾时，点它不动 —— 他明说的"不能让对号消失"', () => {
        expect(toggleAttentionLevel([3], 3)).toEqual([3]);
        expect(toggleAttentionLevel([1, 3], 1)).toEqual([3]);
    });

    it('5 档全选 = 没筛（判"已筛"、决定要不要传 attention 参数都用它）', () => {
        expect(isAttentionUnfiltered([1, 2, 3, 4, 5])).toBe(true);
        expect(isAttentionUnfiltered([1, 2, 3, 4])).toBe(false);
        expect(isAttentionUnfiltered([])).toBe(false);
    });
});

/**
 * 【2026-10-09】服务端筛选用：把一个学期键展开成库里可能出现的各种写法。
 * 为什么必须有它：SQL 里只能做字符串包含，不会像 `splitGradeText` 那样先归一 ——
 * 少列一种写法，就会出现"明明有卷却筛不出来"。
 */
describe('年级·学期 · 服务端筛选用的写法展开', () => {
    it('五年级上 ⇒ 各种写法都在，且覆盖 小五上 / 5年级上', () => {
        const v = termSearchVariants('五年级上');
        expect(v).toContain('五年级上');
        expect(v).toContain('小五上');
        expect(v).toContain('5年级上');
        expect(new Set(v).size).toBe(v.length); // 不重复
    });

    it('★ 展开出来的写法必须都归一回同一个键（与客户端口径一致，否则两边筛出不同结果）', () => {
        for (const term of GRADE_TERMS) {
            for (const form of termSearchVariants(term.key)) {
                expect(normalizeTerm(form)).toBe(term.key);
            }
        }
    });

    it('★ 不会串到别的学期：六年级上的写法，一个都不能被"五年级上"这一组命中', () => {
        const other = new Set(termSearchVariants('五年级上'));
        for (const form of termSearchVariants('六年级上')) {
            expect(other.has(form)).toBe(false);
        }
        // 也不会串到"下"学期
        for (const form of termSearchVariants('五年级下')) {
            expect(other.has(form)).toBe(false);
        }
    });

    it('认不出的写法原样返回一项（宁可筛不到，也不要拼出一个奇怪的串）', () => {
        expect(termSearchVariants('火星上')).toEqual(['火星上']);
        expect(termSearchVariants('六年级')).toEqual(['六年级']);
        expect(termSearchVariants('')).toEqual([]);
    });
});

/**
 * ⭐【2026-10-15 新】「掌握 / 等级」**合并筛选**的键（`docs\14` §7.5）。
 * 空空 2026-10-15 把原【筛选】里的「掌握状态」整组并进【等级】⇒ 6 个选项。
 * 键的集合、"至少留一个"、"全选=没筛"、URL 解析，都在 `lib/attention-level.ts`。
 */
describe('等级 · 合并筛选的键（掌握 + 等级）', () => {
    it('6 个键、顺序 = 下拉里的显示顺序（已掌握在最前，其后 1→5）', () => {
        expect(FILTER_KEYS).toEqual(['mastered', '1', '2', '3', '4', '5']);
    });

    it('filterKeyToLevel：等级键 ⇒ 数字；"mastered" ⇒ null（它不是等级）', () => {
        expect(filterKeyToLevel('3')).toBe(3);
        expect(filterKeyToLevel('mastered')).toBeNull();
        expect(filterKeyToLevel('9')).toBeNull();
        expect(filterKeyToLevel('abc')).toBeNull();
    });

    it('toggleFilterKey：点一下切换，且**至少留一个**（一个都不许没）', () => {
        expect(toggleFilterKey(['mastered', '1'], '1')).toEqual(['mastered']);
        expect(toggleFilterKey(['mastered', '1'], 'mastered')).toEqual(['1']);
        // 只剩一个时再点它 ⇒ 原样返回（不让你把勾全取消）
        expect(toggleFilterKey(['1'], '1')).toEqual(['1']);
        // 新勾上的键按固定顺序插（存出来的 URL 参数才是稳定的）
        expect(toggleFilterKey(['5', 'mastered'], '2')).toEqual(['mastered', '2', '5']);
    });

    it('isFilterUnfiltered：6 项全选 = 没筛', () => {
        expect(isFilterUnfiltered(['mastered', '1', '2', '3', '4', '5'])).toBe(true);
        expect(isFilterUnfiltered(['mastered', '1', '2', '3', '4'])).toBe(false);
        expect(isFilterUnfiltered([])).toBe(false);
    });

    it('parseFilterKeys：解 URL 参数，脏值丢掉 + 去重 + 固定顺序', () => {
        expect(parseFilterKeys('mastered,3,1')).toEqual(['mastered', '1', '3']);
        expect(parseFilterKeys('3,3,mastered')).toEqual(['mastered', '3']);
        expect(parseFilterKeys('1,外星人,9')).toEqual(['1']);
        expect(parseFilterKeys('')).toEqual([]);
        expect(parseFilterKeys(null)).toEqual([]);
    });

    it('★ "已掌握优先于等级"的落点：等级分支必须带 masteryLevel < 2', () => {
        // 这条断言钉的是**服务端口径**（见 api/error-items/list 里那段）：
        // 选了等级档时，已掌握的题不许从等级分支出来。
        const levelBranch = { masteryLevel: { lt: 2 }, attention: { in: [3] } };
        const aMasteredItem = { masteryLevel: 2, attention: 3 };
        expect(aMasteredItem.masteryLevel < 2).toBe(false); // 进不了等级分支
        expect(Number(aMasteredItem.masteryLevel) >= 2).toBe(true); // 只能走"已掌握"分支
        expect(levelBranch.attention.in).toContain(3);
    });
});
