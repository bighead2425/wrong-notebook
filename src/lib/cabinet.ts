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
} from './review-outcomes';
import { normalizeManageType } from './manage-type';
// 【2026-10-13】⑦「今天先练这几道」用状态机算紧迫度（规则只在那一个模块里）
import { reviewStatusOf, type ReviewStatus } from './review-status';
// 【2026-10-13】学情底账（覆盖率）—— 判据在 overview.ts，本文件只负责把它一起返回
import { buildOverview, type Overview } from './overview';
// 【2026-10-15 真真】知识点 × 时间窗统计 —— 判据在 knowledge-stats.ts，同样只负责一起返回
import { buildKnowledgeStats, type KnowledgeSummary } from './knowledge-stats';

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
    /**
     * 【2026-10-20 如如】深挖纸上印的那个 emoji（`ErrorItem.emojiMark`）。
     * 「待回录分析」把它显示在题号前面 —— 纸堆里靠 emoji 找人快过看题号。
     */
    emojiMark?: string | null;
    /** 最近一次深挖纸打印时间 */
    lastPrintedAt: Date | string | null;
    /** 复习结果（JSON 字符串或对象）—— 规则见 review-outcomes.ts */
    reviewOutcomes: unknown;
    /**
     * 掌握度（0 新 / 1 复习中 / 2 已掌握）。
     * 【2026-10-13】⑦「今天先练这几道」要用它把人已掌握的那批**排除掉**
     * （四分法里已掌握不进主库，也不该催着练）。
     * 可选：老调用方（测试）不传也能跑 —— 不传按 0 处理。
     */
    masteryLevel?: number | null;
    /**
     * 【2026-10-16】**还剩几天该练**（`ErrorItem.levelCountdown`，0~49，由每日结算递减）。
     * ②「该复查」现在的判据就是它（倒数 ≤ 0 = 到期）—— 见 `dueReviewItems` 的文件头。
     * 可选：老调用方（测试）不传也能跑 —— 不传按"还没到期"处理。
     */
    levelCountdown?: number | null;
    notebookId?: string | null;
    /**
     * 【2026-10-13 底账】学科 subjectKey（从 **Notebook** 取 —— 题自己不存学科，
     * 见 schema 里 `ErrorItem.gradeSemester` 那条"由 Notebook 承载"的注释）。
     * 可选：老调用方（测试）不传 ⇒ 底账里落进「未归本」，不会算错。
     */
    subject?: string | null;
    /** 【2026-10-13 底账】错因（`MistakeCategory` 之一）—— 覆盖率要数它 */
    mistakeCategory?: string | null;
    /**
     * 【2026-10-15 真真】知识点（`ErrorItem.tags` → `KnowledgeTag`）—— 知识点统计要数它。
     * ⚠️ 真源是**多对多关系 `tags`**，不是 `ErrorItem.knowledgePoints` 那列（那列已 `[DEPRECATED]`）。
     * 可选：老调用方（测试）不传 ⇒ 这道题不进任何知识点统计，**不会算错**。
     */
    tags?: { name: string; subject?: string | null }[] | null;
}

/** 【2026-10-13】"今天先练哪几道"的一条 —— 由复练结果算出来（不落库，见 review-status.ts） */
export interface PracticeTodayItem {
    question: CabinetQuestion;
    /** 状态机算出来的那套（状态 / 连对 / 紧迫度 / 建议下次 / 证据条数） */
    status: ReviewStatus;
    /** 为什么现在该练它（界面直接拼在题号后面；中英各一句，只在这处生成） */
    reasonZh: string;
    reasonEn: string;
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
    /**
     * 【2026-10-20 空空】**组卷时随机给的 emoji 标识**（`ReviewVolume.emojiMark`）。
     * 卷号长得像，靠这个符号一眼认出"就是那一份" —— 回录页要显示它。
     * 可空：老卷可能还没生成过。
     */
    emojiMark?: string | null;
    createdAt: Date | string;
    /** 卷内每一行的标记态：null = 还没标（≈ 还没回录这一行） */
    items: {
        markState: string | null;
        /**
         * 【2026-10-20 空空】那一行对应的题。要它来判断"**这一行还标得了吗**"：
         *   · `deletedAt` 非空 ⇒ 题已删，**永远标不了**
         *   · `masteryLevel === 2` ⇒ 已掌握，**不必再标**
         * 这两种都不该算进"还有 X 行没标"（详见 `pendingRecoverVolumes`）。
         */
        errorItem?: { deletedAt?: Date | string | null; masteryLevel?: number | null } | null;
    }[];
}

/* ============================ 选项与常量 ============================ */

