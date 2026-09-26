import { describe, expect, it } from 'vitest';
import {
    clipCropBoxes,
    figuresForSplit,
    isScopeKind,
    mergeConnectedRects,
    needsWipe,
    mapRect,
    parseCropRegions,
    planNetVersion,
    rebaseCropRegions,
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

    /**
     * ⚠️ 2026-09-26 修：**橙框不是作用域层**。
     *
     * 这组断言原来是 `isPartitionKind('figure') === true` —— 那条断言把 bug
     * 焊成了"正确行为"，改实现时它不会报警，反而会拦着人修。
     * 设计（《看流程图的思考与补充_比对结论》§B）写的是两层：
     *   作用域 = 绿框；语义 = 蓝 > 橙 > 红。
     * 橙框要回答"这段像素是什么"，属语义层。
     *
     * 线上症状（SX20260926002）：橙框被当作用域层 ⇒ 红蓝重叠分图时坐标被连坐丢弃
     * ⇒ 打印端裁不出题图。
     */
    it('作用域层只有绿(scope)；橙(figure)属语义层，不在其中', () => {
        expect(isScopeKind('scope')).toBe(true);
        expect(isScopeKind('figure')).toBe(false); // ← 曾经的 bug 点
        expect(isScopeKind('question')).toBe(false);
        expect(isScopeKind('handwriting')).toBe(false);
    });
});

/**
 * 坐标系换算（M1 / 2026-09-26 二修）。
 *
 * 这一组钉的是"录的时候量的是工作画布、存下来的是裁过的那张图"这个错位。
 * 焊不住的话症状是**不报错、只裁歪**：纸上净版该白的地方没白、题图位置不对，
 * 而代码、类型、控制台全都没有任何异常 —— 属于最难靠肉眼发现的一类。
 */
describe('crop-regions · 坐标系换算（裁剪后重定基准）', () => {
    it('平移：减去裁剪原点，框应整体挪到新图坐标系', () => {
        const out = rebaseCropRegions(
            regions([{ kind: 'figure', x: 120, y: 220, w: 80, h: 60 }]),
            { offsetX: 100, offsetY: 200, baseW: 400, baseH: 300 },
        );
        expect(out.boxes).toEqual([{ kind: 'figure', x: 20, y: 20, w: 80, h: 60 }]);
        expect(out.base).toEqual({ w: 400, h: 300, rotation: 0 });
    });

    it('平移 + 缩放：压缩过的图要按比例缩，否则框会比图大', () => {
        const out = rebaseCropRegions(
            regions([{ kind: 'question', x: 200, y: 400, w: 200, h: 100 }]),
            { offsetX: 100, offsetY: 200, scaleX: 0.5, scaleY: 0.5, baseW: 500, baseH: 400 },
        );
        expect(out.boxes).toEqual([{ kind: 'question', x: 50, y: 100, w: 100, h: 50 }]);
    });

    it('原点在左上（offset 0）时换算应是恒等 —— 防"手滑多减一次"', () => {
        const src = regions([{ kind: 'scope', x: 10, y: 20, w: 30, h: 40 }]);
        const out = rebaseCropRegions(src, { offsetX: 0, offsetY: 0, baseW: 1000, baseH: 800 });
        expect(out.boxes).toEqual(src.boxes);
        expect(out.base).toEqual(src.base);
    });

    it('旋转值必须原样带过去（旋转是烘进像素的，换算不该动它）', () => {
        const out = rebaseCropRegions(
            regions([{ kind: 'figure', x: 0, y: 0, w: 10, h: 10 }], { w: 900, h: 700, rotation: 90 }),
            { offsetX: 5, offsetY: 5, baseW: 300, baseH: 200 },
        );
        expect(out.base.rotation).toBe(90);
    });

    it('换算后落回 base 之内 —— 这正是不换算出错时的典型表现（框飞出图外）', () => {
        // 原图 1000×800，裁剪区从 (400,300) 起 600×500
        const out = rebaseCropRegions(
            regions([
                { kind: 'question', x: 400, y: 300, w: 600, h: 500 },
                { kind: 'figure', x: 800, y: 500, w: 150, h: 200 },
            ]),
            { offsetX: 400, offsetY: 300, baseW: 600, baseH: 500 },
        );
        // 不换算的话这两框是 (400,300)/(800,500)，会整块飞出 600×500 的画布
        expect(validateCropRegions(out).filter((e) => e.includes('超出'))).toEqual([]);
    });
});

