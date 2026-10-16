/**
 * 【2026-10-02 新增】扫到的复练卷页 —— **纸面上直接录入**那两组控件的纯逻辑。
 *
 * 他 2026-10-02 的要求（原话拆解）：
 *   一、点**升降级方框** ⇒ 直接改这道题的类型：降级 ⇒ 深挖变复练；升级 ⇒ 复练变深挖；
 *       再点一次（同一处）⇒ 取消勾选、把库里改回来。
 *   二、每题天蓝框**右侧一个灰圆**，点它三态循环：灰底白流水号 → 绿底白对号（做对）
 *       → 粉底灰错号（做错）→ 灰底白流水号（清空）；每一步都写进这道题的**复习结果**。
 *
 * ⚠️ 本文件**只放纯函数**（不碰 DOM / fetch / React），渲染在 `review-card.tsx`，
 *    写库在 `scan-volume-view.tsx`。
 * ⚠️ **不另写一套**：复习结果的形状与归一化一律走 `lib/review-outcomes.ts`，
 *    类型的取值与判据一律走 `lib/manage-type.ts`（尤其"未定按复练处理"这条）。
 */

// `normalizeReviewOutcomes` 只被 `reviewMarkFromOutcomes`（保留的另一件事）用到 ⇒ 留着
import { normalizeReviewOutcomes } from './review-outcomes';
import {
    normalizeManageType,
    promoteDirectionFor,
    type ManageType,
    type PromoteDirection,
} from './manage-type';

/* ============================ 一、升降级方框 ============================ */

/** 点一下升降框之后要记住的三件事（供乐观更新与回滚） */
export interface PromoteToggle {
    /** 这道题当前印的是哪个方向的框（深挖 ⇒ 降级；复练/未定 ⇒ 升级） */
    direction: PromoteDirection;
    /** 点下去以后这道题的类型（降级 ⇒ review；升级 ⇒ deep） */
    nextType: ManageType;
    /** 点之前原来的类型（null = 未定）—— 再点一次要**原样还原**，不能猜一个值写回去 */
    originalType: ManageType | null;
}

/**
 * 由"这道题现在的类型"推出：这个框指向哪、点下去变成什么、原来是什么。
 *
 * ⚠️ 方向**必须**走 `promoteDirectionFor`（它有一条"未定按复练处理"的既有规矩），
 *    这里不许再写一份 `if (deep) ...`。
 */
export function promoteToggleFor(manageType: unknown): PromoteToggle {
    const originalType = normalizeManageType(manageType);
    const direction = promoteDirectionFor(originalType);
    const nextType: ManageType = direction === 'demote' ? 'review' : 'deep';
    return { direction, nextType, originalType };
}

/**
 * 勾选后**文字**改成什么。
 * 他定的："降级" ⇒ "已降"、"升级" ⇒ "已升"（箭头**不变**）。
 */
export const PROMOTE_APPLIED_LABEL_ZH: Record<PromoteDirection, string> = {
    demote: '已降',
    upgrade: '已升',
};

export const PROMOTE_APPLIED_LABEL_EN: Record<PromoteDirection, string> = {
    demote: 'Done',
    upgrade: 'Done',
};

/**
 * 勾选后**文字底色**变成什么。他定的：降级用**浅绿**、升级用**粉红**。
 * ⚠️ 与"深挖=暗红 / 复练=深绿"（`MANAGE_TYPE_SCREEN_COLOR`）不是一套：
 *    那个讲"这是什么类型"，这个讲"我刚把这道题改成了另一类"。
 */
export const PROMOTE_APPLIED_BG: Record<PromoteDirection, string> = {
    demote: '#d7f0dd',
    upgrade: '#fbd7e0',
};

/* ============================ 二、右侧灰圆（对/错） ============================ */

/** 灰圆的三态：还没记 / 做对了 / 做错了 */
export type ReviewMark = 'none' | 'right' | 'wrong';

/**
 * 【他 2026-10-16 改定的】点一下灰圆换哪一态 —— **两态循环**：
 *   灰 → 对 → 错 → 对 → 错 …
 *
 * ⚠️⚠️ **不再经过"清空"** —— 这正是本次改造的核心（他 2026-10-16 的原话：
 *    旧的三态让"错改对"必经"删除"，中间态还会落库）。
 *    ⇒ 想撤销一条记录就走**长按菜单里的"删除这一条"**，不再靠"再点一下"。
 * ⚠️ 所以从 `wrong` 出发回到的是 `right`（不是 `none`），`none` 只可能来自"这张卷上没有记录"。
 */
export function nextReviewMark(mark: ReviewMark): 'right' | 'wrong' {
    return mark === 'right' ? 'wrong' : 'right';
}

/**
 * 从**题目的复习历史**推圆态（看 `last`）。
 *
 * ⚠️【2026-10-02】**生产代码当前不再用它** —— 圆态改成"按卷"判断了（见 `volumeMarkOf`）。
 * 保留它的原因：它表达的是另一件真实存在的事 ——"这道题最近一次复习结果是什么"，
 * 与"这张纸上我标了什么"是**两个不同的问题**。将来若要画"与复习历史联动"的圆，还会用到。
 * 别把它当成"旧的、删了也没关系"的代码；但也**别再用它来还原扫码页的圆**。
 */
