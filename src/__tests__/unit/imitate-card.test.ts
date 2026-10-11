// @vitest-environment node
// 纯逻辑测试：不碰 DOM、不碰数据库。
import { describe, expect, it } from 'vitest';
import {
    buildImitateSegments,
    imitateLayoutFromSnapshot,
    paginateImitate,
    imitatePageCount,
    splitImitateBlocks,
    themeRowOfSnapshot,
    type ImitateSegment,
} from '@/lib/imitate-card';
import { VOLUME_COLUMN_MM } from '@/lib/review-card';

/**
 * 模仿纸的分页 —— 他 2026-10-10 定的规矩。
 *
 * 这张纸跟另外三种**最不一样**的地方就在分页：
 *   左栏（主题的题干/图/答案/解析）**可以顺延到下一页**，
 *   右栏（附题）却**一道题都不许跨页**。
 * 两套规矩并存，还要合成同一批页 —— 这类"两条流"的算法最容易悄悄错
 * （错法是"某一侧少印了一段"或"流水号断了"），所以逐条钉住。
 *
 * ⚠️ 所有高度都按 `VOLUME_COLUMN_MM` 的**比例**算，**不写死 mm 数字** ——
 *    哪天版面常量改了，这些用例照样成立（写死数字就得改一堆测试，且改的人容易改错）。
 */

const USABLE = VOLUME_COLUMN_MM;

/** 造一段（kind 对分页没影响，这里统一用 text） */
const seg = (n: number | string, ratio: number): ImitateSegment => ({
    key: `s${n}`,
    kind: 'text',
    heightMM: USABLE * ratio,
});

describe('模仿纸分页：左栏（主题内容）能顺延，右栏（附题）不跨页', () => {
    it('左栏装不下就顺延到下一页（段不切开、不丢内容）', () => {
        // 每段占 60% 栏高 ⇒ 一段之后就装不下第二段
        const layout = paginateImitate([seg(1, 0.6), seg(2, 0.6), seg(3, 0.6)], []);
        expect(layout.sheets.length).toBe(3);
        expect(layout.sheets[0].left.map((s) => s.key)).toEqual(['s1']);
        expect(layout.sheets[1].left.map((s) => s.key)).toEqual(['s2']);
        expect(layout.sheets[2].left.map((s) => s.key)).toEqual(['s3']);
    });

    it('右栏一道题绝不跨页（放不下就整道换页）', () => {
        const layout = paginateImitate(
            [],
            [
                { key: 'a', heightMM: USABLE * 0.6 },
                { key: 'b', heightMM: USABLE * 0.6 },
            ],
        );
        expect(layout.sheets.length).toBe(2);
        expect(layout.sheets[0].right.map((b) => b.key)).toEqual(['a']);
        expect(layout.sheets[1].right.map((b) => b.key)).toEqual(['b']);
    });

    it('★ 页数 = 两条流里大的那个；先放完的那一侧，后面几页就是空的', () => {
        const layout = paginateImitate(
            [seg(1, 0.6), seg(2, 0.6), seg(3, 0.6)],
            [{ key: 'a', heightMM: USABLE * 0.6 }],
        );
        expect(layout.sheets.length).toBe(3);
        expect(layout.sheets[0].right.map((b) => b.key)).toEqual(['a']);
        // 第 2、3 页右栏是空的（不是"没生成页"，而是那侧先放完了）
        expect(layout.sheets[1].right).toEqual([]);
        expect(layout.sheets[2].right).toEqual([]);
        // 左栏三段一段不缺
        expect(layout.sheets.flatMap((s) => s.left.map((x) => x.key))).toEqual(['s1', 's2', 's3']);
    });

    it('单段比整栏还高 ⇒ 让它独占一页（宁可溢一点，也不能把内容从纸上弄丢）', () => {
        const layout = paginateImitate([{ key: 'long', kind: 'text', heightMM: USABLE * 1.4 }], []);
        expect(layout.sheets.length).toBe(1);
        expect(layout.sheets[0].left.map((s) => s.key)).toEqual(['long']);
        // 左栏归左栏那一本账（`overflowLeft`，界面提示"请拆成两段"），不进右栏的 overflowRight
        expect(layout.overflowRight).toEqual([]);
        expect(layout.overflowLeft.map((o) => o.key)).toEqual(['long']);
    });

    it('附题一栏都装不下 ⇒ 进 overflowRight（界面据此提示"改用深挖纸"），且流水号照样往前走', () => {
        const layout = paginateImitate(
            [],
            [
                { key: 'a', heightMM: USABLE * 0.6 },
                { key: 'huge', heightMM: USABLE * 2 },
                { key: 'b', heightMM: USABLE * 0.6 },
            ],
        );
        expect(layout.overflowRight.map((o) => o.key)).toEqual(['huge']);
        // a 在第 1 页（流水号 1）；huge 排不下但不占位；b 排到第 2 页，流水号仍是 3（不断号）
        expect(layout.sheets[0].right.map((x) => [x.key, x.seq])).toEqual([['a', 1]]);
        expect(layout.sheets[1].right.map((x) => [x.key, x.seq])).toEqual([['b', 3]]);
    });

    it('预留页脚高度会真的从可用高度里扣掉（否则"最后一屏"会溢出纸面）', () => {
        // ⚠️ 比例取 0.45 而不是 0.5：分页每段还要多算 `IMITATE_SEG_SLACK_MM`（2mm）的余量，
        //    0.5 的两段加上余量就超过一栏了（那是**另一个**用例在管的事）。
        const two = [seg(1, 0.45), seg(2, 0.45)];
        // 不预留：两段加余量仍在一栏之内
        expect(paginateImitate(two, []).sheets.length).toBe(1);
        // 预留 30%：第二段就装不下了
        expect(paginateImitate(two, [], USABLE * 0.3).sheets.length).toBe(2);
    });

    it('★ 每段 / 每道附题都多算一点余量（宁可页尾多点白，也不能把内容裁掉）', () => {
        // 两段各占 0.5 栏：不加余量正好凑满一页；加上余量就超了 ⇒ 必须顺延到第 2 页
        expect(paginateImitate([seg(1, 0.5), seg(2, 0.5)], []).sheets.length).toBe(2);
    });

    it('空卷也要有一张纸（界面上是"第 1 / 1 页"，不是 0 页）', () => {
        const layout = paginateImitate([], []);
        expect(layout.sheets.length).toBe(1);
        expect(layout.sheets[0]).toEqual({ left: [], right: [] });
        expect(imitatePageCount(layout)).toBe(1);
    });

    it('段的顺序一个都不能乱（题干 → 图 → 遮挡线 → 答案 → 解析 就是这个顺序）', () => {
        const segs: ImitateSegment[] = [1, 2, 3, 4, 5].map((n) => seg(n, 0.2));
        const layout = paginateImitate(segs, []);
        expect(layout.sheets.flatMap((s) => s.left.map((x) => x.key))).toEqual([
            's1',
            's2',
            's3',
            's4',
            's5',
        ]);
    });
});

