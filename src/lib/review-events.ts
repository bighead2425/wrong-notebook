/**
 * 【2026-10-14】复习事件流水 —— 把"复习成绩卡片"换成"流水账"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 背景（详见 `docs\09_review_events改造方案.md`）
 *
 *   老的 `ErrorItem.reviewOutcomes` 是**一张只有四个空格的卡片**：
 *     `{"planned":["right",null,null],"last":"wrong"}`
 *     —— `planned[3]`（第 1/7/21 天三次计划复习）+ `last`（最近一次），
 *        **只有结果、没有日期**。
 *
 *   ⇒ 两个后遗症（都在 `review-status.ts` 的文件头里写着）：
 *     ① **不知道"上次复习是哪天"** ⇒ "建议下次"只能按**今天**起算，
 *        算不出真正的"到期日"；
 *     ② **三个格满了之后再来一次就认不出来** ⇒ `RETIRE_STREAK` 只能取 3
 *        （原本想要 4）。
 *
 *   本模块把"卡片"换成"**流水账**"：一次复习一行，**行数不限、每行带日期**。
 *
 * ── 第二步「切读源」**已开始**（2026-10-16，`docs\18`）─────────────────
 *   复习结果的**唯一真相 = 本表**；`ErrorItem.reviewOutcomes` **降级成派生缓存**
 *   （每次流水变动后，由 `deriveReviewOutcomes()` 从最近 4 条算出来写回）。
 *   ⇒ 于是本模块多了三个"写动作"，**仍然是唯一的写入口**：
 *      · `recordReviewEvent`  —— 新增一条（`op: 'add'`，缺省）
 *      · `updateReviewEvent`  —— 改某一条的结果（`op: 'update'`，表格里点一下改）
 *      · `deleteReviewEvent`  —— 删某一条（`op: 'delete'`，长按菜单 / 表格里的"删"）
 *
 * ── ⚠️ 四条纪律 ────────────────────────────────────────────────────
 *   1. **唯一写入口**：所有写入点都必须走本模块的三个函数，
 *      别处不许直接 `prisma.reviewEvent.*`（同"新写入口必须复用同一个 sink"那条）。
 *      📌 有看门测试盯着（`review-event-wiring` 那条路子）。
 *   2. **写入侧必须显式声明**"这是一次复习" —— 从 `reviewOutcomes` 的前后差分
 *      **推不出来**（三格满了之后又对一次，与三格全对长得一模一样）。
 *   3. **`occurredOn` 是 `YYYY-MM-DD` 字符串**，不是 `Date` —— 遵守"时区铁律"：
 *      容器跑 UTC，"哪一天"必须由**客户端**算好再传进来（`dayKey()`）。
 *      ⚠️ 唯一例外是 `source: 'legacy'`（老数据补的流水）：它只能拿创建日顶，
 *         **界面永远不显示它的日期**（时间列写"迁移前"）。
 *   4. **`source` 记账**：见 `lib/review-event-source.ts`（复练纸/模仿纸带卷号、
 *      单题扫描录入**含深挖纸**、本页录入、legacy）。
 */

import { prisma } from './prisma';
import {
    deriveReviewOutcomesJson,
    isReviewOutcome,
    type ReviewOutcome,
} from './review-outcomes';

/** 这次请求要对流水做的**动作**（缺省 = `add`，所以老调用方一行都不用改） */
export type ReviewEventOp = 'add' | 'update' | 'delete';

/** 一次复习的输入（写入侧显式声明的那份数据） */
export interface ReviewEventInput {
    /** **动作**：新增 / 改某一条 / 删某一条（缺省 `add`） */
    op: ReviewEventOp;
    /** 这一天的日键（`YYYY-MM-DD`）—— **本地时区**，由客户端算好；`op = 'add'` 时必有 */
    occurredOn: string;
    /** 结果；`op = 'delete'` 时为 `null`（删一条不需要结果） */
    outcome: ReviewOutcome | null;
    /** 计划内第几次（0/1/2/3）；`null` = **计划外**的额外复习 */
    plannedIndex: number | null;
    /** 从哪张卷标回来的（可空） */
    volumeId: string | null;
    /** 来源（见 `lib/review-event-source.ts`）—— 缺省按 `single_scan` 处理 */
    source: string | null;
    /** `op = 'update' | 'delete'` 时必有：要动哪一条 */
    eventId: string | null;
}

