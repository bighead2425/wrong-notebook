/**
 * 四角检测里"纯几何"部分的单元测试（custom-v21）。
 *
 * 为什么要单独测这些：它们不依赖 OpenCV / wasm，可以脱离浏览器直接跑，
 * 而恰恰是这一类代码最容易出**静默错误** —— custom-v20 就踩过一个：
 * sortCorners 用四个独立极值归位，同一个点被选中两次、另一个点被丢掉，
 * 拉正结果成了退化四边形，而界面上完全看不出来。
 *
 * 覆盖：sortCorners（含菱形回归）/ convexHull / repairToQuad（3、5、6 点补救）/ quadSanity。
 */
import { describe, it, expect } from 'vitest';
import {
    sortCorners,
    convexHull,
    repairToQuad,
    quadSanity,
    type Corner,
} from '@/lib/doc-scan';

/** 把 Corners 拍平成点数组，便于集合比较 */
const flat = (c: ReturnType<typeof sortCorners>): Corner[] =>
    c
        ? [
              c.topLeftCorner,
              c.topRightCorner,
              c.bottomRightCorner,
              c.bottomLeftCorner,
          ]
        : [];

/** 点集比较（忽略顺序） */
const sameSet = (a: Corner[], b: Corner[]) =>
    a.length === b.length &&
    a.every((p) => b.some((q) => q.x === p.x && q.y === p.y));

describe('sortCorners', () => {
    it('正放矩形应正确归位到 左上/右上/右下/左下', () => {
        const r = sortCorners([
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
        ]);
        expect(r).toEqual({
            topLeftCorner: { x: 0, y: 0 },
            topRightCorner: { x: 100, y: 0 },
            bottomRightCorner: { x: 100, y: 80 },
            bottomLeftCorner: { x: 0, y: 80 },
        });
    });

    it('输入顺序打乱后结果不变', () => {
        const orders: Corner[][] = [
            [{ x: 100, y: 80 }, { x: 0, y: 0 }, { x: 0, y: 80 }, { x: 100, y: 0 }],
            [{ x: 0, y: 80 }, { x: 100, y: 80 }, { x: 0, y: 0 }, { x: 100, y: 0 }],
        ];
        for (const o of orders) {
            const r = sortCorners(o);
            expect(r).toEqual({
                topLeftCorner: { x: 0, y: 0 },
                topRightCorner: { x: 100, y: 0 },
                bottomRightCorner: { x: 100, y: 80 },
                bottomLeftCorner: { x: 0, y: 80 },
            });
        }
    });

    it('【custom-v20 回归】菱形（正方形转 45°）不得出现"同点重复 / 顶点丢失"', () => {
        // 旧实现下 TL 与 BL 都会算成 (0,10)，而 (10,20) 被整个丢掉
        const diamond: Corner[] = [
            { x: 0, y: 10 },
            { x: 10, y: 0 },
            { x: 20, y: 10 },
            { x: 10, y: 20 },
        ];
        const out = flat(sortCorners(diamond));
        expect(out).toHaveLength(4);
        // 四个点必须互不相同
        const uniq = new Set(out.map((p) => `${p.x},${p.y}`));
        expect(uniq.size).toBe(4);
        // 且等于输入点集（一个都没丢、也没凭空造点）
        expect(sameSet(out, diamond)).toBe(true);
    });

    it('任意旋转角下都保持"四个互不相同的点"', () => {
        for (let deg = 0; deg < 180; deg += 15) {
            const rad = (deg * Math.PI) / 180;
            const raw: Corner[] = [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
                { x: 100, y: 80 },
                { x: 0, y: 80 },
            ].map((p) => ({
                x: Math.round((p.x * Math.cos(rad) - p.y * Math.sin(rad)) * 100) / 100 + 200,
                y: Math.round((p.x * Math.sin(rad) + p.y * Math.cos(rad)) * 100) / 100 + 200,
            }));
            const out = flat(sortCorners(raw));
            expect(out).toHaveLength(4);
            expect(new Set(out.map((p) => `${p.x},${p.y}`)).size).toBe(4);
            expect(sameSet(out, raw)).toBe(true);
        }
    });

    it('点数不为 4 时应返回 null', () => {
        expect(sortCorners([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }])).toBeNull();
    });
});

describe('convexHull', () => {
    it('凸四边形应原样返回 4 个点', () => {
        const h = convexHull([
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
        ]);
        expect(h).toHaveLength(4);
    });

    it('落在内部的点应被剔除', () => {
        const h = convexHull([
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
            { x: 50, y: 40 }, // 内点
        ]);
        expect(h).toHaveLength(4);
        expect(h.some((p) => p.x === 50 && p.y === 40)).toBe(false);
    });

    it('共线的中间点应被剔除（退化边）', () => {
        const h = convexHull([
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
        ]);
        expect(h).toHaveLength(4);
        expect(h.some((p) => p.x === 50 && p.y === 0)).toBe(false);
    });
});

