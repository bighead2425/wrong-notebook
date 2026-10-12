/**
 * 【2026-10-13】学情底账 —— 内阁页那一块的**纯逻辑**（不碰 DOM / 不碰数据库）。
 *
 * ── 为什么要有这一块 ────────────────────────────────────────────────
 *   他 2026-10-13 说得很直白：
 *     *"这个软件最为有价值的地方 …… 一方面不替孩子学和练，另一方面又指导孩子学和练。"*
 *   而我给他的设计里有一条**前置条件**，必须让他在界面上**看得见**：
 *
 *     > AI 判断的前提是先有"覆盖率"。软件里关于孩子的一切，
 *     > 都来自你们**自觉扫回来**的那些纸 —— 只扫了一半，AI 会**很自信地得出错结论**。
 *
 *   ⇒ 所以这一块**不是统计看板，是"这批数据有多厚"的体检报告**：
 *     每个数字旁边都要能看出"这是基于几道题算的"。
 *     任何 AI 结论将来都要挂在这里的覆盖率上，否则它就是个会说服人的算命先生。
 *
 * ── 三件它**故意不做**的事 ──────────────────────────────────────────
 *   ① 不给"总分"、不给"评级" —— 那是评价，不是事实；评价要等覆盖率够厚（他自己的顾虑）。
 *   ② 不猜学科：`subject` 从 **Notebook** 来（题自己不存学科，见 schema 里
 *      `ErrorItem.gradeSemester` 那条"由 Notebook 承载"的注释）；
 *      没归本的题落进「未归本」，**不塞进"其他"**（"其他"是个真学科 key，两回事）。
 *   ③ 不把"已掌握"混进主库：`masteryLevel === 2` 即四分法里的「已掌握」
 *      （他 2026-09-29 定），它**不算"还要练的题"**，但要在"家底"里看得见。
 *
 * ⚠️ 判据**复用**，一处都不另写：状态机在 `review-status.ts`、错因字典在
 *    `mistake-category.ts`、学科名/色在 `subject-colors.ts`。
 */

import { normalizeManageType, type ManageType } from './manage-type';
import { getMistakeCategoryLabel, normalizeMistakeCategory } from './mistake-category';
import { REVIEW_STATE_LABELS, reviewStatusOf, type ReviewState } from './review-status';
import { getSubjectColorDef } from './subject-colors';

/** 这一块要看的字段（与 `CabinetQuestion` 一样都是"裁剪过的题"） */
export interface OverviewItem {
    id: string;
    /** 学科 subjectKey（math/chinese/…）—— 从 **Notebook** 取，没归本就是 null */
    subject?: string | null;
    /** 错因（MistakeCategory 之一），没打就是 null */
    mistakeCategory?: string | null;
    manageType?: string | null;
    /** 0 新 / 1 复练中 / 2 已掌握（四分法的「已掌握」＝ 2） */
    masteryLevel?: number | null;
    reviewOutcomes?: unknown;
}

/** 一道"学科"下面的小账 */
export interface SubjectSummary {
    /** subjectKey；`''` = **未归本**（不是"其他"学科，别混） */
    key: string;
    label: string;
    /** 2 字母简拼（黑白/色觉差异时的天然冗余，与纸面同一套） */
    code: string;
    hex: string;
    count: number;
    /** 其中"今天该练"的（紧迫度 ≥ 4，口径与内阁⑦「今天先练」完全一致） */
    urgent: number;
    /** 其中已掌握 */
    mastered: number;
    /** 其中**一次复练结果都没有** ⇒ AI 对它们一无所知 */
    noEvidence: number;
}

/** 「有多少 / 共多少 / 百分之几」—— 覆盖率的最小单位 */
export interface CoverageStat {
    have: number;
    all: number;
    /** 0–100 的整数（`all === 0` 时给 0，不显示 NaN） */
    pct: number;
}

