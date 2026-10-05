/**
 * 【2026-10-05】图片拼接 —— **纯逻辑**（不碰 DOM / 不碰数据库 / 不建 canvas）。
 *
 * ── 他为什么要这个 ────────────────────────────────────────────────────
 * 语文 / 英语阅读、其它学科的材料题常常**跨页**：第一页几行原文，第二页还有一段，
 * 第三页才是几道小题。一张照片拍不下 —— 得拍两张（或从收件箱再取一张），
 * **各自框出有用的那一段**，竖着接成一张纸，再拿去裁题。
 *
 * ── 他定的规则（2026-10-05，别再自创）─────────────────────────────────
 *   ① 框是**紫色**的（与裁剪页现有的红/蓝/绿/橙四色都不冲突），只在"拼接模式"里有效；
 *   ② **可以一直加图**（一张接一张），全部画完再点「拼接」；
 *   ③ **框不能交叉**：同一张图内任意两个紫框不许相交、也不许包含 ——
 *      跨图不比较（两张图上的框在空间上本来就不在一起，比不出意义）；
 *   ④ 拼接顺序 = **先按图序，同一张图内按上边 y 排、y 相同看左边 x**；
 *   ⑤ **等宽**：所有段按比例（等比）放大 / 缩小到**同一个宽度**，
 *      基准取**各段里最宽的那一段**（只放大不缩小 ⇒ 丢的像素最少）；
 *   ⑥ 框**画到图片外面**（黑背景）时，**只取图内那部分**，黑边不要；
 *      整段都在图外 ⇒ 丢弃并计数（`dropped`）；
 *   ⑦ 段与段**首尾相接**（上一段的底边 = 下一段的顶边），没有任何间隙。
 *
 * ⚠️ 这个模块**只回答"该怎么拼"**，不画。真正建 canvas / drawImage / toBlob 在组件里做 ——
 *    这样"框超出、框交叉、等宽缩放、总高上限"这些边界情况**全部能纯测**。
 */

/** 一个待拼的框（坐标 = 它所属那张图的**自然像素**坐标） */
export interface StitchBox {
    /** 属于哪张图（0 起，与传入的 images 数组同序） */
    imageIndex: number;
    x: number;
    y: number;
    w: number;
    h: number;
}

/** 每张图的像素尺寸（与 StitchBox.imageIndex 对应） */
export interface StitchImage {
    width: number;
    height: number;
}

/** 一个矩形（裁到图内之后的） */
export interface Rect4 {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** 落地的一段：源矩形 + 在成品图上的纵向位置 */
export interface StitchSegment {
    /** 对应传入 boxes 里的下标（出错时好回溯是哪一段） */
    boxIndex: number;
    imageIndex: number;
    /** 源图上的矩形（**已经裁到图内**，不含黑边） */
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    /** 在成品图上的位置：宽度统一 = `plan.width`，顶边 = dy */
    dy: number;
    dh: number;
}

export interface StitchPlan {
    /** 成品图宽（= 基准段的宽度，必要时被总高上限整体缩过） */
    width: number;
    height: number;
    /** 为了不超过总高上限而做的**整体**缩放比（1 = 没缩） */
    scale: number;
    segments: StitchSegment[];
    /** 被丢弃的框数（整段都在图外、或所属图不存在） */
    dropped: number;
}

/**
 * 成品图的**总高上限**。
 *
 * 为什么要有：可以一直加图 ⇒ 段数一多，拼出来可能是一张又高又窄的长条，
 * 后续进裁剪编辑器会吃内存（编辑器的画布长边上限是 2560，见 `lib/edit-canvas-size.ts`）。
 * 超过就**整体等比缩小**（宽高一起缩），保形不变。
 */
export const STITCH_MAX_HEIGHT = 2560;

/** 一段太细（宽或高不足 1 像素）就当没有 —— 手抖点出来的小框不该产生一条缝 */
const MIN_SEGMENT_EDGE = 1;

/**
 * 把一个框**裁到图片范围内** —— 对应他的规则 ⑥：
 * "紫框已经划到图片外面黑色背景中了，就只取框里属于图片的那部分，黑背景不取"。
 *
 * @returns 裁好之后的矩形；**整段都在图外**（或细过 1 像素）时返回 null
 */
export function clampBoxToImage(box: StitchBox, img: StitchImage): Rect4 | null {
    const x1 = Math.max(0, Math.min(box.x, img.width));
    const y1 = Math.max(0, Math.min(box.y, img.height));
    const x2 = Math.max(0, Math.min(box.x + box.w, img.width));
    const y2 = Math.max(0, Math.min(box.y + box.h, img.height));
    const w = x2 - x1;
    const h = y2 - y1;
    if (w < MIN_SEGMENT_EDGE || h < MIN_SEGMENT_EDGE) return null;
    return { x: x1, y: y1, w, h };
}

/**
 * 两个矩形是否**相交或包含**（边贴边不算 —— 那是"挨着"，不是交叉）。
 *
 * ⚠️ 与 `image-cropper.tsx` 里那个 `rectsIntersect` 同口径（都是严格不等号），
 *    但那份是组件内部的、没导出；这里是拼接自己的口径，注释写明免得以后两边走偏。
 */
export function boxesOverlap(a: Rect4, b: Rect4): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 一对冲突的框（下标对应传入的 boxes 数组） */
export interface BoxConflict {
    a: number;
    b: number;
}

/**
 * 找出**同一张图内**所有相交 / 包含的框对 —— 对应规则 ③（框不能交叉）。
 *
 * 交互时用：画完一个框立刻查一次，有冲突就**不落框**并提示她重画
 * （而不是等点「拼接」时才失败 —— 那时候她已经忘了哪个框画重了）。
 * 跨图的框**不比较**。
 */
export function findBoxConflicts(boxes: readonly StitchBox[]): BoxConflict[] {
    const out: BoxConflict[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            if (boxes[i].imageIndex !== boxes[j].imageIndex) continue;
            if (boxesOverlap(boxes[i], boxes[j])) out.push({ a: i, b: j });
        }
    }
    return out;
}

