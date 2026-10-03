/**
 * 复练纸回录（纸回录第二步）· 纯逻辑单测。
 *
 * 本机没有 AI key，"真跑一次 AI"做不到；所以把最容易写错、又完全能纯测的两段钉死：
 *   ① 「卷页面版图 → 给 AI 的地图」（栏序、块序、题被删）；
 *   ② 「AI 读数 → 每题该写什么」（只写她标了的、题被删只写卷行）。
 * 顺带覆盖扫码分流与查卷降级（卷查不到 / 码不是本卷 / 这一页为空）。
 */
import { describe, it, expect } from 'vitest';
import {
    classifyRecoveryCode,
    slotOfRow,
    pageRowsOf,
    buildReviewPageMap,
    parseReviewReading,
    normalizeMarkValue,
    applyReadingToRows,
    planRecoveryWrites,
    resolveRecoveryLookup,
    type RecoveryRow,
} from '@/lib/review-recover';
import {
    generateRecoverReviewPrompt,
    DEFAULT_RECOVER_REVIEW_TEMPLATE,
} from '@/lib/ai/prompts';

/** 造一行卷条目 */
function row(p: Partial<RecoveryRow> & { rowId: string }): RecoveryRow {
    return {
        pageIndex: 1,
        columnIndex: 0,
        seqInColumn: 1,
        seqInVolume: 1,
        itemNo: null,
        questionText: null,
        errorItemId: null,
        ...p,
    };
}

describe('classifyRecoveryCode · 按二维码类型分流', () => {
    it('裸题号 ⇒ question（走深挖流程）', () => {
        expect(classifyRecoveryCode(' sx20260916001 ')).toEqual({ route: 'question', value: 'SX20260916001' });
    });
    it('复练纸页二维码 ⇒ review-page', () => {
        expect(classifyRecoveryCode('RE20260926001-02')).toEqual({
            route: 'review-page',
            pageCode: 'RE20260926001-02',
            volumeNo: 'RE20260926001',
            pageNo: 2,
        });
    });
    it('积累纸页二维码 ⇒ build-page（这一屏处理不了，要明确提示）', () => {
        expect(classifyRecoveryCode('BU20260926001-01')).toEqual({
            route: 'build-page',
            pageCode: 'BU20260926001-01',
            volumeNo: 'BU20260926001',
            pageNo: 1,
        });
    });
    it('空 ⇒ empty；认不出 ⇒ unknown（原样留着）', () => {
        expect(classifyRecoveryCode('   ')).toEqual({ route: 'empty' });
        expect(classifyRecoveryCode('https://a.b/c')).toEqual({ route: 'unknown', value: 'https://a.b/c' });
    });
});

describe('slotOfRow · 槽位代号', () => {
    it('左栏 L1/L2、右栏 R1', () => {
        expect(slotOfRow({ columnIndex: 0, seqInColumn: 1 })).toBe('L1');
        expect(slotOfRow({ columnIndex: 0, seqInColumn: 2 })).toBe('L2');
        expect(slotOfRow({ columnIndex: 1, seqInColumn: 1 })).toBe('R1');
    });
});

describe('pageRowsOf · 取这一页、按栏与块序排好', () => {
    it('只留这一页的，且按 columnIndex→seqInColumn 排序', () => {
        const rows = [
            row({ rowId: 'a', pageIndex: 1, columnIndex: 1, seqInColumn: 2 }),
            row({ rowId: 'b', pageIndex: 2, columnIndex: 0, seqInColumn: 1 }),
            row({ rowId: 'c', pageIndex: 1, columnIndex: 0, seqInColumn: 1 }),
            row({ rowId: 'd', pageIndex: 1, columnIndex: 1, seqInColumn: 1 }),
        ];
        expect(pageRowsOf(rows, 1).map((r) => r.rowId)).toEqual(['c', 'd', 'a']);
        expect(pageRowsOf(rows, 2).map((r) => r.rowId)).toEqual(['b']);
    });
});

