import { describe, expect, it } from 'vitest';
import { generateAnalyzePrompt } from '@/lib/ai/prompts';

/**
 * 【2026-10-31】清单必须把「册 · 章 · 节」写出来。
 *
 * 起因：要求 AI 交回 book/chapter/section，却不给它这几段——等于让它闭着眼睛填邮编，
 * 只能靠模型自己记教材。而且更糟的是 `renderTagTree` 原来**按节名合并**，
 * 「三角形内角和」在四下和五上各有一节，两册的知识点被并成了一行。
 */
describe('知识点清单渲染', () => {
    it('每行是「册 · 章 · 节」，同名节不被合并', () => {
        const prompt = generateAnalyzePrompt('zh', 5, '数学', {
            tagTree: [
                { book: '四年级下', chapter: '三角形', unit: '三角形内角和', points: ['三角形内角和'] },
                {
                    book: '五年级上',
                    chapter: '第二单元 三角形的再认识',
                    unit: '三角形内角和',
                    points: ['三角形内角和', '四边形内角和'],
                },
            ],
        });

        expect(prompt).toContain('■ 四年级下 · 三角形 · 三角形内角和');
        expect(prompt).toContain('■ 五年级上 · 第二单元 三角形的再认识 · 三角形内角和');

        // 两册各自一条，不能出现"合并后只有一条"
        const lines = prompt.split('\n').filter((l) => l.includes('■ 五年级上'));
        expect(lines).toHaveLength(1);
        expect(prompt).toContain('四边形内角和');
    });

    it('三层结构的学科（学段 → 板块 → 考点）不带空章名', () => {
        const prompt = generateAnalyzePrompt('zh', 5, '语文', {
            tagTree: [{ book: '小学', unit: '病句修改', points: ['成分残缺', '搭配不当'] }],
        });

        expect(prompt).toContain('■ 小学 · 病句修改');
        expect(prompt).not.toContain('undefined');
        expect(prompt).not.toContain('·  ·');
    });

    it('规则里说清楚"照这一行抄三段"', () => {
        const prompt = generateAnalyzePrompt('zh', 5, '数学', {
            tagTree: [{ book: '五年级上', chapter: '第五单元', unit: '平行四边形的面积', points: ['平行四边形的面积'] }],
        });
        expect(prompt).toContain('照这一行的三段逐字抄');
    });
});