/**
 * 排序 —— 对应规则 ④：**先按图序 → 同一张图内按上边 y → y 相同看左边 x**。
 *
 * 返回新数组（元素带原下标），不改入参：调用方常需要"排序后的顺序"和
 * "这个框原来是第几个"两件事同时成立。
 */
export function sortStitchBoxes(
    boxes: readonly StitchBox[],
): { box: StitchBox; index: number }[] {
    return boxes
        .map((box, index) => ({ box, index }))
        .sort(
            (p, q) =>
                p.box.imageIndex - q.box.imageIndex ||
                p.box.y - q.box.y ||
                p.box.x - q.box.x,
        );
}

export interface StitchPlanOptions {
    /** 总高上限，默认 `STITCH_MAX_HEIGHT`（测试里可传小值） */
    maxHeight?: number;
}

/**
 * 【核心】算出怎么拼：排序 → 裁到图内 → 等宽（按比例）→ 首尾相接 → 必要时整体缩。
 *
 * 注意两件事：
 *   · **等宽是按比例缩放的**（不是把每段拉到同宽就算）—— 宽高一起乘同一个系数，
 *     所以内容不会被压扁或拉长；
 *   · 总高超上限时，`scale < 1`，**宽度也要跟着缩**（否则比例就破了），
 *     返回的 `width` 已经是缩过之后的宽度。
 *
 * @returns 拼接方案；一个框都没有（或全被丢弃）时返回宽高为 0 的空方案
 */
export function planStitch(
    boxes: readonly StitchBox[],
    images: readonly StitchImage[],
    options: StitchPlanOptions = {},
): StitchPlan {
    const maxHeight = options.maxHeight ?? STITCH_MAX_HEIGHT;

    const usable: { index: number; imageIndex: number; rect: Rect4 }[] = [];
    let dropped = 0;

    for (const { box, index } of sortStitchBoxes(boxes)) {
        const img = images[box.imageIndex];
        if (!img) {
            dropped += 1;
            continue;
        }
        const rect = clampBoxToImage(box, img);
        if (!rect) {
            dropped += 1;
            continue;
        }
        usable.push({ index, imageIndex: box.imageIndex, rect });
    }

    if (usable.length === 0) {
        return { width: 0, height: 0, scale: 1, segments: [], dropped };
    }

    // 基准宽 = 最宽的那一段（只放大不缩小；窄的段等比放大到同宽）
    const baseW = usable.reduce((max, u) => (u.rect.w > max ? u.rect.w : max), 0);

    const segments: StitchSegment[] = [];
    let dy = 0;
    for (const u of usable) {
        const k = baseW / u.rect.w;
        const dh = Math.max(MIN_SEGMENT_EDGE, Math.round(u.rect.h * k));
        segments.push({
            boxIndex: u.index,
            imageIndex: u.imageIndex,
            sx: u.rect.x,
            sy: u.rect.y,
            sw: u.rect.w,
            sh: u.rect.h,
            dy,
            dh,
        });
        dy += dh;
    }

    // 总高上限：整体等比缩（**先缩再重排 dy**，保证首尾仍然相接）
    const rawHeight = dy;
    const scale = rawHeight > maxHeight ? maxHeight / rawHeight : 1;
    if (scale < 1) {
        let y = 0;
        for (const s of segments) {
            s.dh = Math.max(MIN_SEGMENT_EDGE, Math.round(s.dh * scale));
            s.dy = y;
            y += s.dh;
        }
    }

    const height = segments.reduce((sum, s) => sum + s.dh, 0);
    return {
        width: Math.max(MIN_SEGMENT_EDGE, Math.round(baseW * scale)),
        height: Math.max(MIN_SEGMENT_EDGE, height),
        scale,
        segments,
        dropped,
    };
}
