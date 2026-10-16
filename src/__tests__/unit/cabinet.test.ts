// @vitest-environment node
// 纯逻辑测试（不碰 DOM）：跑 node 环境，本机才起得来（jsdom worker 会因内存超时）。
import { describe, expect, it } from 'vitest';
import {
    buildCabinetTasks,
    CABINET_DEFAULT_OPTIONS,
    dueReviewItems,
    pendingDeepPrint,
    pendingRecoverItems,
    pendingRecoverVolumes,
    practiceTodayItems,
    unprintedInsights,
    upgradeSuggestions,
    type CabinetInsight,
    type CabinetQuestion,
    type CabinetVolume,
} from '@/lib/cabinet';

/**
 * 总理内阁 · 任务判据。
 *
 * 这个页面唯一容易写错的地方就是"判据"：日期、边界、去重。
 * 组测试只钉**已定的口径**，不钉实现细节：
 *   ① 待打印深挖 = 深挖 + 没印过（未定不算深挖）
 *   ② 该复查 = 印过 + **倒数天数 ≤ 0**（到期当天算）
 *      ⚠️【2026-10-16 换口径】出处 `docs\18` §3.4：老口径是"纸面日期格（打印日 +1/7/21）到了"，
 *      依赖 `planned` 里"第几个空格"；而新模型里复习结果换成流水、**没有"第几格"了**
 *      ⇒ 改成看 `levelCountdown`。副作用：② 由"纸面驱动"变成"证据驱动"，
 *      与 ⑦ 语义重叠（**已标注，待空空定**，见 `cabinet.ts` 里 §⑦ 那段注释）。
 *   ③ 该回录 = 印过 + 够天数 + 没有这道题的日积月累
 *   ④ 待回录卷 = review 卷 + 够天数 + 还有没标的行
 *   ⑤ 未打印日积月累 = 没被编进任何卷
 *   ⑥ 建议升深挖 = 不是深挖 + 计划复习错≥2（只建议）
 *   ⑦ 去重：该回录的题不再出现在该复查里
 */

const NOW = new Date(2026, 9, 4); // 2026-10-04

function q(over: Partial<CabinetQuestion> & { id: string }): CabinetQuestion {
    return {
        source: `SX2026${over.id}`,
        manageType: 'review',
        printCount: 0,
        lastPrintedAt: null,
        reviewOutcomes: null,
        ...over,
    };
}

function insight(over: Partial<CabinetInsight> & { id: string; code: string }): CabinetInsight {
    return { volumeIds: [], errorItemNo: null, ...over };
}

describe('cabinet · 空数据', () => {
    it('什么都没有 ⇒ 六条任务全是 0（界面要好看、不能崩）', () => {
        const t = buildCabinetTasks({ questions: [], insights: [], volumes: [], now: NOW });
        expect(t.pendingDeepPrint.count).toBe(0);
        expect(t.dueReviews.count).toBe(0);
        expect(t.pendingRecover.count).toBe(0);
        expect(t.pendingRecoverVolumes.count).toBe(0);
        expect(t.unprintedInsights.count).toBe(0);
        expect(t.upgradeSuggestions.count).toBe(0);
        expect(t.pendingDeepPrint.ids).toEqual([]);
        expect(t.pendingRecoverVolumes.volumeIds).toEqual([]);
    });
});

describe('① 待打印深挖题', () => {
    it('深挖 + 没印过 ⇒ 算；深挖 + 印过 ⇒ 不算', () => {
        const deepNew = q({ id: '1', manageType: 'deep', printCount: 0 });
        const deepPrinted = q({ id: '2', manageType: 'deep', printCount: 1 });
        expect(pendingDeepPrint([deepNew, deepPrinted]).map((x) => x.id)).toEqual(['1']);
    });

    it('复练 / 未定 都不算深挖（未定读作复练，不是深挖）', () => {
        const review = q({ id: '1', manageType: 'review', printCount: 0 });
        const undecided = q({ id: '2', manageType: null, printCount: 0 });
        expect(pendingDeepPrint([review, undecided])).toEqual([]);
    });
});

