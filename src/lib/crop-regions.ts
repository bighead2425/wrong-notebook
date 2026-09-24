/**
 * 框坐标 —— P7「存坐标、不烧像素」的解析、校验与几何。
 *
 * ── 为什么要有这个模块 ──────────────────────────────────────────────
 * 录入时在照片上画四种框（P5 / §九 #5）：
 *
 *   绿 scope       作用域，可叠，取合集 —— 见绿框即"这是一道题"
 *   红 question    题干
 *   蓝 handwriting 她的手写作答
 *   橙 figure      题图（不可 OCR 的图像）
 *
 * 旧做法是**把框线直接画进图片像素**（`image-cropper.tsx` 的 buildRegionCanvas），
 * 一旦烘死就不可逆：想"正面印不带框的原图"就得回头识别并擦掉框线。
 * 现在改成**只存坐标**，于是一张原图 + 一份坐标能派生出四种视图：
 *
 *   正面图 = 原图本身（天然无框）        ← 他思考原文第 14 行要的"原页面的样子"
 *   净版   = 原图 − 蓝框 − 橙框（涂白）   ← 反面印这个
 *   题图   = 橙框区域单独裁出            ← 放在题干右下角
 *   OCR 输入 = 净版
 *
 * ── 两条必须守住的规矩 ──────────────────────────────────────────────
 * ① 坐标**必须连基准图宽高 + 旋转一起存**。只存 x/y/w/h 的话，迟到一次旋转就是
 *    "不报错、只画错"（`rectSpaceStaleRef` 的教训：宁可这一道没有标记，
 *    也不能给一个位置错误的绿框）。
 * ② 涂白**不看优先级**。设计里说"重叠处归高优先级、低优先级原地留白"，听起来要一堆
 *    两两规则；但"涂白"这个动作里**蓝和橙都要涂**，所以直接取并集即天然满足优先
 *    —— 规则塌缩成一个循环，不必实现矩形切分这种容易出错的东西。
 *    （优先级真正会用到的地方是"逐像素打单一标签"，本轮没有这个需求。）
 *
 * 本模块是纯函数：不碰 DOM、不碰数据库、不碰 canvas。
 */

import { normalizeRotation, rotatedSize, rotateRect, type Rect } from './image-rotation';

/** 四种框的语义（与 image-cropper 的画框 UI 一一对应） */
export type CropBoxKind = 'scope' | 'question' | 'handwriting' | 'figure';

export const CROP_BOX_KINDS: readonly CropBoxKind[] = [
    'scope',
    'question',
    'handwriting',
    'figure',
];

/** 人话标签（给孩子看的纸面、给家长看的后台都用这一份） */
export const CROP_KIND_LABEL: Record<CropBoxKind, string> = {
    scope: '绿框 · 作用域',
    question: '红框 · 题干',
    handwriting: '蓝框 · 手写',
    figure: '橙框 · 题图',
};

/**
 * 优先级：蓝 > 橙 > 红（绿是"作用域"层，不与语义框同层比较）。
 * ⚠️ 目前只用于**校验与展示**，涂白走并集（见文件头 ②）。
 */
export const CROP_KIND_PRIORITY: Record<CropBoxKind, number> = {
    handwriting: 3,
    figure: 2,
    question: 1,
    scope: 0,
};

export interface CropBox {
    kind: CropBoxKind;
    x: number;
    y: number;
    w: number;
    h: number;
}

/** 这套坐标是基于哪张图量的 —— 换旋转/换尺寸就会失效，所以必须一起存 */
export interface CropBase {
    w: number;
    h: number;
    /** 顺时针为正，0 / 90 / 180 / 270 */
    rotation: number;
}

export interface CropRegions {
    boxes: CropBox[];
    base: CropBase;
}

export function isCropBoxKind(value: unknown): value is CropBoxKind {
    return typeof value === 'string' && (CROP_BOX_KINDS as readonly string[]).includes(value);
}

