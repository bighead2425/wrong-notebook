import { describe, expect, it } from 'vitest';
import {
    buildSectionIndex,
    searchByKeywords,
    buildCandidates,
    renderCandidates,
    bookDistance,
} from '@/lib/tag-index';
import {
    buildStage1Template,
    parseStage1,
    buildStage2Prompt,
    parseStage2,
    composeCaseText,
} from '@/lib/ai/two-stage';
import { DEFAULT_ANALYZE_TEMPLATE } from '@/lib/ai/prompts';

/**
 * 【2026-11-01】两段式的三条命门，各钉一条：
 *   ① 第一段不能再吐知识点（清单已拿掉）；
 *   ② 关键词要能**跨册**找到节（后母戊鼎在三下、大雁塔在四下）；
 *   ③ 候选要**按离当前册的距离排序**，且当前册全册都在。
 */

describe('第一段：不吐知识点，只吐考点短语', () => {
    const tpl = buildStage1Template(DEFAULT_ANALYZE_TEMPLATE);

    it('模板里不再有 knowledge_points', () => {
        expect(tpl).not.toContain('<knowledge_points>');
        expect(tpl).not.toContain('<kp ');
    });

    it('有 keywords 输出要求，但**不再**要它猜年级', () => {
        expect(tpl).toContain('<keywords>');
        expect(tpl).toContain('UNMATCHED');
        /**
         * 【2026-11-01】用户明确否定了"让 AI 判年级"：
         *   主页本来就有她的年级；而模型判得不准（大雁塔那道判成"五年级下"，
         *   实际是四年级下），猜错反而把她引到错误的册上。
         * 年级改由「这题落在哪一册」自己算出来，不再问模型。
         */
        expect(tpl).not.toContain('<grade_guess>');
        expect(tpl).toContain('不要猜这道题是几年级');
    });

    it('解析第一段输出（老输出里的 grade_guess 仍能解析，只是不再要求）', () => {
        const r = parseStage1(`<subject>数学</subject>
<keywords>质量单位换算 | 复名数互化 | 长度单位</keywords>
<grade_guess>三年级下</grade_guess>`);
        expect(r.subject).toBe('数学');
        expect(r.keywords).toEqual(['质量单位换算', '复名数互化', '长度单位']);
        expect(r.gradeGuess).toBe('三年级下');
    });

    it('UNMATCHED / UNKNOWN 要被吃掉', () => {
        const r = parseStage1('<keywords>UNMATCHED</keywords><grade_guess>UNKNOWN</grade_guess>');
        expect(r.keywords).toEqual([]);
        expect(r.gradeGuess).toBeNull();
    });
});

describe('检索：关键词能跨册找到节', () => {
    const math = buildSectionIndex('math');

    it('索引里每一册都有节', () => {
        const books = new Set(math.map((s) => s.book));
        expect(books.has('三年级下')).toBe(true);
        expect(books.has('四年级下')).toBe(true);
        expect(books.has('五年级上')).toBe(true);
    });

    it('「质量单位换算」能找到三下的千克克吨', () => {
        const hits = searchByKeywords(['质量单位换算'], math);
        const books = hits.map((h) => h.entry.book);
        expect(books).toContain('三年级下');
    });

    it('「列方程解决问题」能找到四下的认识方程', () => {
        const hits = searchByKeywords(['列方程解决问题'], math);
        const inG4 = hits.filter((h) => h.entry.book === '四年级下');
        expect(inG4.length).toBeGreaterThan(0);
        expect(inG4.some((h) => h.entry.section.includes('方程'))).toBe(true);
    });
});