describe('② 该复查的题（**2026-10-16 已换口径**：倒数天数 ≤ 0 = 该练）', () => {
    it('★ 倒数正好走到 0（到期当天）⇒ 算，overdueDays=0', () => {
        const item = q({ id: '1', manageType: 'deep', printCount: 1, levelCountdown: 0 });
        const out = dueReviewItems([item], NOW); // NOW = 2026-10-04
        expect(out).toHaveLength(1);
        expect(out[0].dueOn).toBe('2026-10-04');
        expect(out[0].overdueDays).toBe(0);
    });

    it('★ 倒数还没走完 ⇒ 不算（差一天也不算）', () => {
        expect(dueReviewItems([q({ id: '1', printCount: 1, levelCountdown: 1 })], NOW)).toEqual([]);
    });

    it('★ 倒数是负数（已经过期）⇒ 算，并把"过了几天"报出来', () => {
        const out = dueReviewItems([q({ id: '1', printCount: 1, levelCountdown: -2 })], NOW);
        expect(out).toHaveLength(1);
        expect(out[0].dueOn).toBe('2026-10-02'); // 今天是 10-04、倒数 -2 ⇒ 本该 10-02 练
        expect(out[0].overdueDays).toBe(2);
    });

    it('★ 老题（没有 `levelCountdown` 这一列）⇒ 不算 —— 宁可漏报，也别乱报', () => {
        expect(dueReviewItems([q({ id: '1', printCount: 1 })], NOW)).toEqual([]);
    });

    it('没印过 ⇒ 不算（这块仍然只收"印过深挖纸"的题）', () => {
        expect(dueReviewItems([q({ id: '1', printCount: 0, levelCountdown: 0 })], NOW)).toEqual([]);
    });

    it('★ 钉住"口径已换"：老数据里的计划格**不再影响**结果', () => {
        const item = q({
            id: '1',
            printCount: 1,
            lastPrintedAt: new Date(2026, 8, 30),
            // 老形状：第 1 格已做 ⇒ **老口径**会去看第 7 天（10-07）⇒ 10-04 那天不算
            reviewOutcomes: { planned: ['right', null, null], last: 'right' },
            levelCountdown: 0,
        });
        // 新口径只看倒数 ⇒ 该算。（这条如果红了，说明有人把老口径改回来了）
        expect(dueReviewItems([item], NOW)).toHaveLength(1);
    });
});

describe('③ 该回录的深挖纸', () => {
    const printed = (id: string, when: Date, source = `SX${id}`) =>
        q({ id, source, printCount: 1, lastPrintedAt: when });

    it('印过 4 天、没有日积月累 ⇒ 该回录', () => {
        const res = pendingRecoverItems([printed('1', new Date(2026, 8, 30))], new Set(), NOW);
        expect(res.map((r) => r.question.id)).toEqual(['1']);
        expect(res[0].daysSincePrint).toBe(4);
    });

    it('已经回录过（有一条挂本题号的日积月累）⇒ 不再提醒（大小写不敏感）', () => {
        const item = q({
            id: '1',
            source: 'SX20260916001',
            printCount: 1,
            lastPrintedAt: new Date(2026, 8, 30),
        });
        expect(pendingRecoverItems([item], new Set(['SX20260916001']), NOW)).toEqual([]);
        expect(pendingRecoverItems([item], new Set(['sx20260916001']), NOW)).toEqual([]);
    });

    it('还没够天数（1 天）⇒ 不算', () => {
        expect(pendingRecoverItems([printed('1', new Date(2026, 9, 3))], new Set(), NOW)).toEqual([]);
    });

    it('没印过 ⇒ 不算', () => {
        expect(pendingRecoverItems([q({ id: '1', printCount: 0 })], new Set(), NOW)).toEqual([]);
    });

    it('题号缺失 ⇒ 不列（无法判断是否回录过，宁可漏报不误报）', () => {
        expect(pendingRecoverItems([printed('1', new Date(2026, 8, 30), '')], new Set(), NOW)).toEqual([]);
    });

    it('阈值可配：recoverMinDays=5 ⇒ 4 天不算', () => {
        const opts = { ...CABINET_DEFAULT_OPTIONS, recoverMinDays: 5 };
        expect(pendingRecoverItems([printed('1', new Date(2026, 8, 30))], new Set(), NOW, opts)).toEqual([]);
    });
});

describe('④ 待回录的复练卷', () => {
    const vol = (over: Partial<CabinetVolume> & { id: string }): CabinetVolume => ({
        volumeNo: `RE20260930${over.id}`,
        kind: 'review',
        createdAt: new Date(2026, 8, 30),
        items: [{ markState: null }],
        ...over,
    });

    it('review 卷 + 够天数 + 有没标的行 ⇒ 该回录，带上没标行数', () => {
        const v = vol({
            id: '1',
            items: [{ markState: 'right' }, { markState: null }, { markState: null }],
        });
        const res = pendingRecoverVolumes([v], NOW);
        expect(res).toHaveLength(1);
        expect(res[0].unrecoveredCount).toBe(2);
        expect(res[0].daysSinceCreated).toBe(4);
    });

    it('全部行都标过了 ⇒ 算回录完成，不再提醒', () => {
        expect(pendingRecoverVolumes([vol({ id: '1', items: [{ markState: 'right' }] })], NOW)).toEqual([]);
    });

    it('积累卷（build）不在此列', () => {
        expect(pendingRecoverVolumes([vol({ id: '1', kind: 'build' })], NOW)).toEqual([]);
    });

    it('刚组出来（不足天数）⇒ 不算', () => {
        expect(pendingRecoverVolumes([vol({ id: '1', createdAt: new Date(2026, 9, 3) })], NOW)).toEqual([]);
    });
});

