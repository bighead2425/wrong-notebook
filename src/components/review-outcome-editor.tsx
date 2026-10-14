"use client";

import {
    normalizeReviewOutcomes,
    plannedReviewDates,
    PLANNED_REVIEW_LABELS_ZH,
    PLANNED_REVIEW_LABELS_EN,
    PLANNED_REVIEW_OFFSET_DAYS,
    setLastOutcome,
    setPlannedOutcome,
    type PlannedIndex,
    type ReviewOutcome,
    type ReviewOutcomes,
} from '@/lib/review-outcomes';

/**
 * 【2026-09-30】详情页里的**复习结果编辑器**（四个圆点那套）。
 *
 * 他定的界面形态：
 *   · 前**四**行 = 计划复习的四个节点，**每行写具体日期**（录入日 +1 / +7 / +21 / +49 天，
 *     YYYY-MM-DD；偏移量取自 `PLANNED_REVIEW_OFFSET_DAYS`，本组件不再自己写一遍）；
 *   · 每行三个圆圈：**对号 / 错号 / 空圈**（三选一）；
 *   · 最后一行写「最近一次情况」，同样三个圆圈。
 *
 * 圆圈配色（他的原话）：
 *   · 选中"对号" ⇒ **浅绿底 + 白色对号**
 *   · 选中"错号" ⇒ **浅粉底 + 灰色错号**
 *   · 没选中的那两个 ⇒ **灰底 + 白色符号**（看得出"这里可以点"）
 *   · 空圈 ⇒ **灰底**（点它 = 这一行没有结果）；当这一行确实是"无结果"时，
 *     空圈加一圈**深灰描边**，好让他一眼看出"当前就是它"。
 *
 * ⚠️ 圆圈的**造型**只有这一处（详情页专用）；卡片上那四个只读的小圈在 `review-dots.tsx` ——
 *    两边颜色同源同一组常量，不要各调各的。
 *
 * 逻辑全在 `lib/review-outcomes.ts`：`setPlannedOutcome`（改计划格 ⇒ 联动 last）与
 * `setLastOutcome`（只改最近一次）。这里是纯展示 + 把点击翻译成这两个调用。
 *
 * ⚠️ 【2026-10-14】等级联动那一侧有个**临时口径**：**最后一个计划格暂不进等级账本**
 *    （"第 4 次加减多少"空空还没定）—— 所以这里点第 4 格不会改奖牌。
 *    见 `lib/level-linkage.ts` 的 `computeLevelLinkage()`。
 */

const GRAY_UNSELECTED = '#9aa0a6';
const GRAY_EMPTY = '#e5e7eb';
const GREEN = '#6fbf8b';
const PINK = '#f6c9cf';
const PINK_FG = '#8a8a8a';

type CellKind = ReviewOutcome | 'empty';

/** 一个圆圈的样子：三种形态 × 选中/未选中 */
function dotStyle(kind: CellKind, selected: boolean): React.CSSProperties {
    const base: React.CSSProperties = {
        width: '20px',
        height: '20px',
        borderRadius: '9999px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '11px',
        lineHeight: 1,
        fontWeight: 700,
        cursor: 'pointer',
        padding: 0,
    };
    if (kind === 'right') {
        return selected
            ? { ...base, background: GREEN, color: '#ffffff', border: `1px solid ${GREEN}` }
            : { ...base, background: GRAY_UNSELECTED, color: '#ffffff', border: `1px solid ${GRAY_UNSELECTED}` };
    }
    if (kind === 'wrong') {
        return selected
            ? { ...base, background: PINK, color: PINK_FG, border: `1px solid ${PINK}` }
            : { ...base, background: GRAY_UNSELECTED, color: '#ffffff', border: `1px solid ${GRAY_UNSELECTED}` };
    }
    // 空圈：永远是灰底；"这一行没有结果"时用深灰描边点出来
    return {
        ...base,
        background: GRAY_EMPTY,
        color: 'transparent',
        border: selected ? '2px solid #6b7280' : '1px solid #d1d5db',
    };
}

