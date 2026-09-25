import { describe, expect, it } from 'vitest';
import {
    isPartitionKind,
    mergeConnectedRects,
    needsWipe,
    mapRect,
    parseCropRegions,
    planNetVersion,
    serializeCropRegions,
    toCropBoxKind,
    toLabelKind,
    unionRect,
    validateCropRegions,
    type CropBase,
    type CropRegions,
} from '@/lib/crop-regions';

const BASE: CropBase = { w: 1000, h: 800, rotation: 0 };

function regions(boxes: CropRegions['boxes'], base: CropBase = BASE): CropRegions {
    return { boxes, base };
}

describe('框坐标 · 解析与校验（P7 存坐标、不烧像素）', () => {
    it('合法输入应能原样往返', () => {
        const src = regions([
            { kind: 'scope', x: 10, y: 20, w: 300, h: 200 },
            { kind: 'handwriting', x: 40, y: 260, w: 120, h: 60 },
        ]);
        const parsed = parseCropRegions(serializeCropRegions(src));
        expect(parsed).toEqual(src);
    });

    it('形状不对一律返回 null，绝不半信半疑地拼一个框出来', () => {
        expect(parseCropRegions(null)).toBeNull();
        expect(parseCropRegions(undefined)).toBeNull();
        expect(parseCropRegions('')).toBeNull();
        expect(parseCropRegions('   ')).toBeNull();
        expect(parseCropRegions('{不是 json')).toBeNull();
        expect(parseCropRegions('[]')).toBeNull();
        // 缺 base ⇒ 没有基准尺寸，坐标无从换算 ⇒ 必须整体作废
        expect(parseCropRegions('{"boxes":[]}')).toBeNull();
        expect(parseCropRegions('{"boxes":[],"base":{"w":0,"h":800}}')).toBeNull();
        // 非法 kind
        expect(
            parseCropRegions('{"boxes":[{"kind":"purple","x":1,"y":1,"w":2,"h":2}],"base":{"w":9,"h":9}}'),
        ).toBeNull();
    });

    it('零面积框应被丢掉，而不是留着污染并集', () => {
        const parsed = parseCropRegions(
            '{"boxes":[{"kind":"question","x":1,"y":1,"w":0,"h":10},{"kind":"question","x":5,"y":5,"w":10,"h":10}],"base":{"w":50,"h":50}}',
        );
        expect(parsed?.boxes).toHaveLength(1);
        expect(parsed?.boxes[0]).toEqual({ kind: 'question', x: 5, y: 5, w: 10, h: 10 });
    });

    it('旋转值应收敛到 0/90/180/270', () => {
        const parsed = parseCropRegions(
            '{"boxes":[],"base":{"w":10,"h":10,"rotation":-90}}',
        );
        expect(parsed?.base.rotation).toBe(270);
    });

    it('框超出基准图范围要报出来（坐标与基准图对不上的信号）', () => {
        const errs = validateCropRegions(
            regions([{ kind: 'question', x: 900, y: 100, w: 300, h: 200 }]),
        );
        expect(errs.some((e) => e.includes('超出'))).toBe(true);
    });

    it('没有红框应给出提示（题干范围只能退回整图）', () => {
        const errs = validateCropRegions(
            regions([{ kind: 'handwriting', x: 10, y: 10, w: 20, h: 20 }]),
        );
        expect(errs.some((e) => e.includes('红框'))).toBe(true);
    });

    it('完全合法时不应报任何问题', () => {
        expect(
            validateCropRegions(
                regions([
                    { kind: 'scope', x: 0, y: 0, w: 500, h: 700 },
                    { kind: 'question', x: 10, y: 10, w: 480, h: 300 },
                    { kind: 'handwriting', x: 20, y: 320, w: 200, h: 80 },
                ]),
            ),
        ).toEqual([]);
    });
});

