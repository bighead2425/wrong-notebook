/**
 * 【2026-10-15 真真】知识点 × 时间窗 统计 —— 内阁用的**纯逻辑**（不碰 DOM / 不碰数据库）。
 *
 * ── 这个文件回答一个问题 ─────────────────────────────────────────────
 *   **"哪个知识点在连着错 / 错在哪 / 有多少题根本没数据"**。
 *   它服务的是"AI 写学情评价"那一步 —— 而按项目规矩（`docs\00` 第五节）：
 *   **任何 AI 结论必须显示样本量与覆盖率**。所以这里的每个数字都自带
 *   `coverage`（这个知识点下有几道题、其中几道有复练结果）。
 *   没有覆盖率的知识点排行，就是个会说服人的算命先生。
 *
 * ── 判据一律复用，一处都不另写 ──────────────────────────────────────
 *   · 复习状态 / 紧迫度 → `review-status.ts` 的 `reviewStatusOf`
 *   · "今天该练"的门槛  → `overview.ts` 的 `OVERVIEW_URGENT_THRESHOLD`（**不写死数字**）
 *   · 错因字典与中文名  → `mistake-category.ts`
 *   教训 #15：**断言与实现里尽量引用常量、不写死数字** —— 这里连门槛都 import。
 *
 * ── 三条口径（先说清楚，免得下一个人猜）────────────────────────────
 *   ① **一个知识点一条**，桶键 = **学科 + 知识点名**。
 *      为什么不只用名字：`KnowledgeTag` 的唯一约束是
 *      `@@unique([subject, name, userId, parentId])`（`prisma\schema.prisma:65`）——
 *      **同一个名字可以挂在不同学科下**（如数学的「计算」与物理的「计算」是两条记录）。
 *      只按名字聚合会把两个学科的概念并成一个，正是"不报错、只静默错"。
 *      代价：跨学科同名会分成两条。若以后确认要合并，改 `bucketKey()` 一行即可。
 *   ② **一道题挂 N 个知识点 ⇒ 每个知识点各记 1**（题与知识点是"多对多"，不把题劈开）。
 *      ⇒ 各知识点的 `count` 之和 ≥ 题数，这是**有意**的，不是重复计数。
 *      ⚠️ 但**同一道题里重名的标签只算一次**（同一题被重复挂同一个知识点时去重）。
 *   ③ **`urgent` 与内阁⑦ / 底账走同一条线**：紧迫度 ≥ 门槛，且**已掌握的不算**
 *      （口径逐字对齐 `overview.ts:138` 与 `practiceTodayItems`，免得"三块数字打架"）。
 *
 * ── 故意不做（护栏，别顺手加）──────────────────────────────────────
 *   · **不统计"连着错了几次"** —— 那需要**带时间戳的复习流水**（`ReviewEvent` 表刚建、
 *     现在多半是空的），且判定口径还没定 ⇒ **留给下一棒**，等表里有数据再补。
 *     在那之前，"最近错在哪"由 `byMistakeCategory` + `noEvidence` 这两项体现。
 *   · **不碰 UI / 不碰纸面 / 不碰等级** —— 本模块只把数据算出来。
 */

import {
    getMistakeCategoryLabel,
    normalizeMistakeCategory,
    type MistakeCategory,
} from './mistake-category';
import { OVERVIEW_URGENT_THRESHOLD } from './overview';
import { reviewStatusOf } from './review-status';

/**
 * 一道"裁剪过的题" —— 与 `OverviewItem` / `CabinetQuestion` 同族（都是"题的子集"）。
 *
 * ⚠️ `tags` 的真源是 `ErrorItem.tags`（多对多 `KnowledgeTag`），
 *    **不是** `ErrorItem.knowledgePoints` 那列（那列在 schema 里已标 `[DEPRECATED]`）。
 */
export interface KnowledgeStatItem {
    id: string;
    /** 知识点（`KnowledgeTag`）：`name` 必填，`subject` 缺失时按"未知学科"处理 */
    tags?: { name: string; subject?: string | null }[] | null;
    /** 错因（`MistakeCategory` 之一），没打就是 null */
    mistakeCategory?: string | null;
    /** 0 新 / 1 复练中 / 2 已掌握（四分法的「已掌握」＝ 2） */
    masteryLevel?: number | null;
    reviewOutcomes?: unknown;
    /**
     * 处置方式（deep / review / 未定）。
     * ⚠️ **本棒不用它**（`KnowledgeSummary` 里没有它的口径）——
     * 留在这里是为了下一棒做"紧迫 × 处置方式"交叉时不必再改输入类型。
     */
    manageType?: string | null;
}

/** 覆盖率：`all === 0` 时给 0，**不出现 NaN**（与 `overview.ts` 的 `CoverageStat` 同规矩） */
export interface KnowledgeCoverage {
    have: number;
    all: number;
    /** 0–100 的整数 */
    pct: number;
}

export interface KnowledgeSummary {
    /** 知识点名（`KnowledgeTag.name`，已 trim） */
    name: string;
    /** 学科（`KnowledgeTag.subject`）：该知识点下**第一个非空**的值；都没有则 null */
    subject: string | null;
    /** 这个知识点下有几道题（去重后的题数） */
    count: number;
    /** 其中已掌握（`masteryLevel === 2`） */
    mastered: number;
    /** 其中"今天该练"（紧迫度 ≥ `OVERVIEW_URGENT_THRESHOLD`，已掌握的不算） */
    urgent: number;
    /** 其中**一次复练结果都没有** ⇒ AI 对它一无所知 */
    noEvidence: number;
    /** 错因分布；`__none__` = 还没打错因的（沿用 `overview.ts` 的同一字面量） */
    byMistakeCategory: { key: string; label: string; count: number }[];
    /** 覆盖率：这个知识点下"有复练结果"的题数 / **这个知识点下的题数** */
    coverage: KnowledgeCoverage;
}

