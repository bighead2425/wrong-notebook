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

import {
    normalizeReviewOutcomes,
    type ReviewOutcome,
    type ReviewOutcomes,
} from './review-outcomes';
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
 * 他定的循环顺序（**同一个圆点一下换一格**）：
 *   灰底白数字 → 绿底白对号 → 粉底灰错号 → 灰底白数字 …
 */
export function nextReviewMark(mark: ReviewMark): ReviewMark {
    if (mark === 'none') return 'right';
    if (mark === 'right') return 'wrong';
    return 'none';
}

/**
 * 从**题目的复习历史**推圆态（看 `last`）。
 *
 * ⚠️【2026-10-02】**生产代码当前不再用它** —— 圆态改成"按卷"判断了（见 `markForItem`）。
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
 * 【2026-10-02 他定的】这道题**在某一卷上**该画成哪一态。
 *
 * 取值顺序：**本次会话的本地覆盖** → **卷里那一行记的** `markState` → 灰（`none`）。
 *
 * ⚠️ 兜底判据必须是**卷的行**，不是题目的 `last`。他原话：
 *   "如果扫的是另外一个**没有扫描过**的新卷，即使有这道题**还是应该给灰圈**。"
 *   —— "标过没标过"是**这张纸上**发生过的事，不跟着题跑到别的卷里。
 *
 * 抽成纯函数是为了能被单测钉住（组件里那段是 `useCallback`，测不到）。
 */
export function markForItem(
    itemId: string,
    localMarks: Readonly<Record<string, ReviewMark>>,
    rows: ReadonlyArray<{ errorItemId: string | null; markState?: string | null }>,
): ReviewMark {
    if (itemId in localMarks) return localMarks[itemId];
    const row = rows.find((r) => r.errorItemId === itemId);
    return row?.markState === 'right' || row?.markState === 'wrong' ? row.markState : 'none';
}

/** 三态的配色 —— 绿/粉与错题卡四圆点（`review-dots.tsx`）**刻意一致**，避免同一屏两套红绿 */
export const REVIEW_MARK_COLORS: Record<ReviewMark, { bg: string; fg: string }> = {
    none: { bg: '#9ca3af', fg: '#ffffff' },
    right: { bg: '#6fbf8b', fg: '#ffffff' },
    wrong: { bg: '#f6c9cf', fg: '#8a8a8a' },
};

/* ============================ 三、复习结果写到哪一格 ============================ */

/** 这次结果落在哪一格：0/1/2 = 计划第几次；'last' = 最近一次 */
export type ReviewOutcomeSlot = 0 | 1 | 2 | 'last';

export interface ReviewOutcomeWrite {
    /** 落值之后的完整复习结果（直接交给 `serializeReviewOutcomes`） */
    outcomes: ReviewOutcomes;
    /** 写进了哪一格（界面提示 / 测试断言用） */
    slot: ReviewOutcomeSlot;
}

/**
 * 【他 2026-10-02 定的规则】**按顺序填第一个空位**：
 *   · 没有复习记录 ⇒ 写第一次（planned[0]）；
 *   · 只有第一次   ⇒ 写第二次（planned[1]）；
 *   · 有第二次而没有第三次 ⇒ 写第三次（planned[2]）；
 *   · 有第三次     ⇒ 写最近一次（last）。
 *
 * ⚠️ **额外要求（他专门强调的）**：只要标了"对/错"，就**同时更新 `last`** ——
 *    `last` 的定义就是"最近一次复习的结果（计划内、计划外都算）"，
 *    所以"最近一次情况"那行永远是最新的。
 *
 * ⚠️ 清空**不走这里**：清空是"撤销这次标记"，调用方用写入前的快照回滚
 *    （见 `scan-volume-view.tsx`），不会从这里往回删历史。
 */
export function nextReviewOutcomes(current: unknown, outcome: ReviewOutcome): ReviewOutcomeWrite {
    const base = normalizeReviewOutcomes(current);
    const planned = [...base.planned];
    const emptyIndex = planned.findIndex((v) => v === null);
    if (emptyIndex >= 0) {
        planned[emptyIndex] = outcome;
        return { outcomes: { planned, last: outcome }, slot: emptyIndex as 0 | 1 | 2 };
    }
    // 三个计划位都满了 ⇒ 只动"最近一次"（计划位一个字都不改）
    return { outcomes: { planned, last: outcome }, slot: 'last' };
}
