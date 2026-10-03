/**
 * 回录分析（深挖纸回录）· 纯逻辑单测。
 *
 * 本机没有 AI key，这条链路"真跑一次 AI"做不到；所以把最容易写错、又完全能纯测的两段
 * 钉死：① 二维码内容 → 题号；② 题号查不到题时的降级路径。顺带覆盖 AI 读数的解析与拼装。
 */
import { describe, it, expect } from 'vitest';
import {
    parseQuestionNo,
    parseScannedCode,
    resolveScannedLookup,
    buildRecoverQuestionContext,
    parseRecoveryReading,
    composeRecoveryContent,
    previousHersOf,
} from '@/lib/recover-analysis';
import {
    generateRecoverAnalysisPrompt,
    DEFAULT_RECOVER_ANALYSIS_TEMPLATE,
} from '@/lib/ai/prompts';

describe('parseQuestionNo · 二维码内容 → 题号', () => {
    it('正常题号原样返回（规范成大写）', () => {
        expect(parseQuestionNo('SX20260916001')).toBe('SX20260916001');
        expect(parseQuestionNo('sx20260916001')).toBe('SX20260916001');
    });

    it('前后有空格 / 换行 / 制表符也能认出来', () => {
        expect(parseQuestionNo('  SX20260916001  ')).toBe('SX20260916001');
        expect(parseQuestionNo('\nSX20260916001\n')).toBe('SX20260916001');
        expect(parseQuestionNo('\t sx20260916001 \r\n')).toBe('SX20260916001');
    });

    it('空 / 空白 → null（不猜）', () => {
        expect(parseQuestionNo('')).toBeNull();
        expect(parseQuestionNo('   ')).toBeNull();
        expect(parseQuestionNo('\n\n')).toBeNull();
        expect(parseQuestionNo(null)).toBeNull();
        expect(parseQuestionNo(undefined)).toBeNull();
    });

    it('不是二维码内容（网址 / 普通文字 / 乱码）→ null', () => {
        expect(parseQuestionNo('https://example.com/x')).toBeNull();
        expect(parseQuestionNo('这是一张照片')).toBeNull();
        expect(parseQuestionNo('hello world')).toBeNull();
    });

    it('卷页码码（RE…-02）不是题号 → null', () => {
        expect(parseQuestionNo('RE20260916001-02')).toBeNull();
    });

    it('卷号（RE…/BU…，非学科前缀）不算题号 → null', () => {
        expect(parseQuestionNo('RE20260916001')).toBeNull();
        expect(parseQuestionNo('BU20260916001')).toBeNull();
    });

    it('题号内部夹了换行 / 缺流水位 → null', () => {
        expect(parseQuestionNo('SX20260916\n001')).toBeNull();
        expect(parseQuestionNo('SX20260916')).toBeNull(); // 只有 8 位日期，没流水
    });
});

describe('parseScannedCode · 分类', () => {
    it('题号', () => {
        expect(parseScannedCode(' sx20260916001 ')).toEqual({ kind: 'question', value: 'SX20260916001' });
    });
    it('卷页码码 → page-code', () => {
        expect(parseScannedCode('RE20260916001-02')).toEqual({ kind: 'page-code', value: 'RE20260916001-02' });
    });
    it('空 → empty', () => {
        expect(parseScannedCode('   ')).toEqual({ kind: 'empty', value: '' });
        expect(parseScannedCode(null)).toEqual({ kind: 'empty', value: '' });
    });
    it('其它 → unknown（原样留着给她看）', () => {
        expect(parseScannedCode('https://a.b/c')).toEqual({ kind: 'unknown', value: 'https://a.b/c' });
    });
});