/** 日键格式：`YYYY-MM-DD`（只认形状，不做日历校验 —— 形状不对就当没传） */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验外面传进来的 `reviewEvent`。
 *
 * 形状不对就返回 `null` ⇒ 调用方**当没传**处理。
 * 与项目里 `cropRegions` / `reviewOutcomes` 同一条规矩：
 * **不因为一个可选字段形状不对就拒掉整条更新**。
 *
 * ── 三个动作各自要求什么（`docs\18` §4.2 表格里点一下改/删）──────────────
 *   · `add`（缺省）：**日期 + 结果**必须有
 *   · `update`：**`eventId` + 结果**必须有（日期、来源、卷号都不动 —— 改主意只是
 *     改正"结果记错了"，不是把这次复习挪到别的时间）
 *   · `delete`：只要 `eventId`
 * ⇒ 所以"日期"这条校验**只对 `add` 生效**，别对改/删也要求 —— 那会逼客户端
 *   把整行数据再回传一遍（回传了服务端也不看，纯属骗人）。
 */
export function parseReviewEventInput(value: unknown): ReviewEventInput | null {
    if (!value || typeof value !== 'object') return null;
    const o = value as Record<string, unknown>;

    /**
     * ⚠️ `op` 只认三个字面量，别的一律当 `add` —— 这样老调用方（只传 occurredOn/outcome）
     *    一个字都不用改就继续能用 ✓
     */
    const op: ReviewEventOp = o.op === 'update' || o.op === 'delete' ? o.op : 'add';
    const eventId = typeof o.eventId === 'string' && o.eventId.trim() ? o.eventId.trim() : null;
    const source = typeof o.source === 'string' && o.source.trim() ? o.source.trim() : null;
    const outcome = isReviewOutcome(o.outcome) ? o.outcome : null;
    const occurredOn = typeof o.occurredOn === 'string' && DAY_KEY_RE.test(o.occurredOn) ? o.occurredOn : '';

    if (op === 'add' && (!occurredOn || !outcome)) return null;
    if (op === 'update' && (!eventId || !outcome)) return null;
    if (op === 'delete' && !eventId) return null;

    const plannedIndex =
        typeof o.plannedIndex === 'number' && Number.isInteger(o.plannedIndex) && o.plannedIndex >= 0
            ? o.plannedIndex
            : null;

    const volumeId = typeof o.volumeId === 'string' && o.volumeId.trim() ? o.volumeId : null;

    return { op, occurredOn, outcome, plannedIndex, volumeId, source, eventId };
}

/** 记一条复习流水 —— **唯一写入口** */
export async function recordReviewEvent(args: {
    userId: string;
    errorItemId: string;
    occurredOn: string;
    outcome: ReviewOutcome;
    plannedIndex?: number | null;
    volumeId?: string | null;
    /** 来源（见 `lib/review-event-source.ts`）；不传 = 这条是"老数据补的"由调用方显式给 */
    source?: string | null;
}): Promise<void> {
    await prisma.reviewEvent.create({
        data: {
            userId: args.userId,
            errorItemId: args.errorItemId,
            occurredOn: args.occurredOn,
            outcome: args.outcome,
            plannedIndex: args.plannedIndex ?? null,
            volumeId: args.volumeId ?? null,
            source: args.source ?? null,
        },
    });
}

