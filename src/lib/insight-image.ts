/**
 * 日积月累 · 把一张照片按框**切成几块**（2026-10-18）
 *
 * 只做 canvas 的活儿：给一张图 + 几个矩形，切出来。
 * "该切哪几块"在 `lib/insight-source.ts`（纯函数、有单测）——
 * 这里**不再做任何判断**，否则同一个规则会有两份实现，
 * 一处改了另一处没改，就是"抄错行"那种不报错的错。
 *
 * 三块各去哪：
 *   · printed      → 送 OCR → 变成正文里的**引文块**（书上的话）
 *   · handwritten  → 送 OCR → 变成正文里的**普通段落**（她的话）
 *   · figure       → 直接当这条积累的**附图**（不进 OCR）
 */

import type { InsightSourcePlan } from './insight-source';
import type { Rect } from './image-rotation';

export interface InsightCrops {
    printed: string | null;
    handwritten: string | null;
    figure: string | null;
}

/** OCR 用的图最长边；再大模型也用不上，只是白等上传 */
const OCR_MAX_SIDE = 1600;
/** 小于这个尺寸的框当"误触"（手一抖画出来的 3×3 方块） */
const MIN_SIDE = 24;

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image load failed'));
        img.src = src;
    });
}

/**
 * 裁一块出来。矩形是**这张图自己的自然像素坐标**（`onCropRegions` 给的 base
 * 就是这张图的尺寸，两边同系 —— 这是坐标合同，别在这里再缩放一次）。
 */
function cutOne(
    img: HTMLImageElement,
    rect: Rect | null,
    opts: { maxSide?: number; quality?: number } = {},
): string | null {
    if (!rect) return null;

    // 夹进图内（框可能有一边画到图外）
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const w = Math.min(Math.round(rect.w), img.naturalWidth - x);
    const h = Math.min(Math.round(rect.h), img.naturalHeight - y);
    if (w < MIN_SIDE || h < MIN_SIDE) return null;

    const maxSide = opts.maxSide ?? 0;
    const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(w, h)) : 1;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // 白底：PNG 带透明的话，JPEG 会把透明变成黑
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/jpeg', opts.quality ?? 0.92);
}

/**
 * 按计划切三块。`src` 可以是 objectURL 或 data URL。
 *
 * ⚠️ **一个框都没画时**（plan 全 null）：三块都返回 null，
 *    调用方自己决定"整图当附图"。这里**不替它决定** ——
 *    "不画框 = 整图" 是业务规则，不是裁剪规则。
 */
export async function cutInsightCrops(src: string, plan: InsightSourcePlan): Promise<InsightCrops> {
    const img = await loadImage(src);
    try {
        return {
            printed: cutOne(img, plan.printedArea, { maxSide: OCR_MAX_SIDE }),
            handwritten: cutOne(img, plan.handwrittenArea, { maxSide: OCR_MAX_SIDE }),
            // 附图按纸面用，不用太大；但小字图（比如一张表格）要留得住细节
            figure: cutOne(img, plan.photoCrop, { maxSide: 1400, quality: 0.9 }),
        };
    } finally {
        // 只解引用，不 revoke —— 这个 src 的所有权归调用方（它还要拿整图当附图）
    }
}

/**
 * 把 OCR 出来的一段文字变成**引文块**（书上的话）。
 *
 * 逐行加 `>`，空行留一个 `>`：不加的话，两段会被 md 并成一段，
 * 摘抄的段落感就没了。
 */
export function toQuoteBlock(text: string): string {
    return text
        .split('\n')
        .map((line) => (line.trim() ? `> ${line.trim()}` : '>'))
        .join('\n')
        .trim();
}
