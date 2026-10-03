/**
 * 【2026-10-03】等级（`ErrorItem.attention` 1-5）× 复习结果 —— **联动记账**。
 *
 * ── 他要的东西（原话拆解）──────────────────────────────────────────────
 *   ① **初定级是一次性行为**：刚录入的题，深挖 ⇒ 白银、复练 ⇒ 青铜；此后全靠"调整"。
 *   ② **类型切换**：复练 → 深挖 = 提高一级；深挖 → 复练 = 降低一级（王者封顶、青铜封底）。
 *   ③ **复习结果**：按第 1/2/3 次与"最近一次"的组合加减（规则见 `plannedSlotDelta`）。
 *   ④ 他反复强调的那些"**这时等级不变**"：
 *        · 改第 1 次结果 ⇒ 不变；
 *        · 第 3 次已填时再改第 2 次 ⇒ 不变；
 *        · "最近一次"因为前三次变化**自动跟着变** ⇒ 不变。
 *
 * ── 为什么不是一张"如果…则…"的大表 ─────────────────────────────────────
 *   上面那些"不变"**不是三个特例，是同一个原理**：
 *
 *      **等级是一本账，不是一个快照。只有"新发生的事"才记账；翻旧账不记账。**
 *
 *   于是：
 *     · 某个位置**从空变成有值** ⇒ 记账（按规则算一笔 delta）；
 *     · 改一个**早就记过账**的位置 ⇒ 翻旧账 ⇒ 不记；
 *     · "最近一次"自动跟着前三次变 ⇒ 那是**副作用**、不是新发生的事 ⇒ 不记；
 *     · 只有**最新那一笔**允许反悔（他 2026-10-03 拍板："最新那一格改了值，等级跟着改"）
 *       ⇒ 撤销旧账 + 记新账。
 *
 *   这一改，他那三条"不变"不用单独写代码 —— 它们是这个结构的自然结果。
 *
 * ── 账上只留**一笔**（而且只记"计划三格"）────────────────────────────────
 *   既然只有"最新那一笔"能被反悔，更早的账**永远不可能再被撤销** ⇒ 不必留。
 *   所以 `levelLedger` 存的就是 `{ slot, delta }` —— 最近一次因**计划三格**产生的账。
 *   "最近一次复习"那一格**不进账本**：它按"一次输入"记（见 `computeLevelLinkage` 尾部说明）。
 *
 * ⚠️ 已印出去的纸一律不动（他 2026-10-03 拍板）：等级只影响"将来再印"的纸，
 *    绝不回头改已发出的日期格 —— 否则她按纸复习、系统按新规则算，两边越走越偏。
 */

import { ATTENTION_LEVELS } from './attention-level';
import {
    PLANNED_REVIEW_ROUNDS,
    normalizeReviewOutcomes,
    type ReviewOutcome,
    type ReviewOutcomes,
} from './review-outcomes';

/** 等级下限（青铜） */
export const LEVEL_MIN = 1;
/** 等级上限（王者） */
export const LEVEL_MAX = ATTENTION_LEVELS.length;

/**
 * **初定级**（一次性）：深挖 ⇒ 白银(2)、复练 ⇒ 青铜(1)。
 * 未定（null/其它）⇒ 青铜 —— 与库里的 `@default(1)` 同义。
 */
export function initialLevelForManageType(manageType: unknown): number {
    return manageType === 'deep' ? 2 : LEVEL_MIN;
}

/** 夹进 1..5（非数字一律按下限） */
export function clampLevel(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return LEVEL_MIN;
    return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Math.round(n)));
}

/* ============================ 账（levelLedger） ============================ */

/** 账上的槽位：三个计划节点 + 最近一次 */
export type LevelSlot = 'p1' | 'p2' | 'p3' | 'last';

/** 最近一笔账 —— 只有它可能被"反悔"撤销 */
export interface LevelEntry {
    slot: LevelSlot;
    delta: number;
}

const SLOTS: readonly LevelSlot[] = ['p1', 'p2', 'p3', 'last'];

export function isLevelSlot(value: unknown): value is LevelSlot {
    return typeof value === 'string' && (SLOTS as readonly string[]).includes(value);
}

/** 容错解析（库里存 JSON 字符串）；形状不对 ⇒ 当"没有账"，绝不猜 */
export function normalizeLevelEntry(value: unknown): LevelEntry | null {
    let raw: unknown = value;
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return null;
        try {
            raw = JSON.parse(s);
        } catch {
            return null;
        }
    }
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (!isLevelSlot(obj.slot)) return null;
    const delta = Number(obj.delta);
    if (!Number.isFinite(delta)) return null;
    return { slot: obj.slot, delta: Math.round(delta) };
}

/** 存库字符串；null ⇒ null（清空账目，列写 NULL 而不是 "null"） */
export function serializeLevelEntry(entry: LevelEntry | null): string | null {
    return entry ? JSON.stringify(entry) : null;
}

/* ============================ 规则：各槽位各记多少 ============================ */

