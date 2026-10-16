/**
 * 【2026-10-16 如如】看门测试：**前端写复习结果，只能走"流水"这条路**。
 *
 * ── 为什么要专门加这一条（两个坑，都是本项目真踩过的）────────────────────
 * ① `ReviewEvent` 表 2026-10-14 就建好了、API 也接得住，但**四个写入点一处都没传**
 *    ⇒ 表永远为空，而且**完全静默**（界面一切正常、不报错、日志也没有）。
 *    这正是 `docs\09` 第七节**自己警告过**的那条：
 *      「4 个写入点漏改 ⇒ **数据静默缺失** …… **不报错才是最危险的**」。
 * ② 【2026-10-16 换判据】`docs\18` 把 `ErrorItem.reviewOutcomes` 降级成**派生缓存**、
 *    服务端**不再接受**由调用方写它（收下就忽略 + 打 warn）。
 *    ⇒ 于是失败形态**反过来**了：谁要是还照老写法发 `reviewOutcomes:`，
 *      结果不是报错，而是**点了没反应**（写进去的东西被静静丢掉）—— 同一个"静默"家族。
 *
 * ── 判据（两条，一条管"该有的有"，一条管"不该有的没有"）─────────────────
 *   A. **四个已知写入点**都必须真的把 `reviewEvent` 放进请求体（`/reviewEvent:/`）。
 *   B. 前端**不许再自己拼复习结果**：出现 `reviewOutcomes:` 的那一行，
 *      必须同时出现 `prev.` 或 `updated.`（= 只是把**服务端算好的缓存**回填本地 state）。
 *      自己拼一个值发出去 ⇒ 服务端收下就忽略 ⇒ **点了没反应**（"静默"家族第二例）。
 *      ⏳ 已知遗留两处（第 4 步要清掉）写在 `LEGACY_PENDING` 里 —— 清完必须删名单，
 *      否则本测试会**反过来提醒你**（基线门禁的老规矩：只许降不许涨）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** 递归收集目录下的 `.ts` / `.tsx`（跳过测试文件本身） */
function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            walk(p, out);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
            out.push(p);
        }
    }
    return out;
}

/** 四个已知写入点（改名了就把这里也改掉） */
const WRITE_POINTS = [
    '/src/components/scan-item-panel.tsx',
    '/src/components/scan-volume-view.tsx',
    '/src/app/error-items/[id]/page.tsx',
    '/src/app/recover/page.tsx',
];

describe('复习流水 · 前端写入点的看门护栏', () => {
    const ROOT = process.cwd();
    /**
     * ⚠️ **只扫前端**：`src/app/api/**` 里的 `reviewOutcomes:` 是**读**
     * （prisma 的 `select: { reviewOutcomes: true }` / 响应映射），不是写入点 ——
     * 第一版判据扫全量时被它们误伤了（测试自己当场揪出来）。
     */
    const files = [...walk(join(ROOT, 'src', 'components')), ...walk(join(ROOT, 'src', 'app'))].filter(
        (f) => !f.includes(`${sep}api${sep}`),
    );
    const short = (f: string) => f.replace(ROOT, '').replace(/\\/g, '/');
    const read = (f: string) => readFileSync(join(ROOT, f.replace(/^\//, '')), 'utf8');

    it('★ 自检：那四个写入点文件都还在（护栏不能因为文件改名而悄悄失效）', () => {
        const present = files.map(short);
        for (const f of WRITE_POINTS) {
            expect(present, `${f} 不见了（改名了？那就把这个名单也改掉）`).toContain(f);
        }
    });

    it('★★ A：四个写入点都必须真的把 `reviewEvent` 放进请求体', () => {
        /**
         * ⚠️ 判据必须是 **`reviewEvent:`（带冒号）**，不能只找 `reviewEvent`。
         *    上一版就栽在这儿：摘掉某个写入点的声明后测试**依然是绿的** ——
         *    因为文件里还留着 import 的类型名与注释里的"reviewEvent"，
         *    光"提到名字"就算过 ⇒ **护栏形同虚设**。（2026-10-16 如如当场揪出并修。）
         */
        const REQUEST_BODY_KEY = /reviewEvent:/;
        const missing = WRITE_POINTS.filter((f) => !REQUEST_BODY_KEY.test(read(f)));
        expect(missing, '这些写入点没有把流水放进请求体 ⇒ 表会静默空掉').toEqual([]);
    });

    it('★★ B：前端不许再**自己拼**复习结果（那一行必须是从服务端回填的：带 `prev.` / `updated.`）', () => {
        /**
         * 为什么判据是"这一行有没有 `prev.` / `updated.`"而不是"不许出现某个键"：
         *   `setItem(prev => ({ ...prev, reviewOutcomes: updated.reviewOutcomes ?? prev.reviewOutcomes }))`
         *   这种**回填本地缓存**的写法是合法的（值是服务端给的）；
         *   而 `{ reviewOutcomes: next }` / `{ reviewOutcomes: serializeReviewOutcomes(next) }`
         *   这种**自己拼一个值发出去**的写法正是要禁的 —— 服务端会忽略它。
         */
        const offenders = files.filter((f) =>
            readFileSync(f, 'utf8')
                .split(/\r?\n/)
                .some((line) => /reviewOutcomes:/.test(line) && !/prev\.|updated\./.test(line)),
        );
        const names = offenders.map(short).sort();

        /**
         * ✅【2026-10-16 第 4 步】**名单已清空** —— 卷页与回录页都改成"只写流水"了。
         * 留这个空数组是**故意的**：它把"反查"那条判据保留在测试里 ——
         * 将来谁再往名单里塞东西，就得同时解释为什么。
         */
        const LEGACY_PENDING: string[] = [];

        expect(
            names.filter((n) => !LEGACY_PENDING.includes(n)),
            '这些文件在自己拼复习结果 ⇒ 服务端会忽略 ⇒ 点了没反应',
        ).toEqual([]);

        // 反向自检：名单里那些如果已经清干净了，就必须把名单删掉（否则名单会长成"永久豁免"）
        expect(
            LEGACY_PENDING.filter((n) => !names.includes(n)),
            '这些文件已经清干净了 ⇒ 请把它们从 LEGACY_PENDING 里删掉',
        ).toEqual([]);
    });
});