describe('候选：当前册全册 + 命中节，按距离排序', () => {
    it('后母戊鼎：五上全册在，三下的节也在，且五上排前面', () => {
        const cands = buildCandidates('math', {
            currentBook: '五年级上',
            keywords: ['质量单位换算', '复名数互化', '长度单位'],
        });
        const books = cands.map((c) => c.entry.book);
        expect(books).toContain('五年级上');
        expect(books).toContain('三年级下');

        /* 前若干个必须都是当前册（distance=0） */
        const firstOther = books.findIndex((b) => b !== '五年级上');
        expect(cands.slice(0, firstOther).every((c) => c.distance === 0)).toBe(true);
    });

    it('大雁塔：四下的「认识方程」能进候选（它是跨册题的关键）', () => {
        const cands = buildCandidates('math', {
            currentBook: '五年级上',
            keywords: ['列方程解决问题', '一元一次方程'],
        });
        const hit = cands.find(
            (c) => c.entry.book === '四年级下' && c.entry.section.includes('方程'),
        );
        expect(hit).toBeTruthy();
    });

    /**
     * 【2026-11-01】命中了某一节，就把它**同章的其他节**也带上。
     *
     * 实测踩到的：关键词说"列方程解决问题"，题目实际考的是同一单元里的
     * "解方程" —— 只带命中的那一节，同一章的正确项根本没进候选，第二段选不出来。
     * 扩到「章」而不是「整册」，是因为一道题的落点几乎总在同一单元内。
     */
    it('命中一节 ⇒ 同章其他节一起进候选', () => {
        const cands = buildCandidates('math', {
            currentBook: '五年级上',
            keywords: ['列方程解决问题'],
        });
        const book4 = cands.filter((c) => c.entry.book === '四年级下');
        /* 「认识方程」这一章下不止一个节 */
        const chapters = new Set(book4.map((c) => c.entry.chapter));
        expect(chapters.size).toBeGreaterThan(0);
        const inSameChapter = book4.filter(
            (c) => c.entry.chapter === '第五单元 认识方程',
        );
        expect(inSameChapter.length).toBeGreaterThan(1);
    });

    it('扩展不会挤掉命中的那一节（它排在同章扩展项之前）', () => {
        const cands = buildCandidates('math', {
            currentBook: '五年级上',
            keywords: ['列方程解决问题'],
        });
        const book4 = cands.filter((c) => c.entry.book === '四年级下');
        const hitIdx = book4.findIndex((c) => c.entry.section === '列方程解决问题');
        expect(hitIdx).toBeGreaterThanOrEqual(0);
        /* 命中项 score>0，同章扩展项 score=0 ⇒ 命中项必须排在前面 */
        expect(book4[0].score).toBeGreaterThanOrEqual(book4[hitIdx].score);
    });

    it('候选有上限，不会退化成几百个', () => {
        const cands = buildCandidates('math', {
            currentBook: '五年级上',
            keywords: ['单位', '分数', '图形'],
            limit: 40,
        });
        expect(cands.length).toBeLessThanOrEqual(40);
    });

    it('语文没有"册"，整学段都在候选里', () => {
        const cands = buildCandidates('chinese', {
            currentBook: '高中',
            keywords: ['字音', '病句'],
        });
        expect(cands.some((c) => c.entry.section === '字音')).toBe(true);
        expect(cands.some((c) => c.entry.section === '病句')).toBe(true);
    });
});

describe('第二段：只能从编号里选', () => {
    const cands = buildCandidates('math', {
        currentBook: '五年级上',
        keywords: ['质量单位换算'],
    }).slice(0, 6);
    const entries = cands.map((c) => c.entry);

    it('候选渲染成 [1] [2] 编号，当前册有标记', () => {
        const text = renderCandidates(cands, '五年级上');
        expect(text).toContain('[1]');
        expect(text).toContain('〔当前册〕');
    });

    it('提示词里明确"不要发明新的册章节"', () => {
        const p = buildStage2Prompt({
            caseText: composeCaseText({ questionText: '832.84 千克 = （ ）千克（ ）克' }),
            candidates: entries,
            currentBook: '五年级上',
            subjectCn: '数学',
        });
        expect(p).toContain('不要发明新的册/章/节/知识点');
        expect(p).toContain('[1]');
        expect(p).toContain('五年级上');
    });

    it('解析 pick / confidence', () => {
        const r = parseStage2('<pick>3, 7</pick><confidence>high</confidence><reason>考单位换算</reason>');
        expect(r.picks).toEqual([3, 7]);
        expect(r.confidence).toBe('high');
        expect(r.reason).toBe('考单位换算');
    });

    it('空 pick = 不选', () => {
        expect(parseStage2('<pick></pick><confidence>low</confidence>').picks).toEqual([]);
    });

    /**
     * 【2026-11-01】第二段还要给"这道题具体考到哪几个点"。
     *
     * 为什么：只选到"节"的话，落库落的是**节节点**，比单段式的知识点粗一级 ——
     * 同一个节下的「小数减法」和「数位对齐」会被算成一个桶，复习统计就糊了。
     */
    it('能解析出知识点（| 分隔，最多 3 个）', () => {
        const r = parseStage2(
            '<pick>5</pick><kps>小数减法 | 数位对齐</kps><confidence>high</confidence>',
        );
        expect(r.picks).toEqual([5]);
        expect(r.kps).toEqual(['小数减法', '数位对齐']);
    });

    it('知识点留空是合法的（只给节，落库退到节节点）', () => {
        const r = parseStage2('<pick>5</pick><kps></kps><confidence>medium</confidence>');
        expect(r.kps).toEqual([]);
    });

    it('老格式（压根没有 kps 段）也不报错', () => {
        const r = parseStage2('<pick>5</pick><confidence>low</confidence>');
        expect(r.kps).toEqual([]);
        expect(r.picks).toEqual([5]);
    });
});

describe('距离', () => {
    it('同册为 0，差一趟为 1', () => {
        expect(bookDistance(9, 9)).toBe(0);
        expect(bookDistance(9, 8)).toBe(1);
        expect(bookDistance(9, 6)).toBe(3);
    });
});
