/**
 * 【2026-10-16 真真】看门测试：**列表接口的字段清单必须与 schema 对齐**。
 *
 * 为什么需要：`/api/error-items/list` 现在用**显式 `select`**（为了不传题图、把 9.4MB 降到 23KB），
 * 而显式 select 的代价是 —— **schema 加了字段，这里忘了同步，新字段就永远读不到**，
 * 而且**静默**（接口不报错、界面只是少一个字段）。
 *
 * ⚠️ 这正是本项目反复踩的那类坑（`ReviewEvent` 空表、4 个写入点漏传）⇒ 用测试钉住，别靠人记。
 * ⚠️ 本仓这个 Prisma 版本（5.22）**不支持 `omit`**（实测报 `Unknown argument 'omit'`），
 *    所以只能用显式 select —— 这条护栏是那个选择的必要配套。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIST_ITEM_OMITTED, LIST_ITEM_SCALARS } from '@/lib/constants/error-item-list-fields';

/** 从 schema 文本里抽出某个模型的**标量**字段名（排除关系字段与数组） */
export function scalarFieldsOf(schemaText: string, modelName: string): string[] {
    const start = schemaText.indexOf(`model ${modelName} `);
    if (start < 0) throw new Error(`schema 里找不到 model ${modelName}`);
    const body = schemaText.slice(start, schemaText.indexOf('\n}', start));
    const relationModels = new Set(
        schemaText
            .split('\n')
            .filter((l) => l.startsWith('model '))
            .map((l) => l.split(/\s+/)[1]),
    );

    const out: string[] = [];
    for (const line of body.split('\n').slice(1)) {
        const t = line.trim();
        if (!t || t.startsWith('///') || t.startsWith('//') || t.startsWith('@')) continue;
        const m = t.match(/^([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_?]*(?:\[\])?)/);
        if (!m) continue;
        const [, name, type] = m;
        const bare = type.replace(/\[\]$/, '').replace(/\?$/, '');
        // 关系字段：类型是另一个 model 名（或本 model）⇒ 跳过；数组字段也跳过
        if (type.endsWith('[]') || relationModels.has(bare)) continue;
        out.push(name);
    }
    return out;
}

const ROOT = process.cwd();
const schemaText = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

describe('列表接口字段清单 · 与 schema 的同步护栏', () => {
    it('★ 解析器自身要先可信（拿 schema 真读一遍，字段数是几十个量级）', () => {
        const fields = scalarFieldsOf(schemaText, 'ErrorItem');
        expect(fields.length).toBeGreaterThan(30);
        expect(fields).toContain('id');
        expect(fields).toContain('originalImageUrl');
        // 关系字段不许混进来
        expect(fields).not.toContain('notebook');
        expect(fields).not.toContain('tags');
        expect(fields).not.toContain('reviewEvents');
    });

    it('★★ `LIST_ITEM_SCALARS` + `LIST_ITEM_OMITTED` 必须**恰好**等于 schema 的全部标量字段', () => {
        const inSchema = scalarFieldsOf(schemaText, 'ErrorItem').slice().sort();
        const declared = [...LIST_ITEM_SCALARS, ...LIST_ITEM_OMITTED].slice().sort();

        const missing = inSchema.filter((f) => !declared.includes(f)); // schema 有、这里没声明
        const extra = declared.filter((f) => !inSchema.includes(f)); // 这里声明了、schema 没有（改名/拼错）

        expect(
            { missing, extra },
            [
                '',
                '列表接口的字段清单与 schema 不一致。两种改法：',
                '  · schema 加了字段 ⇒ 去 lib/constants/error-item-list-fields.ts 的 LIST_ITEM_SCALARS 补上；',
                '  · schema 删/改了字段 ⇒ 把旧名字从那个清单里去掉。',
                '⚠️ 漏了不会报错，只会"界面上少一个字段"—— 静默的那种。',
                '',
            ].join('\n'),
        ).toEqual({ missing: [], extra: [] });
    });

    it('★ 被排除的**只有题图**一个 —— 别拿这个清单当"想省就省"的后门', () => {
        expect([...LIST_ITEM_OMITTED]).toEqual(['originalImageUrl']);
    });

    it('★ 清单里不许有重复（重复说明手抖贴了两遍）', () => {
        const all = [...LIST_ITEM_SCALARS, ...LIST_ITEM_OMITTED];
        expect(all.length).toBe(new Set(all).size);
    });
});