export function reviewMarkFromOutcomes(current: unknown): ReviewMark {
    const o = normalizeReviewOutcomes(current);
    if (o.last === 'right') return 'right';
    if (o.last === 'wrong') return 'wrong';
    return 'none';
}

/**
 * 【2026-10-02 他定的 · 2026-10-16 换读源】这道题**在某一卷上**该画成哪一态。
 *
 * 取值顺序：**本次会话的本地覆盖** → **服务端给的这一卷的标记** → 灰（`none`）。
 *
 * ⚠️ 兜底判据必须是**这一卷**，不是题目的 `last`。他原话：
 *   "如果扫的是另外一个**没有扫描过**的新卷，即使有这道题**还是应该给灰圈**。"
 *   —— "标过没标过"是**这张纸上**发生过的事，不跟着题跑到别的卷里。
 * ⭐【2026-10-16】"这一卷的标记"以前读的是卷行上的 `markState`（纸面标记），
 *   现在读**这条题在这张卷上的最近一条流水**（`ReviewEvent`）——
 *   因为流水才是复习结果的真相（`docs\18` §4.3"回显规则"）。
 *   卷行的 `markState` 仍然照写（回录页用它做校对），但**不再拿它画圆**。
 *
 * 抽成纯函数是为了能被单测钉住（组件里那段是 `useCallback`，测不到）。
 */
export function volumeMarkOf(
    itemId: string,
    local: Readonly<Record<string, VolumeMark>>,
    marks: Readonly<Record<string, VolumeMark>>,
): VolumeMark {
    const server = marks[itemId];
    const overlay = local[itemId];
    if (!server && !overlay) return EMPTY_VOLUME_MARK;
    return {
        mark: overlay?.mark ?? server?.mark ?? 'none',
        eventId: overlay?.eventId ?? server?.eventId ?? null,
        rounds: overlay?.rounds ?? server?.rounds ?? 0,
    };
}

/* ==================== 【2026-10-16】这一卷上"这道题"的样子 ==================== */

/** 服务端给的"这道题在这张卷上"的样子（`GET /api/review-volumes/[id]/review-marks`） */
export interface VolumeMark {
    /** 最近一条流水的结果；`none` = 这张卷上还没有记录 */
    mark: ReviewMark;
    /** 最近那条流水的 id —— 长按菜单"删除这一条"要用；没有记录 = `null` */
    eventId: string | null;
    /** 这道题**在这张卷上**录过几条（两轮角标：`>1` 才标） */
    rounds: number;
}

/** "这张卷上没这道题的记录" */
export const EMPTY_VOLUME_MARK: VolumeMark = { mark: 'none', eventId: null, rounds: 0 };

/**
 * 把接口给的一行归一化 —— **不认识的值一律当"没有记录"**，
 * 宁可画灰圈、也不猜一个结果（与 `review-outcomes` 那条规矩一致）。
 */
export function normalizeVolumeMark(raw: unknown): VolumeMark {
    if (!raw || typeof raw !== 'object') return EMPTY_VOLUME_MARK;
    const o = raw as Record<string, unknown>;
    const mark = o.mark === 'right' || o.mark === 'wrong' ? o.mark : 'none';
    const rounds = typeof o.rounds === 'number' && Number.isFinite(o.rounds) ? Math.max(0, Math.trunc(o.rounds)) : 0;
    const eventId = typeof o.eventId === 'string' && o.eventId.trim() ? o.eventId.trim() : null;
    return { mark, eventId, rounds };
}

/** 接口那串数组 ⇒ 以题 id 为键的表（组件里查一次 O(1)） */
export function volumeMarkMap(rows: readonly unknown[]): Record<string, VolumeMark> {
    const out: Record<string, VolumeMark> = {};
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const id = (raw as Record<string, unknown>).errorItemId;
        if (typeof id !== 'string' || !id) continue;
        out[id] = normalizeVolumeMark(raw);
    }
    return out;
}

/** 三态的配色 —— 绿/粉与错题卡四圆点（`review-dots.tsx`）**刻意一致**，避免同一屏两套红绿 */
export const REVIEW_MARK_COLORS: Record<ReviewMark, { bg: string; fg: string }> = {
    none: { bg: '#9ca3af', fg: '#ffffff' },
    right: { bg: '#6fbf8b', fg: '#ffffff' },
    wrong: { bg: '#f6c9cf', fg: '#8a8a8a' },
};

/* ==================== 三、【2026-10-16 已删】"写到哪一格" ====================
 *
 * 这里原来有 `ReviewOutcomeSlot` / `ReviewOutcomeWrite` / `nextReviewOutcomes()` ——
 * 那套"**按顺序填第一个空位**"（没有记录 ⇒ 写 planned[0] … 四格满 ⇒ 写 `last`）
 * 是**老形状**（`{planned,last}`）的写入规则，随 `docs\18` 换成"流水为真相"后**整段作废**：
 *   · 现在点一下就是**一条流水**（新增）或**改那条流水**（`op: update`），
 *     根本不存在"填第几格"这一步；
 *   · 而"纸背面那四个日期框"仍然存在 —— 但那是**纸**的事，判等级/紧迫度都不看它。
 * ⇒ 删掉而不是留着：留着只会让下一个人再写回一个没人读的形状（本项目栽过三次的那类坑）。
 *   老形状**读**的能力仍在 `lib/review-outcomes.ts`（`normalizeReviewOutcomes`）。
 */