function DotRow({
    label,
    labelTitle,
    value,
    onPick,
    L,
}: {
    label: string;
    labelTitle?: string;
    /** 当前这一行的结果：null = 无结果 */
    value: ReviewOutcome | null;
    onPick: (v: ReviewOutcome | null) => void;
    L: (zh: string, en: string) => string;
}) {
    return (
        <div className="flex items-center gap-2">
            <span
                className="w-[92px] shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
                title={labelTitle}
            >
                {label}
            </span>
            <span className="flex items-center gap-1.5">
                <button
                    type="button"
                    style={dotStyle('right', value === 'right')}
                    title={L('做对了', 'Correct')}
                    aria-pressed={value === 'right'}
                    onClick={() => onPick(value === 'right' ? null : 'right')}
                >
                    ✓
                </button>
                <button
                    type="button"
                    style={dotStyle('wrong', value === 'wrong')}
                    title={L('做错了', 'Wrong')}
                    aria-pressed={value === 'wrong'}
                    onClick={() => onPick(value === 'wrong' ? null : 'wrong')}
                >
                    ✗
                </button>
                <button
                    type="button"
                    style={dotStyle('empty', value === null)}
                    title={L('还没有结果', 'No result yet')}
                    aria-pressed={value === null}
                    onClick={() => onPick(null)}
                >
                    ·
                </button>
            </span>
        </div>
    );
}

export function ReviewOutcomeEditor({
    value,
    createdAt,
    onChange,
    L,
}: {
    /** `ErrorItem.reviewOutcomes` 原样传进来（JSON 字符串或对象都认） */
    value?: unknown;
    /** 录入时间（前三行的日期 = 它 +1 / +7 / +21 天） */
    createdAt?: string | null;
    /** 改哪一格都从这里吐出去（父组件负责落库） */
    onChange: (next: ReviewOutcomes) => void;
    L: (zh: string, en: string) => string;
}) {
    const current = normalizeReviewOutcomes(value);
    const dates = plannedReviewDates(createdAt);

    return (
        <div className="space-y-2">
            <div className="text-sm font-medium">{L('复习结果', 'Review results')}</div>
            {current.planned.map((v, i) => (
                <DotRow
                    key={i}
                    label={dates[i] || L('（无录入日期）', '(no date)')}
                    labelTitle={L(
                        `${PLANNED_REVIEW_LABELS_ZH[i]}（录入日 +${PLANNED_REVIEW_OFFSET_DAYS[i]} 天）`,
                        `${PLANNED_REVIEW_LABELS_EN[i]} (record date +${PLANNED_REVIEW_OFFSET_DAYS[i]}d)`,
                    )}
                    value={v}
                    /* ⚠️ 下标类型必须跟着 `PLANNED_REVIEW_ROUNDS` 走 ——
                       这里曾经写死 `i as 0 | 1 | 2`（3 格时代的残留），加第 4 格后
                       虽然运行时仍传 3、但类型是骗人的（hover 提示也退化成"+undefined 天"）。 */
                    onPick={(next) => onChange(setPlannedOutcome(current, i as PlannedIndex, next))}
                    L={L}
                />
            ))}
            <DotRow
                label={L('最近一次情况', 'Latest')}
                labelTitle={L('记录**最近一次**复习的结果（计划内、计划外都算）', 'The most recent review result')}
                value={current.last}
                onPick={(next) => onChange(setLastOutcome(current, next))}
                L={L}
            />
            {/* 一句话说清联动规则（免得到时候搞不懂为什么最后一行自己变了） */}
            <p className="pt-1 text-[11px] leading-tight text-muted-foreground">
                {L(
                    '前四行是计划复习（+1 / +7 / +21 / +49 天）；改前四行时"最近一次"会跟着变成最后一个有结果的',
                    'First four rows are planned reviews; the last row follows the last filled one.',
                )}
            </p>
        </div>
    );
}