/**
 * 左栏的**内容**：把主题拆成段。
 *
 * 顺序是他定的（题干 → 图 → 遮挡线 → 参考答案 → 解析），
 * 而"不印错因"是他 2026-10-10 的**更正**（原稿写过"错因分析"，后来明确作废：
 * 模仿纸问的是"我如何能对"，不谈"错"）。这条要钉死 ——
 * 它跟"纸上零 AI 内容"那条铁律正好相反：**这张纸是唯一允许印答案的**，
 * 所以"哪些能印、哪些不能"必须有测试守着，不能靠记性。
 */
describe('模仿纸左栏：主题拆成段', () => {
    const base = {
        id: 'q1',
        questionText: '一个长方形长 8 厘米，宽 5 厘米，求周长。',
        answerText: '26 厘米',
        analysis: '先算 2×(8+5)。',
    };

    it('★ 顺序 = 题干 → 图 → 遮挡线 → 参考答案 → 解析（他定的顺序）', () => {
        const segs = buildImitateSegments(base, { hasFigure: true });
        expect(segs.map((s) => s.kind)).toEqual(['text', 'figure', 'divider', 'text', 'text']);
        expect(segs.map((s) => s.role)).toEqual(['stem', 'stem', 'stem', 'answer', 'analysis']);
        // ⚠️ 小标题与它的正文**同属一段**（2026-10-12 合并的，理由见 `ImitateSegmentSpec.heading`）
        expect(segs[3].heading).toBe('参考答案');
        expect(segs[3].text).toBe('26 厘米');
        expect(segs[4].heading).toBe('解析');
        expect(segs[4].text).toBe('先算 2×(8+5)。');
    });

    it('★ 小标题只挂在第一块上（不会出现"有标题、没正文"的孤零零一段）', () => {
        const segs = buildImitateSegments(
            { id: 'q1', questionText: '题干', analysis: '第一步。\n\n第二步。' },
            { hasFigure: false },
        );
        const blocks = segs.filter((s) => s.role === 'analysis');
        expect(blocks).toHaveLength(2);
        expect(blocks[0].heading).toBe('解析');
        expect(blocks[1].heading).toBeUndefined();
    });

    it('★ 不印错因（他 10-10 的更正：模仿纸不谈"错"）', () => {
        const segs = buildImitateSegments(
            { ...base, mistakeAnalysis: '这题错在单位没换算' } as typeof base,
            { hasFigure: false },
        );
        const all = segs.flatMap((s) => [s.heading ?? '', s.text]).join('\n');
        expect(all).not.toContain('错');
        expect(all).not.toContain('单位没换算');
    });

    it('没有图就不生成图那一段（不留空白段）', () => {
        const segs = buildImitateSegments(base, { hasFigure: false });
        expect(segs.some((s) => s.kind === 'figure')).toBe(false);
    });

    it('没有答案/解析 ⇒ 连那个小标题都不画（不留孤零零的标题）', () => {
        const segs = buildImitateSegments({ id: 'q2', questionText: '只有题干' }, { hasFigure: false });
        expect(segs.map((s) => s.role)).toEqual(['stem', 'stem']); // 题干 + 遮挡线
        expect(segs.every((s) => !s.heading)).toBe(true);
    });

    it('遮挡线永远在（它就是"题目"与"答案"的分界，题干为空也要有）', () => {
        const segs = buildImitateSegments({ id: 'q3' }, { hasFigure: false });
        expect(segs.filter((s) => s.kind === 'divider')).toHaveLength(1);
    });

    it('题干里的 markdown 图片会被剥掉（题图是单独一段，不然同一张图印两遍）', () => {
        const segs = buildImitateSegments(
            { id: 'q4', questionText: '![图](/x.png)\n求阴影面积' },
            { hasFigure: true },
        );
        const stem = segs.find((s) => s.role === 'stem' && s.kind === 'text');
        expect(stem?.text).toBe('求阴影面积');
        expect(stem?.text).not.toContain('![图]');
    });

    it('题干优先用 questionText，没有才退回 OCR 原文（与复练纸题块同一口径）', () => {
        const a = buildImitateSegments({ id: 'q5', questionText: '编辑过的题干', ocrText: 'OCR 原文' });
        expect(a[0].text).toBe('编辑过的题干');
        const b = buildImitateSegments({ id: 'q6', ocrText: 'OCR 原文' });
        expect(b[0].text).toBe('OCR 原文');
    });
});