/** 裁剪路的"哪些框算这道题的"判定 */
describe('crop-regions · 只留与裁剪区有交集的框', () => {
    it('有交集就留（含只搭一点边），完全在外面的丢掉', () => {
        const src = regions([
            { kind: 'question', x: 0, y: 0, w: 50, h: 50 },      // 完全在内
            { kind: 'figure', x: 90, y: 40, w: 40, h: 40 },      // 只搭一点边 → 留
            { kind: 'handwriting', x: 500, y: 500, w: 10, h: 10 }, // 完全在外 → 丢
        ]);
        const kept = clipCropBoxes(src, { x: 0, y: 0, w: 100, h: 100 });
        expect(kept.map((b) => b.kind)).toEqual(['question', 'figure']);
    });

    it('一个都不沾时应返回空数组（调用方据此存 null，走兜底）', () => {
        const kept = clipCropBoxes(
            regions([{ kind: 'question', x: 900, y: 900, w: 10, h: 10 }]),
            { x: 0, y: 0, w: 100, h: 100 },
        );
        expect(kept).toEqual([]);
    });
});

/**
 * 净版生成的前提判定（M1 / 2026-09-26）。
 *
 * `useNetVersionImage` 只在 `needsWipe` 为真时才动手画 canvas。
 * 这里把"什么情况下该画、什么情况下不该画"钉住 —— 判错的代价是
 * 要么白画一张（内存，手机浏览器上不便宜），要么把"原图本身就是净版"
 * 当成"无法生成净版"，让调用方错误地走了"翻回正面看题"的兜底。
 */
describe('crop-regions · 净版该不该生成', () => {
    it('有蓝框 → 该涂白（这就是净版的主路）', () => {
        const plan = planNetVersion(
            regions([
                { kind: 'question', x: 0, y: 0, w: 400, h: 300 },
                { kind: 'handwriting', x: 50, y: 200, w: 120, h: 60 },
            ]),
        );
        expect(needsWipe(plan)).toBe(true);
        expect(plan.fills).toHaveLength(1);
    });

    it('只有橙框（没作答、但有题图）→ 也要涂白（题图得从中裁出来，位置要留白）', () => {
        const plan = planNetVersion(
            regions([
                { kind: 'question', x: 0, y: 0, w: 400, h: 300 },
                { kind: 'figure', x: 250, y: 30, w: 100, h: 80 },
            ]),
        );
        expect(needsWipe(plan)).toBe(true);
        expect(plan.figures).toHaveLength(1);
    });

    it('只有红框（她压根没作答、也没题图）→ 不生成：原图本身就是净版', () => {
        const plan = planNetVersion(
            regions([{ kind: 'question', x: 0, y: 0, w: 400, h: 300 }]),
        );
        expect(needsWipe(plan)).toBe(false);
    });

    it('蓝框连成一片时应并成一个填白区，不逐个填（少几次 canvas 绘制）', () => {
        // 两个相交的蓝框 = 一段手写的两笔
        const plan = planNetVersion(
            regions([
                { kind: 'question', x: 0, y: 0, w: 400, h: 300 },
                { kind: 'handwriting', x: 50, y: 200, w: 100, h: 60 },
                { kind: 'handwriting', x: 120, y: 210, w: 100, h: 60 },
            ]),
        );
        expect(plan.fills).toHaveLength(1);
        // 并出来的包围盒应覆盖两块
        expect(plan.fills[0].x).toBe(50);
        expect(plan.fills[0].x + plan.fills[0].w).toBe(220);
    });

    it('完全分开的两处手写应各留一块（不能并成一个大白块，那会擦掉题目）', () => {
        const plan = planNetVersion(
            regions([
                { kind: 'question', x: 0, y: 0, w: 400, h: 300 },
                { kind: 'handwriting', x: 10, y: 10, w: 50, h: 30 },
                { kind: 'handwriting', x: 300, y: 250, w: 50, h: 30 },
            ]),
        );
        expect(plan.fills).toHaveLength(2);
    });
});

