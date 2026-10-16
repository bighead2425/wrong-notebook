/**
 * 【2026-10-16 如如】复习结果的**来源** —— 这条流水是从哪个入口录进来的。
 *
 * 出处：`docs\18` 第五节（规格）+ `docs\16` §二·补 补充事实 3/4。
 *
 * ── 五个取值（前四个是他定的；`legacy` 是我为"老数据补流水"加的）────────
 *   · `review_paper`  复练纸（界面显示：**复练纸 + 卷号**）
 *   · `imitate_paper` 模仿纸（界面显示：**模仿纸 + 卷号**）
 *   · `single_scan`   单题扫描录入 —— **深挖纸也并进这里**（他 21:35 拍板："其他来源都写'其他'都行"）
 *   · `detail_page`   本页录入（错题详情页里手动记）
 *   · `legacy`        老数据一次性补的流水 —— **界面永远不显示它的日期**（时间列写"迁移前"），
 *                     因为老数据里**根本没有日期**，补的时候只能拿创建日顶 ⇒ 显示出来就是假的
 *
 * ⚠️⚠️ **判据只能靠"从哪个入口进来"，不能靠码**
 *   深挖纸的二维码内容是**裸题号**（空空拍板过的定位方案）⇒ 扫码那一刻**码里没有纸型信息**，
 *   系统不知道这张码印在深挖纸上还是别处。所以：
 *     · `components/scan-item-panel.tsx`（扫码弹出的单题卡，也是从卷页点加号进去的那个页面）⇒ `single_scan`
 *     · `app/error-items/[id]/page.tsx`（错题详情页）⇒ `detail_page`
 *     · 卷页 / 回录页的复练卡校对 ⇒ `review_paper` / `imitate_paper` + 卷号
 *   ⇒ **不要**试图从二维码内容去猜纸型（那是自创方案，他明确不要）。
 */

/** 全部合法取值 —— 别处判断合法性一律用它，别自己写数组 */
export const REVIEW_EVENT_SOURCES = [
    'review_paper',
    'imitate_paper',
    'single_scan',
    'detail_page',
    'legacy',
] as const;

export type ReviewEventSource = (typeof REVIEW_EVENT_SOURCES)[number];

export function isReviewEventSource(value: unknown): value is ReviewEventSource {
    return typeof value === 'string' && (REVIEW_EVENT_SOURCES as readonly string[]).includes(value);
}

/** 缺省按"单题扫描录入"处理 —— 与"来源收得住"一致，且**绝不猜成卷** */
export function normalizeReviewEventSource(value: unknown): ReviewEventSource {
    return isReviewEventSource(value) ? value : 'single_scan';
}

/** 老数据补的流水？—— 它**没有可信日期**，界面上要特殊对待 */
export function isLegacySource(value: unknown): boolean {
    return value === 'legacy';
}

/**
 * 一行的"来源"列显示什么。
 *
 * @param volumeCode 卷号（`RE…-NN`）—— 只有复练纸/模仿纸会带；没给就只显示纸型
 */
export function reviewEventSourceLabel(
    source: unknown,
    opts: { volumeCode?: string | null; zh?: boolean } = {},
): string {
    const zh = opts.zh !== false;
    const code = (opts.volumeCode ?? '').trim();

    switch (normalizeReviewEventSource(source)) {
        case 'review_paper':
            return code ? `${zh ? '复练纸' : 'Review paper'} ${code}` : zh ? '复练纸' : 'Review paper';
        case 'imitate_paper':
            return code ? `${zh ? '模仿纸' : 'Imitation paper'} ${code}` : zh ? '模仿纸' : 'Imitation paper';
        case 'detail_page':
            return zh ? '本页录入' : 'Entered here';
        case 'legacy':
            return zh ? '迁移前' : 'Before migration';
        case 'single_scan':
        default:
            return zh ? '单题扫描录入' : 'Single-question scan';
    }
}
