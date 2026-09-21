/**
 * 【custom-v36】编辑画布尺寸上限的单元测试。
 *
 * 钉的都是"一句话说得清"的判据：
 *   · 小图原样过（只缩小、不放大 —— 放大会白丢画质）；
 *   · 长边超限按比例收，两条边同乘一个系数（比例不变，转 90° 后长宽仍对得上）；
 *   · 结果至少 1px（0 尺寸画布会直接抛错）。
 * 裁剪窗所有坐标系都建立在"加载时的画布尺寸"上，这里钉错了，
 * 擦除/框选/裁剪会整体错位 —— 所以宁可多钉几条等式。
 */
import { describe, it, expect } from 'vitest';
import { fitEditSize, MAX_EDIT_EDGE } from '@/lib/edit-canvas-size';

describe('edit-canvas-size：小图不放大', () => {
    it('长边未超限的图原样返回，scaled=false', () => {
        expect(fitEditSize(1920, 1440)).toEqual({ w: 1920, h: 1440, scaled: false });
        expect(fitEditSize(800, 2000)).toEqual({ w: 800, h: 2000, scaled: false });
        expect(fitEditSize(MAX_EDIT_EDGE, MAX_EDIT_EDGE)).toEqual({
            w: MAX_EDIT_EDGE, h: MAX_EDIT_EDGE, scaled: false,
        });
    });

    it('恰好等于上限也不缩', () => {
        expect(fitEditSize(3200, 100)).toEqual({ w: 3200, h: 100, scaled: false });
    });
});

describe('edit-canvas-size：超限等比收缩', () => {
    it('12MP 手机照片：4000×3000 → 3200×2400', () => {
        expect(fitEditSize(4000, 3000)).toEqual({ w: 3200, h: 2400, scaled: true });
    });

    it('竖图同样按长边收：3000×4000 → 2400×3200', () => {
        expect(fitEditSize(3000, 4000)).toEqual({ w: 2400, h: 3200, scaled: true });
    });

    it('比例严格保持：收缩前后 w/h 相等（交叉验证）', () => {
        for (const [w, h] of [[4032, 3024], [8160, 6144], [2304, 4096]] as const) {
            const out = fitEditSize(w, h);
            expect(out.scaled).toBe(true);
            // 各自四舍五入过，允许 ±1px 的尾差
            expect(Math.abs(out.w / out.h - w / h)).toBeLessThan(0.01);
        }
    });

    it('收缩后长边恰好等于上限', () => {
        expect(fitEditSize(8160, 6144).w).toBe(MAX_EDIT_EDGE);
        expect(fitEditSize(6144, 8160).h).toBe(MAX_EDIT_EDGE);
    });
});

describe('edit-canvas-size：边界与脏数据', () => {
    it('结果至少 1px，不产生 0 尺寸', () => {
        expect(fitEditSize(999999, 2)).toEqual({ w: MAX_EDIT_EDGE, h: 1, scaled: true });
    });

    it('非法输入收敛成 1px，不让 NaN 进画布', () => {
        expect(fitEditSize(NaN, 100)).toEqual({ w: 1, h: 100, scaled: false });
        expect(fitEditSize(100, Infinity)).toEqual({ w: 100, h: 1, scaled: false });
    });

    it('上限本身非法时按 1 处理', () => {
        expect(fitEditSize(10, 10, 0)).toEqual({ w: 1, h: 1, scaled: true });
        expect(fitEditSize(10, 10, NaN)).toEqual({ w: 1, h: 1, scaled: true });
    });
});
