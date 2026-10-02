/**
 * 【2026-10-03 需求第 11 条】扫到的**积累纸**上，每条日积月累中间那个「圆圈加号」的配色。
 *
 * 他定的规则（原话照做）：
 *   · 这条**没有关联错题**（`Insight.errorItemNo` 为空）⇒ 框与圆圈都 **棕黄**；
 *   · 这条**关联了错题** ⇒ 框与圆圈都 **紫**；
 *   两种情况里，加号（+）本身一律 **白色**。
 *
 * ── 为什么抽成纯函数、单独一个模块 ──────────────────────────────
 *   颜色规则只有一处定义，组件只负责"拿这个颜色去画框和圆"，不各自再写一份；
 *   而"什么颜色"这件事不碰 DOM、不碰 React，正好用单测直接钉死取值 ——
 *   免得日后有人顺手改了框的颜色、却漏掉圆（两处各写一份就会出现这种漂移）。
 */

/** 未关联错题：棕黄（耐看的深金黄，白加号压在上面够清楚） */
export const INSIGHT_PLUS_PLAIN_COLOR = '#b8860b';

/** 已关联错题：紫（与项目里其它"关联到了东西"的紫系同一观感） */
export const INSIGHT_PLUS_LINKED_COLOR = '#7c3aed';

/** 加号本身——两种情况下都是白的 */
export const INSIGHT_PLUS_GLYPH_COLOR = '#ffffff';

/**
 * 这条该用哪个颜色：关联了错题 ⇒ 紫；否则（含 undefined / null）⇒ 棕黄。
 * 判据只有"有没有关联错题"一件事，绝不猜别的。
 */
export function insightPlusColor(linked: boolean | null | undefined): string {
    return linked ? INSIGHT_PLUS_LINKED_COLOR : INSIGHT_PLUS_PLAIN_COLOR;
}