describe('repairToQuad', () => {
    it('正好 4 点应原样（经凸包）返回', () => {
        const q = repairToQuad([
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
        ]);
        expect(q).toHaveLength(4);
    });

    it('三角形应补出第 4 点，且位置等于平行四边形补全的结果', () => {
        // 真值 (0,0)(10,0)(10,10)(0,10) 缺了左上角 → 剩 TR(10,0) BR(10,10) BL(0,10)
        // 最长边 TR–BL，对角顶点 BR → M = TR + BL − BR = (0,0)
        const q = repairToQuad([
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ]);
        expect(q).toHaveLength(4);
        expect(q).toContainEqual({ x: 0, y: 0 });
    });

    it('5 点应压成 4 点（丢掉贡献最小的那个）', () => {
        // 上边中点 (50,0) 是"最多余"的顶点
        const q = repairToQuad([
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
        ]);
        expect(q).toHaveLength(4);
        expect(q!.some((p) => p.x === 50 && p.y === 0)).toBe(false);
    });

    it('6 点应压成 4 点', () => {
        const q = repairToQuad([
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 40 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
        ]);
        expect(q).toHaveLength(4);
    });

    it('点太少（<3）应返回 null', () => {
        expect(repairToQuad([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBeNull();
    });
});

describe('quadSanity（合理性校验 —— 低置信档默认拉正前的闸门）', () => {
    const W = 800;
    const H = 600;

    it('正常的纸张四边形应通过', () => {
        expect(
            quadSanity(
                [
                    { x: 80, y: 60 },
                    { x: 720, y: 60 },
                    { x: 720, y: 540 },
                    { x: 80, y: 540 },
                ],
                W,
                H
            )
        ).toBe(true);
    });

    it('带透视的梯形纸张应通过', () => {
        expect(
            quadSanity(
                [
                    { x: 100, y: 80 },
                    { x: 700, y: 40 },
                    { x: 760, y: 560 },
                    { x: 60, y: 580 },
                ],
                W,
                H
            )
        ).toBe(true);
    });

    it('占满整张图（认的是画面边框而不是纸）应拒绝', () => {
        expect(
            quadSanity(
                [
                    { x: 0, y: 0 },
                    { x: W, y: 0 },
                    { x: W, y: H },
                    { x: 0, y: H },
                ],
                W,
                H
            )
        ).toBe(false);
    });

    it('太小的"四边形"（噪点凑的）应拒绝', () => {
        expect(
            quadSanity(
                [
                    { x: 0, y: 0 },
                    { x: 100, y: 0 },
                    { x: 100, y: 80 },
                    { x: 0, y: 80 },
                ],
                W,
                H
            )
        ).toBe(false);
    });

    it('退化成细条（某条边过短）应拒绝', () => {
        // 面积占比 0.51 够大，唯有最后一条边只有 20px（门槛 600×0.06=36）
        expect(
            quadSanity(
                [
                    { x: 0, y: 0 },
                    { x: 800, y: 0 },
                    { x: 800, y: 600 },
                    { x: 780, y: 600 },
                ],
                W,
                H
            )
        ).toBe(false);
    });

    it('内角过尖/过钝（30° / 150° 的斜菱形）应拒绝', () => {
        // 边长 300、内角 30°；面积占比 0.094、对边比 1，唯有角度出界
        const b = { x: 300 * Math.cos(Math.PI / 6), y: 300 * Math.sin(Math.PI / 6) };
        const p1 = { x: 50, y: 50 };
        const p2 = { x: 350, y: 50 };
        const p3 = { x: 350 + b.x, y: 50 + b.y };
        const p4 = { x: 50 + b.x, y: 50 + b.y };
        expect(quadSanity([p1, p2, p3, p4], W, H)).toBe(false);
        // 同一形状放到 45° 就应通过 —— 证明拒绝确实来自角度规则
        const b45 = { x: 300 * Math.cos(Math.PI / 4), y: 300 * Math.sin(Math.PI / 4) };
        expect(
            quadSanity(
                [
                    { x: 50, y: 50 },
                    { x: 350, y: 50 },
                    { x: 350 + b45.x, y: 50 + b45.y },
                    { x: 50 + b45.x, y: 50 + b45.y },
                ],
                W,
                H
            )
        ).toBe(true);
    });

    it('顶点跑到图外很远应拒绝', () => {
        expect(
            quadSanity(
                [
                    { x: -200, y: 100 },
                    { x: 700, y: 100 },
                    { x: 700, y: 500 },
                    { x: -200, y: 500 },
                ],
                W,
                H
            )
        ).toBe(false);
    });

    it('点数不为 4 应拒绝', () => {
        expect(quadSanity([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }], W, H)).toBe(false);
    });
});
