// @vitest-environment node
// 渲染冒烟测试用 renderToStaticMarkup（react-dom/server），不需要 jsdom —— 跑 node 快得多。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImitateSheet } from '@/components/print/imitate-card';
import { buildImitateSegments, paginateImitate, withHeights, type ImitateSegmentSpec } from '@/lib/imitate-card';
import { VOLUME_COLUMN_MM } from '@/lib/review-card';
import type { ErrorItem } from '@/types/api';

/**
 * 模仿纸（T4）的渲染冒烟测试。
 *
 * 这张纸跟另外三种**反着来**：它**故意印 AI 内容**（左栏的参考答案与解析），
 * 所以"哪些该印、哪些不该印"必须由测试盯着 —— 这里一旦松了，
 * 要么左栏漏印答案（孩子没法照抄，纸就白印了），要么把**错因**也印上去
 * （他 2026-10-10 明确更正过："模仿纸不谈'错'这件事"）。
 *
 * 另外三条肉眼很难发现的：
 *   ① **左栏贯通**：一页放不下要顺延到下一页，且下一页右栏可以是空的；
 *   ② **右栏附题不跨页**、每题都要有升降级小框；
 *   ③ 主题被删 ⇒ 整卷作废（白纸 + 题号 + "此卷作废，建议删除"）；附题被删 ⇒ 就地"此题已无"。
 *
 * ⚠️ 写断言时想清"看哪一页"：左栏会顺延，所以"印了什么内容"要扫**全部页**；
 *    只有"某一页装了哪几段/有没有附题"这类才该锁定单页（第一版就在这里踩过）。
 */

const item = (extra: Partial<ErrorItem> = {}): ErrorItem =>
    ({
        id: 'e1',
        userId: 'u1',
        originalImageUrl: '/uploads/a.jpg',
        questionText: 'STEM-TEXT-9CM',
        ocrText: '（OCR 原文）',
        answerText: 'A-ANSWER-TEXT',
        analysis: 'A-ANALYSIS-TEXT',
        mistakeAnalysis: 'WRONG-REASON-TEXT',
        source: 'SX20260916001',
        masteryLevel: 0,
        tags: [{ name: '周长' }],
        notebook: { grade: '五年级', semester: '上', displayName: '小五上数学', subject: 'sx' },
        createdAt: '2026-09-24T10:00:00.000Z',
        updatedAt: '2026-09-24T10:00:00.000Z',
        ...extra,
    }) as unknown as ErrorItem;

/** 右栏的一格：要么是真实附题，要么是"题已删、只剩题号快照"的空壳 */
interface RightSlot {
    key: string;
    item?: ErrorItem;
    /** 只有空壳才有：快照里的题号（null = 当时就没题号） */
    missingNo?: string | null;
}

interface RenderOptions {
    /** 主题传 null = 主题已被删除（整卷作废） */
    theme?: ErrorItem | null;
    themeNo?: string | null;
    /** 左栏每段占一栏高度的比例（默认 0.35 ⇒ 一页 2 段） */
    segRatio?: number;
    /** 每道附题占一栏高度的比例（默认 0.9 ⇒ 一页 1 道） */
    blockRatio?: number;
    withTweak?: boolean;
}

/** 按真实的分页函数排一遍，把每一页都渲染出来（返回每页的 HTML） */
function renderSheets(slots: RightSlot[], opts: RenderOptions = {}): string[] {
    const theme = opts.theme === undefined ? item() : opts.theme;
    const segRatio = opts.segRatio ?? 0.35;
    const blockRatio = opts.blockRatio ?? 0.9;

    const specs: ImitateSegmentSpec[] = theme ? buildImitateSegments(theme, { hasFigure: false }) : [];
    const segmentByKey: Record<string, ImitateSegmentSpec> = {};
    for (const s of specs) segmentByKey[s.key] = s;

    const layout = paginateImitate(
        withHeights(specs, () => VOLUME_COLUMN_MM * segRatio),
        slots.map((s) => ({ key: s.key, heightMM: VOLUME_COLUMN_MM * blockRatio })),
    );

    const itemByKey: Record<string, ErrorItem> = {};
    const missing: Record<string, string | null> = {};
    for (const s of slots) {
        if (s.item) itemByKey[s.key] = s.item;
        else missing[s.key] = s.missingNo ?? null;
    }

    return layout.sheets.map((sheet, idx) =>
        renderToStaticMarkup(
            <ImitateSheet
                sheet={sheet}
                segmentByKey={segmentByKey}
                theme={theme}
                themeNo={opts.themeNo ?? null}
                pageNo={idx + 1}
                pageCount={layout.sheets.length}
                volumeNo="CO20261011001"
                kind="imitate"
                gradeText="五上"
                printDate={new Date(2026, 9, 11)}
                pageQr="data:image/png;base64,AAAA"
                itemByKey={itemByKey}
                missing={missing}
                blankValueOf={opts.withTweak ? () => 5 : undefined}
                onBlankChange={opts.withTweak ? () => undefined : undefined}
                L={(zh) => zh}
            />,
        ),
    );
}