function toPositiveNumber(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 解析存库的 JSON 字符串。
 *
 * 形状不对一律返回 `null`（= 当成"没有框"），**绝不半信半疑地拼一个框出来** ——
 * 框错位的后果是"净版里手写没擦干净"，孩子一眼看到自己的答案，比没有净版更糟。
 * 调用方拿到 null 就走兜底：原图 + 一行小字「翻回正面看题」，并提示她补画框。
 */
export function parseCropRegions(raw: unknown): CropRegions | null {
    let data: unknown = raw;
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s) return null;
        try {
            data = JSON.parse(s);
        } catch {
            return null;
        }
    }
    if (!data || typeof data !== 'object') return null;

    const obj = data as Record<string, unknown>;
    const baseRaw = obj.base as Record<string, unknown> | undefined;
    if (!baseRaw || typeof baseRaw !== 'object') return null;

    const baseW = toPositiveNumber(baseRaw.w);
    const baseH = toPositiveNumber(baseRaw.h);
    if (baseW === null || baseH === null || baseW <= 0 || baseH <= 0) return null;

    const boxesRaw = obj.boxes;
    if (!Array.isArray(boxesRaw)) return null;

    const boxes: CropBox[] = [];
    for (const item of boxesRaw) {
        if (!item || typeof item !== 'object') return null;
        const b = item as Record<string, unknown>;
        if (!isCropBoxKind(b.kind)) return null;
        const x = toPositiveNumber(b.x);
        const y = toPositiveNumber(b.y);
        const w = toPositiveNumber(b.w);
        const h = toPositiveNumber(b.h);
        // 零面积框没有意义，直接丢掉而不是留着污染并集
        if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) continue;
        boxes.push({ kind: b.kind, x, y, w, h });
    }

    return {
        boxes,
        base: { w: baseW, h: baseH, rotation: normalizeRotation(baseRaw.rotation) },
    };
}

/** 序列化回 JSON 字符串（写入 `ErrorItem.cropRegions`）。只留整数，省库也省得读时对不平。 */
export function serializeCropRegions(regions: CropRegions): string {
    return JSON.stringify({
        boxes: regions.boxes.map((b) => ({
            kind: b.kind,
            x: Math.round(b.x),
            y: Math.round(b.y),
            w: Math.round(b.w),
            h: Math.round(b.h),
        })),
        base: {
            w: Math.round(regions.base.w),
            h: Math.round(regions.base.h),
            rotation: normalizeRotation(regions.base.rotation),
        },
    });
}

/**
 * 校验，返回**人话**的问题清单（空数组 = 没问题）。
 * 只报不改：调用方（录入保存前）拿它决定是拦下来还是放行。
 */
export function validateCropRegions(regions: CropRegions): string[] {
    const errors: string[] = [];
    const { base, boxes } = regions;

    if (!(base.w > 0) || !(base.h > 0)) {
        errors.push('基准图尺寸缺失：没有基准宽高，框的位置无从换算');
    }

    const outOfBase = boxes.filter(
        (b) => b.x + b.w > base.w + 1 || b.y + b.h > base.h + 1,
    );
    if (outOfBase.length > 0) {
        errors.push(`有 ${outOfBase.length} 个框超出了基准图范围（坐标与基准图对不上）`);
    }

    if (!boxes.some((b) => b.kind === 'question') && boxes.length > 0) {
        errors.push('没有红框：题干范围只能退回整图（特殊情况 2 允许，但需留意）');
    }

    return errors;
}

/* ============================ 几何 ============================ */

export function toRect(box: CropBox): Rect {
    return { x: box.x, y: box.y, w: box.w, h: box.h };
}

