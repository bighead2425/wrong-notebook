/**
 * 【2026-10-28】积累卷配图"只存引用"—— 引用格式与解析。
 *
 * 钉住四件事：
 *  ① 引用能来回转（造 / 认 / 拆）；
 *  ② 老数据（`data:` 真图、路径）原样保留，**不迁移也能印**；
 *  ③ 引用解析不到（那条积累把图删了）⇒ 这张图消失，但**其余行不受影响**；
 *  ④ 一条都不剩 ⇒ `figureUrls` 变成 null（打印时不排图位）。
 */

import { describe, expect, it } from 'vitest';

import {
    applyFigureRefs,
    insightFigureRef,
    insightIdOfRef,
    isFigureRef,
    parseFigureUrls,
    serializeFigureUrls,
    FIGURE_REF_PREFIX,
} from '@/lib/volume-figure-ref';

describe('引用格式', () => {
    it('造出来能认、能拆回来', () => {
        const ref = insightFigureRef('ins_1');
        expect(ref).toBe(`${FIGURE_REF_PREFIX}ins_1`);
        expect(isFigureRef(ref)).toBe(true);
        expect(insightIdOfRef(ref)).toBe('ins_1');
    });

    it('老数据（真图 / 路径）不会被当成引用', () => {
        expect(isFigureRef('data:image/jpeg;base64,AAA')).toBe(false);
        expect(isFigureRef('/uploads/a.png')).toBe(false);
        expect(insightIdOfRef('data:image/jpeg;base64,AAA')).toBeNull();
    });
});

describe('parseFigureUrls', () => {
    it('认 JSON 数组', () => {
        expect(parseFigureUrls('["ref:insight:a","/b.png"]')).toEqual(['ref:insight:a', '/b.png']);
    });

    it('空 / null / 脏数据 ⇒ 空数组', () => {
        expect(parseFigureUrls(null)).toEqual([]);
        expect(parseFigureUrls('')).toEqual([]);
        expect(parseFigureUrls('not json')).toEqual([]);
        expect(parseFigureUrls('{"a":1}')).toEqual([]);
    });

    it('存量里"裸字符串"的写法也认', () => {
        expect(parseFigureUrls('data:image/png;base64,AAA')).toEqual(['data:image/png;base64,AAA']);
    });
});

describe('serializeFigureUrls', () => {
    it('空数组 ⇒ null（没有图，不是"图数组为空"）', () => {
        expect(serializeFigureUrls([])).toBeNull();
    });

    it('正常写回 JSON 数组', () => {
        expect(serializeFigureUrls(['a', 'b'])).toBe('["a","b"]');
    });
});

describe('applyFigureRefs', () => {
    const row = (figureUrls: string | null, insightId: string | null = 'ins_1') => ({
        insightId,
        figureUrls,
    });

    it('引用换成真图', () => {
        const out = applyFigureRefs([row('["ref:insight:ins_1"]')], (id) =>
            id === 'ins_1' ? 'data:image/jpeg;base64,REAL' : undefined,
        );
        expect(out[0].figureUrls).toBe('["data:image/jpeg;base64,REAL"]');
    });

    it('图没了 ⇒ 这一行变成没有图，不抛错', () => {
        const out = applyFigureRefs([row('["ref:insight:gone"]')], () => undefined);
        expect(out[0].figureUrls).toBeNull();
    });

    it('老数据（真图）原样不动', () => {
        const raw = '["data:image/jpeg;base64,OLD"]';
        const out = applyFigureRefs([row(raw)], () => undefined);
        expect(out[0].figureUrls).toBe(raw);
    });

    it('一行坏了不影响别的行', () => {
        const out = applyFigureRefs(
            [row('["ref:insight:gone"]'), row('["ref:insight:ok"]'), row(null, null)],
            (id) => (id === 'ok' ? 'data:image/png;base64,OK' : undefined),
        );
        expect(out[0].figureUrls).toBeNull();
        expect(out[1].figureUrls).toBe('["data:image/png;base64,OK"]');
        expect(out[2].figureUrls).toBeNull();
    });

    it('没有引用的卷：一次都不碰（引用同一个对象，省得白白重建）', () => {
        const input = [row('["/a.png"]')];
        const out = applyFigureRefs(input, () => undefined);
        expect(out[0]).toBe(input[0]);
    });
});