describe('框坐标 · 几何', () => {
    it('并集包围盒应取外沿；空数组返回 null', () => {
        expect(unionRect([])).toBeNull();
        expect(
            unionRect([
                { x: 10, y: 20, w: 30, h: 40 }, // y: 20 → 60
                { x: 100, y: 5, w: 10, h: 10 }, // y:  5 → 15
            ]),
        ).toEqual({ x: 10, y: 5, w: 100, h: 55 }); // y 取 5→60 ⇒ 高 55
    });

    it('链式相邻必须并成一个 —— A∩B、B∩C 但 A∩C=∅ 时，三段是同一道题', () => {
        const merged = mergeConnectedRects([
            { x: 0, y: 0, w: 20, h: 20 }, // A
            { x: 15, y: 0, w: 20, h: 20 }, // B（与 A 相交）
            { x: 30, y: 0, w: 20, h: 20 }, // C（与 B 相交、与 A 不相交）
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toEqual({ x: 0, y: 0, w: 50, h: 20 });
    });

    it('真正分开的两块不能被并到一起', () => {
        const merged = mergeConnectedRects([
            { x: 0, y: 0, w: 10, h: 10 },
            { x: 500, y: 500, w: 10, h: 10 },
        ]);
        expect(merged).toHaveLength(2);
    });

    it('mapRect：180° 必须等同于中心对称（交叉验证）', () => {
        const base: CropBase = { w: 100, h: 50, rotation: 0 };
        const target: CropBase = { w: 100, h: 50, rotation: 180 };
        const out = mapRect({ x: 10, y: 5, w: 20, h: 10 }, base, target);
        // 中心对称：(x, y) → (W − x − w, H − y − h)
        expect(out).toEqual({ x: 70, y: 35, w: 20, h: 10 });
    });

    it('mapRect：转 90° 后，框必须仍落在新画布之内（不画出去被裁掉）', () => {
        const base: CropBase = { w: 1000, h: 800, rotation: 0 };
        const target: CropBase = { w: 800, h: 1000, rotation: 90 };
        const out = mapRect({ x: 100, y: 50, w: 200, h: 150 }, base, target);
        expect(out.x).toBeGreaterThanOrEqual(0);
        expect(out.y).toBeGreaterThanOrEqual(0);
        expect(out.x + out.w).toBeLessThanOrEqual(target.w + 0.001);
        expect(out.y + out.h).toBeLessThanOrEqual(target.h + 0.001);
    });

    it('mapRect：等比缩放应只改尺寸、不改相对位置', () => {
        const base: CropBase = { w: 1000, h: 800, rotation: 0 };
        const target: CropBase = { w: 500, h: 400, rotation: 0 };
        expect(mapRect({ x: 100, y: 80, w: 200, h: 160 }, base, target)).toEqual({
            x: 50,
            y: 40,
            w: 100,
            h: 80,
        });
    });

    it('mapRect：同一坐标系进出应是恒等变换', () => {
        const r = { x: 13, y: 27, w: 41, h: 9 };
        expect(mapRect(r, BASE, BASE)).toEqual(r);
    });
});

describe('净版计划 · 按框涂白（M2 主路，确定性操作）', () => {
    it('一个框都没有 ⇒ 走兜底，不涂白（特殊情况 1）', () => {
        const plan = planNetVersion(null);
        expect(plan.fallback).toBe('no-boxes');
        expect(plan.fills).toEqual([]);
        expect(plan.questionArea).toBeNull();
        expect(needsWipe(plan)).toBe(false);
    });

    it('题干范围：红框优先，无红框退回绿框，都没有则整图', () => {
        const withRed = planNetVersion(
            regions([
                { kind: 'scope', x: 0, y: 0, w: 900, h: 700 },
                { kind: 'question', x: 50, y: 50, w: 400, h: 200 },
            ]),
        );
        expect(withRed.questionArea).toEqual({ x: 50, y: 50, w: 400, h: 200 });

        const noRed = planNetVersion(
            regions([{ kind: 'scope', x: 0, y: 0, w: 900, h: 700 }]),
        );
        expect(noRed.questionArea).toEqual({ x: 0, y: 0, w: 900, h: 700 });
    });

    it('涂白 = 蓝 ∪ 橙 —— 两者都要涂，所以优先级天然满足，不需要矩形切分', () => {
        const plan = planNetVersion(
            regions([
                { kind: 'question', x: 0, y: 0, w: 600, h: 400 },
                { kind: 'handwriting', x: 50, y: 300, w: 100, h: 60 }, // 蓝
                { kind: 'figure', x: 350, y: 100, w: 150, h: 120 }, // 橙（与蓝不相邻）
            ]),
        );
        expect(plan.fills).toHaveLength(2);
        expect(needsWipe(plan)).toBe(true);
    });

    it('蓝橙重叠处只涂一次（并集已合并），且结果必须覆盖两者的外沿', () => {
        const plan = planNetVersion(
            regions([
                { kind: 'handwriting', x: 50, y: 50, w: 80, h: 80 },
                { kind: 'figure', x: 100, y: 100, w: 80, h: 80 },
            ]),
        );
        expect(plan.fills).toHaveLength(1);
        expect(plan.fills[0]).toEqual({ x: 50, y: 50, w: 130, h: 130 });
    });

    it('题图（橙框）要逐个保留，用于裁出来放题干右下角', () => {
        const plan = planNetVersion(
            regions([
                { kind: 'question', x: 0, y: 0, w: 600, h: 400 },
                { kind: 'figure', x: 350, y: 100, w: 150, h: 120 },
            ]),
        );
        expect(plan.figures).toEqual([{ x: 350, y: 100, w: 150, h: 120 }]);
    });

    it('没有蓝框时不应涂白（她压根没作答，原图本身就是净版）', () => {
        const plan = planNetVersion(
            regions([{ kind: 'question', x: 0, y: 0, w: 600, h: 400 }]),
        );
        expect(plan.fills).toEqual([]);
        expect(needsWipe(plan)).toBe(false);
        expect(plan.counts.handwriting).toBe(0);
    });

    it('四类框计数应如实反映，供上层判断走主路还是兜底', () => {
        const plan = planNetVersion(
            regions([
                { kind: 'scope', x: 0, y: 0, w: 500, h: 500 },
                { kind: 'question', x: 10, y: 10, w: 400, h: 300 },
                { kind: 'handwriting', x: 20, y: 320, w: 100, h: 50 },
                { kind: 'handwriting', x: 130, y: 320, w: 100, h: 50 },
                { kind: 'figure', x: 300, y: 20, w: 80, h: 60 },
            ]),
        );
        expect(plan.counts).toEqual({ scope: 1, question: 1, handwriting: 2, figure: 1 });
    });
});

/**
 * 两套命名的互转（M1 / 2026-09-26）。
 *
 * 组件 UI 用 question/answer/region/figure，本模块与数据库用 question/handwriting/scope/figure。
 * 这是"同一件事、两套名字"的典型场景 ⇒ 必须钉住，否则会出现
 * 「存进去的是 answer、读出来按 handwriting 找 ⇒ 找不到 ⇒ 静默当没有框」。
 */
describe('crop-regions · 框类型命名互转', () => {
    it('UI 名 → 规范名：answer 要变成 handwriting、region 要变成 scope', () => {
        expect(toCropBoxKind('question')).toBe('question');
        expect(toCropBoxKind('answer')).toBe('handwriting');
        expect(toCropBoxKind('region')).toBe('scope');
        expect(toCropBoxKind('figure')).toBe('figure');
    });

    it('规范名 → UI 名：往返必须回到原点（四种都要过）', () => {
        const all = ['question', 'handwriting', 'scope', 'figure'] as const;
        for (const kind of all) {
            expect(toCropBoxKind(toLabelKind(kind))).toBe(kind);
        }
    });

    it('认不出的类型返回 null，绝不猜一个最近的', () => {
        expect(toCropBoxKind('answer2')).toBeNull();
        expect(toCropBoxKind('')).toBeNull();
        expect(toCropBoxKind('QUESTION')).toBeNull(); // 大小写敏感，不做宽容匹配
    });

    it('分区层 = 绿(scope) + 橙(figure)；红蓝不是', () => {
        expect(isPartitionKind('scope')).toBe(true);
        expect(isPartitionKind('figure')).toBe(true);
        expect(isPartitionKind('question')).toBe(false);
        expect(isPartitionKind('handwriting')).toBe(false);
    });
});
