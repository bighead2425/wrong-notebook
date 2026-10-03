/**
 * 【2026-10-04 新增】「总理内阁」· 任务判据（**纯逻辑，不碰 DOM / 不碰数据库**）。
 *
 * ── 这个文件回答一个问题 ─────────────────────────────────────────────
 *   他（家长）打开「总理内阁」，**不用自己想"现在该干什么"** ——
 *   这一页把"该印哪张纸、该回录哪张纸、哪道题该复查"排成一排任务卡。
 *   所以判据必须**只有这一处实现**：页面、接口、将来的定时提醒都来调它，
 *   免得"卡片说 12 道、点进去却是 9 道"这种两处各算一遍的老毛病。
 *
 * ── 五条判据（哪些是"真算"、哪些是"近似"）────────────────────────────
 *   ① 待打印深挖题：`manageType='deep'` 且 `printCount=0`      —— **真算**
 *   ② 该复查的题：印过深挖纸（printCount>0）且有打印日；
 *      下一个**还没做**的计划复习节点（1/7/21 天）**已到期**   —— **真算**（口径＝纸上三个日期格）
 *   ③ 该回录的深挖纸：印过、过了若干天、且**题库里没有这道题的日积月累**
 *      （回录的落点就是一条挂本题号的 Insight）              —— 判据真、阈值（天数）是**近似**
 *   ④ 待回录的复练卷：卷=review、组卷距今超过若干天、且**还有行没标对错**
 *      （回录复练卷的落点＝卷行 markState；无"已打印"标记 ⇒ 只能**近似**）
 *   ⑤ 未打印的日积月累：这条 Insight **没被编进任何卷**        —— **真算**（走 ReviewVolumeItem.insightId）
 *   ⑥ 建议升为深挖：不是深挖、且计划复习里**错了 ≥2 次**       —— **只建议，绝不自动改**
 *
 * ⚠️ 复习结果的形状与规则**复用** `review-outcomes.ts`（`normalizeReviewOutcomes`），
 *    日期加减**复用** `calendar-grid.ts`（本地 `YYYY-MM-DD` 字符串比较），
 *    等级归一**复用** `manage-type.ts` 的 `normalizeManageType` —— 本文件不另写一份。
 */

import { addDays, dayKey, parseDayKey } from './calendar-grid';
import {
    normalizeReviewOutcomes,
    PLANNED_REVIEW_LABELS_ZH,
    PLANNED_REVIEW_OFFSET_DAYS,
} from './review-outcomes';
import { normalizeManageType } from './manage-type';

/* ============================ 输入形状 ============================ */

/** 一道错题里"判任务"用得上的那几列（就是 `ErrorItem` 的一个子集） */
export interface CabinetQuestion {
    id: string;
    /** 题号（如 SX20260916001）—— 与日积月累的 `errorItemNo` 对应 */
    source: string | null;
    /** deep / review / null(未定) */
    manageType: string | null;
    /** 深挖纸打印次数 */
    printCount: number;
    /** 最近一次深挖纸打印时间 */
    lastPrintedAt: Date | string | null;
    /** 复习结果（JSON 字符串或对象）—— 规则见 review-outcomes.ts */
    reviewOutcomes: unknown;
    notebookId?: string | null;
}

/** 一条日积月累（只取判"有没有印进过卷 / 是不是某题的回收记录"要用的） */
export interface CabinetInsight {
    id: string;
    code: string;
    subject?: string | null;
    /** 关联错题的题号（回录深挖纸落下来的条目就靠它认领那道题）；可为空 */
    errorItemNo?: string | null;
    /** 这条被编进过哪些卷（来自 `ReviewVolumeItem.insightId` 的反查） */
    volumeIds: string[];
}

/** 一份复练卷（只取判"该不该回录"要用的） */
export interface CabinetVolume {
    id: string;
    volumeNo: string;
    kind: string;
    createdAt: Date | string;
    /** 卷内每一行的标记态：null = 还没标（≈ 还没回录这一行） */
    items: { markState: string | null }[];
}

/* ============================ 选项与常量 ============================ */

export interface CabinetOptions {
    /** 印过深挖纸后，隔几天还没回录就算"该回录"（近似阈值，默认 2 天） */
    recoverMinDays: number;
    /** 计划复习里错到几次就"建议升深挖"（默认 2 次） */
    suggestUpgradeMinWrong: number;
}

export const CABINET_DEFAULT_OPTIONS: CabinetOptions = {
    recoverMinDays: 2,
    suggestUpgradeMinWrong: 2,
};

/* ============================ 小工具 ============================ */