/**
 * 【2026-10-12】长文按**语义边界**切块。
 *
 * 为什么要它：主题的解析常常比一整栏还高，而段内部是不拆的 ——
 * 不先切块，那段就只能"整块占一页、尾巴被裁"。他报的"后面 0.3 页不印了"就是这个。
 */
describe('长文按语义边界切块（splitImitateBlocks）', () => {
    it('★ 空行切开（markdown 里就是"另一个段落"）', () => {
        expect(splitImitateBlocks('第一段\n\n第二段')).toEqual(['第一段', '第二段']);
    });

    it('★ 整行的【…】小标题也切开（他这套 AI 解析就是这么分节的）', () => {
        const text = '【解题思路】\n1. 先看条件\n2. 再列式子\n【正确解答推导】\n设 x = 1。';
        expect(splitImitateBlocks(text)).toEqual([
            '【解题思路】\n1. 先看条件\n2. 再列式子',
            '【正确解答推导】\n设 x = 1。',
        ]);
    });

    it('★ 绝不切进列表中间（数字会从 1 重来，那是把内容改错，不是排版）', () => {
        const text = '1. 甲\n2. 乙\n3. 丙';
        expect(splitImitateBlocks(text)).toEqual([text]);
    });

    it('★ 绝不切进 $$ 公式（公式里常有空行）', () => {
        const text = '$$\na = 1\n\nb = 2\n$$\n\n后面这段才切';
        expect(splitImitateBlocks(text)).toEqual(['$$\na = 1\n\nb = 2\n$$', '后面这段才切']);
    });

    it('一行写完的 $$x$$ 不会把后面的切块规则带跑', () => {
        const text = '已知 $$a=1$$\n\n下一段';
        expect(splitImitateBlocks(text)).toEqual(['已知 $$a=1$$', '下一段']);
    });

    it('空内容 ⇒ 一块都没有（不造空段）', () => {
        expect(splitImitateBlocks('')).toEqual([]);
        expect(splitImitateBlocks('   \n\n  ')).toEqual([]);
    });
});

describe('一段比一整栏还高 ⇒ 记进 overflowLeft（界面据此提示拆分）', () => {
    const segOf = (key: string, ratio: number): ImitateSegment => ({
        key,
        kind: 'text',
        heightMM: USABLE * ratio,
    });

    it('★ 超高的那一（几）段被点名，其余照常排版', () => {
        const layout = paginateImitate(
            [segOf('short', 0.3), segOf('huge', 1.5), segOf('short2', 0.3)],
            [],
        );
        expect(layout.overflowLeft.map((o) => o.key)).toEqual(['huge']);
        // 超高的那段仍然独占一页（宁可溢一点，也不能把它从纸上弄丢）
        const all = layout.sheets.flatMap((s) => s.left.map((x) => x.key));
        expect(all).toEqual(['short', 'huge', 'short2']);
    });

    it('正常高度的段一个都不进 overflowLeft', () => {
        const layout = paginateImitate([segOf('a', 0.3), segOf('b', 0.3)], []);
        expect(layout.overflowLeft).toEqual([]);
    });
});

