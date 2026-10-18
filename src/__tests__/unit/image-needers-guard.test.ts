/**
 * 看门护栏 · **要画纸的那几屏，必须把题图要回来**（2026-10-18）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这条护栏是怎么来的（一个"静默无图"的线上 bug）
 *
 * 2026-10-16 的性能修复让 `/api/error-items/list` **默认不返回 `originalImageUrl`**
 * （题图 base64，单张最大约 1.4MB，是其它 37 个字段的几百倍）⇒ 列表从 9.4MB 降到 24KB，很快。
 *
 * 当时真真核了 6 个调用方，结论是"**只有打印预览需要题图**"，于是只给 `print-preview` 加了
 * `?withImages=1`。**漏了两个**：
 *   · `app/review-volumes/page.tsx`（打开某一卷 ⇒ 画这张纸的预览）
 *   · `components/scan-volume-view.tsx`（扫到某一卷 ⇒ 按纸的样子看）
 *
 * 后果（空空 2026-10-18 报的）：**打开已有组卷，所有带图的题都没图了**；
 * 扫到的卷也一样。而且**不报错、不提示**——因为 `useFigureImages(item)` 拿到空的 `src`
 * 只会返回空数组（"大多数题本来就没题图"是常态，所以它不认为这是异常）。
 *
 * ⇒ 这条护栏盯的是：**"要画纸"的三个取数点里，`/api/error-items/list` 必须带 `withImages`**。
 *
 * ⚠️ 判据为什么用"文件名 + 必须出现 withImages"，而不是"扫所有文件找 originalImageUrl"：
 *    那三个要图的文件**从来没写过 `originalImageUrl` 这个名字**（它们通过 `item.originalImageUrl`
 *    在 `useFigureImages` 里间接取），照名字搜是搜不到的 —— 之前漏掉正是这个原因。
 *
 * ⚠️ 新增一个"要画纸"的屏时，**往 `NEED_IMAGES` 里加一行**；加完这条测试会盯着它。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** 这三处都要把"纸"画出来 ⇒ 必须把题图取回来 */
const NEED_IMAGES = [
    'src/app/print-preview/page.tsx',
    'src/app/review-volumes/page.tsx',
    'src/components/scan-volume-view.tsx',
] as const;

/**
 * ⚠️⚠️【为什么不能直接 `toContain('withImages')`】这条护栏**第一版就是假的**：
 *    2026-10-18 我把 `scan-volume-view` 里那行 `params.set("withImages","1")` 临时删掉，
 *    测试**依然是绿的** —— 因为上面那段解释性注释里还有 `withImages` 这个词。
 *    ⇒ 判据必须落在**代码行**：先剔掉注释行，再只认"真的在拼请求参数"的写法。
 *    （同 `review-event-wiring.test.ts` 那次：假护栏比没有护栏更危险，它会让人以为有人看着。）
 */
function codeOnly(src: string): string {
    return src
        .split('\n')
        .filter((line) => {
            const t = line.trim();
            return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
        })
        .join('\n');
}

/** 真的把图要回来的写法：`params.set("withImages", "1")` 或 URL 里拼 `withImages=1` */
const REALLY_ASKS = /params\.set\(\s*["']withImages["']|withImages=1/;

describe('题图 · 要画纸的屏必须带 withImages', () => {
    for (const rel of NEED_IMAGES) {
        it(`★★ ${rel} 的**代码**里必须真的在要图`, () => {
            const src = readFileSync(join(ROOT, rel), 'utf8');
            expect(
                codeOnly(src),
                '这一屏要画纸（题图是纸的一部分）⇒ 拉题时必须带 ?withImages=1（注释里写不算）',
            ).toMatch(REALLY_ASKS);
        });
    }

    it('★ 自检：这三处确实都在调列表接口（判据没失效）', () => {
        const callers = NEED_IMAGES.filter((rel) =>
            codeOnly(readFileSync(join(ROOT, rel), 'utf8')).includes('/api/error-items/list'),
        );
        expect(callers.length).toBe(NEED_IMAGES.length);
    });

    it('★ 自检：`codeOnly` 真的把注释剔掉了（否则判据又变回"注释也算"）', () => {
        const fake = '// params.set("withImages", "1")\n/* withImages=1 */\nconst a = 1;';
        expect(codeOnly(fake)).not.toMatch(REALLY_ASKS);
    });
});