/** 时间 → Date（认不出的当"没有"，不猜） */
function toDate(value: Date | string | null | undefined): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** 两个 `YYYY-MM-DD` 之间差几天（`later - earlier`，同日为 0） */
function daysBetweenKeys(earlier: string, later: string): number {
    return Math.round((parseDayKey(later).getTime() - parseDayKey(earlier).getTime()) / 86400000);
}

/** 题号归一（大写、去空白）—— 与日积月累的 errorItemNo 口径一致 */
function normNo(no: string | null | undefined): string {
    return (no ?? '').trim().toUpperCase();
}

/** 按 id 去重（防御：库里同一条记录绝不会返回两遍，但编排层不该指望它） */
function dedupeById<T extends { id: string }>(rows: readonly T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
    }
    return out;
}

/* ============================ ① 待打印深挖题 ============================ */

/**
 * 类型=深挖，但**这张深挖纸一次都还没印过**。
 *
 * ⚠️ 「未定」**不算深挖**（按定稿的 L0：未定读作复练，不是深挖）——
 *    所以这里只认 `manageType='deep'`，不去猜老数据。
 */
export function pendingDeepPrint(questions: readonly CabinetQuestion[]): CabinetQuestion[] {
    return questions.filter(
        (q) => normalizeManageType(q.manageType) === 'deep' && (Number(q.printCount) || 0) === 0,
    );
}

/* ============================ ② 该复查的题 ============================ */

export interface DueReviewItem {
    question: CabinetQuestion;
    /** 下一个还没做的是第几次计划复习（0=第1天 / 1=第7天 / 2=第21天） */
    plannedIndex: 0 | 1 | 2;
    /** 这个复习节点的到期日（打印日 + 1/7/21，本地 `YYYY-MM-DD`） */
    dueOn: string;
    /** 到期后过了几天（正好到期当天 = 0） */
    overdueDays: number;
    /** 该节点的中文名（"第 7 天复习"） */
    label: string;
}

/**
 * 印过深挖纸、且**纸面下一个日期格已经到期**的题 —— 可以集中打印成复练卷了。
 *
 * 口径（他给的）：日期格 = **打印日 + 1 / 7 / 21 天**；基准取 `lastPrintedAt`。
 * "下一个还没做的" = `reviewOutcomes.planned` 里**第一个为空**的那一格
 *   —— 已经做过的不再提醒；三格都做满的，不再有计划复习。
 *
 * ⚠️ 到期判据用 **>=**：正好到期那一天就算到期（边界要算进来）。
 */
export function dueReviewItems(
    questions: readonly CabinetQuestion[],
    now: Date,
): DueReviewItem[] {
    const today = dayKey(now);
    const out: DueReviewItem[] = [];

    for (const q of questions) {
        if ((Number(q.printCount) || 0) <= 0) continue;
        const base = toDate(q.lastPrintedAt);
        if (!base) continue;

        const planned = normalizeReviewOutcomes(q.reviewOutcomes).planned;
        const idx = planned.findIndex((v) => v === null);
        if (idx === -1) continue; // 三次计划复习都做完了

        const dueOn = addDays(dayKey(base), PLANNED_REVIEW_OFFSET_DAYS[idx]);
        if (today < dueOn) continue; // 还没到期（本地日字符串可直接比大小）

        out.push({
            question: q,
            plannedIndex: idx as 0 | 1 | 2,
            dueOn,
            overdueDays: daysBetweenKeys(dueOn, today),
            label: PLANNED_REVIEW_LABELS_ZH[idx],
        });
    }
    return out;
}

/* ============================ ③ 该回录的深挖纸（题维度）============================ */

export interface PendingRecoverItem {
    question: CabinetQuestion;
    /** 打印日距今几天 */
    daysSincePrint: number;
}

/**
 * 印过深挖纸、过了若干天、且**还没有这道题的日积月累** ⇒ 该回录了。
 *
 * 判据（真）：回录深挖纸的落点就是一条**挂本题号**的 `Insight`（见 /recover 页 saveCard）。
 *            所以"题库里有没有 `errorItemNo === 题号` 的条目"就是"回录没回录过"。
 * 近似：**多少天算久**，这里取 `recoverMinDays`（默认 2 天）—— 纸给她的时间我们没有别的信号。
 *
 * ⚠️ 题号为空（`source` 缺失）⇒ **不列**：无法判断"回录过没有"，宁可漏报也不误报。
 */
