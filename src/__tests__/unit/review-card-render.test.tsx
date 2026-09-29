// @vitest-environment node
// 渲染冒烟测试用 renderToStaticMarkup（react-dom/server），不需要 jsdom —— 跑 node 快得多。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewSheet, stripMarkdownImages } from '@/components/print/review-card';
import { REVIEW_PAGE_HEIGHT_MM, VOLUME_HEADER_MM, type MeasuredPageLayout } from '@/lib/review-card';
import type { VolumeKind } from '@/lib/volume-code';
import type { ErrorItem } from '@/types/api';

/**
 * 卷（复练纸 T2 / 积累纸 T3）的渲染冒烟测试。
 *
 * 验收标准是"打出来好不好看"，但有几条**肉眼很难发现、后果严重**的，必须由测试兜住：
 *   ① **纸上混进 AI 内容**（解析/答案/错因）——与深挖纸同一条铁律；
 *   ② **块又被人设了固定高度** ⇒ 真实内容一高就被 `overflow: hidden` 切掉
 *      （"升降级只剩半个"就是这个）⇒ 这条要钉死；
 *   ③ 该印的没印（卷头 / 页码 / 页二维码）；不该印的印了（进度格、四角角标、假图）；
 *   ④ 每道题都要有升降级小框。
 */

const item = (extra: Partial<ErrorItem> = {}): ErrorItem =>
    ({
        id: 'e1',
        userId: 'u1',
        originalImageUrl: '/uploads/a.jpg',
        questionText: '一个长方形的长是 8 厘米，宽是 5 厘米，求它的周长和面积。',
        ocrText: '（OCR 原文）',
        answerText: '参考答案不该上纸',
        analysis: '解析不该上纸',
        mistakeAnalysis: '错因不该上纸',
        source: 'SX20260916001',
        masteryLevel: 0,
        tags: [{ name: '周长' }],
        notebook: { grade: '五年级', semester: '上', displayName: '小五上数学', subject: 'sx' },
        createdAt: '2026-09-24T10:00:00.000Z',
        updatedAt: '2026-09-24T10:00:00.000Z',
        ...extra,
    }) as unknown as ErrorItem;

interface RenderOptions {
    kind?: VolumeKind;
    volumeNo?: string;
    gradeText?: string;
    withTweak?: boolean;
    /** 每页放几道（默认全放一页） */
    perPage?: number;
}

function renderSheets(items: ErrorItem[], opts: RenderOptions = {}): string {
    const kind = opts.kind ?? 'review';
    const perPage = opts.perPage ?? items.length;
    const itemByKey: Record<string, ErrorItem> = {};
    for (const i of items) itemByKey[i.id] = i;

    const pages: MeasuredPageLayout[] = [];
    for (let i = 0; i < items.length; i += perPage) {
        pages.push({
            columns: [
                {
                    blocks: items.slice(i, i + perPage).map((it, k) => ({
                        key: it.id,
                        heightMM: 40,
                        seq: i + k + 1,
                    })),
                },
            ],
        });
    }

    return pages
        .map((page, idx) =>
            renderToStaticMarkup(
                <ReviewSheet
                    page={page}
                    pageNo={idx + 1}
                    pageCount={pages.length}
                    volumeNo={opts.volumeNo ?? 'RE20260926001'}
                    kind={kind}
                    gradeText={opts.gradeText ?? '五上'}
                    printDate={new Date(2026, 8, 26)}
                    pageQr="data:image/png;base64,AAAA"
                    itemByKey={itemByKey}
                    blankValueOf={opts.withTweak ? () => 5 : undefined}
                    onBlankChange={opts.withTweak ? () => undefined : undefined}
                    L={(zh) => zh}
                />,
            ),
        )
        .join('\n');
}

