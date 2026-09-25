'use client';

/**
 * 从**原图 + 框坐标**派生出纸面要用的图（P7「存坐标、不烧像素」的落地侧）。
 *
 * 派两种：
 *   ① **题图**（橙框 `figure` 圈出来的那块）—— 挂在 T1 反面题干**下方、靠左**
 *      （P5，2026-09-24 定：文字题干 + 题图 = 真题）；
 *   ② **净版**（原图 − 蓝框 − 橙框，涂白）—— 见下方"净版到底用在哪"。
 *
 * ── 净版到底用在哪（2026-09-26 核实设计后写清，免得后人以为漏接了）──────
 * T1 深挖纸的**反面并不印净版图**：P5 反面版面明写「文字题干（OCR）+ 题图」，
 * 且**"⛔ 不再放原图"**。所以别看到"净版没挂到 T1"就以为代码漏了 —— 那是设计如此。
 *
 * 净版真正的用处有两个，都不在 T1 纸面上：
 *   ① **OCR 的输入**（《看流程图…比对结论》§C）：先在整图上按坐标涂好白，
 *      再对净版做一次 OCR —— 手写不混进识别结果，比"先拼区域再识别"少一类 bug；
 *   ② 将来真需要"印一张没有手写的原图"的纸型（T0 等）时有现成的图可用。
 *
 * ⚠️ 为什么"要不要算"用 useMemo 在渲染期派生、effect 里只做异步：
 *    在 effect 体内同步 setState 会触发级联渲染（React 官方不建议），
 *    项目 lint 把它当 **error** 拦（见技能《陷阱 18》）。
 */

import { useEffect, useMemo, useState } from 'react';
import { ErrorItem } from '@/types/api';
import { parseCropRegions, planNetVersion, needsWipe, toPixelRects } from '@/lib/crop-regions';

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

/**
 * 按框坐标，从原图派生**净版**：把蓝框（她的手写）与橙框（题图）涂白。
 *
 * 兜底口径（与 `planNetVersion` 一致）：
 *   · 没有 `cropRegions`、或一个框都没画 → 返回 **null**，
 *     表示"这道题没有净版"，调用方走自己的兜底（T1 是"翻回正面看题"那行小字）；
 *   · 有框但**没有蓝框也没有橙框**（她压根没作答、也没题图）→ 也返回 null：
 *     原图本身就是净版，再生成一张一模一样的图纯属浪费内存与一次 canvas 绘制。
 *
 * ⚠️ 涂白**不看优先级**：设计里写"重叠处归高优先级"，但"涂白"这个动作上
 *    蓝和橙**都要涂**，所以直接取并集即天然满足 —— 规则塌缩成一个循环
 *    （见 `lib/crop-regions.ts` 文件头 ②）。
 */
export function useNetVersionImage(item: ErrorItem): string | null {
    const raw = item.cropRegions ?? null;
    const src = item.originalImageUrl;

    const prep = useMemo(() => {
        const regions = parseCropRegions(raw);
        if (!regions) return null;
        const plan = planNetVersion(regions);
        // 不值得生成：没有可涂的地方
        if (!needsWipe(plan)) return null;
        return { regions, fills: plan.fills, src };
    }, [raw, src]);

    const [drawn, setDrawn] = useState<{ key: object; url: string } | null>(null);

    useEffect(() => {
        if (!prep) return;
        let cancelled = false;
        const img = new Image();
        // 原图是 dataURL（库里存的就是 base64），同源，不必设 crossOrigin
        img.onload = () => {
            if (cancelled) return;
            const natW = img.naturalWidth;
            const natH = img.naturalHeight;
            if (!natW || !natH) return;

            const canvas = document.createElement('canvas');
            canvas.width = natW;
            canvas.height = natH;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            ctx.drawImage(img, 0, 0);

            // 框坐标是"基准图坐标系"的，按原图**自然像素**换算后填白
            const rects = toPixelRects(prep.fills, prep.regions.base, natW, natH);
            ctx.fillStyle = '#ffffff';
            for (const r of rects) {
                ctx.fillRect(
                    Math.max(0, Math.floor(r.x)),
                    Math.max(0, Math.floor(r.y)),
                    Math.ceil(r.w),
                    Math.ceil(r.h),
                );
            }

            if (!cancelled) setDrawn({ key: prep, url: canvas.toDataURL('image/jpeg', 0.92) });
        };
        img.src = prep.src;

        return () => {
            cancelled = true;
            img.onload = null;
        };
    }, [prep]);

    if (!prep) return null;
    return drawn && drawn.key === prep ? drawn.url : null;
}