/** 全部页拼成一份 HTML —— 检查"印了什么内容"时用它（左栏会顺延，只看第 1 页会漏） */
function renderAll(slots: RightSlot[], opts: RenderOptions = {}): string {
    return renderSheets(slots, opts).join('\n');
}

/**
 * 省事的写法：右栏就是几道真题。
 *
 * ⚠️ 附题的题干**故意与主题不同**（`RIGHT-STEM-TEXT`）：两边都用同一串字的话，
 *   "左栏内容不重复印"这类断言会被右栏那份撞中，看着像 bug、其实是测试数据的问题。
 */
const real = (...ids: string[]): RightSlot[] =>
    ids.map((id) => ({ key: id, item: item({ id, questionText: 'RIGHT-STEM-TEXT' }) }));

describe('模仿纸 · 左栏（主题）：该印的与**不该印**的', () => {
    it('★ 左栏按他定的顺序印：题干 → 遮挡线 → 参考答案 → 解析', () => {
        const html = renderAll(real('b1'));
        const stem = html.indexOf('STEM-TEXT-9CM');
        const divider = html.indexOf('遮挡线');
        const answerHead = html.indexOf('参考答案');
        const analysisHead = html.indexOf('解析');
        expect(stem).toBeGreaterThan(-1);
        expect(divider).toBeGreaterThan(stem);
        expect(answerHead).toBeGreaterThan(divider);
        expect(analysisHead).toBeGreaterThan(answerHead);
        // 正文也真的印出来了（只有小标题没有内容 = 孩子抄不到东西）
        expect(html).toContain('A-ANSWER-TEXT');
        expect(html).toContain('A-ANALYSIS-TEXT');
    });

    it('★★ 铁律的例外要守得准：**印答案与解析，但一个字都不许印错因**', () => {
        // 他 2026-10-10 的原话："模仿纸的意图是我如何能对……所以就不谈'错'这件事了"。
        const html = renderAll(real('b1'));
        expect(html).toContain('A-ANSWER-TEXT');
        expect(html).toContain('A-ANALYSIS-TEXT');
        expect(html).not.toContain('WRONG-REASON-TEXT');
        // 连"错因"这个小标题都不许出现
        expect(html).not.toContain('错因');
    });

    it('左栏取不到题干时，遮挡线**照样在**（它是题目与答案的分界，不是装饰）', () => {
        const html = renderAll(real('b1'), { theme: item({ questionText: null, ocrText: null }) });
        expect(html).toContain('遮挡线');
        expect(html).toContain('A-ANSWER-TEXT');
        expect(html).not.toContain('STEM-TEXT-9CM');
    });

    it('没有答案/解析 ⇒ 连小标题都不画（免得纸上一个孤标题 + 一片空白）', () => {
        const html = renderAll(real('b1'), { theme: item({ answerText: null, analysis: null }) });
        expect(html).not.toContain('参考答案');
        expect(html).not.toContain('解析');
        expect(html).toContain('遮挡线');
    });

    it('左栏的段带 data-imitate-seg 锚点（量尺靠它逐段读高度，缺了就等于没量）', () => {
        const html = renderAll(real('b1'));
        expect(html).toContain('data-imitate-seg="e1:stem"');
        expect(html).toContain('data-imitate-seg="e1:divider"');
        expect(html).toContain('data-imitate-seg="e1:analysis"');
    });
});