/** `byMistakeCategory` 里"还没打错因"那一档的固定 key（与 `overview.ts` 同一个字面量） */
export const NO_CATEGORY_KEY = '__none__';

/** `__none__` 那一档显示的名字（与 `overview.ts` 同一句） */
export const NO_CATEGORY_LABEL = '没打错因';

function pct(have: number, all: number): number {
    if (all <= 0) return 0;
    return Math.round((have / all) * 100);
}

/**
 * 桶键 = 学科 + 名字（见文件头口径①）。
 *
 * 用 `\u0000` 当分隔符：知识点名里不可能出现 NUL，
 * 所以 `("a", "b c")` 与 `("a b", "c")` 不会撞成同一个键。
 */
function bucketKey(name: string, subject: string | null): string {
    return `${subject ?? ''}\u0000${name}`;
}

/** 中间累加桶（只在函数内用） */
interface Bucket {
    name: string;
    subject: string | null;
    /** 这个知识点下的题 id —— 顺带保证"同一题只算一次"（输入若有重复 id 也不虚增） */
    ids: Set<string>;
    mastered: number;
    urgent: number;
    noEvidence: number;
    withResult: number;
    categories: Map<MistakeCategory, number>;
    noCategory: number;
}

/**
 * 汇总。
 *
 * @param items 在库的题（调用方已经把回收箱 / 归档本排除掉，口径见 `api/cabinet` 的注释）
 * @param today 算"今天该练"用的今天（**纯函数，不读系统时间**，方便单测）
 */
export function buildKnowledgeStats(
    items: readonly KnowledgeStatItem[],
    today: Date = new Date(),
): KnowledgeSummary[] {
    const buckets = new Map<string, Bucket>();

    for (const it of items) {
        const status = reviewStatusOf(it.reviewOutcomes, today);
        const isMastered = it.masteryLevel === 2;
        /** 口径③：与 `overview.ts` 逐字一致 —— 到线 **且** 已掌握的不算 */
        const isUrgent = !isMastered && status.urgency >= OVERVIEW_URGENT_THRESHOLD;
        const category = normalizeMistakeCategory(it.mistakeCategory);

        /**
         * 这道题挂的知识点 —— **先在题内部去重**（口径②的那个"⚠️"）。
         * 脏数据一律跳过而不是抛错：空名字 / 缺字段 / `tags` 不是数组，
         * 都只是"这道题没有可用知识点"，不该让整个统计崩掉。
         */
        const seenInItem = new Set<string>();
        const owned: { name: string; subject: string | null }[] = [];
        for (const t of it.tags ?? []) {
            const name = (t?.name ?? '').trim();
            if (!name) continue;
            const subject = (t?.subject ?? '').trim() || null;
            const key = bucketKey(name, subject);
            if (seenInItem.has(key)) continue;
            seenInItem.add(key);
            owned.push({ name, subject });
        }
        /** 没有知识点 ⇒ 这一题不进任何统计（**也不算错**，静默跳过） */
        if (owned.length === 0) continue;

        for (const { name, subject } of owned) {
            const key = bucketKey(name, subject);
            let b = buckets.get(key);
            if (!b) {
                b = {
                    name,
                    subject,
                    ids: new Set<string>(),
                    mastered: 0,
                    urgent: 0,
                    noEvidence: 0,
                    withResult: 0,
                    categories: new Map<MistakeCategory, number>(),
                    noCategory: 0,
                };
                buckets.set(key, b);
            }
            // 一道题对一个知识点只贡献一次
            if (b.ids.has(it.id)) continue;
            b.ids.add(it.id);

            if (isMastered) b.mastered += 1;
            if (isUrgent) b.urgent += 1;
            if (status.evidenceCount === 0) b.noEvidence += 1;
            else b.withResult += 1;
            if (category) b.categories.set(category, (b.categories.get(category) ?? 0) + 1);
            else b.noCategory += 1;
        }
    }

    const summaries: KnowledgeSummary[] = [...buckets.values()].map((b) => {
        const all = b.ids.size;
        /**
         * 错因排序：**按数量降序**（与 `overview.ts` 的**实际代码**一致；
         * 那个文件头注释写的是"按字典顺序"，与代码不符 —— 已记进本轮交接单）。
         * 数量相同时按 key 排，保证两次调用次序一致。
         */
        const byMistakeCategory = [...b.categories.entries()]
            .map(([key, count]) => ({ key, label: getMistakeCategoryLabel(key), count }))
            .sort((a, c) => (c.count !== a.count ? c.count - a.count : a.key.localeCompare(c.key)));

        return {
            name: b.name,
            subject: b.subject,
            count: all,
            mastered: b.mastered,
            urgent: b.urgent,
            noEvidence: b.noEvidence,
            byMistakeCategory:
                b.noCategory > 0
                    ? [
                          ...byMistakeCategory,
                          { key: NO_CATEGORY_KEY, label: NO_CATEGORY_LABEL, count: b.noCategory },
                      ]
                    : byMistakeCategory,
            coverage: { have: b.withResult, all, pct: pct(b.withResult, all) },
        };
    });

    /**
     * 排序：**先急的 → 再多的 → 最后按名字**（全确定性 ⇒ 两次调用结果一致，方便断言）。
     * 名字也相同时再按学科 —— 给"跨学科同名"那两条一个稳定次序。
     */
    return summaries.sort((a, b) => {
        if (b.urgent !== a.urgent) return b.urgent - a.urgent;
        if (b.count !== a.count) return b.count - a.count;
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) return byName;
        return (a.subject ?? '').localeCompare(b.subject ?? '');
    });
}