describe('⑤ 未打印的日积月累', () => {
    it('没被编进任何卷 ⇒ 算；进过卷 ⇒ 不算', () => {
        const fresh = insight({ id: '1', code: 'JL20261001001' });
        const used = insight({ id: '2', code: 'JL20261001002', volumeIds: ['v1'] });
        expect(unprintedInsights([fresh, used]).map((i) => i.id)).toEqual(['1']);
    });
});

describe('⑥ 建议升为深挖', () => {
    const withOutcomes = (id: string, manageType: string | null, planned: (string | null)[]) =>
        q({ id, manageType, printCount: 1, lastPrintedAt: new Date(2026, 8, 1), reviewOutcomes: { planned, last: null } });

    it('不是深挖 + 计划复习错 2 次 ⇒ 进建议', () => {
        const res = upgradeSuggestions([withOutcomes('1', 'review', ['wrong', 'wrong', null])]);
        expect(res).toHaveLength(1);
        expect(res[0].wrongCount).toBe(2);
    });

    it('只错 1 次 ⇒ 不进建议', () => {
        expect(upgradeSuggestions([withOutcomes('1', 'review', ['wrong', null, null])])).toEqual([]);
    });

    it('已经是深挖 ⇒ 不进建议（不用再建议它升）', () => {
        expect(upgradeSuggestions([withOutcomes('1', 'deep', ['wrong', 'wrong', 'wrong'])])).toEqual([]);
    });

    /**
     * ★ 2026-10-04 审理补：把"未定也参与建议"**钉住**。
     * 之前这段代码的注释写着"未定不在本任务里"，但实现是只排除 deep ⇒ 未定其实会进来。
     * 裁决：保留行为（按 L0「未定读作复练」，对它的"建议升深挖"同样有用；且只是建议不强改），
     * 所以补这条测试当文档 —— 若哪天决定"未定一律不提示"，改实现时这条也要一起改。
     */
    it('★ 未定（manageType=null 的老数据）也参与建议 —— 按 L0 它读作复练', () => {
        const res = upgradeSuggestions([withOutcomes('1', null, ['wrong', 'wrong', null])]);
        expect(res).toHaveLength(1);
        expect(res[0].wrongCount).toBe(2);
    });
});

describe('⑦ 编排 + 跨任务去重', () => {
    it('该回录的题不再出现在该复查里（先回录、后复查）', () => {
        // 09-30 打印、10-04 仍未回录，且倒数已到 0 —— 两个任务本会同时命中
        const item = q({
            id: '1',
            source: 'SX1',
            manageType: 'deep',
            printCount: 1,
            lastPrintedAt: new Date(2026, 8, 30),
            levelCountdown: 0,
        });
        const t = buildCabinetTasks({ questions: [item], insights: [], volumes: [], now: NOW });
        expect(t.pendingRecover.count).toBe(1);
        expect(t.dueReviews.count).toBe(0); // 被回录任务"顶掉"了
    });

    it('回录过之后，该复查才出现', () => {
        const item = q({
            id: '1',
            source: 'SX1',
            manageType: 'deep',
            printCount: 1,
            lastPrintedAt: new Date(2026, 8, 30),
            levelCountdown: 0,
        });
        const t = buildCabinetTasks({
            questions: [item],
            insights: [insight({ id: 'i1', code: 'JL1', errorItemNo: 'SX1' })],
            volumes: [],
            now: NOW,
        });
        expect(t.pendingRecover.count).toBe(0);
        expect(t.dueReviews.count).toBe(1);
        // 这条已回录，所以不该再算"未打印日积月累"（它确实没进卷 —— 会进未打印清单，属正常）
        expect(t.unprintedInsights.count).toBe(1);
    });

    it('同一题在同一任务内只算一次（按 id 去重）', () => {
        const item = q({ id: '1', manageType: 'deep', printCount: 0 });
        const t = buildCabinetTasks({ questions: [item, item], insights: [], volumes: [], now: NOW });
        expect(t.pendingDeepPrint.count).toBe(1);
        expect(t.pendingDeepPrint.ids).toEqual(['1']);
    });
});