describe('卷 · 原题被删的占位（2026-09-30 他定的规矩）', () => {
    /**
     * 他的原话大意：错题本本来就该有进有出。卷里某道题的原题被删了，
     * **不要重排整页**，就地留"题号 + 此题已无"，上下虚线隔开，后面题往前排，页尾空出来就空着。
     * 理由：手机扫这一页二维码，跳出来的是**这一页**，题窜页了扫码就对不上。
     */
    const missingPage: MeasuredPageLayout = {
        columns: [
            {
                blocks: [
                    { key: 'missing:row1', heightMM: 0, seq: 1 },
                    { key: 'e1', heightMM: 40, seq: 2 },
                ],
            },
        ],
    };

    it('★ 传了 missing：该格留"题号 + 此题已无"，真题照旧在', () => {
        const html = renderToStaticMarkup(
            <ReviewSheet
                page={missingPage}
                pageNo={1}
                pageCount={1}
                volumeNo="RE20260930001"
                kind="review"
                printDate={new Date(2026, 8, 30)}
                itemByKey={{ e1: item() }}
                missing={{ 'missing:row1': 'SX20260916001' }}
                L={(zh) => zh}
            />,
        );
        expect(html).toContain('此题已无');
        expect(html).toContain('SX20260916001');
        expect(html).toContain('data-review-block="e1"'); // 真题没被连坐
        // 铁律照旧：占位块上也不许出现 AI 内容
        expect(html).not.toContain('参考答案');
    });

    it('没传 missing（打印预览页那条路）：什么都不画，行为与以前完全一致', () => {
        const html = renderToStaticMarkup(
            <ReviewSheet
                page={missingPage}
                pageNo={1}
                pageCount={1}
                volumeNo="RE20260930001"
                kind="review"
                printDate={new Date(2026, 8, 30)}
                itemByKey={{ e1: item() }}
                L={(zh) => zh}
            />,
        );
        expect(html).not.toContain('此题已无');
        expect(html).toContain('data-review-block="e1"');
    });
});

describe('卷 · 纸上零 AI 内容', () => {
    it('解析 / 错因 / 参考答案一个字都不许出现', () => {
        const html = renderSheets([item()]);
        expect(html).not.toContain('参考答案');
        expect(html).not.toContain('解析');
        expect(html).not.toContain('错因');
        expect(html).not.toContain('不该上纸');
    });
});

