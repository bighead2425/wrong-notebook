/**
 * 【2026-10-08】rank 5 兜底（四边直线拟合 + 交点）的纯逻辑测试。
 *
 * 背景：他建议"用白边的切线延长交于四个角来辅助找角，特别是找不到角的时候"。
 * 这里测的是这套推断里**能纯算的部分**（角度分组 / 挑最外两条边 / 直线求交 / 四边成角）；
 * 真正跑 OpenCV 的那一段（HoughLinesP）由 `doc-scan-detect-tiers.test.ts` 那套
 * "真实 OpenCV + 合成图"的脚手架覆盖。
 */
import { describe, it, expect } from 'vitest';
import {
    lineIntersect,
    pickOuterPair,
    quadFromEdges,
    segAngleDeg,
    splitSegsByOrientation,
    type HoughSeg,
} from '@/lib/doc-scan';

const seg = (x1: number, y1: number, x2: number, y2: number): HoughSeg => ({ x1, y1, x2, y2 });

describe('segAngleDeg —— 线段角度规范化到 -90..90', () => {
    it('水平线 → 0', () => {
        expect(segAngleDeg(seg(0, 0, 100, 0))).toBeCloseTo(0, 6);
    });

    it('竖直线 → ±90（两个方向都归一）', () => {
        expect(Math.abs(segAngleDeg(seg(0, 0, 0, 100)))).toBeCloseTo(90, 6);
        expect(Math.abs(segAngleDeg(seg(0, 100, 0, 0)))).toBeCloseTo(90, 6);
    });

    it('斜线：反向写的同一条线角度一致（不会一个 30 一个 -150）', () => {
        const a = segAngleDeg(seg(0, 0, 100, 58));
        const b = segAngleDeg(seg(100, 58, 0, 0));
        expect(a).toBeCloseTo(b, 6);
        expect(a).toBeCloseTo(30, 0);
    });

    it('接近竖直但偏一点：仍落在 -90..90 内', () => {
        const a = segAngleDeg(seg(0, 0, 5, 100));
        expect(a).toBeGreaterThan(80);
        expect(a).toBeLessThanOrEqual(90);
    });
});

describe('splitSegsByOrientation —— 以 45° 为界分两组', () => {
    it('水平 / 竖直各归各的', () => {
        const horiz = seg(0, 10, 100, 10);
        const vert = seg(10, 0, 10, 100);
        const { horiz: h, vert: v } = splitSegsByOrientation([horiz, vert]);
        expect(h).toEqual([horiz]);
        expect(v).toEqual([vert]);
    });

    it('45° 整（斜着）归到竖直组 —— 边界写法是"绝对值 < 45 才算水平"', () => {
        const diag = seg(0, 0, 100, 100);
        const { horiz, vert } = splitSegsByOrientation([diag]);
        expect(horiz).toHaveLength(0);
        expect(vert).toHaveLength(1);
    });

    it('空输入不炸', () => {
        expect(splitSegsByOrientation([])).toEqual({ horiz: [], vert: [] });
    });
});

describe('pickOuterPair —— 挑最靠外的两条边', () => {
    it('水平组：最上（y 最小）与最下（y 最大）', () => {
        const top = seg(0, 20, 100, 22);
        const mid = seg(0, 100, 100, 100);
        const bottom = seg(0, 180, 100, 178);
        const got = pickOuterPair([mid, bottom, top], true, 10);
        expect(got).toEqual([top, bottom]);
    });

    it('竖直组：最左（x 最小）与最右（x 最大）', () => {
        const left = seg(30, 0, 30, 100);
        const right = seg(300, 0, 300, 100);
        const got = pickOuterPair([right, left], false, 10);
        expect(got).toEqual([left, right]);
    });

    it('两条"边"离得太近 → null（这是防"同一条边被 Hough 拆成两段"的关键门槛）', () => {
        const a = seg(0, 100, 100, 100);
        const b = seg(0, 108, 100, 108); // 只差 8
        expect(pickOuterPair([a, b], true, 50)).toBeNull();
    });

    it('线段少于 2 条 → null', () => {
        expect(pickOuterPair([], true, 1)).toBeNull();
        expect(pickOuterPair([seg(0, 0, 10, 0)], true, 1)).toBeNull();
    });
});

describe('lineIntersect —— 按延长线求交点（推角的关键）', () => {
    it('两条垂直线 → 交点精确', () => {
        const h = seg(0, 50, 100, 50);
        const v = seg(30, 0, 30, 100);
        expect(lineIntersect(h, v)).toEqual({ x: 30, y: 50 });
    });

    it('交点**落在两条线段之外**也照样给出来（"延长线交于角"正是靠这个）', () => {
        const top = seg(100, 100, 200, 100); // 上边，只画了中间一段
        const left = seg(50, 150, 50, 250); // 左边，也只画了下面一段
        const p = lineIntersect(top, left);
        expect(p).not.toBeNull();
        expect(p!.x).toBeCloseTo(50, 6);
        expect(p!.y).toBeCloseTo(100, 6);
    });

    it('平行 → null', () => {
        expect(lineIntersect(seg(0, 0, 100, 0), seg(0, 40, 100, 40))).toBeNull();
    });

    it('几乎平行（约 3°以内）→ null（交点会飞到天边，不能要）', () => {
        const a = seg(0, 0, 1000, 0);
        const b = seg(0, 40, 1000, 40 + 1000 * Math.tan((2.5 * Math.PI) / 180));
        expect(lineIntersect(a, b)).toBeNull();
    });

    it('斜着的两条边也能交（透视纸）', () => {
        const top = seg(0, 0, 100, 20);
        const left = seg(0, 0, 20, 100);
        const p = lineIntersect(top, left);
        expect(p).not.toBeNull();
        expect(p!.x).toBeCloseTo(0, 6);
        expect(p!.y).toBeCloseTo(0, 6);
    });
});

describe('quadFromEdges —— 四条边 → 四个角', () => {
    it('正矩形：给回 左上/右上/右下/左下', () => {
        const top = seg(20, 20, 180, 20);
        const bottom = seg(20, 120, 180, 120);
        const left = seg(20, 20, 20, 120);
        const right = seg(180, 20, 180, 120);
        const q = quadFromEdges(top, bottom, left, right);
        expect(q).not.toBeNull();
        expect(q![0].x).toBeCloseTo(20, 6); // TL
        expect(q![0].y).toBeCloseTo(20, 6);
        expect(q![1].x).toBeCloseTo(180, 6); // TR
        expect(q![2].y).toBeCloseTo(120, 6); // BR
        expect(q![3].x).toBeCloseTo(20, 6); // BL
    });

    it('梯形的两条"上下边"不平行时，交点仍然成立（透视校正要的就是这个）', () => {
        const top = seg(30, 20, 170, 20);
        const bottom = seg(10, 140, 190, 140);
        const left = seg(20, 30, 5, 130); // 斜着
        const right = seg(180, 30, 195, 130);
        const q = quadFromEdges(top, bottom, left, right);
        expect(q).not.toBeNull();
        expect(q!.length).toBe(4);
        for (const p of q!) {
            expect(Number.isFinite(p.x)).toBe(true);
            expect(Number.isFinite(p.y)).toBe(true);
        }
    });

    it('有一对边平行 → null（算不出那个角）', () => {
        const top = seg(20, 20, 180, 20);
        const bottom = seg(20, 120, 180, 120);
        const left = seg(20, 20, 20, 120);
        const badRight = seg(180, 20, 280, 20); // 与上边平行，交不出点
        expect(quadFromEdges(top, bottom, left, badRight)).toBeNull();
    });
});