export interface Overview {
    totals: {
        /** 在库题数（不含回收箱、不含归档本里的题 —— 口径与内阁其余块一致） */
        all: number;
        mastered: number;
        /** 今天该练的（新题 / 刚错 / 连错 ≥ 2） */
        urgent: number;
        /** 已经不用再排进复练的 */
        retired: number;
    };
    coverage: {
        /** 有复练结果的 —— **最要紧的那条**：没有它，状态机什么都算不出来 */
        reviewResult: CoverageStat;
        /** 打过错因的 —— 处置建议靠它 */
        mistakeCategory: CoverageStat;
        /** 定过处置方式的（深挖/复练）—— 不是"未定" */
        manageType: CoverageStat;
    };
    bySubject: SubjectSummary[];
    byReviewState: { state: ReviewState; zh: string; en: string; count: number }[];
    byMistakeCategory: { key: string; label: string; count: number }[];
    /** 固定阈值：紧迫度到这个数就算"今天该练"（与 `practiceTodayItems` 同一条线） */
    urgentThreshold: number;
}

/** 「今天该练」的紧迫度门槛 —— **与内阁⑦同一条线**（改这里等于两处一起改） */
export const OVERVIEW_URGENT_THRESHOLD = 4;

function pct(have: number, all: number): number {
    if (all <= 0) return 0;
    return Math.round((have / all) * 100);
}

/**
 * 汇总。
 *
 * @param items 在库的题（调用方已经把回收箱/归档本排除掉，见 `api/cabinet` 的口径注释）
 * @param today 算"今天该练"用的今天（纯函数，不读系统时间，方便单测）
 */
export function buildOverview(items: OverviewItem[], today: Date = new Date()): Overview {
    const all = items.length;

    let mastered = 0;
    let urgent = 0;
    let retired = 0;
    let withResult = 0;
    let withCategory = 0;
    let withManageType = 0;

    /** 学科桶：key -> 累加 */
    const subjectMap = new Map<string, SubjectSummary>();
    /** 状态桶 */
    const stateCount: Record<ReviewState, number> = { new: 0, due: 0, practicing: 0, retired: 0 };
    /** 错因桶 */
    const categoryCount = new Map<string, number>();
    let noCategory = 0;

    for (const it of items) {
        const status = reviewStatusOf(it.reviewOutcomes, today);
        const isMastered = it.masteryLevel === 2;
        const hasCategory = normalizeMistakeCategory(it.mistakeCategory) !== null;
        const manageType: ManageType | null = normalizeManageType(it.manageType);

        if (isMastered) mastered += 1;
        if (status.state === 'retired') retired += 1;
        // 「今天该练」：紧迫度到线，且**已掌握的不算**（四分法里它不进主库）——
        // 口径与 `practiceTodayItems` 逐字一致，免得"两块数字打架"。
        const isUrgent = !isMastered && status.urgency >= OVERVIEW_URGENT_THRESHOLD;
        if (isUrgent) urgent += 1;

        if (status.evidenceCount > 0) withResult += 1;
        if (hasCategory) withCategory += 1;
        if (manageType !== null) withManageType += 1;

        // ── 学科（未归本用 ''，**不是** 'other'）
        const sKey = (it.subject ?? '').trim().toLowerCase();
        const def = sKey ? getSubjectColorDef(sKey) : null;
        const bucketKey = def ? def.key : '';
        let bucket = subjectMap.get(bucketKey);
        if (!bucket) {
            bucket = {
                key: bucketKey,
                label: def ? def.label : '未归本',
                code: def ? def.code : '—',
                hex: def ? def.hex : '#9ca3af',
                count: 0,
                urgent: 0,
                mastered: 0,
                noEvidence: 0,
            };
            subjectMap.set(bucketKey, bucket);
        }
        bucket.count += 1;
        if (isUrgent) bucket.urgent += 1;
        if (isMastered) bucket.mastered += 1;
        if (status.evidenceCount === 0) bucket.noEvidence += 1;

        // ── 状态
        stateCount[status.state] += 1;

        // ── 错因
        const cat = normalizeMistakeCategory(it.mistakeCategory);
        if (cat) categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
        else noCategory += 1;
    }

    /**
     * 学科排序：**题多的在前**（一眼看出重心）；同数按 key 固定序（结果稳定，不会两次不同）。
     * ⚠️ 「未归本」永远排最后 —— 它是"还没整理"，不是一科。
     */
    const bySubject = [...subjectMap.values()].sort((a, b) => {
        if (a.key === '' && b.key !== '') return 1;
        if (b.key === '' && a.key !== '') return -1;
        if (b.count !== a.count) return b.count - a.count;
        return a.key.localeCompare(b.key);
    });

    /**
     * 错因排序：**按字典顺序**（`MISTAKE_CATEGORIES` 的排列 = 界面下拉里的顺序），
     * 不按数量 —— 数量每天都在变，顺序跟着跳会让人找不到"上次那个在哪"。
     */
    const byMistakeCategory = [...categoryCount.entries()]
        .map(([key, count]) => ({
            key,
            label: getMistakeCategoryLabel(key as never),
            count,
        }))
        .sort((a, b) => b.count - a.count);

    return {
        totals: { all, mastered, urgent, retired },
        coverage: {
            reviewResult: { have: withResult, all, pct: pct(withResult, all) },
            mistakeCategory: { have: withCategory, all, pct: pct(withCategory, all) },
            manageType: { have: withManageType, all, pct: pct(withManageType, all) },
        },
        bySubject,
        byReviewState: (['new', 'due', 'practicing', 'retired'] as ReviewState[]).map((state) => ({
            state,
            zh: REVIEW_STATE_LABELS[state].zh,
            en: REVIEW_STATE_LABELS[state].en,
            count: stateCount[state],
        })),
        byMistakeCategory:
            noCategory > 0
                ? [...byMistakeCategory, { key: '__none__', label: '没打错因', count: noCategory }]
                : byMistakeCategory,
        urgentThreshold: OVERVIEW_URGENT_THRESHOLD,
    };
}

