/**
 * 【2026-10-17 如如】看门测试：**"已掌握"开关的下一档只能有一个算法**。
 *
 * ── 为什么加这条（真 bug，空空 2026-10-17 报的）────────────────────────────
 *   详情页的"标记为已掌握"自己写了一套：`const newLevel = masteryLevel > 0 ? 0 : 1`
 *   ⇒ 点"已掌握"写进去的是 **1（复习中）**，**永远到不了 2**。
 *   表现：详情页里开关看着打开了，退出再进错题本，**错题卡左上角仍是"待复习"**；
 *   而反方向（2 ⇒ 0）是对的，所以他只看到"一进一出不对劲"。
 *
 *   `nextMasteryLevel()` 的唯一实现在 `lib/level-settle.ts`：`>= 2 ? 0 : 2`。
 *   掌握开关在本项目有**四个入口**（错题卡 / 列表行内 / 扫码单题卡 / 详情页 / 日积月累里那道关联题），
 *   各写一套必然分叉 —— 所以用测试钉住"**凡往请求体里放 masteryLevel 的地方，
 *   必须同时出现 `nextMasteryLevel(`**"。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *   A. 前端文件里出现 `masteryLevel:`（= 在拼请求体）⇒ 该文件必须出现 `nextMasteryLevel(`
 *   B. 反查：不许出现手写的下一档（`masteryLevel > 0 ? 0 : 1` 这种）
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

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

describe('掌握开关 · 下一档只能有一个算法', () => {
    const ROOT = process.cwd();
    /** 只扫前端（`src/app/api/**` 里也有 `masteryLevel:`，那是读/写库，不适用这条判据） */
    const files = [...walk(join(ROOT, 'src', 'components')), ...walk(join(ROOT, 'src', 'app'))].filter(
        (f) => !f.includes(`${sep}api${sep}`),
    );
    const short = (f: string) => f.replace(ROOT, '').replace(/\\/g, '/');
    const read = (f: string) => readFileSync(f, 'utf8');

    /**
     * 去掉注释行再判 —— 否则**注释里提到那个写法**也会被当成违规
     * （本测试 B 第一条就误报过：修 bug 时我在注释里写了原代码长什么样）。
     */
    const readCode = (f: string) =>
        read(f)
            .split(/\r?\n/)
            .filter((line) => {
                const t = line.trim();
                return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
            })
            .join('\n');

    /** 真正的"写入点" = 既在拼请求体、又真的发请求（纯展示组件里的类型声明不算） */
    const writers = files.filter(
        (f) => /masteryLevel:/.test(readCode(f)) && /apiClient\.(patch|put)\b/.test(read(f)),
    );

    it('★ 自检：确实能扫到那几个掌握开关（找不到 ⇒ 判据自己失效了）', () => {
        expect(writers.length, '一个掌握开关都没扫到？判据可能匹配不上').toBeGreaterThanOrEqual(3);
    });

    it('★★ A：凡往请求体里放 `masteryLevel` 的文件，都必须用 `nextMasteryLevel(`', () => {
        const missing = writers.filter((f) => !/nextMasteryLevel\(/.test(readCode(f)));
        expect(missing.map(short), '自己算"下一档"必然与 lib/level-settle.ts 分叉（这个 bug 就是这么来的）').toEqual(
            [],
        );
    });

    it('★ B：反查 —— 不许再出现手写的"已掌握下一档"', () => {
        /**
         * 这条是给"未来"的：即使有人 import 了 `nextMasteryLevel` 却在别处顺手写一个
         * `masteryLevel > 0 ? 0 : 1`，也当场拦下（**注释里写不算**，见 `readCode`）。
         */
        const handRolled = files.filter((f) =>
            /masteryLevel\s*>\s*0\s*\?\s*0\s*:\s*1/.test(readCode(f)),
        );
        expect(handRolled.map(short)).toEqual([]);
    });

    it('★ 唯一实现本身：0/1 ⇒ 2，2 ⇒ 0（点一下就是"已掌握 ⇄ 未掌握"，没有中间档）', async () => {
        const { nextMasteryLevel } = await import('@/lib/level-settle');
        expect(nextMasteryLevel(0)).toBe(2);
        expect(nextMasteryLevel(1)).toBe(2);
        expect(nextMasteryLevel(2)).toBe(0);
        expect(nextMasteryLevel(undefined)).toBe(2);
        expect(nextMasteryLevel(null)).toBe(2);
    });
});