/** 某道题的事件流（按日期升序；同一天按入库先后）—— 第二步切读源时用它 */
export async function listReviewEvents(userId: string, errorItemId: string) {
    return prisma.reviewEvent.findMany({
        where: { userId, errorItemId },
        orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
    });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-16 如如】新模型要的三个动作 + 派生 + 取最近几条
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 改某一条的结果（详情页表格里点一下"改成对/错"）。
 *
 * ⚠️ **只改 `outcome`** —— 日期、来源、卷号都不动（那是"这一次复习"的事实，
 *    改主意只是改正"结果记错了"，不是把这次复习挪到别的时间）。
 * ⚠️ 条件里带 `userId` + `errorItemId`（**不是只按 id**）⇒ 越权改别人的记录改不动。
 * @returns 真的改到了才 `true`（id 不存在 / 不是自己的 ⇒ `false`）
 */
export async function updateReviewEvent(args: {
    userId: string;
    errorItemId: string;
    eventId: string;
    outcome: ReviewOutcome;
}): Promise<boolean> {
    const res = await prisma.reviewEvent.updateMany({
        where: { id: args.eventId, userId: args.userId, errorItemId: args.errorItemId },
        data: { outcome: args.outcome },
    });
    return res.count > 0;
}

/** 删某一条（详情页表格里的"删" / 卷页长按菜单的"删除这一条"） */
export async function deleteReviewEvent(args: {
    userId: string;
    errorItemId: string;
    eventId: string;
}): Promise<boolean> {
    const res = await prisma.reviewEvent.deleteMany({
        where: { id: args.eventId, userId: args.userId, errorItemId: args.errorItemId },
    });
    return res.count > 0;
}

/** 派生用的最小形状（只要结果） */
export interface ReviewEventLike {
    outcome: string;
}

/**
 * 这道题**最近的 N 条**流水 —— **按时间正序返回**（末尾 = 最近一次）。
 *
 * ⚠️ 实现细节容易写错：Prisma 的 `take` 配 `orderBy asc` 取的是**最前面** N 条，
 *    不是"最近" N 条 ⇒ 必须 **desc 取 N 条、再反转**。
 * ⚠️ 同一天录多条时分不出先后 ⇒ 再用 `createdAt` 兜一层（与 `listReviewEvents` 同口径）。
 */
export async function listRecentEvents(userId: string, errorItemId: string, limit: number) {
    const rows = await prisma.reviewEvent.findMany({
        where: { userId, errorItemId },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        take: limit,
    });
    return rows.reverse();
}

/**
 * **派生**：从流水算 `ErrorItem.reviewOutcomes` 该写的字符串（规格 §3.1 要的那个函数）。
 * 唯一实现在 `lib/review-outcomes.ts` 的 `deriveReviewOutcomesJson()`（纯函数、前端也能用），
 * 这里只做转发 —— 免得"算最近 4 条"的逻辑有两份。
 */
export function deriveReviewOutcomes(events: readonly { outcome: unknown }[]): string {
    return deriveReviewOutcomesJson(events);
}

/** 老数据补的流水用哪个来源值（`ReviewEventSource` 里的一员） */
export const LEGACY_EVENT_SOURCE = 'legacy';

/**
 * **老数据补流水**（一次性、惰性触发）。
 *
 * 空空 2026-10-16 23:20 定："老数据随便补流水吧，满足测试环境即可"。
 *
 * 为什么要补（而不是只做形状转换）：**圈和表要一致** ——
 *   详情页那张表是**按流水**渲染的；不补流水的话，老题会出现
 *   "错题卡 4 个圈有值、表格却是空的"这种自相矛盾。
 *
 * ⚠️ 日期只能拿 `createdAt` 顶（老数据**没有**日期）⇒ 所以：
 *    · `source` 一律写 `legacy`；
 *    · **界面永远不显示 legacy 行的日期**（时间列写"迁移前"）。
 * ⚠️ 只在"这道题**当前还是老形状**且**还没有任何流水**"时才补 ⇒ 天然幂等（不会越补越多）。
 */
export async function backfillLegacyEvents(args: {
    userId: string;
    errorItemId: string;
    /** 老形状展开出来的结果序列（**调用方用 `legacyOutcomesToRecent()` 算好再传**） */
    outcomes: readonly ReviewOutcome[];
    /** 用来顶日期的那个日键（调用方给题目的 `createdAt` 的本地日） */
    occurredOn: string;
}): Promise<number> {
    if (!args.outcomes.length) return 0;

    const existing = await prisma.reviewEvent.count({
        where: { userId: args.userId, errorItemId: args.errorItemId },
    });
    if (existing > 0) return 0; // 已经有流水了 ⇒ 别再补

    await prisma.reviewEvent.createMany({
        data: args.outcomes.map((outcome, i) => ({
            userId: args.userId,
            errorItemId: args.errorItemId,
            occurredOn: args.occurredOn,
            outcome,
            plannedIndex: i, // 只为**保留顺序**（新模型不再用它做判据）
            volumeId: null,
            source: LEGACY_EVENT_SOURCE,
        })),
    });
    return args.outcomes.length;
}

/**
 * 连对次数（从最后一条往前数，遇到"错"就停）。
 * 带时间戳 ⇒ **不限次数**，这正是老数据做不到的那件事。
 */
export function rightStreakOf(events: readonly { outcome: string }[]): number {
    let n = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].outcome === 'right') n += 1;
        else break;
    }
    return n;
}

