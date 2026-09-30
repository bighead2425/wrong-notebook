import { isManageType } from "./manage-type";
import { normalizeBlankLines, normalizeFigureScale } from "./review-card";

/**
 * 卷内条目的**规范化**（POST 建卷 / PATCH 覆盖保存**共用这一处**）。
 *
 * 为什么单独一个文件：建卷与"更新组卷"要写进库的是**同一套字段、同一套兜底**。
 * 两边各写一遍，迟早在某个字段上分叉 —— 那时就会出现
 * "新建的卷好好的、更新过的卷少了题图"这种最难查的不一致。
 */

export interface VolumeItemInput {
    errorItemId: string | null;
    /**
     * 【2026-10-01 第三轮：积累纸】这一行印的是哪条**日积月累**。
     * 与 errorItemId **互斥**：复练卷的行挂题，积累卷的行挂积累条目。
     * ⚠️ 两者都允许为空（"这一行只留快照"也是合法的 —— 卷是印出去的凭证，快照才是主角）。
     */
    insightId: string | null;
    seqInVolume: number;
    pageIndex: number;
    columnIndex: number;
    seqInColumn: number;
    itemNo: string | null;
    questionText: string | null;
    figureUrls: string | null;
    manageType: string | null;
    blankLines: number;
    /** 题图缩放百分比（100 = 版面默认）—— 与留白一样属于"影响纸面的量"，必须进快照 */
    figureScale: number;
}

export function parseVolumeItems(rawItems: unknown, defaultBlankLines: number): VolumeItemInput[] {
    const list = Array.isArray(rawItems) ? rawItems : [];
    return list.map((entry, index) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const figs = e.figureUrls;
        const figureUrls = Array.isArray(figs)
            ? JSON.stringify(figs.filter((x) => typeof x === "string"))
            : typeof figs === "string"
                ? figs
                : null;
        const mt = typeof e.manageType === "string" && isManageType(e.manageType) ? e.manageType : null;
        return {
            errorItemId: typeof e.errorItemId === "string" && e.errorItemId ? e.errorItemId : null,
            insightId: typeof e.insightId === "string" && e.insightId ? e.insightId : null,
            seqInVolume: Number.isFinite(Number(e.seqInVolume)) ? Number(e.seqInVolume) : index + 1,
            pageIndex: Number.isFinite(Number(e.pageIndex)) ? Number(e.pageIndex) : 1,
            columnIndex: Number.isFinite(Number(e.columnIndex)) ? Number(e.columnIndex) : 0,
            seqInColumn: Number.isFinite(Number(e.seqInColumn)) ? Number(e.seqInColumn) : 1,
            itemNo: typeof e.itemNo === "string" ? e.itemNo : null,
            questionText: typeof e.questionText === "string" ? e.questionText : null,
            figureUrls,
            manageType: mt,
            blankLines: normalizeBlankLines(e.blankLines as number | null | undefined, defaultBlankLines),
            figureScale: normalizeFigureScale(e.figureScale as number | null | undefined),
        };
    });
}

/**
 * 【2026-10-01 第三轮：积累纸】给"挂了积累条目"的行**自动补上配图**。
 *
 * 前端建卷时只给了 insightId + JL 编号 + 正文 —— **图不给**。
 * 为什么不让前端传：列表接口刻意不返回图片本体（图片在独立表，列表查询不碰它，
 * 见 20261001220000 那条迁移的注释），前端手上根本没有图。
 *
 * 所以由服务端补：按 insightId 一次查回配图，填进 `figureUrls`（快照列）。
 * 判据仍是定盘星 —— **印出去的凭证必须存快照**，图也得落进卷里，
 * 否则原条目一改图，已经印出去的卷就"变了"。
 *
 * @param items 已规范化的卷内行（会被**原地**补 figureUrls）
 */
export async function attachInsightFigures(
    items: VolumeItemInput[],
    loadPhoto: (insightId: string) => Promise<string | null>,
): Promise<void> {
    const need = items.filter((i) => i.insightId && !i.figureUrls);
    for (const it of need) {
        const url = await loadPhoto(it.insightId!);
        if (url) it.figureUrls = JSON.stringify([url]);
    }
}

/** 总页数：优先用调用方算好的；没有就从题目的 pageIndex 里取最大（至少 1 页） */
export function resolvePageCount(rawPageCount: unknown, items: VolumeItemInput[]): number {
    const n = Number(rawPageCount);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    return Math.max(1, ...items.map((i) => i.pageIndex));
}

/**
 * 卷名规范化（2026-09-30）：去首尾空白、把连续空白压成一个空格、限长 60 字。
 * 空串 / 全是空白 ⇒ `null`（= 没有名字，不是"名字叫空"）。
 * ⚠️ 超长**截断**而不是报错 —— 名字是给人看的标签，不该因为写长了就存不下来。
 */
export function normalizeVolumeTitle(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const t = value.trim().replace(/\s+/g, ' ');
    return t ? t.slice(0, 60) : null;
}