/* ==========================================================================
 * ⑦ 【2026-10-13 他拍板的设计】今天先练这几道
 *
 * 判据 = **由复练结果算出来的紧迫度**（`lib/review-status.ts`），与②「该复查」分工：
 *   ② 看**纸上的日期格**（打印日 +1/+7/+21）；⑦ 看**复练结果**。
 *   ⭐ ⑦ 补②的窟窿：计划三次做满后②直接 `continue`（判据是"第一个空格"），
 *      之后要是又错就没人管了 —— 这类题在⑦里捞得回来。
 * ========================================================================== */
describe('practiceTodayItems —— 今天先练这几道', () => {
    const outcomes = (planned: ('right' | 'wrong' | null)[], last: 'right' | 'wrong' | null) =>
        JSON.stringify({ planned, last });

    it('★ 从没练过的题要收（紧迫度 5）', () => {
        const out = practiceTodayItems([q({ id: 'A', reviewOutcomes: null })], NOW);
        expect(out).toHaveLength(1);
        expect(out[0].reasonZh).toBe('还没练过');
        expect(out[0].status.urgency).toBe(5);
    });

    it('★ 连错两次以上 ⇒ 收，而且理由写"连错 N 次"', () => {
        const out = practiceTodayItems([q({ id: 'A', reviewOutcomes: outcomes(['wrong', 'wrong', null], 'wrong') })], NOW);
        expect(out).toHaveLength(1);
        expect(out[0].reasonZh).toBe('连错 2 次');
    });

    it('★ 上次做错 ⇒ 收（理由"上次做错"）', () => {
        const out = practiceTodayItems([q({ id: 'A', reviewOutcomes: outcomes([null, null, null], 'wrong') })], NOW);
        expect(out[0].reasonZh).toBe('上次做错');
    });

    it('★ 连对 1–2 次的不收（那是"到点再练"，不是"今天必须练"）', () => {
        const one = q({ id: 'A', reviewOutcomes: outcomes([null, null, null], 'right') });
        const two = q({ id: 'B', reviewOutcomes: outcomes(['right', 'right', null], 'right') });
        expect(practiceTodayItems([one, two], NOW)).toHaveLength(0);
    });

    it('★ 已掌握（masteryLevel=2）一律不收 —— 四分法里它不进主库，也不该催练', () => {
        const done = q({ id: 'A', reviewOutcomes: null, masteryLevel: 2 });
        expect(practiceTodayItems([done], NOW)).toHaveLength(0);
    });

    it('★ 已经在别的任务里催过的题不重复收（传进来的排除集）', () => {
        const a = q({ id: 'A', reviewOutcomes: null });
        const b = q({ id: 'B', reviewOutcomes: null });
        const out = practiceTodayItems([a, b], NOW, new Set(['A']));
        expect(out.map((x) => x.question.id)).toEqual(['B']);
    });

    it('★ 排序：紧迫度 desc → 连错多的在前 → 题号升序（确定性，不会今天这样明天那样）', () => {
        const fresh = q({ id: 'A', source: 'SX202601', reviewOutcomes: null }); // 5
        const wrong2 = q({ id: 'B', source: 'SX202602', reviewOutcomes: outcomes(['wrong', 'wrong', null], 'wrong') }); // 5，连错 2
        const wrong1 = q({ id: 'C', source: 'SX202603', reviewOutcomes: outcomes([null, null, null], 'wrong') }); // 4
        const out = practiceTodayItems([wrong1, fresh, wrong2], NOW);
        expect(out.map((x) => x.question.id)).toEqual(['B', 'A', 'C']);
    });

    it('★ 被②「该复查」漏掉的那批（计划三次做满之后又错）能在这里被捞回来', () => {
        // 计划三格全填 + 最近一次是错 ⇒ dueReviewItems 的判据（第一个空格）找不到它，直接跳过
        const missed = q({
            id: 'A',
            printCount: 3,
            lastPrintedAt: new Date(2026, 8, 1),
            reviewOutcomes: outcomes(['right', 'right', 'right'], 'wrong'),
        });
        expect(dueReviewItems([missed], NOW)).toHaveLength(0); // ② 看不见它
        const out = practiceTodayItems([missed], NOW); // ⑦ 看得见
        expect(out).toHaveLength(1);
        expect(out[0].status.state).toBe('due');
    });

    it('★ 汇总进 buildCabinetTasks：与②③去重（同一题不被三块同时催）', () => {
        const tasks = buildCabinetTasks({
            questions: [q({ id: 'A', reviewOutcomes: null })],
            insights: [],
            volumes: [],
            now: NOW,
        });
        expect(tasks.practiceToday.count).toBe(1);
        expect(tasks.practiceToday.items[0].reasonZh).toBe('还没练过');
        expect(tasks.practiceToday.items[0].urgency).toBe(5);
    });
});
