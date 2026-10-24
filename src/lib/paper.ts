/**
 * 纸张幅面 —— **全项目唯一的尺寸来源**。
 *
 * 2026-10-24 之前，B5 的尺寸散在 `deep-dive-card.ts` 里当编译期常量用；
 * 现在统一收到这里，深挖纸和卷类（复练/模仿/积累）都从这里取。
 *
 * ⚠️ **默认必须是 B5**：新部署的软件不能因为多了 A4 就改变任何现有排版。
 *
 * ── A4 的定位（空空 2026-10-24 原话）────────────────────────────────
 *   "A4 是 B5 的补充……也许是 B5 没纸了，或临时做一次自测。
 *    不要为 A4 大动干戈，主要设计还是要为 B5 设计。"
 * ⇒ A4 不是二等幅面，但也别为它引入复杂度：
 *   · **不做重排分页** —— 每页几道题按原记录，只按新宽度渲染；
 *   · 宽度**用满**，不能是"A4 纸上居中印一个 B5 宽的条"。
 */

export type PaperId = "B5" | "A4";

export interface PaperSpec {
    id: PaperId;
    /** 整纸宽高（mm） */
    w: number;
    h: number;
    /** 四边页边距（与 globals.css 的 `@page` 必须一致） */
    margin: { top: number; right: number; bottom: number; left: number };
    /** 内容区 = 整纸 − 页边距 */
    content: { w: number; h: number };
    /**
     * 每一面**实际占**的高度 = content.h − 2。
     *
     * 为什么留 2mm：一面是固定版式，要靠显式高度把页脚钉在底部；
     * 高度写成与内容区一模一样时，浏览器取整多出一点点就会把整块挪到下一页，
     * 表现是"每道题前面空一张白纸"。留 2mm 对这个风险免疫。
     */
    sideHeight: number;
    /** 打孔装订位宽度（正面左、反面右） */
    punchGutter: number;
    /** 扣掉打孔位后真正能排的宽度 */
    usableWidth: number;
}

/** 页边距：B5 / A4 用同一套。打印机的不可打印区约 5–10mm，14–16mm 是安全的。 */
const MARGIN_MM = { top: 14, right: 15, bottom: 16, left: 15 } as const;

/** 打孔位：与幅面无关，活页夹的孔离纸边的距离是固定的。 */
const PUNCH_GUTTER_MM = 12;

function makeSpec(
    id: PaperId,
    w: number,
    h: number,
): PaperSpec {
    const content = {
        w: w - MARGIN_MM.left - MARGIN_MM.right,
        h: h - MARGIN_MM.top - MARGIN_MM.bottom,
    };
    return {
        id,
        w,
        h,
        margin: { ...MARGIN_MM },
        content,
        sideHeight: content.h - 2,
        punchGutter: PUNCH_GUTTER_MM,
        usableWidth: content.w - PUNCH_GUTTER_MM,
    };
}

/**
 * 国内市售 B5 = 182mm × 257mm（**JIS B5**）。
 * ⚠️ CSS 的 `size: B5` 是 ISO B5 = 176×250mm，比国产纸每边小 6mm，满页排版会跑版，
 *   所以 `@page` 里写的是明确毫米数。
 */
export const PAPERS: Record<PaperId, PaperSpec> = {
    B5: makeSpec("B5", 182, 257),
    /** A4 = 210 × 297。内容区 180 × 267，扣打孔位后可排 168。 */
    A4: makeSpec("A4", 210, 297),
};

/** 缺省幅面。**不能改** —— 改了等于让所有存量纸改版。 */
export const DEFAULT_PAPER_ID: PaperId = "B5";

/** 幅面选择在配置里的形状：四种纸各一个 */
export interface PaperConfig {
    /** T1 深挖纸 */
    deepDive: PaperId;
    /** 复练卷 */
    review: PaperId;
    /** 模仿卷 */
    imitate: PaperId;
    /** 积累卷 */
    build: PaperId;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
    deepDive: DEFAULT_PAPER_ID,
    review: DEFAULT_PAPER_ID,
    imitate: DEFAULT_PAPER_ID,
    build: DEFAULT_PAPER_ID,
};

export const PAPER_IDS: readonly PaperId[] = ["B5", "A4"];

export function isPaperId(v: unknown): v is PaperId {
    return v === "B5" || v === "A4";
}

/**
 * 从配置里取幅面。**脏数据一律退回 B5** ——
 * 配置是手改过的 json，出现 `"b5"` / `""` / `null` 都有可能，
 * 这时候宁可按 B5 印（和现在一样），也不要抛错让整个打印页打不开。
 */
export function paperOf(id: string | null | undefined): PaperSpec {
    return PAPERS[isPaperId(id) ? id : DEFAULT_PAPER_ID];
}

/** 四种纸 → 配置字段名 */
export type PaperKind = keyof PaperConfig;

/** 某个纸型该用多大纸；配置缺项一律 B5 */
export function paperFor(kind: PaperKind, config: Partial<PaperConfig> | null | undefined): PaperSpec {
    return paperOf(config?.[kind]);
}
