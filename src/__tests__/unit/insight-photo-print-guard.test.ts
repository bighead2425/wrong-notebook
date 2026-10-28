/**
 * 【2026-10-19 真真】看门测试：**取"要印进纸里的图"，必须走 `readPhotoForPrint`**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么加这一条（这是个真 bug 的护栏）
 *
 * 空空 2026-10-19 反馈："管理页里图片旁边的『入版 / 不入版』切换似乎不起作用。"
 *
 * 真因：开关**存得住**（探针验过：写进去、读回来都对），但**建卷时没人看它** ——
 *   `api/review-volumes` 的 POST 和 `[id]` 的 PATCH 各自写了一段
 *   `prisma.insightPhoto.findUnique({ select: { data: true } })`，只取图、不看开关。
 *   而打印页前端算的 `photoUrl`（`photoIncludedInPrint === false ? null : …`）
 *   **根本传不过去** —— 建卷只传 `insightId`，图是服务端按 id 补进快照的。
 * ⇒ 开关拨到"不入版"，纸上照样有图。
 *
 * 修法：判断收进 `lib/insight-photo.ts` 的 `readPhotoForPrint()`，两条补图路径都调它。
 *
 * 这条测试钉的就是"以后别再自己取图"：凡在 `src/app` 下直接 `insightPhoto.findUnique`
 * 并且取 `data` 的，一律算绕过 —— 白名单只留 `lib/insight-photo.ts` 自己。
 *
 * 📌 **它已经红过一次**：首跑就点名了 `api/review-volumes/route.ts:104` 与
 *    `api/review-volumes/[id]/route.ts:175`（修之前的那两处）—— 教训 #23：
 *    "加护栏必须先让它红一次"，否则你放的可能是一条永远绿的假护栏。
 * ══════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** 唯一允许直接取图的地方（它自己就是"要不要这张图"的实现处） */
const ALLOWED = new Set(['src/lib/insight-photo.ts']);

/** 递归列出 `src/` 下的全部 .ts/.tsx（相对路径，正斜杠） */
function sourceFiles(root = 'src'): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) {
                if (name === '__tests__' || name === 'node_modules') continue;
                walk(full);
                continue;
            }
            if (!/\.(ts|tsx)$/.test(name)) continue;
            out.push(full.split(sep).join('/'));
        }
    };
    walk(root);
    return out.sort();
}

/**
 * 这个文件是不是在"自己取图"。
 *
 * 判据两条同时成立：
 *  ① 出现 `insightPhoto.findUnique(` / `findFirst(` / `findMany(`；
 *  ② 同一段里出现 `data: true`（真的把图本体取出来了）。
 * 只看名字不算 —— 注释里提到 `insightPhoto.findUnique` 的说明文字不该触发。
 *
 * ⚠️【2026-10-28】把 `findMany` 补进判据：批量取图同样是"自己取图"。
 *    那天 `lib/volume-figure-ref.ts` 用 `findMany({ select: { data: true } })` 取了一批图，
 *    护栏没红 —— 因为它只认单条。**漏掉的判据等于没有判据。**
 */
export function takesPhotoDirectly(source: string): boolean {
    const calls = source.match(/insightPhoto\.(findUnique|findFirst|findMany)\s*\(/g);
    if (!calls) return false;
    return /data\s*:\s*true/.test(source);
}

describe('入版开关的看门护栏', () => {
    it('★ 除 lib/insight-photo.ts 外，没有任何地方自己取图', () => {
        const offenders = sourceFiles('src').filter((f) => {
            if (ALLOWED.has(f)) return false;
            return takesPhotoDirectly(readFileSync(f, 'utf8'));
        });
        expect(offenders).toEqual([]);
    });

    it('判据本身可信：注释里提到调用、或只取开关不取图 ⇒ 都不算', () => {
        expect(takesPhotoDirectly('// prisma.insightPhoto.findUnique 将来要加')).toBe(false);
        expect(takesPhotoDirectly('await prisma.insightPhoto.findUnique({ where, select: { includedInPrint: true } })')).toBe(false);
        expect(takesPhotoDirectly('await prisma.insightPhoto.findUnique({ where, select: { data: true } })')).toBe(true);
    });

    it('★ 两条建卷路径都**把"入版"这一步交给补图那一步**（不是只 import 了不用）', () => {
        const post = readFileSync('src/app/api/review-volumes/route.ts', 'utf8');
        const patch = readFileSync('src/app/api/review-volumes/[id]/route.ts', 'utf8');
        /**
         * 断言的是**调用形式**：只 `import` 了、实际又自己写一段查图的话，这条会红。
         *
         * ⚠️【2026-10-28】原来钉的是 `readPhotoForPrint` —— 那是"把整张图读进来"的写法。
         * 现在建卷只要回答"有没有可印的图"，图本身不再进卷（存引用），
         * 所以这里跟着改成 `hasPhotoForPrint`。判据（看 `includedInPrint`）没有变。
         */
        expect(post).toMatch(/attachInsightFigures\(items,\s*hasPhotoForPrint\)/);
        expect(patch).toMatch(/attachInsightFigures\(items,\s*hasPhotoForPrint\)/);
    });

    it('★ 引用解析也只走 lib/insight-photo.ts（不许自己 findMany 取图）', () => {
        const src = readFileSync('src/lib/volume-figure-ref.ts', 'utf8');
        expect(src).not.toMatch(/insightPhoto\./);
        expect(src).toMatch(/readPhotosForPrint/);
    });
});
