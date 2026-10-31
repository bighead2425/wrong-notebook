import { describe, expect, it } from 'vitest';
import { MATH_CURRICULUM } from '@/lib/tag-data/math';
import { buildResolverIndex, resolveTagRefs, type FlatTag } from '@/lib/tag-resolve';

/**
 * 重名回归表 —— 「挂错册必须是 0」的静态版。
 *
 * 【2026-10-31】为什么不拍 38 张照片：
 * 会挂错册的根因是**名字到册的解析**，跟图片没有关系。用真实词表把全库节点复原出来，
 * 对每一条（册 + 节 + 名）各解析一次，几百毫秒就能覆盖全部 640 条 —— 比人工拍 38 张
 * 更严格，而且以后改词表会自动重跑。
 *
 * 真图片只用 6–8 道（含高三和跨年级复习卷）验证端到端，见第二批的验收清单。
 */

interface Entry { book: string; chapter: string; section: string; name: string }

function flattenMath(): { tags: FlatTag[]; entries: Entry[] } {
    const tags: FlatTag[] = [];
    const entries: Entry[] = [];
    let n = 0;
    const id = (p: string) => `${p}${n++}`;

    for (const [book, chapters] of Object.entries(MATH_CURRICULUM)) {
        const bookId = id('bk');
        tags.push({ id: bookId, name: book, parentId: null });

        for (const ch of chapters) {
            const chId = id('ch');
            tags.push({ id: chId, name: ch.chapter, parentId: bookId });

            for (const sec of ch.sections) {
                const secId = id('sc');
                tags.push({ id: secId, name: sec.section, parentId: chId });

                for (const name of sec.tags) {
                    tags.push({ id: id('tg'), name, parentId: secId });
                    entries.push({ book, chapter: ch.chapter, section: sec.section, name });
                }
            }
        }
    }
    return { tags, entries };
}

const { tags, entries } = flattenMath();
const index = buildResolverIndex(tags);
const byId = new Map(tags.map((t) => [t.id, t]));

/** 名字 → 出现在哪几册 */
const booksByName = new Map<string, Set<string>>();
for (const e of entries) {
    const set = booksByName.get(e.name) ?? new Set<string>();
    set.add(e.book);
    booksByName.set(e.name, set);
}
const duplicated = [...booksByName.entries()].filter(([, books]) => books.size > 1);

describe('数学词表 · 重名回归', () => {
    it('词表规模与重名规模符合预期（防止词表被误删/误并）', () => {
        expect(entries.length).toBeGreaterThan(500);
        // 2026-10-31 实测 38 组；只做下限保护，改教材时不会误红
        expect(duplicated.length).toBeGreaterThanOrEqual(30);
    });

    it('跨册重名：册说对了，**一条都不许挂到别的册**', () => {
        const wrong: string[] = [];

        for (const [name, books] of duplicated) {
            for (const book of books) {
                const [r] = resolveTagRefs([{ book, name }], index, tags);
                if (!r.tagId) {
                    // 同名但该册没有？说明构造有问题，也要报
                    wrong.push(`${book} / ${name} → 未命中`);
                    continue;
                }
                const hit = byId.get(r.tagId);
                // 找到它的册（往上爬）
                let cur = hit;
                while (cur?.parentId) cur = byId.get(cur.parentId);
                if (cur?.name !== book) {
                    wrong.push(`${book} / ${name} → 挂到了 ${cur?.name}`);
                }
            }
        }

        expect(wrong).toEqual([]);
    });

    it('全库每一条（册 + 节 + 名）都能 path 命中，且落在正确的那一节', () => {
        const wrong: string[] = [];

        for (const e of entries) {
            const [r] = resolveTagRefs(
                [{ book: e.book, section: e.section, name: e.name }],
                index,
                tags,
            );
            if (r.matchedBy !== 'path') {
                wrong.push(`${e.book} / ${e.section} / ${e.name} → ${r.matchedBy}`);
                continue;
            }
            const hit = byId.get(r.tagId!);
            const parent = hit?.parentId ? byId.get(hit.parentId) : null;
            if (parent?.name !== e.section) {
                wrong.push(`${e.book} / ${e.section} / ${e.name} → 落在了 ${parent?.name}`);
            }
        }

        expect(wrong).toEqual([]);
    });

    it('高三上 / 高三下 都能归到「高三」这一册（修复前是整册掉出清单）', () => {
        const gaoSan = entries.filter((e) => e.book === '高三');
        expect(gaoSan.length).toBeGreaterThan(0);

        for (const term of ['高三上', '高三下']) {
            const [r] = resolveTagRefs(
                [{ book: term, section: gaoSan[0].section, name: gaoSan[0].name }],
                index,
                tags,
            );
            expect(r.matchedBy).toBe('path');
        }
    });
});
