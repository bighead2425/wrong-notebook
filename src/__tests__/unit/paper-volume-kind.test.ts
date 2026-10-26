/**
 * 【2026-10-26 幅面审计】**四种纸的幅面设置，是否真的各走各的。**
 *
 * 空空实测报的三条，全部是"共用件没接上"：
 *   ① 模仿纸设 A4 不生效 —— `kind` 映射写成了"不是 build 就当 review"，模仿纸走了复练纸的设置
 *   ② 积累纸 A4 下身份条横线还是灰的 —— 横线读 `var(--paper-rule, #666)`，
 *      复练纸设了、积累纸没设
 *   ③ 扫码预览变回 B5 —— 那一处的 `InsightSheet` 没传 `paper`
 *
 * 前两条中①可以用纯函数钉死；②③是"某个组件漏了一行"，只能静态检查。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paperForVolumeKind } from '@/lib/paper';

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf8');

/** 四种纸全 B5 的基准配置 */
const ALL_B5 = { deepDive: 'B5', review: 'B5', imitate: 'B5', build: 'B5' } as const;

describe('卷的种类 → 用哪张纸的幅面', () => {
    it('★ 模仿纸用自己的设置，不是复练纸的', () => {
        const cfg = { ...ALL_B5, imitate: 'A4' } as const;
        expect(paperForVolumeKind('imitate', cfg).id).toBe('A4');
        // 复练纸此时仍是 B5 —— 两者互不串
        expect(paperForVolumeKind('review', cfg).id).toBe('B5');
    });

    it('复练纸设 A4 时，模仿纸不受影响', () => {
        const cfg = { ...ALL_B5, review: 'A4' } as const;
        expect(paperForVolumeKind('review', cfg).id).toBe('A4');
        expect(paperForVolumeKind('imitate', cfg).id).toBe('B5');
    });

    it('积累卷走 build 那一档', () => {
        const cfg = { ...ALL_B5, build: 'A4' } as const;
        expect(paperForVolumeKind('build', cfg).id).toBe('A4');
        expect(paperForVolumeKind('build', cfg).w).toBe(210);
    });
});

describe('静态护栏：别再手写旧的错误映射', () => {
    it('★ paperFor(...) 里不许再内联 `=== "build" ? "build" : "review"`', () => {
        /**
         * 判据是"**把映射写在 paperFor 的实参里**"——
         * 那个写法漏掉了 imitate（它会被当成 review）。
         *
         * ⚠️ 不要退化成"全文不许出现这个三元"：
         *    `print-preview` 的 `kindOfMode()` 里确实有这三个分支，
         *    但它是 `deep → imitate → build → review` 完整的，**逻辑是对的**。
         *    第一版测试就是这么误报的。
         */
        const suspects = [
            'components/scan-volume-view.tsx',
            'app/review-volumes/page.tsx',
            'app/print-preview/page.tsx',
            'app/insights/print/page.tsx',
        ];
        const bad = suspects.filter((rel) => {
            const src = read(rel);
            return /paperFor\(\s*(kind|mode)\s*===/.test(src);
        });
        expect(bad).toEqual([]);
    });

    it('★ 扫码预览传给 InsightSheet 时带上了 paper', () => {
        const src = read('components/insight-scan-view.tsx');
        // 抓 <InsightSheet ... > 这一段，里面必须有 paper=
        const m = src.match(/<InsightSheet[\s\S]{0,400}?page=\{page\}/);
        expect(m, '没找到 <InsightSheet> 调用').toBeTruthy();
        expect(m![0]).toMatch(/paper=\{/);
    });

    it('★ 积累纸自己设了 --paper-rule（A4 蓝线）', () => {
        const src = read('components/print/insight-sheet.tsx');
        expect(src).toMatch(/--paper-rule/);
    });

    it('★ 深挖纸的 A4 也不是灰色（身份条下边框内联判断）', () => {
        const src = read('components/print/deep-dive-card.tsx');
        expect(src).toMatch(/1c7ed6/);
    });
});