/**
 * 回归：橙框失效（线上 bug SX20260926002 / 2026-09-26）。
 *
 * 用户在一幅图上画了红（题干）+ 蓝（手写）+ 橙（题图）三种框，
 * 打印出来**反面没有题图**。排查结论：
 *   `image-cropper.tsx` 原先把 `figure` 和 `scope` 一起当作"作用域层"排除
 *   ⇒ ① 导出区包围盒不含橙框；② 红蓝重叠分图那一支 `onCropRegions(null)`
 *     把橙框坐标连坐丢弃 ⇒ 读取端 `figures` 为空。
 *
 * 下面用**用户截图里的真实坐标**钉住"橙框必须在语义层、必须能算出 figures"。
 * 坐标来源：截图 2519×475，红 (31,35)-(2513,412) 蓝 (118,127)-(1388,270)
 *           橙 (1043,242)-(1493,405)。
 */
describe('crop-regions · 回归：红蓝重叠时橙框不能被连坐（SX20260926002）', () => {
    /** 用户那张图的三个框（相对图左上角） */
    const userShot = () =>
        regions([
            { kind: 'question', x: 31, y: 35, w: 2482, h: 377 },
            { kind: 'handwriting', x: 118, y: 127, w: 1270, h: 143 },
            { kind: 'figure', x: 1043, y: 242, w: 450, h: 163 },
        ]);

    it('橙框不在作用域层 —— 这是 bug 的根，钉死它', () => {
        expect(isScopeKind('figure')).toBe(false);
    });

    it('红蓝重叠 + 有橙框 ⇒ figures 必须非空（否则题图裁不出来）', () => {
        const plan = planNetVersion(userShot());
        expect(plan.figures).toHaveLength(1);
        expect(plan.figures[0]).toEqual({ x: 1043, y: 242, w: 450, h: 163 });
    });

    it('橙框要参与填白（题图不该留在净版上）', () => {
        const plan = planNetVersion(userShot());
        expect(needsWipe(plan)).toBe(true);
    });

    it('分图后题干区平移：橙框减掉 (tx,ty) 仍在题干区之内', () => {
        // buildSplitCanvas 的题干区 = 红∪蓝包围盒 + 1% padding，向下取整
        const q = { x: 31, y: 35, w: 2482, h: 377 };
        const a = { x: 118, y: 127, w: 1270, h: 143 };
        const x0 = Math.min(q.x, a.x), y0 = Math.min(q.y, a.y);
        const x1 = Math.max(q.x + q.w, a.x + a.w), y1 = Math.max(q.y + q.h, a.y + a.h);
        const pad = Math.max(4, (y1 - y0) * 0.01);
        const tx = Math.max(0, Math.floor(x0 - pad));
        const ty = Math.max(0, Math.floor(y0 - pad));

        const f = { x: 1043, y: 242, w: 450, h: 163 };
        const nx = f.x - tx, ny = f.y - ty;
        // 平移后仍为正、且右/下边界不超出题干区
        expect(nx).toBeGreaterThanOrEqual(0);
        expect(ny).toBeGreaterThanOrEqual(0);
        expect(nx + f.w).toBeLessThanOrEqual(x1 - tx);
        expect(ny + f.h).toBeLessThanOrEqual(y1 - ty);
    });

    it('橙框若被裁到题干区之外 ⇒ clipCropBoxes 保留"有交集"的那部分语义', () => {
        // 判据是"有交集"不是"被包含"：压在边界上的框仍算属于这一道
        const r = regions([{ kind: 'figure', x: 100, y: 100, w: 200, h: 100 }]);
        const kept = clipCropBoxes(r, { x: 0, y: 0, w: 150, h: 150 });
        expect(kept).toHaveLength(1);
        // 完全在外的框不该被带进来
        const outside = clipCropBoxes(r, { x: 0, y: 0, w: 50, h: 50 });
        expect(outside).toHaveLength(0);
    });
});