describe('模仿纸 · 左栏贯通（与另外三种纸最大的不同）', () => {
    it('★ 一页放不下 ⇒ 顺延到下一页（不是被裁掉）', () => {
        // 6 段 × 0.35 栏高 ⇒ 每页 2 段 ⇒ 3 页
        const pages = renderSheets(real('b1'), { segRatio: 0.35 });
        expect(pages.length).toBe(3);
        expect(pages[0]).toContain('STEM-TEXT-9CM');
        expect(pages[0]).toContain('遮挡线');
        expect(pages[1]).toContain('A-ANSWER-TEXT'); // 答案在第 2 页
        expect(pages[2]).toContain('A-ANALYSIS-TEXT'); // 解析在第 3 页
    });

    it('★ 段**不切开**：一段装不下就整段挪走（不做文本级切分）', () => {
        // 每段 0.6 栏高 ⇒ 一页只放得下一段；遮挡线自己占一页
        const pages = renderSheets(real('b1'), { segRatio: 0.6 });
        expect(pages.length).toBe(6);
        expect(pages[0]).toContain('STEM-TEXT-9CM');
        expect(pages[0]).not.toContain('遮挡线'); // 没被硬塞进上一页
        expect(pages[1]).toContain('遮挡线');
        expect(pages[1]).not.toContain('STEM-TEXT-9CM'); // 题干也不重复印
    });

    it('★ 某侧先排完，那侧后面的页就空着（页数取两侧大的那个）', () => {
        // 左栏 3 页、右栏 1 道（1 页）⇒ 第 2/3 页右栏为空，但纸照样出
        const pages = renderSheets(real('b1'));
        expect(pages.length).toBe(3);
        expect(pages[1]).not.toContain('print-promote-box'); // 第 2 页右栏空
        expect(pages[1]).toContain('A-ANSWER-TEXT'); // 但左栏接着印
    });
});

describe('模仿纸 · 右栏（附题）', () => {
    it('附题沿用复练纸那套：流水号 + 每题一个升降级小框', () => {
        const pages = renderSheets(real('b1', 'b2'));
        // 左栏 3 页、右栏 2 道（每页 1 道 ⇒ 2 页）⇒ 一共 3 页
        expect(pages.length).toBe(3);
        expect(pages[0]).toContain('data-review-block="b1"');
        expect(pages[1]).toContain('data-review-block="b2"');
        expect(pages[2]).not.toContain('data-review-block'); // 第 3 页右栏空
        // 流水号连号（跨页也不断）
        expect(pages[0]).toContain('1.');
        expect(pages[1]).toContain('2.');
        // 每道题都有升降级框（他要求"右边栏每道题右下角都有升降级框"）
        expect(pages[0]).toContain('print-promote-box');
        expect(pages[1]).toContain('print-promote-box');
    });

    it('★ 附题被删 ⇒ 就地印"题号 + 此题已无"，不重排、后面的题照排', () => {
        const pages = renderSheets([
            { key: 'gone:1', missingNo: 'SX20260916999' },
            { key: 'b2', item: item({ id: 'b2' }) },
        ]);
        const all = pages.join('\n');
        expect(all).toContain('此题已无');
        expect(all).toContain('SX20260916999');
        // 占位块就是"一道普通的题"：不画自己的虚线、也没有升降级框（与复练纸同一条规矩）
        expect(pages[0]).not.toContain('print-promote-box');
        // 真题照旧在后面（没被连坐）
        expect(pages[1]).toContain('data-review-block="b2"');
    });

    it('留白微调（− X ＋）只在传了回调时才有（打印那一路完全没有它）', () => {
        expect(renderAll(real('b1'), { withTweak: true })).toContain('print-review-tweak');
        expect(renderAll(real('b1'))).not.toContain('print-review-tweak');
    });
});

describe('模仿纸 · 卷头与作废', () => {
    it('卷头印：阳文框「模仿」+ 卷号 + 第X/Y页 + 页二维码，且用模仿卷那个蓝', () => {
        const html = renderSheets(real('b1'))[0];
        expect(html).toContain('模仿');
        expect(html).toContain('CO20261011001');
        expect(html).toContain('1/3'); // 3 页：左栏 6 段 ÷ 每页 2 段
        expect(html).toContain('data:image/png;base64,AAAA');
        expect(html).toContain('#1e40af'); // 模仿 = 蓝（他原稿写的"蓝色框、蓝色字"）
    });

    it('★ 主题被删 ⇒ 整卷作废：白纸 + 题号 + "此卷作废，建议删除"，且不印任何内容', () => {
        const html = renderSheets(real('b1'), { theme: null, themeNo: 'SX20260916001' })[0];
        expect(html).toContain('SX20260916001');
        expect(html).toContain('此卷作废');
        expect(html).not.toContain('print-promote-box'); // 附题也不印
        expect(html).not.toContain('遮挡线');
    });

    it('模仿纸是**卷**：打孔位与复练纸同一条物理边（奇数页左、偶数页右）', () => {
        const pages = renderSheets(real('b1'));
        expect(pages[0]).toContain('print-imitate-sheet');
        expect(pages[0]).toContain('--punch-l:12mm');
        expect(pages[1]).toContain('--punch-r:12mm'); // 第 2 页翻到右边
    });
});