describe('buildReviewPageMap · 版面地图（单栏 vs 双栏 / 题被删）', () => {
    it('单栏：只有左栏一块，按块序列出，含题号与题干', () => {
        const map = buildReviewPageMap([
            row({ rowId: 'a', columnIndex: 0, seqInColumn: 1, seqInVolume: 1, itemNo: 'SX20260916001', questionText: '计算 1/2+1/3', errorItemId: 'q1' }),
            row({ rowId: 'b', columnIndex: 0, seqInColumn: 2, seqInVolume: 2, itemNo: 'SX20260916002', questionText: '计算 1/4+1/5', errorItemId: 'q2' }),
        ]);
        expect(map).toContain('左栏（从上到下）：');
        expect(map).not.toContain('右栏');
        expect(map).toContain('L1｜流水 1｜题号 SX20260916001｜题干：计算 1/2+1/3');
        expect(map).toContain('L2｜流水 2｜题号 SX20260916002｜题干：计算 1/4+1/5');
    });

    it('双栏：左右两栏各自从上到下（先左后右）', () => {
        const map = buildReviewPageMap([
            row({ rowId: 'a', columnIndex: 0, seqInColumn: 1, seqInVolume: 1, itemNo: 'SX20260916001', errorItemId: 'q1' }),
            row({ rowId: 'b', columnIndex: 1, seqInColumn: 1, seqInVolume: 2, itemNo: 'SX20260916002', errorItemId: 'q2' }),
        ]);
        expect(map.indexOf('左栏（从上到下）：')).toBeLessThan(map.indexOf('右栏（从上到下）：'));
        expect(map).toContain('L1｜');
        expect(map).toContain('R1｜');
    });

    it('★ 题被删（errorItemId 为空）：纸上有这一格，地图里明确标出来', () => {
        const map = buildReviewPageMap([
            row({ rowId: 'a', columnIndex: 0, seqInColumn: 1, seqInVolume: 1, itemNo: 'SX20260916001', questionText: '被删的题', errorItemId: null }),
        ]);
        expect(map).toContain('（纸上有这一格，但题已从题库删除）');
        expect(map).not.toContain('被删的题');
    });

    it('没有题干文本时给占位（不抛）', () => {
        const map = buildReviewPageMap([
            row({ rowId: 'a', columnIndex: 0, seqInColumn: 1, seqInVolume: 1, itemNo: 'SX20260916001', questionText: '   ', errorItemId: 'q1' }),
        ]);
        expect(map).toContain('（没有存到题干文本）');
    });
});

describe('parseReviewReading · AI 读数解析', () => {
    it('XML 标签：正常取出四态', () => {
        const r = parseReviewReading(
            '<mark slot="L1">right</mark>\n<mark slot="L2">wrong</mark>\n<mark slot="R1">none</mark>\n<mark slot="R2">unclear</mark>\n<unclear>右栏最后一行糊了</unclear>',
        );
        expect(r.marksBySlot).toEqual({ L1: 'right', L2: 'wrong', R1: 'none', R2: 'unclear' });
        expect(r.unclear).toBe('右栏最后一行糊了');
    });

    it('中文/符号取值也能归一（对/错/勾/叉/没标/看不清）', () => {
        expect(normalizeMarkValue('对')).toBe('right');
        expect(normalizeMarkValue('✓')).toBe('right');
        expect(normalizeMarkValue('错')).toBe('wrong');
        expect(normalizeMarkValue('✗')).toBe('wrong');
        expect(normalizeMarkValue('没标')).toBe('none');
        expect(normalizeMarkValue('看不清')).toBe('unclear');
        expect(normalizeMarkValue('什么鬼')).toBe('unclear');
        expect(normalizeMarkValue('')).toBe('unclear');
    });

    it('AI 没按 XML 写、逐行 `L1: right` 时也能兜底读回', () => {
        const r = parseReviewReading('L1: right\nR1: wrong');
        expect(r.marksBySlot).toEqual({ L1: 'right', R1: 'wrong' });
    });

    it('一个都没读到 ⇒ 空 Record（上层按"没标"兜底，绝不猜）', () => {
        expect(parseReviewReading('完全不是标签的一段话').marksBySlot).toEqual({});
    });
});

describe('applyReadingToRows · 铺到校对表格', () => {
    const pageRows = [
        row({ rowId: 'a', columnIndex: 0, seqInColumn: 1, seqInVolume: 1, itemNo: 'SX1', errorItemId: 'q1' }),
        row({ rowId: 'b', columnIndex: 1, seqInColumn: 1, seqInVolume: 2, itemNo: 'SX2', errorItemId: 'q2' }),
    ];

    it('读到的用读到的，没读到的按"没标"，并带上槽位', () => {
        const out = applyReadingToRows(pageRows, { marksBySlot: { L1: 'right' }, unclear: '' });
        expect(out).toEqual([
            { row: pageRows[0], slot: 'L1', mark: 'right' },
            { row: pageRows[1], slot: 'R1', mark: 'none' },
        ]);
    });

    it('AI 读成"看不清"的格子原样保留（等她改，不猜对错）', () => {
        const out = applyReadingToRows(pageRows, { marksBySlot: { R1: 'unclear' }, unclear: '右栏糊了' });
        expect(out[1].mark).toBe('unclear');
    });
});

