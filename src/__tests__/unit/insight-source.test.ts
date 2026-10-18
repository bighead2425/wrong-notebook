/**
 * 日积月累 · 照片拆分的几何（2026-10-18）
 *
 * 钉住的都是"错了不报错、只让孩子看见抄错行"的地方：
 *   · 绿框必须**合并**（跟错题的分割相反）；
 *   · 红蓝必须**各归各**（一个变引文、一个变正文）；
 *   · 绿框以外的东西一个都不许漏进来。
 */

import { describe, it, expect } from 'vitest';
import { needsOriginalPhoto, planInsightSource } from '@/lib/insight-source';
import type { CropBox, CropRegions } from '@/lib/crop-regions';

const base = { w: 1000, h: 1400, rotation: 0 };

function regions(boxes: CropBox[]): CropRegions {
    return { boxes, base };
}

const box = (kind: CropBox['kind'], x: number, y: number, w: number, h: number): CropBox => ({
    kind,
    x,
    y,
    w,
    h,
});

describe('planInsightSource', () => {
    it('一个框都没画：整图当附图，字也整图读', () => {
        const p = planInsightSource(null);
        expect(p.scope).toBeNull();
        expect(p.printedArea).toBeNull();
        expect(p.handwrittenArea).toBeNull();
        expect(p.photoCrop).toBeNull();
        expect(needsOriginalPhoto(p)).toBe(true);
    });

    it('两个不相邻的绿框 ⇒ 并集，不是切成两条', () => {
        const p = planInsightSource(regions([box('scope', 100, 100, 200, 100), box('scope', 100, 500, 300, 80)]));
        // 包围盒：x 100..400, y 100..580
        expect(p.scope).toEqual({ x: 100, y: 100, w: 300, h: 480 });
        // 只画了绿框 ⇒ 靠 note 提醒"整块当一段话读"
        expect(p.notes.join()).toContain('只画了绿框');
    });

    it('红蓝各归各：一个走引文、一个走正文', () => {
        const p = planInsightSource(
            regions([box('question', 60, 100, 800, 200), box('handwriting', 60, 340, 800, 260)]),
        );
        expect(p.printedArea).toEqual({ x: 60, y: 100, w: 800, h: 200 });
        expect(p.handwrittenArea).toEqual({ x: 60, y: 340, w: 800, h: 260 });
        // 两者不合并成一个矩形（合并了就再也分不出谁说的）
        expect(p.printedArea).not.toEqual(p.handwrittenArea);
    });

    it('多个红框取并集（一段摘抄可能被分成几段框）', () => {
        const p = planInsightSource(
            regions([box('question', 60, 100, 400, 100), box('question', 60, 260, 400, 100)]),
        );
        expect(p.printedArea).toEqual({ x: 60, y: 100, w: 400, h: 260 });
    });

    it('橙框相邻 ⇒ 合成一张附图', () => {
        const p = planInsightSource(
            regions([box('figure', 100, 100, 200, 200), box('figure', 290, 120, 180, 160)]),
        );
        expect(p.photoCrop).toEqual({ x: 100, y: 100, w: 370, h: 200 });
        expect(needsOriginalPhoto(p)).toBe(false);
    });

    it('橙框不相邻 ⇒ 仍取并集（一条积累只有一张附图，宁多勿丢）', () => {
        const p = planInsightSource(
            regions([box('figure', 100, 100, 100, 100), box('figure', 600, 900, 100, 100)]),
        );
        expect(p.photoCrop).toEqual({ x: 100, y: 100, w: 600, h: 900 });
    });

    it('绿框以外的东西一个都不许漏进来', () => {
        const p = planInsightSource(
            regions([
                box('scope', 100, 100, 300, 300),
                box('question', 50, 50, 100, 100), // 大部分在绿框外，只剩右下角一小块
                box('handwriting', 800, 800, 100, 100), // 完全在绿框外
                box('figure', 900, 1200, 50, 50), // 完全在绿框外
            ]),
        );
        // 红框被夹到交集：x 100..150, y 100..150
        expect(p.printedArea).toEqual({ x: 100, y: 100, w: 50, h: 50 });
        // 完全在外的蓝框、橙框直接丢掉（不是拿原坐标硬塞回来）
        expect(p.handwrittenArea).toBeNull();
        expect(p.photoCrop).toBeNull();
    });

    it('只有橙框：字不读，图裁那一块', () => {
        const p = planInsightSource(regions([box('figure', 200, 200, 400, 300)]));
        expect(p.printedArea).toBeNull();
        expect(p.handwrittenArea).toBeNull();
        expect(p.photoCrop).toEqual({ x: 200, y: 200, w: 400, h: 300 });
        expect(p.notes.join()).not.toContain('只画了绿框');
    });
});