describe('resolveScannedLookup · 题号查不到题的降级路径', () => {
    const found = { found: true, source: 'main' as const, item: { id: 'q1' } };

    it('查到题 ⇒ ready（带 item 与来源）', () => {
        const r = resolveScannedLookup({ kind: 'question', value: 'SX20260916001' }, found);
        expect(r).toEqual({
            status: 'ready',
            no: 'SX20260916001',
            item: { id: 'q1' },
            source: 'main',
        });
    });

    it('回收箱里的题也能 ready（source=trash，交给界面标底色）', () => {
        const r = resolveScannedLookup(
            { kind: 'question', value: 'SX20260916001' },
            { found: true, source: 'trash', item: { id: 'q2' } },
        );
        expect(r.status).toBe('ready');
        if (r.status === 'ready') expect(r.source).toBe('trash');
    });

    it('★ 题号查不到题 ⇒ blocked(lookup-miss)，绝不静默当成空题', () => {
        const r = resolveScannedLookup({ kind: 'question', value: 'SX20260916999' }, { found: false, item: null });
        expect(r).toEqual({ status: 'blocked', reason: 'lookup-miss', detail: 'SX20260916999' });
    });

    it('found=true 但 item 缺失 ⇒ 同样按 miss 处理（不崩）', () => {
        const r = resolveScannedLookup({ kind: 'question', value: 'SX20260916001' }, { found: true, item: null });
        expect(r).toEqual({ status: 'blocked', reason: 'lookup-miss', detail: 'SX20260916001' });
    });

    it('查库结果为空（请求失败/未提供）⇒ miss', () => {
        const r = resolveScannedLookup({ kind: 'question', value: 'SX20260916001' }, null);
        expect(r.status).toBe('blocked');
        if (r.status === 'blocked') expect(r.reason).toBe('lookup-miss');
    });

    it('空码 / 页码码 / 其它码 ⇒ 各自的 blocked 原因（都能在界面上说清）', () => {
        expect(resolveScannedLookup({ kind: 'empty', value: '' }, null)).toEqual({
            status: 'blocked',
            reason: 'empty',
            detail: null,
        });
        expect(resolveScannedLookup({ kind: 'page-code', value: 'RE20260916001-02' }, null)).toEqual({
            status: 'blocked',
            reason: 'page-code',
            detail: 'RE20260916001-02',
        });
        expect(resolveScannedLookup({ kind: 'unknown', value: 'https://a.b/c' }, null)).toEqual({
            status: 'blocked',
            reason: 'unknown',
            detail: 'https://a.b/c',
        });
    });
});

describe('buildRecoverQuestionContext', () => {
    it('带上题号 / 学科 / 错因 / 题干', () => {
        const ctx = buildRecoverQuestionContext({
            no: 'SX20260916001',
            questionText: '计算 1/2 + 1/3',
            subject: '数学',
            mistakeReason: '概念模糊',
        });
        expect(ctx).toContain('题号：SX20260916001');
        expect(ctx).toContain('学科：数学');
        expect(ctx).toContain('这道题记的错因：概念模糊');
        expect(ctx).toContain('1/2 + 1/3');
    });

    it('没有题干也不抛，给出占位', () => {
        const ctx = buildRecoverQuestionContext({ no: 'SX20260916001', questionText: '   ' });
        expect(ctx).toContain('（这道题没有存到题干文本）');
    });
});

