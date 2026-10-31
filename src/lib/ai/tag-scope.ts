/**
 * 「这次给 AI 看哪几册」——纯函数，不碰数据库。
 *
 * 单独放一个文件，是为了能**直接单测**：`tag-service.ts` 顶部 import 了 prisma，
 * 把它拖进测试就得连带 mock 数据库，测试会变成"测 prisma 而不是测规则"。
 */

/** 年级号 → 该年级涉及的顶层节点（册）名 */
export const GRADE_TO_TOPNODE: Record<number, string[]> = {
    1: ['一年级上', '一年级下'],
    2: ['二年级上', '二年级下'],
    3: ['三年级上', '三年级下'],
    4: ['四年级上', '四年级下'],
    5: ['五年级上', '五年级下'],
    6: ['六年级上', '六年级下'],
    7: ['七年级上', '七年级下'],
    8: ['八年级上', '八年级下'],
    9: ['九年级上', '九年级下'],
    10: ['高一上', '高一下'],
    11: ['高二上', '高二下'],
    /**
     * 【2026-10-31 修】**高三不分上/下。**
     *
     * 词表（数理化生四个学科）顶层只有一个「高三」——高三整年是一轮复习，
     * 教材没有下册。但这里原来写的是 ['高三上', '高三下']，于是：
     *   `topNodeNamesUpTo(12)` 返回 6 个名字 → `getTagTree` 按名字找根节点
     *   → 库里找不到「高三上/下」→ 过滤后只剩高一到高二四册
     *   ⇒ **高三学生拍的任何一道题，AI 从来没看到过高三是哪些知识点。**
     *
     * 这是个静默失败：清单少了册不报错，只是模型选不到，最后标 UNMATCHED
     * 或者硬塞进「高二下」。所以这里必须与词表逐字对齐。
     */
    12: ['高三'],
};

/**
 * 「年级/学期」→「词表里的册名」。
 *
 * 【2026-10-31 新增】为什么要单独一个函数：
 *
 * `gradeTerm` 回答的是"**她什么时候在读**"——高三上、高三下是两段真实时间，
 * 卷子也确实分两批发。而词表要回答的是"**取哪一册**"——高三只有一轮复习，没有下册。
 *
 * 一个字段同时当两个用，就会出现 `tag-scope.ts` 那个 bug：拿着"高三上"去库里找根节点，
 * 找不到，整册静默消失。
 *
 * 所以把边界画在这里：**别的学科原样返回，只有高三归一到「高三」**。
 * 取数、挂父节点、提示词展示一律走它（见 `findParentTagIdForGrade`）。
 */
export function bookKeyOf(term: string | null | undefined): string | null {
    if (!term) return null;
    const t = term.trim();
    if (!t) return null;
    if (t === '高三上' || t === '高三下' || t === '高三') return '高三';
    return t;
}

/**
 * 取要发给 AI 的顶层节点名。
 *
 * 【2026-10-31 改口径】**小学不再跨年级累进，只给"当前年级 + 上一学年"（最多 4 册）。**
 *
 * 为什么改：词表建成 12 册之后，若仍按"一年级到五年级全给"，清单会到 40 多个单元、
 * 几百个知识点，而其中「100以内加减法」这类对一个五年级孩子是纯噪音 ——
 * 选项越多，模型越容易挑"看起来最像的"，而不是正确的。
 *
 * 为什么保留上一学年：单元之间有依赖（五上的小数乘法建立在四下"小数的意义"上），
 * 复习卷也常把上学年内容混进来。只给当前一册会把这类题逼成 UNMATCHED。
 *
 * 中学维持累进（中考、高考本质上都是累计考查）。
 */
export function topNodeNamesUpTo(grade: number | null): string[] {
    if (!grade) {
        return Object.values(GRADE_TO_TOPNODE).flat();
    }

    if (grade <= 6) {
        const from = Math.max(1, grade - 1);
        const names: string[] = [];
        for (let g = from; g <= grade; g++) {
            names.push(...(GRADE_TO_TOPNODE[g] || []));
        }
        return names;
    }

    const start = grade <= 9 ? 7 : 10;
    const names: string[] = [];
    for (let g = start; g <= grade; g++) {
        names.push(...(GRADE_TO_TOPNODE[g] || []));
    }
    return names;
}

/**
 * 学科 → 中文名对照（provider 里拿到的是中文名，查数据用的是英文 key）
 */
export const SUBJECT_KEY_BY_NAME: Record<string, string> = {
    数学: 'math',
    物理: 'physics',
    化学: 'chemistry',
    生物: 'biology',
    语文: 'chinese',
    英语: 'english',
    历史: 'history',
    地理: 'geography',
    政治: 'politics',
};

/**
 * 取数口径：按「册」还是按「学段」。
 *
 * 【2026-10-31】九个学科的词表分家之后，取数不能再一刀切：
 *
 * · **链条型（数理化生）**：前面的章节是后面的地基，教材一册一册往下发。
 *   按册/年级取，且只给"当前年级 + 上一学年"，逼近她眼前正在学的东西。
 *
 * · **能力型/板块型（语文、英语、政史地）**：知识不是沿册垒起来的 ——
 *   语文的"病句修改"、历史的"中国近代史"从第一天起就叫这个名字，到高考还是它。
 *   所以顶层用**学段**（小学 / 初中 / 高中），同一条目在不同学段取不同深度。
 *
 * 混用会出两种错：链条型按学段给，会丢掉"上一册"这个依赖；
 * 能力型按册给，会把同一条能力重复建十几遍，而且一改教材就全废。
 */
export type ScopeKind = 'grade' | 'stage';

export const SUBJECT_SCOPE: Record<string, ScopeKind> = {
    math: 'grade',
    physics: 'grade',
    chemistry: 'grade',
    biology: 'grade',
    chinese: 'stage',
    english: 'stage',
    history: 'stage',
    geography: 'stage',
    politics: 'stage',
};

export type StageName = '小学' | '初中' | '高中';

/** 年级号 → 学段（1–6 小学 / 7–9 初中 / 10–12 高中） */
export function stageOf(grade: number | null): StageName | null {
    if (!grade) return null;
    if (grade <= 6) return '小学';
    if (grade <= 9) return '初中';
    return '高中';
}

/**
 * 某学科、某年级，这次该给 AI 看哪几个顶层节点。
 *
 * - 链条型：交给 `topNodeNamesUpTo`（小学＝当前年级+上一学年，中学＝累进）
 * - 能力型：只给当前学段；年级未知时三个学段都给
 */
export function topNodeNamesForSubject(subject: string, grade: number | null): string[] {
    const scope = SUBJECT_SCOPE[subject] ?? 'grade';

    if (scope === 'stage') {
        const stage = stageOf(grade);
        return stage ? [stage] : ['小学', '初中', '高中'];
    }

    return topNodeNamesUpTo(grade);
}
