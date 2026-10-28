/**
 * 【2026-10-01】日积月累配图的**读写**只在这里（一处实现）。
 *
 * 为什么图片单独一张表（存储改正，他拍板的）：正文是几 KB 的文字、图片是几百 KB 的 data URL，
 * 挤在同一行里 = "字典每一页都贴照片" —— 列表每次都被迫把所有照片搬进内存。
 * 分表之后主表查询完全不碰它。
 *
 * ⚠️ 一条积累**最多一张图**（他定的规则）⇒ `@@unique([insightId])`，写入就是"建或换"。
 */
import { prisma } from "@/lib/prisma";

/** null = 删图；字符串 = 建或换（data URL） */
export async function writePhoto(insightId: string, photo: string | null): Promise<void> {
    if (photo === null) {
        await prisma.insightPhoto.deleteMany({ where: { insightId } });
        return;
    }
    const existing = await prisma.insightPhoto.findUnique({ where: { insightId } });
    if (existing) {
        await prisma.insightPhoto.update({ where: { insightId }, data: { data: photo } });
    } else {
        await prisma.insightPhoto.create({ data: { insightId, data: photo } });
    }
}

/** 取一条积累的图片（没有就 null）。列表**不要**用它 —— 那会把照片全搬回来 */
export async function readPhoto(insightId: string): Promise<string | null> {
    const row = await prisma.insightPhoto.findUnique({
        where: { insightId },
        select: { data: true },
    });
    return row?.data ?? null;
}

/**
 * 【2026-10-19 真真】**取"可以印进纸里"的图** —— 入版开关在这里落地（唯一一处）。
 *
 * ── 为什么非要有这个函数（这是个真 bug 的修复）──────────────────────
 * 空空 2026-10-19 反馈："管理页里图片旁边的『入版 / 不入版』切换似乎不起作用"。
 *
 * 真因：开关**存得住**（探针验过：`updateMany` 写进去、读回来都对），
 * 但**建卷时没人看它** —— `api/review-volumes` 的 POST 与 PATCH 各自写了一段
 * `insightPhoto.findUnique({ select: { data: true } })`，只取图、不看开关。
 * 而打印页前端算的 `photoUrl`（`photoIncludedInPrint === false ? null : …`）
 * **根本没被用上** —— 建卷只传 `insightId`，图是**服务端按 id 补进快照**的。
 * ⇒ 开关拨到"不入版"，纸上照样有图。
 *
 * 修法：把"要不要这张图"的判断收进**这一个函数**，两条补图路径都调它。
 * ⚠️ 以后再加新的建卷/重排路径，也必须走这里 —— 别再自己 `findUnique` 取图。
 *
 * @returns 入版 = 图（data URL）；不入版 / 没图 = null
 */
export async function readPhotoForPrint(insightId: string): Promise<string | null> {
    const row = await prisma.insightPhoto.findUnique({
        where: { insightId },
        select: { data: true, includedInPrint: true },
    });
    return row && row.includedInPrint ? row.data : null;
}

/**
 * 【2026-10-25】**一次问清一批图里哪些是"不入版"的。**
 *
 * 用途：`GET /api/review-volumes/[id]` 读卷时按当前开关过一遍图
 * （卷里的图是建卷快照，开关之后再拨不会自己变）。
 *
 * 为什么不直接在路由里查：与 `readPhotoForPrint` 同一条规矩 ——
 * **"入版"这件事的判断只放在这个文件里**，别处只拿结论。
 */
export async function excludedFromPrint(insightIds: readonly string[]): Promise<Set<string>> {
    if (insightIds.length === 0) return new Set();
    const rows = await prisma.insightPhoto.findMany({
        where: { insightId: { in: [...insightIds] } },
        select: { insightId: true, includedInPrint: true },
    });
    return new Set(rows.filter((r) => !r.includedInPrint).map((r) => r.insightId));
}

