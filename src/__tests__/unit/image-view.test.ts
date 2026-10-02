// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来。
import { describe, expect, it } from 'vitest';
import {
    IMAGE_VIEW_MAX_ZOOM,
    IMAGE_VIEW_MIN_ZOOM,
    clampPan,
    clampZoom,
    computeFitZoom,
    panLimit,
    resolveView,
    zoomAtPoint,
    type ResolvedView,
} from '@/lib/image-view';

/**
 * 图片阅览的缩放/平移钳制（2026-10-03 抽自收件箱预览页，给日积月累页配图放大用）。
 *
 * 钉住三件容易"不报错、只是图跑丢"的事：
 *   ① 缩放的上下限（数值收敛，NaN 不能漏进 transform）；
 *   ② 「适应大小」算得对（整图真的塞得进视口）；
 *   ③ 平移边界 + 以光标为中心缩放（缩放焦点下的内容不跑）。
 */
describe('图片阅览 · 缩放', () => {
    it('★ 夹在 [min, max] 之间；越界收敛，不报错', () => {
        expect(clampZoom(1)).toBe(1);
        expect(clampZoom(0.0001)).toBe(IMAGE_VIEW_MIN_ZOOM);
        expect(clampZoom(999)).toBe(IMAGE_VIEW_MAX_ZOOM);
    });

    it('非有限数：NaN 退下限；±Infinity 按普通 clamp 收敛，绝不写进 transform', () => {
        expect(clampZoom(Number.NaN)).toBe(IMAGE_VIEW_MIN_ZOOM);
        expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(IMAGE_VIEW_MAX_ZOOM);
        expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(IMAGE_VIEW_MIN_ZOOM);
    });
});

describe('图片阅览 · 适应大小', () => {
    it('★ 大图按短边缩到视口内（四周各留 16px，取宽高两个比例里的小者）', () => {
        const z = computeFitZoom({ w: 400, h: 300 }, { w: 800, h: 600 });
        expect(z).toBeCloseTo(Math.min((400 - 32) / 800, (300 - 32) / 600), 5);
    });

    it('小图不让它被硬拉过头（fitMax 兜住）', () => {
        const z = computeFitZoom({ w: 400, h: 300 }, { w: 20, h: 20 });
        expect(z).toBe(2); // fitMax 默认 2
    });

    it('尺寸还没量出来（0）时返回 1，不产生荒谬比例', () => {
        expect(computeFitZoom({ w: 0, h: 0 }, { w: 100, h: 100 })).toBe(1);
        expect(computeFitZoom({ w: 400, h: 300 }, { w: 0, h: 0 })).toBe(1);
    });
});

describe('图片阅览 · 平移边界', () => {
    it('图比视口大：边界是 (图 - 视口) / 2', () => {
        expect(panLimit({ w: 400, h: 300 }, { w: 1000, h: 500 }, 1)).toEqual({ x: 300, y: 100 });
    });

    it('★ 图比视口小的一边不许拖动（否则能把图拖出屏幕找不回来）', () => {
        expect(panLimit({ w: 400, h: 300 }, { w: 200, h: 100 }, 1)).toEqual({ x: 0, y: 0 });
        // 想拖到很远，也被夹回 0
        expect(clampPan({ x: 999, y: -999 }, { w: 400, h: 300 }, { w: 200, h: 100 }, 1)).toEqual({
            x: 0,
            y: 0,
        });
    });

    it('非法 pan 值退回 0', () => {
        expect(clampPan({ x: Number.NaN, y: 5 }, { w: 400, h: 300 }, { w: 1000, h: 500 }, 1)).toEqual({
            x: 0,
            y: 5,
        });
    });
});

describe('图片阅览 · 以焦点缩放', () => {
    const vp = { w: 400, h: 300 };
    const img = { w: 200, h: 100 };

    it('★ 光标下的内容缩放后不动（滚轮焦点手感）', () => {
        const cur: ResolvedView = resolveView(vp, img, 1, { x: 0, y: 0 });
        expect(cur).toMatchObject({ zoom: 1, tx: 100, ty: 100 }); // 居中
        const next = zoomAtPoint(vp, img, cur, { x: 200, y: 150 }, 2); // 正中心放大
        expect(next.zoom).toBe(2);
        // 中心点 (200,150) 缩放前后都对应同一块内容
        const before = (200 - cur.tx) / cur.zoom;
        const after = next.tx + before * next.zoom;
        expect(after).toBeCloseTo(200, 5);
    });

    it('往外缩也不会缩到负比例（下限兜住）', () => {
        const cur = resolveView(vp, img, 1, { x: 0, y: 0 });
        expect(zoomAtPoint(vp, img, cur, { x: 10, y: 10 }, 0).zoom).toBe(IMAGE_VIEW_MIN_ZOOM);
    });
});