describe('planRecoveryWrites · AI 读数 → 每题该写什么', () => {
    const pageRows = [
        row({ rowId: 'r1', columnIndex: 0, seqInColumn: 1, seqInVolume: 1, itemNo: 'SX20260916001', errorItemId: 'q1' }),
        row({ rowId: 'r2', columnIndex: 0, seqInColumn: 2, seqInVolume: 2, itemNo: 'SX20260916002', errorItemId: null }),
        row({ rowId: 'r3', columnIndex: 1, seqInColumn: 1, seqInVolume: 3, itemNo: 'SX20260916003', errorItemId: 'q3' }),
    ];

    it('★ 只写"她标了"的题（对/错）；没标与看不清一律跳过', () => {
        const writes = planRecoveryWrites(pageRows, { r1: 'right', r2: 'none', r3: 'unclear' });
        expect(writes.map((w) => w.rowId)).toEqual(['r1']);
        expect(writes[0]).toMatchObject({ slot: 'L1', markState: 'right', writesOutcome: true, errorItemId: 'q1' });
    });

    it('★ 题被删（errorItemId 为空）⇒ 只写卷行 markState，不写复习史', () => {
        const writes = planRecoveryWrites(pageRows, { r2: 'wrong' });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ rowId: 'r2', slot: 'L2', markState: 'wrong', writesOutcome: false, errorItemId: null });
    });

    it('多格混合：该写的都写、各自带上槽位与对错', () => {
        const writes = planRecoveryWrites(pageRows, { r1: 'wrong', r2: 'right', r3: 'right' });
        expect(writes.map((w) => [w.slot, w.markState, w.writesOutcome])).toEqual([
            ['L1', 'wrong', true],
            ['L2', 'right', false],
            ['R1', 'right', true],
        ]);
    });

    it('她一个都没标 ⇒ 空数组（不静默清空、不替她做主）', () => {
        expect(planRecoveryWrites(pageRows, {})).toEqual([]);
    });
});

describe('resolveRecoveryLookup · 查卷降级', () => {
    const items = [
        row({ rowId: 'a', pageIndex: 1, columnIndex: 0, seqInColumn: 1, itemNo: 'SX1', errorItemId: 'q1' }),
        row({ rowId: 'b', pageIndex: 1, columnIndex: 0, seqInColumn: 2, itemNo: 'SX2', errorItemId: 'q2' }),
        row({ rowId: 'c', pageIndex: 2, columnIndex: 0, seqInColumn: 1, itemNo: 'SX3', errorItemId: 'q3' }),
    ];

    it('卷在、这一页有条目 ⇒ ready（只回这一页的行）', () => {
        const r = resolveRecoveryLookup(
            { volumeNo: 'RE20260926001', pageNo: 1 },
            { volume: { id: 'v1', volumeNo: 'RE20260926001', kind: 'review' }, items },
        );
        expect(r.status).toBe('ready');
        if (r.status === 'ready') {
            expect(r.volumeId).toBe('v1');
            expect(r.pageNo).toBe(1);
            expect(r.rows.map((x) => x.rowId)).toEqual(['a', 'b']);
        }
    });

    it('★ 卷查不到 ⇒ blocked(volume-miss)', () => {
        const r = resolveRecoveryLookup({ volumeNo: 'RE20260926001', pageNo: 1 }, { volume: null, items: [] });
        expect(r).toEqual({ status: 'blocked', reason: 'volume-miss', detail: 'RE20260926001' });
    });

    it('★ 查到的卷号与扫到的对不上 ⇒ blocked(wrong-volume)（码不是本卷的）', () => {
        const r = resolveRecoveryLookup(
            { volumeNo: 'RE20260926001', pageNo: 1 },
            { volume: { id: 'v1', volumeNo: 'RE20260926002', kind: 'review' }, items },
        );
        expect(r).toEqual({ status: 'blocked', reason: 'wrong-volume', detail: 'RE20260926002' });
    });

    it('这一页在库里是空的 ⇒ blocked(empty-page)', () => {
        const r = resolveRecoveryLookup(
            { volumeNo: 'RE20260926001', pageNo: 9 },
            { volume: { id: 'v1', volumeNo: 'RE20260926001', kind: 'review' }, items },
        );
        expect(r).toEqual({ status: 'blocked', reason: 'empty-page', detail: '9' });
    });
});

describe('generateRecoverReviewPrompt · 提示词红线', () => {
    it('导出默认模板且够长', () => {
        expect(typeof DEFAULT_RECOVER_REVIEW_TEMPLATE).toBe('string');
        expect(DEFAULT_RECOVER_REVIEW_TEMPLATE.length).toBeGreaterThan(300);
    });

    it('把版面地图注入进去', () => {
        const prompt = generateRecoverReviewPrompt('L1｜流水 1｜题号 SX20260916001');
        expect(prompt).toContain('L1｜流水 1｜题号 SX20260916001');
    });

    it('★ 明确"绝不判卷 / 只读她标的记号"（AI 不判卷）', () => {
        const prompt = generateRecoverReviewPrompt('L1｜流水 1');
        expect(prompt).toContain('绝不判卷');
        expect(prompt).toContain('她标在纸上的记号');
        expect(prompt).toContain('不许猜');
    });

    it('★ 明确"升降框不看、不读、不据此输出"', () => {
        const prompt = generateRecoverReviewPrompt('L1｜流水 1');
        expect(prompt).toContain('升降框');
    });

    it('要求按槽位输出 mark 标签，取值只认四态', () => {
        const prompt = generateRecoverReviewPrompt('L1｜流水 1');
        expect(prompt).toContain('<mark slot="L1">right</mark>');
        expect(prompt).toContain('right');
        expect(prompt).toContain('wrong');
        expect(prompt).toContain('none');
        expect(prompt).toContain('unclear');
    });
});