/** 最后一次复习的日期（`YYYY-MM-DD`）；没有事件 ⇒ `null` */
export function lastReviewDay(events: readonly { occurredOn: string }[]): string | null {
    return events.length ? events[events.length - 1].occurredOn : null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-16 如如】详情页那张表要读的东西（时间 / 来源 / 结果）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 详情页表格的一行（`docs\18` §4.2） */
export interface ReviewEventRow {
    id: string;
    /** 客户端算好的日键（`YYYY-MM-DD`） */
    occurredOn: string;
    outcome: ReviewOutcome;
    /** 来源（可能为空 —— 老数据与将来的新入口），界面按"单题扫描录入"兜 */
    source: string | null;
    volumeId: string | null;
    /** 卷号（`RE20261016001`）—— 只有复练纸/模仿纸带卷时会填上 */
    volumeNo: string | null;
    /** 入库时刻（**审计用**；"哪天"看 `occurredOn`，别拿它当练习日） */
    createdAt: Date;
}

/**
 * 这道题**最近的 N 条**流水（**正序返回，末尾 = 最近一次**）+ 卷号。
 *
 * ⚠️ 这里是**读**，但照样放在本模块里（唯一碰流水表的地方）——
 *    免得"读一处、写一处"，两边的排序口径迟早分叉。
 * ⚠️ `volumeId` 在 schema 里是**普通字符串**（不是关系）⇒ 卷号要**另查一次**，
 *    而且必须**一次查完**（`in: [...]`），不许每题/每行查一遍（`docs\17` 那条性能账）。
 */
export async function listReviewEventRows(
    userId: string,
    errorItemId: string,
    limit: number,
): Promise<ReviewEventRow[]> {
    const rows = await prisma.reviewEvent.findMany({
        where: { userId, errorItemId },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        select: { id: true, occurredOn: true, outcome: true, source: true, volumeId: true, createdAt: true },
    });
    const ordered = rows.reverse(); // 同 `listRecentEvents`：desc 取 N 条再反转

    const volumeIds = [...new Set(ordered.map((r) => r.volumeId).filter((v): v is string => !!v))];
    const volumes = volumeIds.length
        ? await prisma.reviewVolume.findMany({
              where: { id: { in: volumeIds } },
              select: { id: true, volumeNo: true },
          })
        : [];
    const noById = new Map(volumes.map((v) => [v.id, v.volumeNo]));

    return ordered.map((r) => ({
        id: r.id,
        occurredOn: r.occurredOn,
        outcome: isReviewOutcome(r.outcome) ? r.outcome : 'right',
        source: r.source,
        volumeId: r.volumeId,
        volumeNo: r.volumeId ? (noById.get(r.volumeId) ?? null) : null,
        createdAt: r.createdAt,
    }));
}

/** 某道题在**某一张卷**上的一条记录（卷页画圆 / 角标 / 长按菜单要用） */
export interface VolumeReviewMark {
    errorItemId: string;
    /** 最近一条的结果 */
    outcome: ReviewOutcome;
    /** 最近那条的 id（"删除这一条"用它） */
    eventId: string;
    /** 这道题在这张卷上录过几条（>1 ⇒ 画轮次角标） */
    rounds: number;
}

/**
 * 【2026-10-16 如如】**这一张卷上**每道题的复习记录（`docs\18` §4.3"回显规则"）。
 *
 * 口径：
 *   · 只认 `volumeId = 这张卷` 的流水（**别的卷上的记录不参与** ——
 *     他 2026-10-02 定过："扫一个新卷，即使有这道题还是应该给灰圈"）；
 *   · 每题给**最近一条**（按 `occurredOn` + `createdAt` 取末位）⇒ 圆画它；
 *   · 同时给 `rounds` = 这张卷上录过几条 ⇒ 轮次角标。
 *
 * ⚠️ **一次查完**（`errorItemId in [...]`）再在内存里分组 ——
 *    绝不许"每道题查一次"（`docs\17` 那条性能账：慢来自查询次数多）。
 * ⚠️ 只取需要的列（`select`）：卷页可能有几十道题。
 */
export async function listVolumeReviewMarks(
    userId: string,
    volumeId: string,
    errorItemIds: readonly string[],
): Promise<VolumeReviewMark[]> {
    if (!volumeId || !errorItemIds.length) return [];

    const rows = await prisma.reviewEvent.findMany({
        where: { userId, volumeId, errorItemId: { in: [...errorItemIds] } },
        orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, errorItemId: true, outcome: true },
    });

    const byItem = new Map<string, VolumeReviewMark>();
    for (const r of rows) {
        if (!isReviewOutcome(r.outcome)) continue; // 脏数据跳过（宁可画灰圈，也不猜）
        const prev = byItem.get(r.errorItemId);
        // 正序读进来 ⇒ 每次覆盖就是"最近一条"
        byItem.set(r.errorItemId, {
            errorItemId: r.errorItemId,
            outcome: r.outcome,
            eventId: r.id,
            rounds: (prev?.rounds ?? 0) + 1,
        });
    }
    return [...byItem.values()];
}