describe('parseRecoveryReading · AI 读数解析与校验', () => {
    it('三个标签齐全 ⇒ 原样取出', () => {
        const raw = `<her_words>我卡在约分</her_words>
<organized>我这次卡在约分。</organized>
<unclear>最后一个字看不清</unclear>`;
        const r = parseRecoveryReading(raw);
        expect(r.herWords).toBe('我卡在约分');
        expect(r.organized).toBe('我这次卡在约分。');
        expect(r.unclear).toBe('最后一个字看不清');
    });

    it('organized 为空 ⇒ 抛错（空正文绝不静默入库）', () => {
        expect(() => parseRecoveryReading('<her_words>嗯</her_words><organized></organized>'))
            .toThrowError(/AI_RESPONSE_ERROR/);
        expect(() => parseRecoveryReading('完全不是标签的一段话')).toThrowError(/AI_RESPONSE_ERROR/);
    });

    it('只有 organized（她没写清楚 / 没给标签）也能过，另两段空', () => {
        const r = parseRecoveryReading('<organized>她说她没看懂题意。</organized>');
        expect(r.organized).toBe('她说她没看懂题意。');
        expect(r.herWords).toBe('');
        expect(r.unclear).toBe('');
    });

    it('闭标签丢了（响应被截断）也能把 organized 救回来', () => {
        const r = parseRecoveryReading('<her_words>我把分母弄反了</her_words>\n<organized>我把分母弄反了。');
        expect(r.organized).toBe('我把分母弄反了。');
    });
});

describe('composeRecoveryContent · 她的话 + 斜体 AI 整理', () => {
    it('她的话在前（原样），AI 整理在后（整段斜体 + 前缀）', () => {
        const md = composeRecoveryContent({ herWords: '我卡在约分', organized: '我这次卡在约分。', unclear: '' });
        expect(md).toBe('我卡在约分\n\n*—— AI 整理：我这次卡在约分。*');
    });

    it('她一个字没写清楚 ⇒ 只剩斜体 AI 整理', () => {
        const md = composeRecoveryContent({ herWords: '  ', organized: '她这次没写清楚卡在哪。', unclear: '' });
        expect(md).toBe('*—— AI 整理：她这次没写清楚卡在哪。*');
    });

    it('★ 多段 organized：每段各自包斜体（他 2026-10-04："她写多了可以多段"）', () => {
        const md = composeRecoveryContent({ herWords: '', organized: '第一句。\n\n第二句。', unclear: '' });
        // 第一段带前缀、第二段不带 —— 但两段都要是斜体
        // （斜体 `*…*` 跨空行会断 ⇒ "多段"只能靠"一段一个斜体块"）
        expect(md).toBe('*—— AI 整理：第一句。*\n\n*第二句。*');
    });

    it('段内换行照样折掉（段内一断行，斜体在段内就破了）', () => {
        const md = composeRecoveryContent({ herWords: '', organized: '第一句\n接着写。\n\n第二段。', unclear: '' });
        expect(md).toBe('*—— AI 整理：第一句 接着写。*\n\n*第二段。*');
    });

    it('有看不清的交代时，末尾附一行斜体提示', () => {
        const md = composeRecoveryContent({ herWords: '我卡在', organized: '我卡在约分。', unclear: '最后一个字' });
        expect(md).toContain('*（AI 看不清：最后一个字）*');
    });
});

/**
 * 【2026-10-04 他要求】"对已经有日积月累的题，将原日积月累和现在的内容进行**有机合并**然后覆盖"。
 *
 * 合并的分工（这一组就是钉住它）：
 *   · **她的话 —— 累积保留**：上次的原话一字不动地留着，这次的接在后面（**不经过模型**）；
 *   · **AI 的整理 —— 交给模型融合**：所以 compose 这里只收"新的整理"，不会把上次的 AI 段抄回来。
 */
describe('composeRecoveryContent · 有旧日积月累时的有机合并', () => {
    const prev = '我卡在约分\n\n*—— AI 整理：她卡在约分这一步。*';

    it('★ 她的话累积：上次的在前、这次的接在后', () => {
        const md = composeRecoveryContent(
            { herWords: '这次我卡在通分', organized: '她这次卡在通分。', unclear: '' },
            prev,
        );
        expect(md).toBe('我卡在约分\n\n这次我卡在通分\n\n*—— AI 整理：她这次卡在通分。*');
    });

    it('★ 上次的 AI 整理段**不会**被抄回来（那段由模型融合后重写）', () => {
        const md = composeRecoveryContent(
            { herWords: '这次我卡在通分', organized: '融合：通分这一步。', unclear: '' },
            prev,
        );
        expect(md).not.toContain('她卡在约分这一步');
        expect(md.match(/—— AI 整理：/g)?.length).toBe(1);
    });

    it('没有旧内容时与从前一字不差（回归保护）', () => {
        const r = { herWords: '我卡在约分', organized: '我卡在约分。', unclear: '' };
        expect(composeRecoveryContent(r)).toBe(composeRecoveryContent(r, null));
        expect(composeRecoveryContent(r, '   ')).toBe(composeRecoveryContent(r));
    });
});

