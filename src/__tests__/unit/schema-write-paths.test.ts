/**
 * 【2026-10-16 真真】看门测试：**schema 里建了模型，就必须有人写它**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么加这一条
 *
 * `ReviewEvent` 表 2026-10-14 就建好了、API 也接得住，但**前端四处写入点一处都没传**
 * ⇒ 表永远为空，而且**完全静默**（界面正常、不报错、日志也没有）。
 * 那是靠**逐行读代码**才发现的（真真 2026-10-15 复核），成本很高。
 *
 * 既然"建了却没人写"是**一类**坑，就不该靠人眼盯 ⇒ 用脚本扫全部模型。
 * 真真 2026-10-16 首次跑的结果：16 个模型里 **只有 1 个**没人写（`ScanReturn`，见下面的白名单）。
 *
 * ⚠️⚠️ **本文件第一版差点成为"假护栏"，记下来**：
 *    第一版判据只认 `prisma.<模型>.<写操作>(`，而有三张表是在**事务里**写的
 *    （`tx.printBatch.create` / `tx.printJob.create` / `tx.reviewSchedule.create`）
 *    ⇒ 被误判成"没人写"；更糟的是**白名单里也正好列着它们**，
 *    **扫描器的 bug 与白名单的错误互相印证，测试当时是绿的**。
 *    放宽成"任意客户端变量"后**当场变红**、正好点名白名单多了三个 ⇒ 这才叫真的在拦。
 *    📌 **"证明护栏会红"这一步不能省**（教训 #23），否则你放的可能是一条永远绿的假护栏。
 *
 * ⚠️ 与 `review-event-wiring.test.ts`（如如加的）**互补**：
 *    那条管"**写点之间**别漏传"（同一张表、多个调用点）；
 *    本条管"**表本身**有没有写入口"（整个模型一个写点都没有）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/* ============================ 被测试的核心逻辑 ============================ */

const WRITE_OPS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];

/** 从 schema 文本里抽出全部模型名 */
export function modelsOf(schemaText: string): string[] {
    return schemaText
        .split('\n')
        .filter((l) => l.startsWith('model '))
        .map((l) => l.split(/\s+/)[1])
        .sort();
}

/**
 * 某个模型在给定源码里有没有写入口。
 *
 * ⚠️⚠️ **必须认"任何客户端变量名"，不能只认 `prisma.`** —— 这条是本文件第一版踩的坑：
 *    第一版正则写的是 `prisma\.<model>\.create(`，而 `api/import/route.ts:349` 用的是
 *    **事务客户端** `tx.reviewSchedule.create(...)` ⇒ 被误判成"没人写"。
 *    更糟的是：**当时测试是绿的** —— 因为白名单里也写着 `ReviewSchedule`，
 *    **扫描器的 bug 和白名单的错误互相印证**，谁也没发现。
 *    （与如如那条 `review-event-wiring.test.ts` 的"第一版是假护栏"是同一类事故。）
 * ⇒ 判据放宽成"**任意标识符**.<模型名>.<写操作>("：`prisma.` / `tx.` / `transaction.` 都认。
 */
export function hasWriter(model: string, sourceTexts: readonly string[]): boolean {
    const prop = model[0].toLowerCase() + model.slice(1);
    const re = new RegExp(`\\b[A-Za-z_$][\\w$]*\\.${prop}\\.(${WRITE_OPS.join('|')})\\s*\\(`);
    return sourceTexts.some((s) => re.test(s));
}

/**
 * 扫出"建了却没人写"的模型。
 *
 * ⚠️ 判据必须**带 `prisma.` 前缀 + 参数左括号**：
 *    只找 `errorItem.create` 这种写法会误伤注释与文档；只找模型名更是全误伤。
 *    （如如那条护栏就栽在"只找名字"上 —— 见 `review-event-wiring.test.ts` 的注释。）
 */
export function findUnwrittenModels(schemaText: string, sourceTexts: readonly string[]): string[] {
    return modelsOf(schemaText).filter((m) => !hasWriter(m, sourceTexts));
}

/* ============================ 真实源码扫描 ============================ */

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
}

const sourceTexts = walk(join(ROOT, 'src'))
    .filter((f) => !f.includes(`${sep}__tests__${sep}`))
    .map((f) => readFileSync(f, 'utf8'));

const schemaText = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

