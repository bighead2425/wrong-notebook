'use client';

/**
 * 从**原图 + 框坐标**派生出纸面要用的图（P7「存坐标、不烧像素」的落地侧）。
 *
 * 目前只派一种：**题图**（橙框 `figure` 圈出来的那块，不可 OCR 的图），
 * 挂在反面题干**下方、靠左**（P5，2026-09-24 定：文字题干 + 题图 = 真题）。
 *
 * ⚠️ 为什么"要不要算"用 useMemo 在渲染期派生、effect 里只做异步：
 *    在 effect 体内同步 setState 会触发级联渲染（React 官方不建议），
 *    项目 lint 把它当 **error** 拦（见技能《陷阱 18》）。
 */

import { useEffect, useMemo, useState } from 'react';
import { ErrorItem } from '@/types/api';
import { parseCropRegions, planNetVersion, toPixelRects } from '@/lib/crop-regions';

type Prep = {
    regions: NonNullable<ReturnType<typeof parseCropRegions>>;
    /** 橙框矩形（**基准图坐标系**） */
    figures: { x: number; y: number; w: number; h: number }[];
    src: string;
};

/**
 * 按橙框坐标，从原图裁出题图。
 *
 * 没有 `cropRegions`、或里面没有橙框 ⇒ 返回空数组（反面就只有文字题干，
 * 这是"大多数题本来就没有题图"的常态，不是异常）。
 */
export function useFigureImages(item: ErrorItem): string[] {
    const raw = item.cropRegions ?? null;
    const src = item.originalImageUrl;

    const prep = useMemo<Prep | null>(() => {
        const regions = parseCropRegions(raw);
        if (!regions) return null;
        const plan = planNetVersion(regions);
        if (plan.figures.length === 0) return null;
        return { regions, figures: plan.figures, src };
    }, [raw, src]);

    const [drawn, setDrawn] = useState<{ prep: Prep; urls: string[] } | null>(null);

    useEffect(() => {
        if (!prep) return;
        let cancelled = false;
        const img = new Image();

        img.onload = () => {
            if (cancelled) return;
            const natW = img.naturalWidth;
            const natH = img.naturalHeight;
            if (!natW || !natH) return;

            // 按**自然像素**裁，不缩放 —— 题图本来就不大，缩了反而糊
            const rects = toPixelRects(prep.figures, prep.regions.base, natW, natH);
            const urls: string[] = [];
            for (const r of rects) {
                const x = Math.max(0, Math.floor(r.x));
                const y = Math.max(0, Math.floor(r.y));
                const w = Math.min(natW - x, Math.ceil(r.w));
                const h = Math.min(natH - y, Math.ceil(r.h));
                if (w <= 0 || h <= 0) continue;

                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) continue;
                ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
                urls.push(canvas.toDataURL('image/png'));
            }
            if (!cancelled) setDrawn({ prep, urls });
        };
        img.src = prep.src;

        return () => {
            cancelled = true;
            img.onload = null;
        };
    }, [prep]);

    if (!prep) return [];
    return drawn && drawn.prep === prep ? drawn.urls : [];
}
