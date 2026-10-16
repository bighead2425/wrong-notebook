/**
 * 【2026-10-16 真真】看门测试：**凡 `prisma.errorItem.findMany` 必须显式 `select`**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么加这一条
 *
 * 2026-10-16 一天之内**连查三处**同一个病根：
 *   ① `/api/error-items/list`（错题本列表）—— 一页 18 题 ⇒ 响应体 **9.40 MB**
 *   ② `/api/insights` 的 `loadQuestions`（日积月累·管理页）—— 一页 50 题 ⇒ **26.12 MB**
 *   ③ `/api/analytics`（**首页与内阁页**用的统计）—— **不分页、取全部题** ⇒ 300 题约 **410MB**
 *   ④ `/api/notebooks/[id]/analyze` —— 不分页
 *
 * 病根都一样：**只写 `include`、不写 `select`** ⇒ Prisma 返回 `ErrorItem` 的全部标量字段，
 * 其中 `originalImageUrl` 是**题图 base64**（单张最大约 1.37MB，见 `lib/image-utils.ts`
 * 的 `compressImage(maxSizeMB = 1)`）。**而绝大多数接口一个图片字段都不用。**
 *
 * 这类坑**靠人眼盯不住**（一天查了四处才发现）⇒ 钉进测试。
 * 与 `schema-write-paths.test.ts`（建了模型没人写）/ `review-event-wiring.test.ts`（漏传字段）
 * 是同一路子的"静默失效"护栏。
 * ══════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
}

/** 调用可能跨很多行（真真自己写的注释比代码长）⇒ 窗口给足 */
const WINDOW = 60;

/**
 * 找出"调了 `prisma.errorItem.findMany` 但整段里没有 `select:` / `omit:`"的位置。
 *
 * ⚠️ 判据是**文本级**的（不解析 AST）—— 够用且便宜。
 *    代价：窗口内的 `select:` 只要出现就算过（哪怕它属于别的调用）。
 *    这个宽松方向是**故意**的：宁可漏报，也不要天天假红（假红会让人把护栏删掉）。
 */
export function findUnselectedFindMany(sourceText: string): number[] {
    const lines = sourceText.split('\n');
    const hits: number[] = [];
    lines.forEach((line, i) => {
        if (!/errorItem\.findMany\s*\(/.test(line)) return;
        const chunk = lines.slice(i, i + WINDOW).join('\n');
        if (!/\bselect\s*:/.test(chunk) && !/\bomit\s*:/.test(chunk)) hits.push(i + 1);
    });
    return hits;
}

const files = walk(join(ROOT, 'src')).filter((f) => !f.includes(`${sep}__tests__${sep}`));

/**
 * **白名单：这些地方确实需要题图**（都是"导出/备份"性质，图就是要带走的东西）。
 * ⚠️ 往这里加之前先问一句：**这个接口真的要把图传出去吗？** 还是又一个"顺手 include"？
 */
const NEEDS_IMAGE: Record<string, string> = {
    '/src/app/api/export/route.ts': '数据导出/备份 —— 图本来就是要带走的东西',
    '/src/app/api/error-items/export-all-obsidian/route.ts': '导出到 Obsidian —— 图要落到笔记里',
    '/src/app/api/error-items/merge/route.ts':
        '合并重复题 —— 要把**图**连同题干/错因重送 AI（`extractBase64(item.originalImageUrl)`）。' +
        '⚠️ 另注：这个路由**目前没有任何调用方**（「合并」入口 2026-10-09 已砍），属死代码；' +
        '但留着它是对的（将来要复活时不必再踩一遍这个坑）',
};

describe('错题查询 · 必须显式 select 的看门护栏', () => {
    it('★ 扫描器自身要先可信（合成输入，证明它真的会红）', () => {
        // 没写 select ⇒ 报
        expect(findUnselectedFindMany('const a = await prisma.errorItem.findMany({ where: { userId } });')).toEqual([1]);
        // 写了 select ⇒ 不报
        expect(findUnselectedFindMany('const a = await prisma.errorItem.findMany({ select: { id: true } });')).toEqual([]);
        // 跨行、注释比代码长 ⇒ 也要认（真真自己写的注释就是那样）
        expect(
            findUnselectedFindMany(
                ['prisma.errorItem.findMany({', '  where: { userId },', '  /** 说明… */'.repeat(20), '  select: { id: true },', '});'].join('\n'),
            ),
        ).toEqual([]);
    });

    it('★★ 真源码里**除了白名单**，不许再有"没写 select"的错题查询', () => {
        const offenders: string[] = [];
        for (const f of files) {
            const rel = f.replace(ROOT, '').replace(/\\/g, '/');
            if (NEEDS_IMAGE[rel]) continue;
            for (const line of findUnselectedFindMany(readFileSync(f, 'utf8'))) {
                offenders.push(`${rel}:${line}`);
            }
        }
        expect(
            offenders,
            [
                '',
                '有错题查询没写 select ⇒ Prisma 会返回全部标量字段，**含 base64 题图（单张最大约 1.37MB）**。',
                '',
                '改法：给它一个显式 select（只要读几个字段就只写几个）。',
                '  列表类页面请复用 `lib/constants/error-item-list-fields.ts` 的 LIST_ITEM_SCALARS。',
                '',
                '⚠️ 只有"导出/备份"性质的接口才需要图 ⇒ 真要图，加进本文件的 NEEDS_IMAGE 白名单并写清理由。',
                '',
            ].join('\n'),
        ).toEqual([]);
    });

    it('★ 白名单里的路径必须真实存在（改名了要同步，别留一条永远匹配不上的规则）', () => {
        for (const rel of Object.keys(NEEDS_IMAGE)) {
            const full = join(ROOT, rel);
            expect(() => statSync(full), `白名单里的 ${rel} 不存在了`).not.toThrow();
        }
    });

    it('★ 白名单每条都要写清理由', () => {
        for (const [f, why] of Object.entries(NEEDS_IMAGE)) {
            expect(why.length, `${f} 的理由太短`).toBeGreaterThan(10);
        }
    });
});
