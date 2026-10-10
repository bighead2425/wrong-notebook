import { describe, expect, it } from 'vitest';
import { parseVolumeItems, resolvePageCount, normalizeVolumeTitle } from '@/lib/volume-input';
import { FIGURE_SCALE_DEFAULT, FIGURE_SCALE_MAX, FIGURE_SCALE_MIN } from '@/lib/review-card';

/**
 * 卷内条目的规范化 —— **建卷（POST）与更新组卷（PATCH）共用这一处**。
 *
 * 为什么值得单独测：这两个接口写进库的是"印出去那张纸"的全部依据，
 * 字段兜底一旦分叉，就会出现"新建的卷正常、更新过的卷少了题图/图变小了"这类
 * 最难查的不一致。所以这里把**每一条兜底规则**都钉住。
 */
describe('卷内条目 · parseVolumeItems', () => {
    it('完整字段照原样收下（含 2026-09-29 新增的题图缩放）', () => {
        const items = parseVolumeItems(
            [
                {
                    errorItemId: 'e1',
                    seqInVolume: 3,
                    pageIndex: 2,
                    columnIndex: 1,
                    seqInColumn: 2,
                    itemNo: 'SX20260916001',
                    questionText: '题干',
                    figureUrls: ['/a.png', '/b.png'],
                    manageType: 'deep',
                    blankLines: 7,
                    figureScale: 130,
                },
            ],
            5,
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            errorItemId: 'e1',
            seqInVolume: 3,
            pageIndex: 2,
            columnIndex: 1,
            seqInColumn: 2,
            itemNo: 'SX20260916001',
            questionText: '题干',
            manageType: 'deep',
            blankLines: 7,
            figureScale: 130,
        });
        // 题图数组存成 JSON 字符串（列是 TEXT）
        expect(items[0].figureUrls).toBe('["/a.png","/b.png"]');
    });

    it('★ 题图缩放：缺省 = 100、越界夹到合法区间（他拖把手能拖到的范围）', () => {
        const items = parseVolumeItems(
            [{ errorItemId: 'a' }, { errorItemId: 'b', figureScale: 5 }, { errorItemId: 'c', figureScale: 999 }],
            5,
        );
        /**
         * ⚠️ 断言里**引用常量、不写死数字**（2026-10-10 改）。
         * 原来写的是 `[100, 30, 180]`，而上限当天从 180 提到 300
         * （深挖纸正面那张整页照片要能放大到纸面极限）⇒ 这条当场就红了。
         * 写死数字的断言会让"改一个上限"变成"改 N 处测试"，
         * 而真正要钉住的是**这条规则本身**（缺省 100、越界夹到区间两端），不是那个数字。
         */
        expect(items.map((i) => i.figureScale)).toEqual([
            FIGURE_SCALE_DEFAULT,
            FIGURE_SCALE_MIN,
            FIGURE_SCALE_MAX,
        ]);
    });

    it('留白：没给/给了垃圾值 ⇒ 退回这张卷的默认行数；越界夹到合法区间', () => {
        const items = parseVolumeItems(
            [{ errorItemId: 'a' }, { errorItemId: 'b', blankLines: '??' }, { errorItemId: 'c', blankLines: -3 }],
            8,
        );
        expect(items[0].blankLines).toBe(8);
        expect(items[1].blankLines).toBe(8);
        // 负数被夹到下限（不是原样存进去 —— 存进去纸上就是负数行留白）
        expect(items[2].blankLines).toBeGreaterThanOrEqual(0);
    });

    it('题型/等级只收已知值；空 id、缺字段一律落成 null / 默认序号', () => {
        const items = parseVolumeItems([{ errorItemId: '', manageType: '不存在的类型' }], 5);
        expect(items[0].errorItemId).toBeNull();
        expect(items[0].manageType).toBeNull();
        expect(items[0].seqInVolume).toBe(1); // index + 1
        expect(items[0].pageIndex).toBe(1);
        expect(items[0].columnIndex).toBe(0);
        expect(items[0].seqInColumn).toBe(1);
        // 非法 json 形态的题图（对象/数字）不收，避免库里出现读不出来的列
        expect(items[0].figureUrls).toBeNull();
    });

    it('非数组、null 数组都当空处理（不抛异常）', () => {
        expect(parseVolumeItems(null, 5)).toEqual([]);
        expect(parseVolumeItems(undefined, 5)).toEqual([]);
        expect(parseVolumeItems('not-an-array', 5)).toEqual([]);
    });
});

describe('卷内条目 · resolvePageCount', () => {
    it('调用方给了合法页数就用它', () => {
        expect(resolvePageCount(3, [{ pageIndex: 1 } as never])).toBe(3);
        expect(resolvePageCount('4', [])).toBe(4);
    });

    it('给不出就从题目的 pageIndex 取最大，且至少 1 页', () => {
        expect(resolvePageCount(undefined, [{ pageIndex: 1 }, { pageIndex: 5 }] as never)).toBe(5);
        expect(resolvePageCount(0, [])).toBe(1);
        expect(resolvePageCount('abc', [{ pageIndex: 2 }] as never)).toBe(2);
    });
});

/**
 * 卷名（2026-09-30 他提的）：只存库里、**不上纸** —— 纸面的身份是卷号。
 * 名字是给他自己在管理页里认卷、找卷用的。
 */
describe('卷名 normalizeVolumeTitle', () => {
    it('去首尾空白、连续空白压成一个空格', () => {
        expect(normalizeVolumeTitle('  第五单元  复练  ')).toBe('第五单元 复练');
    });

    it('空 / 全空白 / 非字符串 ⇒ null（= 没有名字，不是"名字叫空"）', () => {
        expect(normalizeVolumeTitle('')).toBeNull();
        expect(normalizeVolumeTitle('   ')).toBeNull();
        expect(normalizeVolumeTitle(undefined)).toBeNull();
        expect(normalizeVolumeTitle(123)).toBeNull();
    });

    it('超长截到 60 字（名字写长了不该拦住保存）', () => {
        const long = 'x'.repeat(200);
        expect(normalizeVolumeTitle(long)).toHaveLength(60);
    });
});
