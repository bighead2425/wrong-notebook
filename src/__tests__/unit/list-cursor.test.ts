// @vitest-environment node
// 纯逻辑测试：列表翻页的游标（拼串 / 拆串 / 坏值兜底）
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '@/lib/list-cursor';

describe('list-cursor · 上拉加载更多的游标', () => {
    it('两个值：拼出来能原样拆回来（日积月累用「日期 + 当日序号」）', () => {
        const c = encodeCursor('2026-10-09', 3);
        expect(decodeCursor(c, 2)).toEqual(['2026-10-09', '3']);
    });

    it('一个值：卷列表用的就是这种（只拿 id 当锚点）', () => {
        const c = encodeCursor('clx123abc');
        expect(decodeCursor(c, 1)).toEqual(['clx123abc']);
    });

    it('值里出现分隔符 | 也不会串位（会被转义）', () => {
        const c = encodeCursor('a|b', 'c');
        expect(decodeCursor(c, 2)).toEqual(['a|b', 'c']);
    });

    it('中文与空格照样能拆回来', () => {
        const c = encodeCursor('五年级上', ' 前后有空格 ');
        expect(decodeCursor(c, 2)).toEqual(['五年级上', ' 前后有空格 ']);
    });

    it('段数不对 ⇒ null（当作"没有游标"，从第一页开始）', () => {
        expect(decodeCursor('only-one', 2)).toBeNull();
        expect(decodeCursor('a|b|c', 2)).toBeNull();
    });

    it('空值 / 坏转义 ⇒ null，一律不抛异常', () => {
        expect(decodeCursor(null, 2)).toBeNull();
        expect(decodeCursor(undefined, 2)).toBeNull();
        expect(decodeCursor('', 2)).toBeNull();
        expect(decodeCursor('%', 1)).toBeNull(); // 单个 % 是非法转义
        expect(decodeCursor('a|b', 0)).toBeNull();
    });

    it('多段里夹一个空值也能原样拆回来', () => {
        expect(decodeCursor(encodeCursor('a', ''), 2)).toEqual(['a', '']);
        expect(decodeCursor(encodeCursor('', 'x'), 2)).toEqual(['', 'x']);
    });

    it('⚠️ 单段且值为空 ⇒ 整串也是空 ⇒ 与"没有游标"无法区分（设计如此，不是 bug）', () => {
        // 锚点永远是非空的（日期、编号、id），所以"空游标"只可能来自"没传"。
        // 这条断言是把这份含糊**钉住**：谁哪天想拿空串当合法锚点，测试会先拦下他。
        expect(encodeCursor('')).toBe('');
        expect(decodeCursor(encodeCursor(''), 1)).toBeNull();
    });
});