/**
 * 一句话说清"这批数据能不能信" —— 界面上直接显示，**别让覆盖率藏在数字堆里**。
 *
 * 分档只按最要紧的那条（**有复练结果的百分比**）：没有结果，状态机、紧迫度、
 * "今天先练哪几道"全是空转 —— 所以它才是"数据够不够厚"的真正刻度。
 */
export function coverageSentence(coverage: CoverageStat, zh = true): string {
    if (coverage.all === 0) {
        return zh ? '还没有在库的错题。' : 'No questions in the library yet.';
    }
    if (coverage.have === 0) {
        return zh
            ? `一次复练结果都还没有（0 / ${coverage.all}）—— 现在给出的任何"状态"都只是占位，先让扫回来的纸勾上 ✓ / ✗。`
            : `No review results yet (0 / ${coverage.all}) — every "state" is a placeholder until sheets are scanned back.`;
    }
    if (coverage.pct < 30) {
        return zh
            ? `只有 ${coverage.have} / ${coverage.all} 道题有复练结果（${coverage.pct}%）—— 样本还薄，看结论时要留一份心。`
            : `Only ${coverage.have} / ${coverage.all} have review results (${coverage.pct}%) — the sample is still thin.`;
    }
    if (coverage.pct < 70) {
        return zh
            ? `有 ${coverage.have} / ${coverage.all} 道题有复练结果（${coverage.pct}%）—— 能看出大方向了。`
            : `${coverage.have} / ${coverage.all} have review results (${coverage.pct}%) — good enough for the big picture.`;
    }
    return zh
        ? `有 ${coverage.have} / ${coverage.all} 道题有复练结果（${coverage.pct}%）—— 数据够厚，结论可以当真。`
        : `${coverage.have} / ${coverage.all} have review results (${coverage.pct}%) — thick enough to trust.`;
}
