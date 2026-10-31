import { describe, expect, it } from 'vitest';
import { normalizeTagName, parseTagRefs } from '@/lib/ai/tag-ref';

describe('parseTagRefs · 四段坐标', () => {
    it('自闭合标签：四个属性都读到', () => {
        const raw = '<kp book="五年级上" chapter="第五单元 多边形的面积" section="平行四边形的面积" name="底和高的对应"/>';
        expect(parseTagRefs(raw)).toEqual([{
            book: '五年级上',
            chapter: '第五单元 多边形的面积',
            section: '平行四边形的面积',
            name: '底和高的对应',
        }]);
    });

    it('成对标签：name 缺省时取标签内文字', () => {
        const raw = '<kp book="五年级上">平行四边形的面积</kp>';
        expect(parseTagRefs(raw)).toEqual([{
            book: '五年级上',
            chapter: undefined,
            section: undefined,
            name: '平行四边形的面积',
        }]);
    });

    it('两条都收，顺序不变', () => {
        const raw = `
<kp book="五年级上" section="小数加减法" name="小数加法"/>
<kp book="五年级上" section="小数加减法" name="小数减法"/>
`;
        expect(parseTagRefs(raw).map((r) => r.name)).toEqual(['小数加法', '小数减法']);
    });

    it('单引号 / 中文引号也能读', () => {
        expect(parseTagRefs(`<kp book='三年级下' name='面积单位换算'/>`)[0].book).toBe('三年级下');
        expect(parseTagRefs(`<kp book=“三年级下” name=“面积单位换算”/>`)[0].book).toBe('三年级下');
    });

    it('UNMATCHED 不是知识点，必须丢掉', () => {
        expect(parseTagRefs('<kp name="UNMATCHED"/>')).toEqual([]);
        expect(parseTagRefs('<kp>UNMATCHED</kp>')).toEqual([]);
    });

    it('旧格式（逗号分隔）解析不出坐标 —— 交给上层降级，不在这里猜', () => {
        expect(parseTagRefs('小数加法, 小数减法')).toEqual([]);
        expect(parseTagRefs(null)).toEqual([]);
    });
});

describe('normalizeTagName · 身份归一', () => {
    it('括号补充整段去掉', () => {
        expect(normalizeTagName('等式的性质（等式两边同乘一个数）')).toBe('等式的性质');
        expect(normalizeTagName('等式的性质(两边同除)')).toBe('等式的性质');
    });

    it('空白与分隔符不影响身份', () => {
        expect(normalizeTagName(' 小数 加法 ')).toBe('小数加法');
    });

    it('不吞掉正常名字里的字', () => {
        expect(normalizeTagName('平行四边形的面积')).toBe('平行四边形的面积');
    });
});