describe('卷 · 块不许有固定高度（第三次改版的核心）', () => {
    it('★ 题块只有流式样式，**没有任何 height**', () => {
        const html = renderSheets([item(), item({ id: 'e2' }), item({ id: 'e3' })]);
        expect(html.split('print-review-block').length - 1).toBe(3);
        // 块上出现 height ⇒ 真实内容一高就被 overflow:hidden 切掉，正是要防的
        expect(/print-review-block"[^>]*height/i.test(html)).toBe(false);
    });

    it('答题区给 min-height（留白行数），但不给固定 height', () => {
        const html = renderSheets([item()], { withTweak: true });
        expect(html).toContain('print-review-answer');
        expect(/print-review-answer\\?\\?"[^>]*min-height/.test(html)).toBe(true);
    });
});

describe('卷 · 卷头（页眉）', () => {
    it('阳文框字样：复练纸印「复练」、积累纸印「积累」，且是白底彩框彩字', () => {
        expect(renderSheets([item()], { kind: 'review' })).toContain('复练');
        expect(renderSheets([item()], { kind: 'build' })).toContain('积累');
        expect(renderSheets([item()], { kind: 'review' })).toContain('background:#ffffff');
    });

    it('卷号、页码「第X/Y页」、印刷日期、年级都在', () => {
        const html = renderSheets([item()], { volumeNo: 'RE20260928003', gradeText: '六年级上' });
        expect(html).toContain('RE20260928003');
        expect(html).toContain('1/1');
        expect(html).toContain('2026-09-26');
        expect(html).toContain('六年级上');
    });

    it('卷头收成一排、总高 15mm，二维码在卷头里', () => {
        const html = renderSheets([item()]);
        expect(html).toContain('print-volume-header');
        expect(html).toContain(`height:${VOLUME_HEADER_MM}mm`);
        expect(html).toContain('print-volume-qr');
        expect(html).toContain('print-volume-header-rule');
    });

    it('⚠️ 页眉**不写知识点**（复练/积累纸与深挖纸在这点上不同）', () => {
        const html = renderSheets([item({ tags: [{ name: '□仅知识点占位□' }] } as Partial<ErrorItem>)]);
        expect(html).not.toContain('□仅知识点占位□');
    });
});

describe('卷 · 面的标记规范', () => {
    it('★ **不印四角角标**（2026-09-28 去掉：没有代码认它，二维码自带定位角）', () => {
        const html = renderSheets([item()]);
        for (const at of ['tl', 'tr', 'bl', 'br']) {
            expect(html).not.toContain(`print-review-corner-${at}`);
        }
    });

    it('⚠️ 每题**不再**印题号与二维码（他 2026-09-28 提的第 1 条：只留一条浅虚线）', () => {
        const html = renderSheets([item(), item({ id: 'e2', source: 'SX20260916002' })]);
        expect(html).not.toContain('SX20260916001');
        expect(html).not.toContain('SX20260916002');
        expect(html.split('print-qr').length - 1).toBe(1);
    });

    it('题与题之间是一条**浅灰虚线**，且只有第一条不画', () => {
        const html = renderSheets([item(), item({ id: 'e2' }), item({ id: 'e3' })]);
        expect(html.split('dashed').length - 1).toBe(2);
        expect(html).toContain('#cfcfcf');
    });

    it('流水号从 1 开始，逐题累加；**换页不重置**（第 2 页第一题是 3.）', () => {
        const html = renderSheets([item(), item({ id: 'e2' }), item({ id: 'e3' })], { perPage: 2 });
        for (const n of ['1.', '2.', '3.']) {
            expect(html).toContain(`>${n}<`);
        }
        const page2 = html.split('print-review-sheet').slice(-1)[0];
        expect(page2).toContain('3.');
    });
});

describe('卷 · 打孔位（奇左偶右）', () => {
    it('第 1 页留左、第 2 页留右（与深挖纸正反面同一条物理边）', () => {
        const many = Array.from({ length: 6 }, (_, i) => item({ id: `e${i}` }));
        const html = renderSheets(many, { perPage: 3 });
        // 【2026-09-29 起打孔位走 CSS 变量】屏幕上的"纸边"要叠在它外面、
        // 打印时纸边清零但孔位保留 —— 内联 padding 会被那套覆盖规则吃掉。
        expect(html).toContain('--punch-l:12mm');
        expect(html).toContain('--punch-r:12mm');
    });
});

describe('卷 · 该有的与不该有的', () => {
    it('⚠️ **不印"做几遍"的进度勾格** —— 进度走扫码回收后记在题上', () => {
        const html = renderSheets([item({ manageType: 'review' } as Partial<ErrorItem>)]);
        for (const word of ['第1遍', '第 1 遍', '做几遍', '遍数', '进度格']) {
            expect(html).not.toContain(word);
        }
    });

    it('★ 每道题都有一个升降级小框（不是只有第一题）', () => {
        const html = renderSheets([
            item({ manageType: 'review' } as Partial<ErrorItem>),
            item({ id: 'e2', manageType: 'review' } as Partial<ErrorItem>),
            item({ id: 'e3', manageType: 'deep' } as Partial<ErrorItem>),
        ]);
        expect(html.split('print-promote-box').length - 1).toBe(3);
        expect(html).toContain('升级');
        expect(html).toContain('降级');
    });

    it('★ 未定等级的行**也印框**（按复练 ⇒ 升级）—— 保证每道题都有', () => {
        const html = renderSheets([item(), item({ id: 'e2' })]);
        expect(html.split('print-promote-box').length - 1).toBe(2);
        expect(html).toContain('升级');
    });

    it('留白微调只在**被要求时**渲染，且带 print-review-tweak 类名（打印时由 CSS 隐藏）', () => {
        expect(renderSheets([item()])).not.toContain('print-review-tweak');
        const withTweak = renderSheets([item()], { withTweak: true });
        expect(withTweak).toContain('print-review-tweak');
        expect(withTweak).toContain('5行');
    });

    it('整张纸的高度 = 页高（含 2mm 松量）', () => {
        const html = renderSheets([item()]);
        expect(html).toContain('print-review-sheet');
        expect(html).toContain(`height:${REVIEW_PAGE_HEIGHT_MM}mm`);
    });
});

describe('卷 · 题干里的"假图"要去掉', () => {
    it('markdown 图片语法被剥掉（否则纸上是一个破图标 + 替代文字）', () => {
        const src = '5. 如果下图中的阴影部分表示的小数是（ ）。\n\n![题目图片](https://x/img.png)\n\nA. 0.025';
        const out = stripMarkdownImages(src);
        expect(out).not.toContain('![');
        expect(out).not.toContain('题目图片');
        expect(out).toContain('A. 0.025');
    });

    it('正常文字一个字都不动', () => {
        const src = '一个长方形的长是 8 厘米。';
        expect(stripMarkdownImages(src)).toBe(src);
    });

    it('剥掉后不留一堆空行，也不留行尾空格', () => {
        expect(stripMarkdownImages('甲\n\n![x](y)\n\n\n乙')).toBe('甲\n\n乙');
        expect(stripMarkdownImages('甲   \n乙')).toBe('甲\n乙');
    });
});
