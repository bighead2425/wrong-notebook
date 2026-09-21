/**
 * 【custom-v33】逆时针 90° 旋转换算的单元测试。
 *
 * 这套换算有两个真实用户：收件箱预览页（决定图怎么显示）和裁剪窗口的「🔄转」
 * （要把画布、擦除痕迹、各种框一起搬到新坐标系）。算错一格，用户看到的就是
 * "框线全部错位"——而且错得不明显，容易当成"数据坏了"。
 *
 * 所以这里不看"像不像"，只钉**可验证的等式**：
 *   · 四角映射（逆时针到底往哪转）；
 *   · 180° 必须等于中心对称、270° 必须等于顺时针 90°（换个角度算，两边对得上才算对）。
 */
import { describe, it, expect } from 'vitest';
import {
    normalizeRotation,
    rotateCCW,
    rotatedSize,
    rotatePointCCW,
    rotateRect,
    rotateRectCCW,
} from '@/lib/image-rotation';

describe('image-rotation：角度归一化', () => {
    it('只认 0/90/180/270，别的数取最近一档并对 360 取模', () => {
        expect(normalizeRotation(0)).toBe(0);
        expect(normalizeRotation(90)).toBe(90);
        expect(normalizeRotation(270)).toBe(270);
        expect(normalizeRotation(360)).toBe(0);
        expect(normalizeRotation(-90)).toBe(270);
        expect(normalizeRotation(450)).toBe(90);
        expect(normalizeRotation(89)).toBe(90);   // 四舍五入到最近档
        expect(normalizeRotation(44)).toBe(0);
    });

    it('脏数据一律当中立值 0，不让 NaN 扩散到坐标里', () => {
        expect(normalizeRotation(undefined)).toBe(0);
        expect(normalizeRotation(null)).toBe(0);
        expect(normalizeRotation(NaN)).toBe(0);
        expect(normalizeRotation(Infinity)).toBe(0);
        expect(normalizeRotation('90')).toBe(0); // 字符串不认 —— 台账里存成字符串是个 bug，不该被悄悄接受
    });

    it('逆时针转一次 = 减 90°，转四次回到原点', () => {
        expect(rotateCCW(0)).toBe(270);
        expect(rotateCCW(270)).toBe(180);
        expect(rotateCCW(180)).toBe(90);
        expect(rotateCCW(90)).toBe(0);
        expect(rotateCCW(rotateCCW(rotateCCW(rotateCCW(0))))).toBe(0);
    });
});

describe('image-rotation：尺寸与坐标', () => {
    it('90°/270° 长宽对调，0°/180° 不变', () => {
        expect(rotatedSize(1200, 800, 0)).toEqual({ w: 1200, h: 800 });
        expect(rotatedSize(1200, 800, 90)).toEqual({ w: 800, h: 1200 });
        expect(rotatedSize(1200, 800, 180)).toEqual({ w: 1200, h: 800 });
        expect(rotatedSize(1200, 800, 270)).toEqual({ w: 800, h: 1200 });
    });

    /**
     * 这条是整套换算的"地基"：只要四角映射对了，方向就不会反。
     * 逆时针 90° = 右边转到上边、上边转到左边，于是：
     *   右上角 → 左上角，左上角 → 左下角，右下角 → 右上角。
     */
    it('逆时针 90° 的四角映射（方向反了这条会立刻挂）', () => {
        const W = 1200;
        expect(rotatePointCCW({ x: W, y: 0 }, W)).toEqual({ x: 0, y: 0 });        // 右上 → 左上
        expect(rotatePointCCW({ x: 0, y: 0 }, W)).toEqual({ x: 0, y: W });        // 左上 → 左下
        expect(rotatePointCCW({ x: W, y: 800 }, W)).toEqual({ x: 800, y: 0 });    // 右下 → 右上
    });

    it('矩形转完还是矩形：位置、长宽都对调', () => {
        // 原图右上角一条 100×40 的横条 → 转过之后应贴在左上角，变竖条
        expect(rotateRectCCW({ x: 1100, y: 0, w: 100, h: 40 }, 1200))
            .toEqual({ x: 0, y: 0, w: 40, h: 100 });
    });

    it('原始宽高不同也不会把框转歪（宽 1200 高 800 的画幅）', () => {
        // 左下角一块 200×150
        expect(rotateRectCCW({ x: 0, y: 650, w: 200, h: 150 }, 1200))
            .toEqual({ x: 650, y: 1000, w: 150, h: 200 });
    });
});

describe('image-rotation：多次旋转', () => {
    const src = { x: 100, y: 50, w: 300, h: 200 };
    const W = 1200;
    const H = 800;

    /**
     * 用"另一个角度算一遍"来验证逐步变换 —— 如果 180° 不等于中心对称，
     * 说明中途某一步参照系的宽高搞混了（这是最容易错、又最难看出来的地方）。
     */
    it('转 180° 必须等于中心对称', () => {
        expect(rotateRect(src, W, H, 180)).toEqual({
            x: W - src.x - src.w,
            y: H - src.y - src.h,
            w: src.w,
            h: src.h,
        });
    });

    it('转 270° 必须等于顺时针 90°', () => {
        // 顺时针 90°：(x,y) → (H−y, x)，矩形随之 { x: H−y−h, y: x, w: h, h: w }
        expect(rotateRect(src, W, H, 270)).toEqual({
            x: H - src.y - src.h,
            y: src.x,
            w: src.h,
            h: src.w,
        });
    });

    it('连续转四次回到原位（逐步变换不漂）', () => {
        let r = { ...src };
        let w = W;
        let h = H;
        for (let i = 0; i < 4; i++) {
            r = rotateRect(r, w, h, 90);
            const size = rotatedSize(w, h, 90);
            w = size.w;
            h = size.h;
        }
        expect(r).toEqual(src);
    });

    it('0° 原样返回，不做任何多余换算', () => {
        expect(rotateRect(src, W, H, 0)).toEqual(src);
    });
});