function intersects(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 多个矩形的并集包围盒；空数组返回 null */
export function unionRect(rects: readonly Rect[]): Rect | null {
    if (rects.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w);
        maxY = Math.max(maxY, r.y + r.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 合并**相互连通**的矩形（连通分量 + 并集包围盒）。
 *
 * 为什么不是"两两能叠就并"：A∩B、B∩C 但 A∩C=∅ 时，三个框其实是一道题的三段，
 * 必须并成一个；两两规则会在这种"链式相邻"下漏掉。（同 `image-cropper.tsx`
 * 的 `mergeRegions`。）
 *
 * 并出来的包围盒是**保守**的（可能多吃一点空白），这对"涂白"是安全方向：
 * 多吃的是题目周围的留白，少吃的才是没擦干净的手写。
 */
export function mergeConnectedRects(rects: readonly Rect[]): Rect[] {
    const pool = rects.map((r) => ({ ...r }));
    const out: Rect[] = [];

    while (pool.length > 0) {
        const group = [pool.shift() as Rect];
        let grew = true;
        while (grew) {
            grew = false;
            for (let i = pool.length - 1; i >= 0; i--) {
                if (group.some((g) => intersects(g, pool[i]))) {
                    group.push(pool.splice(i, 1)[0]);
                    grew = true;
                }
            }
        }
        out.push(unionRect(group) as Rect);
    }
    return out;
}

/**
 * 换一套坐标系：把**基于 `base` 量的**矩形，映射到 `target`（可能转过、可能缩放过）的坐标系里。
 *
 * 分两步，且**顺序不能反**：
 *   ① 先转（用 `base` 自己的宽高做参照系，与 image-cropper 的 rotateRect 完全同一套数学）；
 *   ② 再缩（按"转完之后 base 的显示尺寸"到 target 的比例）。
 *
 * ⚠️ 第 ② 步的分母必须是**转过之后**的 base 尺寸（`rotatedSize`），
 *    用转之前的宽高会在 90/270 时把 x/y 的比例搞反 —— 又是"不报错、只画错"。
 */
export function mapRect(rect: Rect, base: CropBase, target: CropBase): Rect {
    const step = normalizeRotation(target.rotation - base.rotation);
    const rotated = rotateRect(rect, base.w, base.h, step);
    const baseShown = rotatedSize(base.w, base.h, step);
    const sx = target.w / baseShown.w;
    const sy = target.h / baseShown.h;
    return {
        x: rotated.x * sx,
        y: rotated.y * sy,
        w: rotated.w * sx,
        h: rotated.h * sy,
    };
}

/* ====================== 净版计划（M2 主路） ====================== */

export interface NetVersionPlan {
    /**
     * 题干范围。红框并集的包围盒；没有红框退回绿框；两者都没有 = null（= 整图）。
     * 这就是"特殊情况 1/2"的落点：没有任何框 → 不涂白、整图当题干。
     */
    questionArea: Rect | null;
    /**
     * 要涂白的矩形（**蓝 ∪ 橙**，重叠已合并）。
     * 直接渲染成白块即可得净版；不需要 AI、不需要 inpainting。
     */
    fills: Rect[];
    /** 题图区（橙框逐个保留），裁出来放到题干右下角 */
    figures: Rect[];
    /** 四类框各有多少，用于判断走主路还是兜底 */
    counts: Record<CropBoxKind, number>;
    /**
     * 走不了"按框涂白"主路的情形 —— 由调用方决定走哪条兜底：
     *   'no-boxes'  一个框都没有 → 原图直接用，别涂
     *   'no-handwriting' 没有蓝框 → 可能是"完全不会"（特殊情况 3），不涂就是净版
     */
    fallback: null | 'no-boxes';
}

/**
 * 由框坐标算出"怎么从原图得到净版"。
 *
 * 纯几何、无副作用 ⇒ **可以写单测钉住**，这正是 M2 从"技术风险最高"降级为
 * "确定性操作"的依据：手写在哪是框出来的、坐标已知，涂白就是净版。
 */
export function planNetVersion(regions: CropRegions | null): NetVersionPlan {
    const boxes = regions?.boxes ?? [];
    const counts: Record<CropBoxKind, number> = {
        scope: 0,
        question: 0,
        handwriting: 0,
        figure: 0,
    };
    for (const b of boxes) counts[b.kind] += 1;

    if (boxes.length === 0) {
        return {
            questionArea: null,
            fills: [],
            figures: [],
            counts,
            fallback: 'no-boxes',
        };
    }

    const of = (kind: CropBoxKind) => boxes.filter((b) => b.kind === kind).map(toRect);

    const questionRects = of('question');
    const scopeRects = of('scope');
    const questionArea =
        unionRect(questionRects) ?? unionRect(scopeRects) ?? null;

    // 蓝（她的手写）+ 橙（题图）涂白 —— 两个都要涂，所以并集即满足"蓝 > 橙 > 红"的优先级
    const fills = mergeConnectedRects([...of('handwriting'), ...of('figure')]);

    return {
        questionArea,
        fills,
        figures: of('figure'),
        counts,
        fallback: null,
    };
}

/**
 * 净版需要涂白吗？
 * 没有蓝框（她压根没作答，特殊情况 3）或没有框时，原图本身就是净版 —— 别多此一举。
 */
export function needsWipe(plan: NetVersionPlan): boolean {
    return plan.fills.length > 0;
}

/**
 * 把框换算到**某张具体图片的自然像素**坐标系，好让 canvas 直接 fillRect。
 *
 * ⚠️ 一条必须写死的前提：**`ErrorItem.originalImageUrl` 指的就是 `base` 那张图**
 *    （存库时若做过旋转，旋转已经烘进那张图，`base.rotation` 记录的就是它）。
 *    所以这里 target.rotation 取 `base.rotation` —— 相对旋转量为 0，只做等比缩放。
 *    若哪天改成"存未旋转的原图 + 另存旋转角"，这里必须跟着改，
 *    否则就是"框还在原地、图已经转了"的**不报错只画错**。
 */
export function toPixelRects(
    rects: readonly Rect[],
    base: CropBase,
    imageWidth: number,
    imageHeight: number,
): Rect[] {
    if (!(imageWidth > 0) || !(imageHeight > 0)) return [];
    const target: CropBase = { w: imageWidth, h: imageHeight, rotation: base.rotation };
    return rects.map((r) => mapRect(r, base, target));
}
