/**
 * 日积月累 · **一张照片怎么拆成"字"和"图"**（2026-10-18）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 他 2026-10-18 的原话（拆成四条规则）：
 *
 *   "在一张图上框绿框，框选多个的位置就是绿框中的内容是我想要的
 *    （录入错题是每个绿框是一道题的分割，**这里是把所有绿框合并**）。
 *    红框是印刷或打印出来的文字……蓝框是孩子自己手写的内容，
 *    这样就把别人说的话和孩子自己说的话区分开了。
 *    橙框是拍照中取得的图片……OCR 就是要提取红框、蓝框的内容，橙框是告诉 AI 这里是一张图片。
 *
 *    如果这个图片中画了橙框，那么这个橙框内的图片，才是这条积累的附图，
 *    而其他打印和手写的内容其实就可以剔除掉了。"
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 与错题那条链路的**三个不同**（照抄会错，逐条说明）───────────────
 *  ① 绿框：错题 = 分割（一区一题，切多张）；积累 = **合并**（取并集包围盒，只切一张）。
 *  ② 净版：错题涂的是「蓝 ∪ 橙」（她要的是"只留印刷体"给 AI 判题）；
 *     积累**不涂白** —— 红框和蓝框都要读，只是**分开读**（见 ③）。
 *  ③ 分离方式：错题把红蓝重叠的图**重排成一张拼图**；积累**各自裁一块**，
 *     因为这两块要分别变成"书上的话"（引文块）和"她的话"（普通段落），
 *     拼在一起就再也分不开了。
 *
 * ── 这一层为什么必须是纯函数 ────────────────────────────────────────
 * 裁歪一像素不会报错，只会让她看见"抄错行"的文字。所以把"裁哪几块"
 * 从 canvas 与 React 里剥出来，用单测钉住 —— canvas 只负责照着矩形切。
 */

import {
    mergeConnectedRects,
    toRect,
    unionRect,
    type CropBoxKind,
    type CropRegions,
} from './crop-regions';
import type { Rect } from './image-rotation';

export interface InsightSourcePlan {
    /** 绿框并集 = "只要这一块"；null = 整张图都要 */
    scope: Rect | null;
    /** 红框并集（印刷/打印体）→ OCR 出来是**别人说的话**；null = 没画红框 */
    printedArea: Rect | null;
    /** 蓝框并集（她手写）→ OCR 出来是**她自己的话**；null = 没画蓝框 */
    handwrittenArea: Rect | null;
    /**
     * 这条积累的附图从哪裁：橙框并集。
     * `null` = 一个橙框都没画 ⇒ **整张图当附图**（他的原话："录入了图片，
     * 那么那个图片当然就是这条积累的附图"）。
     */
    photoCrop: Rect | null;
    counts: Record<CropBoxKind, number>;
    /** 给人看的提醒（空数组 = 没毛病）。只提示，不擅自改 */
    notes: string[];
}

/** 把矩形夹进 scope；完全落在外面就返回 null（"绿框以外的都不要了"） */
function clampTo(r: Rect, scope: Rect | null): Rect | null {
    if (!scope) return r;
    const x0 = Math.max(r.x, scope.x);
    const y0 = Math.max(r.y, scope.y);
    const x1 = Math.min(r.x + r.w, scope.x + scope.w);
    const y1 = Math.min(r.y + r.h, scope.y + scope.h);
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 一组框的并集，再夹进 scope */
function areaOf(boxes: readonly Rect[], scope: Rect | null): Rect | null {
    const u = unionRect(boxes);
    return u ? clampTo(u, scope) : null;
}

/**
 * 算出一张照片该怎么拆。
 *
 * 关键判断顺序（别调换）：
 *   1. **绿框并集**先定 —— 别的框都要夹进它；
 *   2. 红、蓝**各自**并集（不是合并成一个）—— 它们要变成正文里两种不同的东西；
 *   3. 橙框合并（相邻的连成一片）再取并集当附图；
 *   4. **一个橙框都没有** ⇒ 附图 = 整张图（不是"没有附图"）。
 */
export function planInsightSource(regions: CropRegions | null): InsightSourcePlan {
    const boxes = regions?.boxes ?? [];
    const counts: Record<CropBoxKind, number> = {
        scope: 0,
        question: 0,
        handwriting: 0,
        figure: 0,
    };
    for (const b of boxes) counts[b.kind] += 1;

    const of = (kind: CropBoxKind) => boxes.filter((b) => b.kind === kind).map(toRect);

    // ① 绿框：**并集**（与错题的"分割"相反）
    const scope = unionRect(of('scope'));

    // ② 红蓝各自归堆，再夹进绿框
    const printedArea = areaOf(of('question'), scope);
    const handwrittenArea = areaOf(of('handwriting'), scope);

    // ③ 橙框：先连通合并，再取并集（多个小块拼成一张附图）
    //    完全落在绿框外的橙框**丢掉**（绿框以外都不要了），不能拿原坐标硬塞回来
    const figureRects = of('figure')
        .map((r) => clampTo(r, scope))
        .filter((r): r is Rect => r !== null);
    const figures = mergeConnectedRects(figureRects);
    const photoCrop = unionRect(figures);

    const notes: string[] = [];
    if (boxes.length === 0) {
        notes.push('一个框都没画：整张图当附图，字也按整张图读。');
    } else {
        if (!photoCrop) notes.push('没画橙框：整张图会当这条的附图。');
        if (!printedArea && !handwrittenArea && !photoCrop) {
            notes.push('只画了绿框：绿框里那整块会当一段话读进正文，不区分是书上的还是你写的。');
        }
        if (counts.question > 0 && counts.handwriting === 0) {
            notes.push('只有红框：读出来会当"别人的话"（引文块）排在正文前面。');
        }
        if (counts.scope > 1) {
            notes.push(`画了 ${counts.scope} 个绿框：会**合并**成一块（不是切成 ${counts.scope} 条）。`);
        }
    }

    return {
        scope,
        printedArea,
        handwrittenArea,
        photoCrop,
        counts,
        notes,
    };
}

/**
 * 这条积累**最后要不要留原图**。
 *
 * 他的规矩（2026-10-18）：画了橙框 ⇒ 只留橙框那块，其余（打印的、手写的）
 * 在 OCR 之后**剔除**掉，因为正文里已经有字了，再存一张同样的图只是重复。
 *
 * ⇒ 有橙框：不留原图（留的是裁出来的那一块）；没有橙框：整图就是附图，留着。
 */
export function needsOriginalPhoto(plan: InsightSourcePlan): boolean {
    return plan.photoCrop === null;
}
