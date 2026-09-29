import { describe, expect, it } from 'vitest';
import { SHEET_FULL_WIDTH_PX, SHEET_ZOOM_MIN, fitZoomFor } from '@/components/print/sheet-zoom';

/**
 * 纸面两档大小（2026-09-30 他提的：手机上纸太宽要左右拉）。
 *
 * 只有档位计算是纯函数，值得钉；双击切换与 zoom 生效属于浏览器行为，只能真机验。
 */
describe('纸面缩放 · fitZoomFor', () => {
    it('整纸宽按 182mm 换算成 px（CSS 规定 1in = 96px）', () => {
        expect(SHEET_FULL_WIDTH_PX).toBeCloseTo((182 * 96) / 25.4, 5); // ≈ 687.9px
    });

    it('★ 够宽就 1（不放大）：电脑上"适应宽度"就等于实际大小', () => {
        expect(fitZoomFor(SHEET_FULL_WIDTH_PX)).toBe(1);
        expect(fitZoomFor(SHEET_FULL_WIDTH_PX * 2)).toBe(1);
    });

    it('★ 手机那种窄屏：按宽度等比缩到看得全一行', () => {
        const phone = 390 - 32; // 一台常见手机的可用宽度（减掉左右内边距）
        const z = fitZoomFor(phone);
        expect(z).toBeLessThan(1);
        expect(z).toBeGreaterThan(SHEET_ZOOM_MIN);
        // 缩放后整纸宽必须真的塞得进可用宽度（这就是"不用左右拉"的判据）
        expect(SHEET_FULL_WIDTH_PX * z).toBeLessThanOrEqual(phone + 0.01);
    });

    it('极窄 / 拿不到宽度：不缩到看不清（下限保住），拿不到就退回 1', () => {
        expect(fitZoomFor(10)).toBe(SHEET_ZOOM_MIN);
        expect(fitZoomFor(0)).toBe(1);
        expect(fitZoomFor(Number.NaN)).toBe(1);
    });
});