describe('模仿卷 · 按**快照**还原版面（2026-10-11）', () => {
    const seg = (key: string, h: number): ImitateSegment => ({ key, kind: 'text', heightMM: h });

    it('★ 右栏只认快照：哪一页有哪几道 = 快照说了算，不重排', () => {
        // 快照：第 1 页有 B、第 2 页有 C（哪怕它们其实放得下同一页，也不许挪）
        const rows = [
            { key: 'B', seq: 1, pageIndex: 1, columnIndex: 1, seqInColumn: 1 },
            { key: 'C', seq: 2, pageIndex: 2, columnIndex: 1, seqInColumn: 1 },
        ];
        const layout = imitateLayoutFromSnapshot(rows, []);
        expect(layout.sheets.length).toBe(2);
        expect(layout.sheets[0].right.map((r) => r.key)).toEqual(['B']);
        expect(layout.sheets[1].right.map((r) => r.key)).toEqual(['C']);
        // 流水号跟着快照走（跨页连号）
        expect(layout.sheets[1].right[0].seq).toBe(2);
    });

    it('★ 左栏按主题**现算**（快照里不存分段）：段够长就自己多出一页', () => {
        const rows = [{ key: 'B', seq: 1, pageIndex: 1, columnIndex: 1, seqInColumn: 1 }];
        // 每段 0.6 栏高 ⇒ 一页只放得下一段 ⇒ 左栏自己 2 页
        const layout = imitateLayoutFromSnapshot(rows, [
            seg('t:stem', VOLUME_COLUMN_MM * 0.6),
            seg('t:divider', VOLUME_COLUMN_MM * 0.6),
        ]);
        expect(layout.sheets.length).toBe(2);
        expect(layout.sheets[0].left.map((s) => s.key)).toEqual(['t:stem']);
        expect(layout.sheets[1].left.map((s) => s.key)).toEqual(['t:divider']);
        // 第 2 页右栏空着（右栏第 1 页就排完了）
        expect(layout.sheets[1].right).toEqual([]);
    });

    it('页数取两条流里大的那个（右栏长 ⇒ 左栏后面几页空着）', () => {
        const rows = [
            { key: 'B', seq: 1, pageIndex: 1, columnIndex: 1, seqInColumn: 1 },
            { key: 'C', seq: 2, pageIndex: 2, columnIndex: 1, seqInColumn: 1 },
            { key: 'D', seq: 3, pageIndex: 3, columnIndex: 1, seqInColumn: 1 },
        ];
        const layout = imitateLayoutFromSnapshot(rows, [seg('t:stem', 10)]);
        expect(layout.sheets.length).toBe(3);
        expect(layout.sheets[0].left.length).toBe(1);
        expect(layout.sheets[2].left).toEqual([]);
    });

    it('左栏那一行（columnIndex 0）**不算右栏**：传进来也不许印成附题', () => {
        const rows = [
            { key: 'theme', seq: 0, pageIndex: 1, columnIndex: 0, seqInColumn: 1 },
            { key: 'B', seq: 1, pageIndex: 1, columnIndex: 1, seqInColumn: 1 },
        ];
        const layout = imitateLayoutFromSnapshot(rows, []);
        expect(layout.sheets[0].right.map((r) => r.key)).toEqual(['B']);
    });

    it('主题被删（左栏一个段都没有）⇒ 仍然出得来一张纸，只是左栏空着', () => {
        const rows = [{ key: 'B', seq: 1, pageIndex: 1, columnIndex: 1, seqInColumn: 1 }];
        const layout = imitateLayoutFromSnapshot(rows, []);
        expect(layout.sheets.length).toBe(1);
        expect(layout.sheets[0].left).toEqual([]);
    });

    it('themeRowOfSnapshot：挑得出左栏那一行，挑不到就 null（不猜）', () => {
        const rows = [
            { key: 'B', seq: 1, pageIndex: 1, columnIndex: 1, seqInColumn: 1 },
            { key: 'theme', seq: 0, pageIndex: 1, columnIndex: 0, seqInColumn: 1 },
        ];
        expect(themeRowOfSnapshot(rows)?.key).toBe('theme');
        expect(themeRowOfSnapshot([rows[0]])).toBeNull();
    });
});
