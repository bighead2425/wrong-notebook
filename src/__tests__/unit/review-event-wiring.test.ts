/**
 * 【2026-10-16 如如】看门测试：**凡是写复习结果的前端文件，必须同时声明"这是一次复习"**。
 *
 * ── 为什么要专门加这一条 ────────────────────────────────────────────────
 * `ReviewEvent` 表 2026-10-14 就建好了、API 也接得住，但**四个写入点一处都没传**
 * ⇒ 表永远为空，而且**完全静默**（界面一切正常、不报错、日志也没有）。
 * 这正是 `docs\09` 第七节**自己警告过**的那条：
 *   「4 个写入点漏改 ⇒ **数据静默缺失** …… **不报错才是最危险的**」。
 *
 * 这类坑"靠人眼盯"是盯不住的（真真 2026-10-15 是复核代码才发现的）⇒ 在测试里钉死。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 * 文件里出现 **`reviewOutcomes:`**（小写、带冒号 = 作为请求体的键在**写**它）
 * ⇒ 该文件必须同时出现 `reviewEvent`。
 * （读它的文件不会带冒号 —— 例如 `ReviewOutcomes` 类型标注是大写 R，不会误伤。）
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

describe('复习流水 · 前端写入点的看门护栏', () => {
    const ROOT = process.cwd();
    /**
     * ⚠️ **只扫前端**：`src/app/api/**` 那些文件里也有 `reviewOutcomes:`，但那是
     * **读**（prisma 的 `select: { reviewOutcomes: true }` / 响应映射 `reviewOutcomes: it.xxx`），
     * 不是写入点 —— 第一版判据扫全量时被它们误伤了（测试自己当场揪出来）。
     */
    const files = [...walk(join(ROOT, 'src', 'components')), ...walk(join(ROOT, 'src', 'app'))].filter(
        (f) => !f.includes(`${sep}api${sep}`),
    );

    /** 写入点 = 请求体里出现 `reviewOutcomes:` 的文件 */
    const writers = files.filter((f) => /reviewOutcomes:/.test(readFileSync(f, 'utf8')));
    const short = (f: string) => f.replace(ROOT, '').replace(/\\/g, '/');

    it('★ 至少能找到 4 个写入点（一条都找不到 ⇒ 说明这条护栏自己失效了，先修它）', () => {
        expect(writers.length).toBeGreaterThanOrEqual(4);
    });

    it('★★ 每个写入点都必须同时传 `reviewEvent` —— 否则流水表又会静默空掉', () => {
        /**
         * ⚠️ 判据必须是 **`reviewEvent:`（带冒号）**，不能只找 `reviewEvent`。
         *    第一版就栽在这儿：摘掉某个写入点的声明后测试**依然是绿的** ——
         *    因为那个文件里还留着 import 的类型名 `ReviewEventDraft` 与注释里的"reviewEvent"，
         *    光"提到名字"就算过 ⇒ **护栏形同虚设**。（2026-10-16 如如当场揪出并修。）
         *
         * 📌 若将来有人改用简写属性名 `{ reviewEvent }`，把判据放宽成
         *    `/reviewEvent\s*[:,}]/` 即可 —— 但改之前先想清楚为什么。
         */
        const REQUEST_BODY_KEY = /reviewEvent:/;
        const missing = writers.filter((f) => !REQUEST_BODY_KEY.test(readFileSync(f, 'utf8')));
        expect(missing.map(short)).toEqual([]);
    });

    it('★ 四个已知写入点**逐个点名**，防止"改了个名就算过了"', () => {
        const list = writers.map(short).sort();
        for (const known of [
            '/src/components/scan-item-panel.tsx',
            '/src/components/scan-volume-view.tsx',
            '/src/app/error-items/[id]/page.tsx',
            '/src/app/recover/page.tsx',
        ]) {
            expect(list, `少了这个写入点：${known}（改名了就把这里也改掉）`).toContain(known);
        }
    });
});
