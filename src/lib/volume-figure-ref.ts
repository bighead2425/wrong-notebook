/**
 * 【2026-10-28】**积累卷的配图不再存副本，改存"引用"**。
 *
 * ── 为什么要改（他拍板的）──────────────────────────────────────────
 *   一张 1.15MB 的日积月累配图，被印进 10 个积累卷 ⇒ 库里存了 10 份一模一样的图，
 *   光这一条就吃掉 10.3MB（全库 33.8MB 里 15.56MB 是这类副本）。
 *
 *   他的判断（2026-10-28 22:00）：**积累是会进化的**，改内容就是进化；
 *   "恢复到当初那张纸"没有任何意义，"那只是恋旧甚至是复辟"。
 *   所以配图不需要快照 —— 跟着**当前那一条**走就行。
 *
 * ── 为什么文字仍然存快照 ──────────────────────────────────────────
 *   不是恋旧，是**排版**：一卷排好版之后，每行占多高、分到第几栏是按当时字数算死的。
 *   文字改成现取的话，第二天补两句话再打，字多了装不下，会把后面所有行挤歪。
 *   文字 286 行一共才 28KB，存得起；图是 MB 级，且不改版面 ⇒ 只存引用。
 *
 * ── 格式 ─────────────────────────────────────────────────────────
 *   `figureUrls` 是 JSON 数组（历史原因）。引用写成 `ref:insight:<insightId>`，
 *   与老数据里的 `data:image/...`、以及可能的路径字符串**共存**：
 *   解析时按元素判断，认不出来的原样留着（老卷不需要迁移也能印）。
 *
 * ⚠️ 一条积累最多一张图（他定的规则），所以这里不处理"多张"。
 * ⚠️ "入版/不入版"开关**不在这里判断** —— 那是 `lib/insight-photo.ts` 的唯一职责，
 *    `stripExcludedFigures()` 在解析引用**之前**已经把不入版的行清成 null 了。
 */
import { readPhotosForPrint } from "@/lib/insight-photo";

/** 引用的前缀。改它等于让库里所有老引用失效，别改。 */
export const FIGURE_REF_PREFIX = "ref:insight:";

/** 由积累 id 造一个引用 */
export function insightFigureRef(insightId: string): string {
    return `${FIGURE_REF_PREFIX}${insightId}`;
}

/** 这个字符串是不是一条引用 */
export function isFigureRef(value: string): boolean {
    return value.startsWith(FIGURE_REF_PREFIX);
}

/** 从引用里取回积累 id；不是引用 ⇒ null */
export function insightIdOfRef(value: string): string | null {
    if (!isFigureRef(value)) return null;
    const id = value.slice(FIGURE_REF_PREFIX.length).trim();
    return id || null;
}

/**
 * 把 `figureUrls`（JSON 数组字符串）读成字符串数组。
 * 脏数据一律当"没有图"，不让它把打印整页搞崩。
 */
export function parseFigureUrls(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
        if (typeof v === "string" && v) return [v];
        return [];
    } catch {
        /* 存量里有过"直接存裸字符串"的写法，兜一下 */
        return raw.startsWith("data:") || raw.startsWith("ref:") || raw.startsWith("/") ? [raw] : [];
    }
}

/** 把数组写回 `figureUrls` 的格式；空数组 ⇒ null（= 这一行没有图） */
export function serializeFigureUrls(urls: readonly string[]): string | null {
    const clean = urls.filter((x) => typeof x === "string" && x.length > 0);
    return clean.length ? JSON.stringify(clean) : null;
}

/**
 * **纯函数的那一半**：拿"id → 图"的查表结果，把引用换成真图。
 *
 * 单独拆出来是为了能单测 —— 数据库那半（`resolveFigureRefs`）只负责查、不负责拼。
 *
 * 规则：
 *   · 认得出是引用的 ⇒ 查到就换成图；查不到（那条积累把图删了）⇒ **这张图丢掉**，不报错；
 *   · 认不出的（`data:` 老数据、路径）⇒ 原样保留；
 *   · 换完一张不剩 ⇒ `null`（= 这一行没有图，打印时不排）。
 */
export function applyFigureRefs<
    T extends { insightId: string | null; figureUrls: string | null },
>(items: T[], lookup: (insightId: string) => string | undefined): T[] {
    return items.map((it) => {
        const urls = parseFigureUrls(it.figureUrls);
        if (!urls.some(isFigureRef)) return it;
        const resolved: string[] = [];
        for (const u of urls) {
            const id = insightIdOfRef(u);
            if (!id) {
                resolved.push(u);
                continue;
            }
            const data = lookup(id);
            if (data) resolved.push(data);
        }
        return { ...it, figureUrls: serializeFigureUrls(resolved) };
    });
}

/**
 * **读的时候**把引用换成真图（data URL）。
 *
 * 一次查库把这一卷里所有引用对应的图取回来（按 insightId 批量），
 * 然后交给 `applyFigureRefs` 去拼。
 *
 * ⚠️ 老数据里的 data URL 原样返回，所以**不迁移也能用**；迁移只是为了省空间。
 */
export async function resolveFigureRefs<
    T extends { insightId: string | null; figureUrls: string | null },
>(items: T[]): Promise<T[]> {
    /** 先扫一遍要查哪些 id —— 没有引用就一次库都不碰 */
    const wanted = new Set<string>();
    for (const it of items) {
        for (const u of parseFigureUrls(it.figureUrls)) {
            const id = insightIdOfRef(u);
            if (id) wanted.add(id);
        }
    }
    if (wanted.size === 0) return items;

    /* 取图走 `lib/insight-photo.ts`（唯一允许碰图的地方，见那边的看门测试） */
    const byInsight = await readPhotosForPrint([...wanted]);
    return applyFigureRefs(items, (id) => byInsight.get(id));
}
