import { MANAGE_TYPE_SCREEN_COLOR } from '@/lib/manage-type';

/**
 * 【2026-09-30】两个打印次数并排显示：**深挖纸打印次数 | 复练纸印刷次数**。
 *
 * 他要的：前者**暗红**、后者**深绿**，颜色与列表卡片右下角那个「深挖 / 复练」小标签**同源**
 * （直接取 `MANAGE_TYPE_SCREEN_COLOR`，不另配一套色 —— 同一个概念两处颜色不一致，
 *   将来改色必漏一处）。
 *
 * `compact` = 卡片上用（一行放不下全称，用简称）；详情页用全称。
 */
export function PrintCounts({
    deep,
    review,
    compact = false,
    className = '',
}: {
    deep?: number | null;
    review?: number | null;
    compact?: boolean;
    className?: string;
}) {
    const deepLabel = compact ? '深挖' : '深挖纸打印次数';
    const reviewLabel = compact ? '复练' : '复练纸印刷次数';
    return (
        <span className={`whitespace-nowrap tabular-nums ${className}`}>
            <span style={{ color: MANAGE_TYPE_SCREEN_COLOR.deep }}>
                {deepLabel} {deep ?? 0}
            </span>
            <span className="text-muted-foreground mx-1">|</span>
            <span style={{ color: MANAGE_TYPE_SCREEN_COLOR.review }}>
                {reviewLabel} {review ?? 0}
            </span>
        </span>
    );
}