describe('previousHersOf · 从旧正文里切出"她的话"', () => {
    it('在 AI 前缀处切断，只留她写的部分', () => {
        expect(previousHersOf('我卡在约分\n\n*—— AI 整理：她卡在约分。*')).toBe('我卡在约分');
    });

    it('只有"看不清"那行时，也在它前面切断', () => {
        expect(previousHersOf('我卡在约分\n\n*（AI 看不清：最后一个字）*')).toBe('我卡在约分');
    });

    it('★ 没有标记（比如那条是手工写的）⇒ 整段都当她的话留着（宁可多留，不可丢话）', () => {
        expect(previousHersOf('这是一条手工写的日积月累')).toBe('这是一条手工写的日积月累');
        expect(previousHersOf('*—— AI 整理：先写了 AI 段*')).toBe('');
    });

    it('空 / null / undefined ⇒ 空串（不炸）', () => {
        expect(previousHersOf('')).toBe('');
        expect(previousHersOf('   ')).toBe('');
        expect(previousHersOf(null)).toBe('');
        expect(previousHersOf(undefined)).toBe('');
    });
});

describe('generateRecoverAnalysisPrompt · 提示词红线', () => {
    it('导出默认模板', () => {
        expect(typeof DEFAULT_RECOVER_ANALYSIS_TEMPLATE).toBe('string');
        expect(DEFAULT_RECOVER_ANALYSIS_TEMPLATE.length).toBeGreaterThan(200);
    });

    it('把题干上下文注入进去', () => {
        const prompt = generateRecoverAnalysisPrompt('题号：SX20260916001\n题干：\n1+1=?');
        expect(prompt).toContain('题号：SX20260916001');
        expect(prompt).toContain('1+1=?');
    });

    it('明确写入"不许编造 / 看不清就留空 / 保留她的口吻"', () => {
        const prompt = generateRecoverAnalysisPrompt('题号：X');
        expect(prompt).toContain('只依据照片里她真正写下的字');
        expect(prompt).toContain('不许编造');
        expect(prompt).toContain('留空比乱写好');
        expect(prompt).toContain('保留她的口吻');
    });

    it('要求输出 her_words / organized / unclear 三段', () => {
        const prompt = generateRecoverAnalysisPrompt('题号：X');
        expect(prompt).toContain('<her_words>');
        expect(prompt).toContain('<organized>');
        expect(prompt).toContain('<unclear>');
    });

    it('★ 没有旧日积月累时，明确告诉模型"以前没记过"（不留白让它脑补）', () => {
        const prompt = generateRecoverAnalysisPrompt('题号：X');
        expect(prompt).toContain('以前没有记过日积月累');
    });

    it('★ 有旧日积月累时：注入进去 + 要求"有机合并"（不是拼接）', () => {
        const prompt = generateRecoverAnalysisPrompt(
            '题号：X',
            'zh',
            undefined,
            null,
            '我卡在约分\n\n*—— AI 整理：她卡在约分。*',
        );
        expect(prompt).toContain('我卡在约分');
        expect(prompt).toContain('有机合并');
        expect(prompt).toContain('不许只是把两段话接在一起');
        // 且明确要求 her_words 只输出这次的（上次的原话由客户端自己保留）
        expect(prompt).toContain('不要把上次的原话抄回来');
    });
});