export interface CabinetOptions {
    /** 印过深挖纸后，隔几天还没回录就算"该回录"（近似阈值，默认 2 天） */
    recoverMinDays: number;
    /** 计划复习里错到几次就"建议升深挖"（默认 2 次） */
    suggestUpgradeMinWrong: number;
    /**
     * 【2026-10-20 空空第 6 条】**她已经确认"不升级"的那些题** —— 题 id → 当时错了几次。
     *
     * 判据：`当前错误次数 <= 当时次数` 才压着不提示。
     * 为什么不是"永久不再提示"：她又错了第三次、第四次，情况已经变了，
     * 还拿老决定挡着就是**替她做了一个过时的决定**。
     * 不传 = 没有留级记录（默认行为不变，老单测照旧通过）。
     */
    keptWrongCounts?: Map<string, number>;
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
    /** 该练的那一天（本地 `YYYY-MM-DD`）—— **新口径：今天 + 倒数天数**（倒数 ≤ 0 ⇒ 就是今天或更早） */
    dueOn: string;
    /** 到期后过了几天（正好到期当天 = 0） */
    overdueDays: number;
    /** 短标签（界面自己拼后面的说明） */
    label: string;
}

/**
 * 印过深挖纸、且**倒数天数已经走完**的题 —— 可以集中打印成复练卷了。
 *
 * ── 【2026-10-16 如如 改口径】出处：`docs\18` §3.4 ───────────────────────
 *   老口径是**纸面驱动**：`打印日 + [1,7,21,49][planned 里第一个空格]` ——
 *   它依赖"第几次计划复习"这个下标，而**新模型里没有"第几格"了**（复习结果换成流水）。
 *   ⇒ 改成 `levelCountdown`（= 还差几天该练，`daily-settle` 每天递减）：
 *      **倒数 ≤ 0 ⇒ 到期**；`dueOn = 今天 + 倒数`（负数 = 已经过期的天数）。
 *
 *   ⚠️ **副作用要说清**：这一改，② 就从"纸面驱动"变成"**证据驱动**"了 ——
 *      而 ⑦「今天先练」本来也是证据驱动（见下面 §⑦ 那段分工注释）。
 *      ⇒ **两块的语义开始重叠**。本次**按规格照做**（没自创），
 *      但"要不要合并这两块 / 或让②回到纸面口径"是**产品问题，待空空定**。
 */
export function dueReviewItems(
    questions: readonly CabinetQuestion[],
    now: Date,
): DueReviewItem[] {
    const today = dayKey(now);
    const out: DueReviewItem[] = [];

    for (const q of questions) {
        if ((Number(q.printCount) || 0) <= 0) continue;

        const countdown = Number(q.levelCountdown);
        // 老题可能没这个数（`levelCountdown` 是 2026-10-15 才加的列）⇒ 交给别的块（待打印 / 今天先练）
        if (!Number.isFinite(countdown)) continue;
        if (countdown > 0) continue; // 还没到期

        const dueOn = addDays(today, countdown);
        out.push({
            question: q,
            dueOn,
            overdueDays: Math.max(0, -countdown),
            label: '该练',
        });
    }
    return out;
}

/* ============================ ⑦ 今天先练这几道 ============================ */

/**
 * 【2026-10-13 他拍板的设计】**"今天先练哪几道"** —— 由复练结果算出来的紧迫度排序。
 *
 * ── 它与②「该复查的题」的分工（两块都留着，不互相替代）──────────────
 *   · ② 该复查 = **纸面驱动**：印过深挖纸、纸上的日期格（+1/+7/+21 天）到了。
 *   · ⑦ 今天先练 = **证据驱动**：按复练结果算出的紧迫度（新题 / 刚错 / 连错）。
 *
 *   ⭐ ⑦ 补的正是②那个窟窿：②的判据是"`planned` 里第一个空格"，
 *      **三格做满就直接 `continue`** ⇒ "计划三次都做完、之后又做错"的题，
 *      ②**永远不会再提醒**；而按新规则**错了就必须回来练**。这类题在⑦里捞得回来。
 *
 *   ⚠️⚠️【2026-10-16 如如 更新】**上面这个分工已经被打破了** ——
 *      ② 的判据改成了 `levelCountdown ≤ 0`（`docs\18` §3.4，因为新模型里没有"第几格"），
 *      而那是**证据驱动**的 ⇒ **② 与 ⑦ 现在语义重叠**。
 *      本次**按规格照做、没自创**；但"两块要不要合并 / ② 要不要另找纸面口径"
 *      **是产品问题，待空空定**（已写进 HANDOFF §③）。
 *      📌 判据仍在 ⑦ 这边写死：**已在②里出现的题不重复收**（`buildCabinetTasks` 里做差集）。
 *
 * ── 收谁（判据写死，人和 AI 都别在这里加形容词）──────────────────────
 *   只收**紧迫度 ≥ 4**：新录入（还没练过）、最近一次错、连错两次以上。
 *   · ⚠️ `masteryLevel >= 2`（已掌握）一律不收 —— 四分法里它们不进主库，也不该催练。
 *   · ⚠️ 已在②③（该复查 / 该回录）里出现的题**不重复收**：那两块已经在催它了，
 *        同一道题被三块同时催，等于没有重点。
 *
 * ── 排序（确定性：同样的输入永远同样的顺序，界面不会今天这样明天那样）────
 *   紧迫度 desc → 连错多的在前 → 题号升序（题号就是录入先后）。
 */