/**
 * **类型切换**的升降。
 *
 * 他定的只有两条：复练 → 深挖 = +1、深挖 → 复练 = −1。
 * 其它（含 未定 ↔ 任一）一律 **0** —— 因为"深挖/复练"才是那对"升/降"的两端，
 * "未定→深挖"不属于他说的那两种情形，**不乱动等级**（真要改，手动点等级即可）。
 */
export function levelDeltaForTypeSwitch(from: unknown, to: unknown): number {
    if (from === 'review' && to === 'deep') return 1;
    if (from === 'deep' && to === 'review') return -1;
    return 0;
}

/**
 * 计划内第 `index` 个位置**这一次该记多少账**（`index` = 0 / 1 / 2）。
 *
 * ── 他的规则，逐条译成代码 ──────────────────────────────────────────────
 *  第 1 次：**无论对错都不影响等级** ⇒ 恒 0。
 *  第 2 次：
 *      · 一次对、二次错 ⇒ **+1**
 *      · 两次都错       ⇒ **+2**
 *      · 两次都对       ⇒ **−1**
 *      · 一次错（或空）、二次对 ⇒ **0**
 *  第 3 次（"就不看第一次了"）：
 *      · 三次对 ⇒ 二次也对 ⇒ **−1**；二次错（或空）⇒ **0**
 *      · 三次错 ⇒ 一次对（或空）、二次错（或空）⇒ **+1**
 *      · 三次错 ⇒ 三次全错 ⇒ **+2**
 *      · 三次错、二次对 ⇒ **0**
 *
 * ⚠️ 他为第 1 次留了"或空"的分支（"第一次如果错（或空）第二次对，则级别不变"），
 *    所以"第 1 次没填、只填了第 2 次"这种情况按 **0** 处理 —— 那等于"这是她的第一次结果"。
 */
export function plannedSlotDelta(outcomes: ReviewOutcomes, index: number): number {
    if (index <= 0) return 0; // 第 1 次：不影响等级
    const p1 = outcomes.planned[0];
    const p2 = outcomes.planned[1];
    const p3 = outcomes.planned[2];

    if (index === 1) {
        if (p2 === 'wrong') {
            if (p1 === 'wrong') return 2; // 两次都错
            if (p1 === 'right') return 1; // 一次对、二次错
            return 0; // 第 1 次还没结果 ⇒ 视作她的第一次
        }
        if (p2 === 'right') {
            return p1 === 'right' ? -1 : 0; // 两次都对 ⇒ 降；一次错/空、二次对 ⇒ 不变
        }
        return 0;
    }

    // index === 2
    if (p3 === 'right') {
        return p2 === 'right' ? -1 : 0;
    }
    if (p3 === 'wrong') {
        if (p2 === 'right') return 0; // 二次对、三次错 ⇒ 不变
        if (p1 === 'wrong' && p2 === 'wrong') return 2; // 三次全错
        return 1; // 一次对/空 + 二次错/空 ⇒ +1
    }
    return 0;
}

/** "最近一次"**手动**给结果时的账：对 ⇒ −1、错 ⇒ +1、清空 ⇒ 0 */
export function lastSlotDelta(value: ReviewOutcome | null): number {
    if (value === 'right') return -1;
    if (value === 'wrong') return 1;
    return 0;
}

/** 槽位 → 中文说明（写进变更日志，方便回溯"这题为什么升了"） */
export function slotLabelZh(slot: LevelSlot): string {
    if (slot === 'p1') return '第 1 次复习';
    if (slot === 'p2') return '第 2 次复习';
    if (slot === 'p3') return '第 3 次复习';
    return '最近一次复习';
}

/* ============================ 主算法 ============================ */

export interface LevelLinkageInput {
    /** 这道题**此刻**的等级（类型切换若已算过，传算完的值） */
    currentAttention: unknown;
    /** 写入**前**的复习结果（库里那份，JSON 字符串或对象） */
    prevOutcomes: unknown;
    /** 这次要写进去的复习结果 */
    nextOutcomes: unknown;
    /** 账上现有的一笔（`ErrorItem.levelLedger`），没有就 null */
    prevEntry: unknown;
}

export interface LevelLinkageResult {
    /** 算完的等级（没变化时 = 原样） */
    attention: number;
    /** 该写回库的账（`null` = 清空） */
    entry: LevelEntry | null;
    /** 等级有没有真的动（没动就别写 attention、别记日志） */
    changed: boolean;
    /** 账目有没有变（变了就要写 `levelLedger`，哪怕等级没动） */
    entryChanged: boolean;
    /** 实际净变化量（撤销旧账 + 记新账之后，**已夹过 1..5**） */
    delta: number;
    /** 记账发生在哪个槽位；没记账 ⇒ null */
    slot: LevelSlot | null;
    /** 变更原因（中文，写日志用） */
    reasonZh: string;
}

/**
 * 复习结果变化 ⇒ 等级该动多少。
 *
 * 只做三件事：① 找**唯一**变化的那一格；② 判断它是不是"最新的"（不是就**不记账**）；
 * ③ 撤销旧账 + 记新账，夹进 1..5。
 */