/**
 * 【2026-10-28】**只问"这条积累这次有没有可印的图"，不把图取回来。**
 *
 * 为什么需要：建卷时只决定两件事 —— ① 这一行要不要挂图；② 挂的话存成**引用**
 * （`ref:insight:<id>`，见 `lib/volume-figure-ref.ts`）。
 * 以前这里调 `readPhotoForPrint`，为了判断"有没有图"把几百 KB 的 data URL 读进内存，
 * 读完再塞进 `figureUrls` —— 那份数据正是要消灭的副本。
 *
 * 判据与 `readPhotoForPrint` **必须一致**（同一个 `includedInPrint` 开关），
 * 所以两处都以 `InsightPhoto` 那一行为准，只是取的列不同。
 */
export async function hasPhotoForPrint(insightId: string): Promise<boolean> {
    const row = await prisma.insightPhoto.findUnique({
        where: { insightId },
        select: { includedInPrint: true },
    });
    return Boolean(row?.includedInPrint);
}

/**
 * 【2026-10-28】**一批"能印"的图**（`insightId → data URL`），给卷里的引用解析用。
 *
 * 为什么放在这里而不是让 `volume-figure-ref.ts` 自己查：
 * 「取图只能在这个文件里」是 2026-10-19 定下的看门护栏（有测试钉着），
 * 图的取法一分散，"入版开关"这种判据迟早在某条路上被漏掉。
 *
 * 只返回**入版**的行：不入版的那条连引用都不该解析出图来。
 * 引用指向一条已经不存在的积累 ⇒ 映射里没有它，调用方当作"这张图没了"。
 */
export async function readPhotosForPrint(insightIds: readonly string[]): Promise<Map<string, string>> {
    if (insightIds.length === 0) return new Map();
    const rows = await prisma.insightPhoto.findMany({
        where: { insightId: { in: [...insightIds] }, includedInPrint: true },
        select: { insightId: true, data: true },
    });
    return new Map(rows.map((r) => [r.insightId, r.data]));
}

/**
 * 【2026-10-25】**把一批卷行里"现在不入版"的图清掉**（读时过滤，不写库）。
 *
 * 为什么需要它：卷里的 `figureUrls` 是**建卷那一刻的快照**，
 * 开关之后再拨不会自己变 —— 打印/扫码看到的还是老样子。
 *
 * ⚠️ 有**两条**按卷读数据的路，都要调这里：
 *     · `GET /api/review-volumes/[id]`（按内部 id，打印页用）
 *     · `GET /api/review-volumes/lookup?code=`（按纸上的卷号，扫码预览用）
 *     漏掉任何一条，都会出现"这个页面没了、那个页面还挂着"。
 *
 * 只清 `figureUrls`，题文/顺序/页码一律不动 —— 快照该定死的照样定死。
 */
export async function stripExcludedFigures<
    T extends { insightId: string | null; figureUrls: string | null },
>(items: T[]): Promise<T[]> {
    const ids = items.map((i) => i.insightId).filter((x): x is string => Boolean(x));
    if (ids.length === 0) return items;
    const excluded = await excludedFromPrint(ids);
    if (excluded.size === 0) return items;
    return items.map((it) =>
        it.insightId && excluded.has(it.insightId) ? { ...it, figureUrls: null } : it,
    );
}

/**
 * 【2026-10-13 第 6 条】**"入版"开关** —— 组成积累纸时这张图跟不跟着进去。
 *
 * 他原话："点中入版，则表示在组成积累纸的时候，这个图片是跟随进入的，
 *          如果这个按钮开关是关着的……在排版积累纸的时候，这个图片是不跟随进入的。"
 * ⇒ 关掉**不等于删图**（图还在库里、编辑区还看得见），只是**这一版纸不排它**。
 *
 * ⚠️ 用 `updateMany` 而不是 `update`：这一条**没有图**时会命中 0 行 ——
 *    那不算错（他可能先在没图的一条上点了开关），不该抛出去打断这次保存。
 */
export async function setPhotoPrintIncluded(insightId: string, includedInPrint: boolean): Promise<void> {
    await prisma.insightPhoto.updateMany({
        where: { insightId },
        data: { includedInPrint },
    });
}