export function pendingRecoverItems(
    questions: readonly CabinetQuestion[],
    recoveredNos: ReadonlySet<string>,
    now: Date,
    options: CabinetOptions = CABINET_DEFAULT_OPTIONS,
): PendingRecoverItem[] {
    const today = dayKey(now);
    const out: PendingRecoverItem[] = [];
    // 传入集合可能大小写/空白不一，这里再归一一次（判据只看"题号是否相等"）
    const recovered = new Set([...recoveredNos].map((no) => normNo(no)).filter(Boolean));

    for (const q of questions) {
        if ((Number(q.printCount) || 0) <= 0) continue;
        const base = toDate(q.lastPrintedAt);
        if (!base) continue;

        const days = daysBetweenKeys(dayKey(base), today);
        if (days < options.recoverMinDays) continue;

        const no = normNo(q.source);
        if (!no) continue;
        if (recovered.has(no)) continue;

        out.push({ question: q, daysSincePrint: days });
    }
    return out;
}

/* ============================ ④ 待回录的复练卷（卷维度）============================ */

export interface PendingRecoverVolumeItem {
    volume: CabinetVolume;
    /** 还有几行没标对错（≈ 还没回录的题数） */
    unrecoveredCount: number;
    /** 组卷距今几天 */
    daysSinceCreated: number;
}

/**
 * 已经组出来、过了若干天、且**还有行没标对错**的复练卷 ⇒ 建议回录。
 *
 * 近似（说明在汇报里）：卷表**没有"已打印"标记**，所以只能拿"组卷时间 + 有没标的行"当判据 ——
 *   组出来 >recoverMinDays 天还没回录完 ⇒ 提示他**人工看一眼**这张纸该不该扫回来。
 * 积累卷（build）不在此列：它按"未打印日积月累"那条任务走。
 */
export function pendingRecoverVolumes(
    volumes: readonly CabinetVolume[],
    now: Date,
    options: CabinetOptions = CABINET_DEFAULT_OPTIONS,
): PendingRecoverVolumeItem[] {
    const today = dayKey(now);
    const out: PendingRecoverVolumeItem[] = [];

    for (const v of volumes) {
        if (v.kind !== 'review') continue;
        const created = toDate(v.createdAt);
        if (!created) continue;

        const days = daysBetweenKeys(dayKey(created), today);
        if (days < options.recoverMinDays) continue;

        const unrecoveredCount = v.items.filter((it) => !it.markState).length;
        if (unrecoveredCount === 0) continue;

        out.push({ volume: v, unrecoveredCount, daysSinceCreated: days });
    }
    return out;
}

/* ============================ ⑤ 未打印的日积月累 ============================ */

/** 没被编进任何卷的条目 —— 就是"新增了、还没印过"的日积月累。 */
export function unprintedInsights(insights: readonly CabinetInsight[]): CabinetInsight[] {
    return insights.filter((i) => i.volumeIds.length === 0);
}

/* ============================ ⑥ 建议升为深挖（只建议）============================ */

export interface UpgradeSuggestion {
    question: CabinetQuestion;
    /** 三次计划复习里错了多少次 */
    wrongCount: number;
}

/**
 * **建议**把某道题升成深挖 —— 依据：计划复习里错了 ≥ `suggestUpgradeMinWrong`（默认 2）次。
 *
 * ⚠️ **只建议、绝不自动改**（沿用已拍板的 TBD-9：以她的为准，AI/系统并存不覆盖）。
 *    已经是深挖（或未定）不在本任务里；未定的题若要升，也由人自己点。
 * ⚠️ 只数 `planned` 三格、**不重复数 `last`** —— `last` 常常就是计划内那一次同步过来的，
 *    两处都数会把同一件事算两遍（见 review-outcomes.ts 规矩①）。
 */
export function upgradeSuggestions(
    questions: readonly CabinetQuestion[],
    options: CabinetOptions = CABINET_DEFAULT_OPTIONS,
): UpgradeSuggestion[] {
    const out: UpgradeSuggestion[] = [];
    for (const q of questions) {
        if (normalizeManageType(q.manageType) === 'deep') continue;
        const planned = normalizeReviewOutcomes(q.reviewOutcomes).planned;
        const wrongCount = planned.filter((v) => v === 'wrong').length;
        if (wrongCount < options.suggestUpgradeMinWrong) continue;
        out.push({ question: q, wrongCount });
    }
    return out;
}

/* ============================ 编排（含跨任务去重）============================ */

/** 一张任务卡的通用形状：有几个 + 都是谁（给界面做链接/预览用） */
export interface CabinetTask<T> {
    count: number;
    /** 涉及的错题 id（卷类任务则为空，另给 volumeIds） */
    ids: string[];
    items: T[];
}