/**
 * **已知遗留模型**（建了、没人写，且**当前不打算修**）。
 *
 * ⚠️ 往这里加第 2 个之前先想清楚：**是真遗留，还是又一个"静默失效"？**
 *    这两者的区别是 —— 遗留是"设计早就换掉了、表忘了删"；
 *    静默失效是"设计还要它、但某个环节没接上"（`ReviewEvent` 就是后者）。
 *    **后者要修，前者可以慢慢清。**
 *
 * 📌 2026-10-16 真真首跑：16 个模型里只有下面这 1 个。
 */
const KNOWN_DEAD: Record<string, string> = {
    ScanReturn:
        '"扫回来的那一面"回录表。回录流程最终走了 ScanVolume / markState 那条路，本表从未接上写入口。' +
        '⚠️ 与 `docs\\03` 第四节"台面剩余"里那条对得上（那里也记着它没有写入方）',
};

describe('数据模型 · 写入口的看门护栏', () => {
    it('★ 扫描器自身要先可信：能认出"没人写"的模型', () => {
        // 教训 #23：护栏必须"能红"。这里用**合成输入**证明它真的会红 ——
        // 不用去动真 schema（动真 schema 风险大、还得记得改回来）。
        const fakeSchema = ['model Foo {', '  id String @id', '}', 'model Bar {', '  id String @id', '}'].join('\n');
        expect(modelsOf(fakeSchema)).toEqual(['Bar', 'Foo']);
        expect(findUnwrittenModels(fakeSchema, ['prisma.foo.create({ data: {} })'])).toEqual(['Bar']);
        expect(findUnwrittenModels(fakeSchema, [])).toEqual(['Bar', 'Foo']);
    });

    it('★ 判据不许"只看名字" —— 注释里提到模型名不算写入口', () => {
        const fakeSchema = 'model Foo {\n  id String @id\n}';
        // 只提到名字（注释 / 类型 / 文档）⇒ 仍然算"没人写"
        expect(findUnwrittenModels(fakeSchema, ['// prisma.foo.create 将来要加', 'const x: Foo = {} as Foo;'])).toEqual([
            'Foo',
        ]);
        // 真的调用了（哪怕写法不同）⇒ 算有写入口
        expect(findUnwrittenModels(fakeSchema, ['await prisma.foo.createMany({ data })'])).toEqual([]);
    });

    it('★★ **事务客户端也算** —— `tx.foo.create(...)` 必须认（本文件第一版就栽在这儿）', () => {
        const fakeSchema = 'model Foo {\n  id String @id\n}';
        // 第一版只认 `prisma.` 前缀 ⇒ 把"只在事务里写"的表误判成没人写；
        // 而白名单里又恰好列着它 ⇒ **扫描器的 bug 与白名单的错误互相印证，测试照样绿**。
        expect(findUnwrittenModels(fakeSchema, ['await tx.foo.create({ data: {} })'])).toEqual([]);
        expect(findUnwrittenModels(fakeSchema, ['await transaction.foo.upsert({ where, create, update })'])).toEqual([]);
    });

    it('★★ 真 schema 里"没人写"的模型，必须**恰好**等于白名单（多一个少一个都要显式改这里）', () => {
        const unwritten = findUnwrittenModels(schemaText, sourceTexts);
        expect(
            unwritten,
            [
                '',
                '有模型建了却没人写。分两种，别混：',
                '  · **真遗留** ⇒ 加进 KNOWN_DEAD 并写清"被谁取代了"；',
                '  · **静默失效**（设计还要它、只是某个环节没接上）⇒ **去修它**，别加白名单。',
                '（ReviewEvent 就是后者：表建好两个月，前端一处都没传。）',
                '',
            ].join('\n'),
        ).toEqual(Object.keys(KNOWN_DEAD).sort());
    });

    it('★ 白名单里的每个模型都必须写清理由（免得变成"不知道为什么在这"）', () => {
        for (const [model, why] of Object.entries(KNOWN_DEAD)) {
            expect(why.length, `${model} 的理由太短了，写清楚它被谁取代`).toBeGreaterThan(15);
        }
    });

    it('★ 核心表一个都不能掉队（这几张是产品的命脉，白名单里出现 = 出大事了）', () => {
        const unwritten = new Set(findUnwrittenModels(schemaText, sourceTexts));
        for (const must of ['ErrorItem', 'Notebook', 'Insight', 'User', 'ReviewEvent', 'DailySettle']) {
            expect(unwritten.has(must), `${must} 竟然没有写入口 —— 这不是遗留，是坏了`).toBe(false);
        }
    });
});