/**
 * 回归：分图产物上的橙框坐标（2026-09-26 三修）。
 *
 * 背景：`figuresForSplit` 是"绿框路径"和"整页分图路径"**共用**的换算。
 * 抽成纯函数的原因就是这条换算线上已经连踩两次（坐标系错位、橙框连坐），
 * 规矩是"只允许一处实现"。
 *
 * 分图产物布局：题干区 stem（原样贴在 0,0）+ gap + 答案堆叠。
 *   ⇒ stem 内的橙框：新坐标 = 旧坐标 − stem 原点；
 *   ⇒ stem 外的橙框：位置已变，**必须丢**（给了就是裁别处的像素上纸）。
 */
describe('crop-regions · 分图产物上的橙框换算', () => {
    /** 分图产物：题干区在 (0,0)，尺寸 800×300 */
    const stem = { x: 0, y: 0, w: 800, h: 300 };

    it('题干区内的橙框：按 stem 原点平移', () => {
        const out = figuresForSplit(
            [{ kind: 'figure', x: 100, y: 50, w: 200, h: 120 }],
            stem,
            { w: 800, h: 500 },
        );
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({ kind: 'figure', x: 100, y: 50, w: 200, h: 120 });
    });

    it('题干区不在原点时（绿框内再分图）：减去 stem 原点', () => {
        const out = figuresForSplit(
            [{ kind: 'figure', x: 340, y: 210, w: 120, h: 80 }],
            { x: 200, y: 150, w: 600, h: 300 },
            { w: 600, h: 420 },
        );
        expect(out).toHaveLength(1);
        expect(out[0].x).toBe(140);
        expect(out[0].y).toBe(60);
    });

    it('落在答案堆叠区（stem 之外）的橙框 ⇒ 丢弃，不给错坐标', () => {
        const out = figuresForSplit(
            [{ kind: 'figure', x: 100, y: 400, w: 200, h: 80 }],
            stem,
            { w: 800, h: 500 },
        );
        expect(out).toHaveLength(0);
    });

    it('红/蓝/绿框一律不保留（它们的坐标在拼图上已无意义）', () => {
        const out = figuresForSplit(
            [
                { kind: 'question', x: 10, y: 10, w: 100, h: 100 },
                { kind: 'handwriting', x: 20, y: 20, w: 50, h: 50 },
                { kind: 'scope', x: 0, y: 0, w: 800, h: 300 },
            ],
            stem,
            { w: 800, h: 500 },
        );
        expect(out).toHaveLength(0);
    });

    it('橙框压在题干区边界上：保留，且夹进产物范围之内', () => {
        const out = figuresForSplit(
            [{ kind: 'figure', x: 700, y: 250, w: 200, h: 100 }],
            stem,
            { w: 800, h: 500 },
        );
        expect(out).toHaveLength(1);
        // x+w 不能越过产物宽度，y+h 不能越过题干区高度
        expect(out[0].x + out[0].w).toBeLessThanOrEqual(800);
        expect(out[0].y + out[0].h).toBeLessThanOrEqual(500);
        expect(out[0].w).toBeGreaterThan(0);
        expect(out[0].h).toBeGreaterThan(0);
    });

    it('多个橙框（多张题图）各自换算，不串位', () => {
        const out = figuresForSplit(
            [
                { kind: 'figure', x: 50, y: 40, w: 100, h: 60 },
                { kind: 'figure', x: 300, y: 100, w: 150, h: 90 },
            ],
            { x: 20, y: 20, w: 700, h: 260 },
            { w: 700, h: 400 },
        );
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ kind: 'figure', x: 30, y: 20, w: 100, h: 60 });
        expect(out[1]).toEqual({ kind: 'figure', x: 280, y: 80, w: 150, h: 90 });
    });

    it('产物尺寸非法（0）⇒ 返回空，不产出无法换算的坐标', () => {
        expect(
            figuresForSplit([{ kind: 'figure', x: 10, y: 10, w: 50, h: 50 }], stem, { w: 0, h: 0 }),
        ).toHaveLength(0);
    });

    it('没有橙框 ⇒ 空数组（大多数题本来就没有题图，不是异常）', () => {
        expect(
            figuresForSplit(
                [{ kind: 'question', x: 0, y: 0, w: 100, h: 100 }],
                stem,
                { w: 800, h: 500 },
            ),
        ).toHaveLength(0);
    });
});