export function computeLevelLinkage(input: LevelLinkageInput): LevelLinkageResult {
    const before = clampLevel(input.currentAttention);
    const prev = normalizeReviewOutcomes(input.prevOutcomes);
    const next = normalizeReviewOutcomes(input.nextOutcomes);
    const prevEntry = normalizeLevelEntry(input.prevEntry);

    const unchanged: LevelLinkageResult = {
        attention: before,
        entry: prevEntry,
        changed: false,
        entryChanged: false,
        delta: 0,
        slot: null,
        reasonZh: '',
    };

    // ① 哪一格变了？（界面一次点一下 ⇒ 正常情况下最多一处）
    const changedPlanned: number[] = [];
    for (let i = 0; i < PLANNED_REVIEW_ROUNDS; i += 1) {
        if (prev.planned[i] !== next.planned[i]) changedPlanned.push(i);
    }
    const lastChanged = prev.last !== next.last;

    if (changedPlanned.length > 0) {
        const i = Math.max(...changedPlanned);
        const slot = (['p1', 'p2', 'p3'] as const)[i];

        /**
         * ② 它是不是"最新的"？
         *    · 它之后还有计划格有值 ⇒ 它是旧账 ⇒ **不记账**（他要的"第 3 次已填时改第 2 次不变"）。
         */
        const hasLaterFilled = next.planned.some((v, j) => j > i && v !== null);
        if (hasLaterFilled) return unchanged;

        // 清空一格（有值 → 空）：只有"最新那格被清"才需要撤销它自己那笔账
        if (next.planned[i] === null) {
            if (prevEntry?.slot !== slot) return unchanged;
            return finish(before, prevEntry, -prevEntry.delta, slot, '撤销', true);
        }

        // ③ 撤销旧账（如果账就是这一格）+ 记新账
        const rawDelta = plannedSlotDelta(next, i) - (prevEntry?.slot === slot ? prevEntry.delta : 0);
        return finish(before, prevEntry, rawDelta, slot, '复习结果');
    }

    /**
     * 计划格没动、只有"最近一次"动了 ⇒ 一次**直接**给最近一次的结果
     * （"前三次变化、它自动跟着变"那一路走不到这里 —— 那时 `changedPlanned` 非空，上面已经返回了）。
     *
     * ⚠️ 这里**不撤销旧账**（与计划三格有意不同）：
     *   计划三格是"**组合**规则"（看的是当前这三个值的组合）⇒ 改正时按"假如一开始就是这个组合"重算；
     *   最近一次是"**一次输入**"（他原话"只要对就降级、只要错就升级"说的是一次输入）
     *   ⇒ 改正就**再动一次**。好处："误点成错、马上改回对"能**原样退回**，不留残余。
     *   同理他说的"点击成还没有结果就不变" ⇒ 清空记 0、也不撤销。
     */
    if (lastChanged) {
        const delta = lastSlotDelta(next.last);
        const after = clampLevel(before + delta);
        const real = after - before;
        if (real === 0) return unchanged;
        return {
            attention: after,
            entry: prevEntry, // ← 最近一次不进账本
            changed: true,
            entryChanged: false,
            delta: real,
            slot: 'last',
            reasonZh: `最近一次复习 ⇒ ${real > 0 ? `升 ${real} 级` : `降 ${-real} 级`}`,
        };
    }

    return unchanged;
}

/**
 * 收口：夹进 1..5、把**实际生效**的变化记成账。
 *
 * ⚠️ 账上记的是**实际生效的量**（`after - before`），不是"理论上该加多少"——
 *    因为撞到王者封顶 / 青铜封底时那一笔根本没生效，日后反悔要按"没生效"来撤。
 */
function finish(
    before: number,
    prevEntry: LevelEntry | null,
    rawDelta: number,
    slot: LevelSlot,
    what: string,
    isClear = false,
): LevelLinkageResult {
    const after = clampLevel(before + rawDelta);
    const real = after - before;
    // 清空了 ⇒ 这一格不再有贡献，账目清空；
    // 真实生效为 0 ⇒ 也没有账可撤（比如顶到王者了）
    const entry: LevelEntry | null = isClear || real === 0 ? null : { slot, delta: real };

    const entryChanged =
        (entry?.slot ?? null) !== (prevEntry?.slot ?? null) || (entry?.delta ?? 0) !== (prevEntry?.delta ?? 0);

    if (!entryChanged && real === 0) {
        return {
            attention: before,
            entry: prevEntry,
            changed: false,
            entryChanged: false,
            delta: 0,
            slot: null,
            reasonZh: '',
        };
    }

    const dir = real > 0 ? `升 ${real} 级` : real < 0 ? `降 ${-real} 级` : '等级不变（已到边界）';
    return {
        attention: after,
        entry,
        changed: real !== 0,
        entryChanged,
        delta: real,
        slot,
        reasonZh: `${what}（${slotLabelZh(slot)}）⇒ ${dir}`,
    };
}
