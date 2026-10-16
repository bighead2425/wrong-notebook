/**
 * 【2026-10-16 如如】看门测试：**流水表只能有一个写入口**。
 *
 * 出处：`docs\18` §3.1（"别处不许直接写 `reviewOutcomes`"）+ `lib/review-events.ts` 文件头纪律 1。
 *
 * 为什么值得单独钉一条：本项目**已经栽过三次同一个坑** ——
 *   · `schema-write-paths`（建了模型没人写）· `review-event-wiring`（漏传字段）
 *   · `error-item-select-guard`（漏 select）
 * 而"流水是唯一真相"这件事一旦被绕过（比如某个路由图省事自己 `prisma.reviewEvent.create`），
 * 结果就是**派生缓存和流水对不上** —— 界面显示 4 个圈、流水里却是另外几条，而且**不报错**。
 *
 * ⚠️ 本测试**必须能红**（教训 #23：加护栏先让它红一次）——
 *    写完之后故意在别处加一行 `prisma.reviewEvent.` 验证它会报出来。
 *    📌 **首跑就抓到一处**：`lib/review-event-draft.ts` 的**注释**里写了这个字面量
 *    （不是真的在动表）⇒ 已把注释措辞改掉。
 *    ⇒ 判据是**文本匹配**：注释里也别写这个字面量，写"直接读写流水表的调用"就行。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 递归收集 `src` 下的 `.ts` / `.tsx`（跳过测试文件本身） */
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

describe('复习流水 · 唯一写入口（看门护栏）', () => {
    const ROOT = process.cwd();
    const files = walk(join(ROOT, 'src'));
    const short = (f: string) => f.replace(ROOT, '').replace(/\\/g, '/');

    /** 判据：文件里出现 `prisma.reviewEvent.`（= 真的在动那张表） */
    const touching = files.filter((f) => /prisma\.reviewEvent\./.test(readFileSync(f, 'utf8')));

    it('★★ 只有 `lib/review-events.ts` 能直接碰 `prisma.reviewEvent`', () => {
        const SINK = short(join(ROOT, 'src', 'lib', 'review-events.ts'));
        expect(touching.map(short).sort()).toEqual([SINK]);
    });

    it('★ 那个唯一入口必须**同时**提供增 / 改 / 删三个动作（缺一个，别人就会自己写）', () => {
        const src = readFileSync(join(ROOT, 'src', 'lib', 'review-events.ts'), 'utf8');
        for (const fn of ['recordReviewEvent', 'updateReviewEvent', 'deleteReviewEvent']) {
            expect(src, `少了 ${fn}`).toContain(`export async function ${fn}`);
        }
    });

    it('★ 改 / 删必须带 `userId` 条件（不许只按 id 动别人的记录）', () => {
        const src = readFileSync(join(ROOT, 'src', 'lib', 'review-events.ts'), 'utf8');
        // 取 updateMany / deleteMany 那两段，看 where 里有没有 userId
        const whereBlocks = src.match(/where:\s*\{[^}]*\}/g) ?? [];
        const scoped = whereBlocks.filter((w) => w.includes('userId'));
        expect(scoped.length, '写/改/删三处的 where 都该带 userId').toBeGreaterThanOrEqual(3);
    });
});