export function practiceTodayItems(
    questions: readonly CabinetQuestion[],
    now: Date,
    excludeIds: ReadonlySet<string> = new Set(),
): PracticeTodayItem[] {
    const out: PracticeTodayItem[] = [];
    for (const q of questions) {
        if (excludeIds.has(q.id)) continue;
        if ((Number(q.masteryLevel) || 0) >= 2) continue;
        const status = reviewStatusOf(q.reviewOutcomes, now);
        if (status.urgency < 4) continue;

        let reasonZh: string;
        let reasonEn: string;
        if (status.state === 'new') {
            reasonZh = '还没练过';
            reasonEn = 'never practiced';
        } else if (status.wrongStreak >= 2) {
            reasonZh = `连错 ${status.wrongStreak} 次`;
            reasonEn = `wrong ${status.wrongStreak}× in a row`;
        } else {
            reasonZh = '上次做错';
            reasonEn = 'last attempt was wrong';
        }
        out.push({ question: q, status, reasonZh, reasonEn });
    }

    out.sort((a, b) => {
        if (b.status.urgency !== a.status.urgency) return b.status.urgency - a.status.urgency;
        if (b.status.wrongStreak !== a.status.wrongStreak) return b.status.wrongStreak - a.status.wrongStreak;
        return String(a.question.source ?? a.question.id).localeCompare(String(b.question.source ?? b.question.id));
    });
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

        /**
         * 【2026-10-20 空空】"还有 X 行没标"**只数还标得了的行**。
         *
         * 他原来的疑问："已掌握的题还用计数吗？已删除的题都没办法标了，还用计数吗？"
         * 两种都**不该算**：
         *   · **已删除**：那一行点进去是 404，永远标不掉 ⇒ 这份卷会**永远卡在待回录里**
         *     （这是真 bug，不是口味问题）。
         *   · **已掌握**：她不用再练这道题了，标了对错也不会改变什么。
         *
         * ⚠️ 判据要跟"卷预览里点得动的那几行"对齐 —— 别一边说"还有 3 行"，另一边只画得出 2 个灰圈。
         */
        const canStillMark = (it: CabinetVolume["items"][number]) =>
            !it.errorItem?.deletedAt && (it.errorItem?.masteryLevel ?? 0) < 2;

        const unrecoveredCount = v.items.filter((it) => !it.markState && canStillMark(it)).length;
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
 *    已经是深挖的题不再建议（它本来就是深挖）。
 *    **「未定」（manageType=null，都是老数据）也参与建议** —— 按已定的 L0 口径，
 *    未定读作复练，所以"计划复习错 ≥2 次"对它同样成立；而且这只是**建议**，
 *    点不点、改不改仍由人决定。
 *    📌 2026-10-04 审理时发现这里注释与实现不一致（注释原写"未定不在本任务里"，
 *       而 `normalizeManageType(null) !== 'deep'` ⇒ 未定其实会进来）。
 *       判断：**保留行为、修正注释**（对未定的题给"建议升深挖"是有用的），
 *       并补了单测把这条钉住。若他要求"未定一律不提示"，改这里 + 改那条单测即可。
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
        /**
         * 【2026-10-20 第 6 条】她点过「留级」的，只要**错得不比当时多**就不再提示。
         * 注意是 `<=`：当时错 2 次、现在还是 2 次 ⇒ 继续压着；
         * 现在错 3 次 ⇒ 重新冒出来（情况变了，值得再看一眼）。
         */
        const keptAt = options.keptWrongCounts?.get(q.id);
        if (keptAt !== undefined && wrongCount <= keptAt) continue;
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
        /** ⚠️【2026-10-16】原来的 `plannedIndex`（第几次计划复习）**已删** ——
         *  新模型里没有"第几格"，判据改成 `levelCountdown`（见 `dueReviewItems`） */
        label: string;
        overdueDays: number;
    }>;
    pendingRecover: CabinetTask<{ id: string; source: string | null; daysSincePrint: number; notebookId?: string | null; emojiMark?: string | null }>;
    pendingRecoverVolumes: CabinetTask<{ id: string; volumeNo: string; emojiMark?: string | null; unrecoveredCount: number; daysSinceCreated: number }> & {
        volumeIds: string[];
    };
    unprintedInsights: CabinetTask<{ id: string; code: string; subject?: string | null }>;
    /**
     * 【2026-10-13】"今天先练这几道" —— 由复练结果算出来的紧迫度（`practiceTodayItems`）。
     * 没有 `count` 上限：**总数如实给**，界面上要显示"共 N 道、这里列前几道"，
     * 只显示前几道会让人以为只有那几道（项目规矩：统计类界面必须亮出样本量）。
     */
    practiceToday: CabinetTask<{
        id: string;
        source: string | null;
        notebookId?: string | null;
        urgency: number;
        reasonZh: string;
        reasonEn: string;
    }>;
    upgradeSuggestions: CabinetTask<{
        id: string;
        source: string | null;
        notebookId?: string | null;
        wrongCount: number;
    }>;
    /**
     * 【2026-10-13】学情底账 —— **不是任务，是"这批数据有多厚"的体检报告**。
     *
     * 出处：我给他设计状态机时提的那条前置条件 ——
     *   *"AI 判断的前提是先有覆盖率 …… 只扫了一半，AI 会**很自信地得出错结论**。"*
     * ⇒ 每个数字都要能看出"这是基于几道题算的"，所以它跟任务卡一起返回，
     *   界面上一眼看到"一共几道、其中几道有复练结果"（判据在 `lib/overview.ts`）。
     *
     * ⚠️ 名字叫 `ledger` 不叫 `overview`：接口返回体里已经有一个 `overview`
     *    （错题本一览那套 `questionCount / byManageType / byMastery`，页面在用它），
     *    两个都叫 overview 会让人以为是同一个东西。
     */
    ledger: Overview;
    /**
     * 【2026-10-15 真真】知识点 × 时间窗统计 —— **也不是任务**，是"**哪个知识点在连着错**"。
     *
     * 出处：空空已批的设计第 4 层（`docs\12` 第一节）——
     *   *"新增一张按「知识点 × 时间窗」聚合的表：同一知识点连着错了几次、错因分布、
     *     最近一次是什么时候。AI 读它写评价。"*
     * ⇒ 它服务的是"AI 写学情评价"，所以**每个数字都带 `coverage`**
     *   （项目硬线：任何 AI 结论必须显示样本量与覆盖率）。
     *
     * ⚠️ 判据在 `lib/knowledge-stats.ts`，本文件只负责一起算、一起返回。
     * ⚠️ **本棒不动 UI** —— 展示位等空空定；这里只把数据备好。
     */
    knowledgeStats: KnowledgeSummary[];
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
    /**
     * ⑦ 今天先练：**排除**已经落在别的任务里的题（待打印深挖 / 该复查 / 该回录）——
     * 那些块已经在催它了，别再催一遍。理由见 `practiceTodayItems` 的文件头。
     */
    const alreadyNagged = new Set<string>([
        ...deep.map((q) => q.id),
        ...due.map((d) => d.question.id),
        ...recover.map((r) => r.question.id),
    ]);
    const practice = practiceTodayItems(questions, now, alreadyNagged);

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
                /** 【2026-10-20 如如】深挖纸上印的 emoji —— 回录页靠它找纸（漏了这行就全是 📄） */
                emojiMark: r.question.emojiMark ?? null,
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
                /** 【2026-10-20】组卷时那个 emoji —— 回录页靠它认卷 */
                emojiMark: v.volume.emojiMark ?? null,
                unrecoveredCount: v.unrecoveredCount,
                daysSinceCreated: v.daysSinceCreated,
            })),
        },
        unprintedInsights: {
            count: unprinted.length,
            ids: unprinted.map((i) => i.id),
            items: unprinted.map((i) => ({ id: i.id, code: i.code, subject: i.subject })),
        },
        practiceToday: {
            count: practice.length,
            ids: practice.map((p) => p.question.id),
            items: practice.map((p) => ({
                id: p.question.id,
                source: p.question.source,
                notebookId: p.question.notebookId,
                urgency: p.status.urgency,
                reasonZh: p.reasonZh,
                reasonEn: p.reasonEn,
            })),
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
        /** 【2026-10-13 底账】与任务卡用**同一批题**算 —— 用户看到"共 N 道"必须处处一致 */
        ledger: buildOverview(questions, now),
        /**
         * 【2026-10-15 真真】知识点统计：同样用**同一批题**（`questions` 与 `ledger` 逐字同源）
         * ⇒ 三块数字（任务卡 / 底账 / 知识点）不会出现"各算一遍、互相打架"。
         * ⚠️ 需要 `questions[].tags`；取数侧没带的话这里会得到空数组（不是错，是"没数据"）。
         */
        knowledgeStats: buildKnowledgeStats(questions, now),
    };
}
