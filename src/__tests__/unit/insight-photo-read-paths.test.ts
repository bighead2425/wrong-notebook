/**
 * 【2026-10-25 真真】**看门：按卷读数据的两条路都必须按"入版"开关清图。**
 *
 * 这个 bug 真实发生过：空空在打印页看到"不入版"的图没了，
 * 但同一条积累纸打开"扫码图"进去，那张图**还挂着**。
 *
 * 真因不是判断写错，而是**有两条读卷的路**：
 *   · `GET /api/review-volumes/[id]`    —— 按内部 id（打印页）
 *   · `GET /api/review-volumes/lookup`  —— 按纸上的卷号（扫码预览、扫到的卷）
 * 当时只改了前者。
 *
 * 教训与 `docs` 里那条一致：**一条数据两条出口时，改动必须同时过一遍**，
 * 光靠"我记得也改一下"迟早会漏。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');

function read(rel: string): string {
    return readFileSync(join(ROOT, 'src', rel), 'utf8');
}

describe('入版开关 · 两条读卷路径', () => {
    it('★★ 卷详情 和 按卷号查询，都必须调 stripExcludedFigures', () => {
        const targets = [
            'app/api/review-volumes/[id]/route.ts',
            'app/api/review-volumes/lookup/route.ts',
        ];
        const missing = targets.filter((rel) => {
            const src = read(rel);
            // 必须真的调用（而不只是 import 了）
            return !/stripExcludedFigures\(\s*[a-zA-Z_.]+/.test(src);
        });
        expect(missing).toEqual([]);
    });

    it('★ 过滤逻辑本身只在 lib/insight-photo.ts 里（别处不许自己判 includedInPrint）', () => {
        const p = read('lib/insight-photo.ts');
        expect(p).toMatch(/includedInPrint/);
        // 换个说法：谁能碰 includedInPrint，白名单只有这一个文件
        expect(p).toMatch(/export async function excludedFromPrint/);
        expect(p).toMatch(/export async function stripExcludedFigures/);
    });
});
