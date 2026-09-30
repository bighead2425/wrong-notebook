/**
 * 【2026-09-30】复习结果 —— 错题卡底部那**四个圆圈**的数据与规则。
 *
 * ── 他要的东西（原话拆解）──────────────────────────────────────────
 *  前三个圆圈 = **三次计划复习**（录入后第 1 天 / 第 7 天 / 第 21 天）各自的结果；
 *  第四个圆圈 = **到目前为止最近一次复习的结果** —— 不论那一次是不是计划内的。
 *
 *  三种状态：
 *    灰圈            = 还没有结果
 *    浅绿底 + 白勾   = 那一次做对了
 *    浅粉底 + 灰叉   = 那一次做错了
 *
 * ── 两条容易搞混的规矩（他就此专门解释过）────────────────────────────
 *  ① **计划内的一次做完 ⇒ 第四个圈同步成同一个结果**（因为"最近一次"就是它）。
 *     他说："如果只复习了一次做对了，则第一个圆圈是绿色对号，而第四个圆圈也为绿色对号。"
 *  ② **计划外的复习只动第四个圈**：前三个圈纹丝不动（那是计划内的账），
 *     第四个圈改成这一次的结果。他举的例子：前三个都对，后来一次做错了 ⇒
 *     前三个不动、第四个变粉叉。
 *
 * ⚠️ 本轮**只做显示与规则**（还没有录入入口）：深挖纸回录 / 扫码复做的链路开发时，
 *    由写入方调用本模块的 `recordReviewResult` 落值 —— **规则只在这一处实现**，
 *    免得"计划内同步 last"这条规矩在几处各写一遍、迟早分叉。
 *
 * 值存在 `ErrorItem.reviewOutcomes`（TEXT，JSON）。形状：
 *   {"planned":["right",null,null],"last":"wrong"}
 */

export type ReviewOutcome = 'right' | 'wrong';

export interface ReviewOutcomes {
    /** 计划内的三次（第 1 / 7 / 21 天），null = 还没结果 */
    planned: (ReviewOutcome | null)[];
    /** 最近一次复习的结果 —— 计划内、计划外都算 */
    last: ReviewOutcome | null;
}

/** 计划复习的次数与节点（界面上的 tooltip 直接用它，别处不要再写一遍"1/7/21"） */
export const PLANNED_REVIEW_ROUNDS = 3;

export const PLANNED_REVIEW_LABELS_ZH = ['第 1 天复习', '第 7 天复习', '第 21 天复习'] as const;
export const PLANNED_REVIEW_LABELS_EN = ['Day 1 review', 'Day 7 review', 'Day 21 review'] as const;

export function isReviewOutcome(value: unknown): value is ReviewOutcome {
    return value === 'right' || value === 'wrong';
}

export function emptyReviewOutcomes(): ReviewOutcomes {
    return { planned: [null, null, null], last: null };
}

/**
 * 容错归一化：接受 JSON 字符串（库里存的样子）或已经是对象的样子。
 * 任何一处不合法就按"还没有结果"处理 —— **宁可显示灰圈，也不猜一个结果**。
 */
export function normalizeReviewOutcomes(value: unknown): ReviewOutcomes {
    let raw: unknown = value;
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return emptyReviewOutcomes();
        try {
            raw = JSON.parse(s);
        } catch {
            return emptyReviewOutcomes();
        }
    }
    if (!raw || typeof raw !== 'object') return emptyReviewOutcomes();

    const obj = raw as Record<string, unknown>;
    const plannedRaw = Array.isArray(obj.planned) ? obj.planned : [];
    const planned: (ReviewOutcome | null)[] = [];
    for (let i = 0; i < PLANNED_REVIEW_ROUNDS; i += 1) {
        const v = plannedRaw[i];
        planned.push(isReviewOutcome(v) ? v : null);
    }
    return { planned, last: isReviewOutcome(obj.last) ? obj.last : null };
}

/** 解析 → 存库字符串（写入侧统一走它，别处不许自己拼 JSON） */
export function serializeReviewOutcomes(outcomes: ReviewOutcomes): string {
    return JSON.stringify(outcomes);
}

/**
 * 记一次复习结果。
 *
 * @param plannedIndex 0/1/2 = 这是计划内的第几次；**不传**表示计划外的复习
 *                     （计划外只动 `last`，前三个圈不动 —— 规矩 ②）
 */
export function recordReviewResult(
    current: unknown,
    result: ReviewOutcome,
    plannedIndex?: 0 | 1 | 2,
): ReviewOutcomes {
    const base = normalizeReviewOutcomes(current);
    const planned = [...base.planned];
    if (plannedIndex !== undefined && plannedIndex >= 0 && plannedIndex < PLANNED_REVIEW_ROUNDS) {
        planned[plannedIndex] = result;
    }
    // 不论计划内外，"最近一次"都跟着更新（规矩 ①）
    return { planned, last: result };
}

/** 界面上一个圆圈要画成什么样 */
export interface ReviewDot {
    key: 'p1' | 'p2' | 'p3' | 'last';
    state: 'none' | 'right' | 'wrong';
    /** 悬停提示（中文） */
    zh: string;
    /** 悬停提示（英文） */
    en: string;
}

/**
 * 四个圆圈（前三个计划内 + 最后一个是"最近一次"）。
 * 顺序即显示顺序；第 4 个与前面用 `|` 隔开（布局在组件里，不在这里）。
 */
export function reviewDots(outcomes: unknown): ReviewDot[] {
    const o = normalizeReviewOutcomes(outcomes);
    const dots: ReviewDot[] = o.planned.map((state, i) => ({
        key: (['p1', 'p2', 'p3'] as const)[i],
        state: state ?? 'none',
        zh: `${PLANNED_REVIEW_LABELS_ZH[i]}：${stateLabel(state, 'zh')}`,
        en: `${PLANNED_REVIEW_LABELS_EN[i]}: ${stateLabel(state, 'en')}`,
    }));
    dots.push({
        key: 'last',
        state: o.last ?? 'none',
        zh: `最近一次复习：${stateLabel(o.last, 'zh')}`,
        en: `Latest review: ${stateLabel(o.last, 'en')}`,
    });
    return dots;
}

function stateLabel(state: ReviewOutcome | null | undefined, lang: 'zh' | 'en'): string {
    if (state === 'right') return lang === 'zh' ? '做对了' : 'correct';
    if (state === 'wrong') return lang === 'zh' ? '做错了' : 'wrong';
    return lang === 'zh' ? '还没有结果' : 'no result yet';
}