export interface CabinetTasks {
    pendingDeepPrint: CabinetTask<{ id: string; source: string | null; notebookId?: string | null }>;
    dueReviews: CabinetTask<{
        id: string;
        source: string | null;
        notebookId?: string | null;
        dueOn: string;
        plannedIndex: 0 | 1 | 2;
        label: string;
        overdueDays: number;
    }>;
    pendingRecover: CabinetTask<{ id: string; source: string | null; daysSincePrint: number; notebookId?: string | null }>;
    pendingRecoverVolumes: CabinetTask<{ id: string; volumeNo: string; unrecoveredCount: number; daysSinceCreated: number }> & {
        volumeIds: string[];
    };
    unprintedInsights: CabinetTask<{ id: string; code: string; subject?: string | null }>;
    upgradeSuggestions: CabinetTask<{
        id: string;
        source: string | null;
        notebookId?: string | null;
        wrongCount: number;
    }>;
}

/**
 * 把 6 条任务一次算出来。
 *
 * ── 跨任务去重的取舍（他特别问过："同一题落进两个任务要不要去重"）──────
 *   · **①②③ 之间**：待打印(printCount=0) 与 该复查/该回录(printCount>0) 天然不相交；
 *   · **② 与 ③ 之间**：做了**一处去重** —— **"该回录"的题，不再出现在"该复查"里**。
 *     理由：深挖纸还没回录（她写的分析还没扫回来）就让她去印复练卷，
 *     顺序是反的（先回录、后复查）。所以计划复习的提醒让位给回录提醒。
 *   · **③ 与 ④（卷）**：一个是题、一个是卷，不同对象，不去重。
 *   · **⑥ 与其他**：⑥ 只在"错得多、还不是深挖"时给**建议**，是并列的提示，
 *     不抢占别的任务（他要求"只建议"）。
 *   · **同一条任务内部**：按题目 id 天然唯一（输入每一题只出一项）。
 */
export function buildCabinetTasks(input: {
    questions: readonly CabinetQuestion[];
    insights: readonly CabinetInsight[];
    volumes: readonly CabinetVolume[];
    now: Date;
    options?: CabinetOptions;
}): CabinetTasks {
    const options = input.options ?? CABINET_DEFAULT_OPTIONS;
    const { now } = input;
    // 同一题只算一次（输入按 id 去重；DB 侧不会重复，这是防御性的）
    const questions = dedupeById(input.questions);
    const insights = dedupeById(input.insights);
    const volumes = dedupeById(input.volumes);

    const recoveredNos = new Set(
        insights
            .map((i) => i.errorItemNo)
            .filter((no): no is string => !!no && !!no.trim())
            .map((no) => normNo(no)),
    );

    const deep = pendingDeepPrint(questions);
    const recover = pendingRecoverItems(questions, recoveredNos, now, options);
    const recoveringIds = new Set(recover.map((r) => r.question.id));
    const due = dueReviewItems(questions, now).filter((d) => !recoveringIds.has(d.question.id));
    const recoveredVolumes = pendingRecoverVolumes(volumes, now, options);
    const unprinted = unprintedInsights(insights);
    const upgrades = upgradeSuggestions(questions, options);

    return {
        pendingDeepPrint: {
            count: deep.length,
            ids: deep.map((q) => q.id),
            items: deep.map((q) => ({ id: q.id, source: q.source, notebookId: q.notebookId })),
        },
        dueReviews: {
            count: due.length,
            ids: due.map((d) => d.question.id),
            items: due.map((d) => ({
                id: d.question.id,
                source: d.question.source,
                notebookId: d.question.notebookId,
                dueOn: d.dueOn,
                plannedIndex: d.plannedIndex,
                label: d.label,
                overdueDays: d.overdueDays,
            })),
        },
        pendingRecover: {
            count: recover.length,
            ids: recover.map((r) => r.question.id),
            items: recover.map((r) => ({
                id: r.question.id,
                source: r.question.source,
                daysSincePrint: r.daysSincePrint,
                notebookId: r.question.notebookId,
            })),
        },
        pendingRecoverVolumes: {
            count: recoveredVolumes.length,
            ids: [],
            volumeIds: recoveredVolumes.map((v) => v.volume.id),
            items: recoveredVolumes.map((v) => ({
                id: v.volume.id,
                volumeNo: v.volume.volumeNo,
                unrecoveredCount: v.unrecoveredCount,
                daysSinceCreated: v.daysSinceCreated,
            })),
        },
        unprintedInsights: {
            count: unprinted.length,
            ids: unprinted.map((i) => i.id),
            items: unprinted.map((i) => ({ id: i.id, code: i.code, subject: i.subject })),
        },
        upgradeSuggestions: {
            count: upgrades.length,
            ids: upgrades.map((u) => u.question.id),
            items: upgrades.map((u) => ({
                id: u.question.id,
                source: u.question.source,
                notebookId: u.question.notebookId,
                wrongCount: u.wrongCount,
            })),
        },
    };
}
