/**
 * 标签评测题库（30 道）
 *
 * 【设计原则】
 * 1. **不是随便找题凑数**：每题都对着词表里真实存在的「节」来写，这样才能判"选对没选对"。
 * 2. **故意放同名的坑**：五上和四下都有「第一单元 小数的意义和加减法」，
 *    节名一模一样（小数加减法 / 单位换算与复名数 / 小数的意义与数位）。
 *    这是本套词表最容易挂错册的地方 —— 只看名字必然撞车，必须靠册次区分。
 * 3. **跨学科 3 道**：走"无本拍照"场景，验的是"学科能不能判对、判不出时会不会乱塞清单"。
 * 4. **跨年级 2 道**：混入六上内容，验的是会不会硬塞进五上。
 *
 * ⚠️ 输入是**纯文本题干**，跳过了 OCR。所以结果偏乐观：
 *    真实录入还要多一层"图片识别错字"的误差。这一点在报告里必须写明。
 */

export type Scenario = 'notebook' | 'nobody';

export interface EvalCase {
    id: string;
    /** notebook = 从「五上数学」本子里录入（学科、年级已知）；nobody = 首页拍照（都不知道） */
    scenario: Scenario;
    /** 期望学科（中文） */
    subject: string;
    /** 期望册（仅理科有意义） */
    book?: string;
    /** 期望节 */
    section?: string;
    /** 期望知识点：命中任意一个即算对 */
    kps?: string[];
    text: string;
    note?: string;
}

export const CASES: EvalCase[] = [
    /* ── 第一单元：小数的再认识和加减法（与四下同名，最危险） ── */
    {
        id: 'M01', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '小数的意义与数位', kps: ['小数的意义', '小数的数位与计数单位'],
        text: '0.36 里面有（ ）个 0.01，它的计数单位是（ ）。',
    },
    {
        id: 'M02', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '小数的大小比较', kps: ['小数的大小比较'],
        text: '比较大小：0.8 ○ 0.80    3.05 ○ 3.5    0.99 ○ 1',
    },
    {
        id: 'M03', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '小数加减法', kps: ['小数加法', '小数加减混合运算'],
        text: '小明买了一支钢笔 12.5 元，一本笔记本 8.75 元，一共花了多少元？',
    },
    {
        id: 'M04', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '小数加减法', kps: ['小数减法', '小数加减混合运算'],
        text: '妈妈带 50 元去超市，买菜用了 23.6 元，还剩多少元？',
    },
    {
        id: 'M05', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '单位换算与复名数', kps: ['长度单位换算', '单名数与复名数互化', '质量单位换算'],
        text: '3.6 千米 =（ ）米；2 吨 50 千克 =（ ）吨；4 平方米 8 平方分米 =（ ）平方米。',
    },

    /* ── 第二单元：三角形的再认识 ── */
    {
        id: 'M06', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '三角形的分类与特征', kps: ['三角形的分类', '等腰三角形'],
        text: '一个三角形中有两个角分别是 70° 和 40°，这个三角形按角分是什么三角形？按边分呢？',
    },
    {
        id: 'M07', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '三角形内角和', kps: ['三角形内角和'],
        text: '一个三角形的两个内角分别是 65° 和 48°，第三个内角是多少度？',
        note: '⚠️ 五上/四下/八上都有「三角形内角和」，是重名陷阱',
    },
    {
        id: 'M08', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '三角形三边关系', kps: ['三角形三边关系'],
        text: '下面哪组线段能围成一个三角形？A. 3cm、4cm、8cm   B. 5cm、5cm、9cm   C. 2cm、3cm、6cm',
    },
    {
        id: 'M09', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '三角形的分类与特征', kps: ['三角形的底和高'],
        text: '一个等腰三角形的两条边分别是 6 厘米和 13 厘米，它的周长是多少厘米？',
    },

    /* ── 第三单元：小数乘法 ── */
    {
        id: 'M10', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '小数乘整数', kps: ['小数乘整数'],
        text: '每支铅笔 1.8 元，买 6 支一共要付多少元？',
    },
    {
        id: 'M11', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '小数乘小数', kps: ['小数乘小数'],
        text: '每千克苹果 7.8 元，妈妈买了 2.5 千克，需要付多少元？',
    },
    {
        id: 'M12', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '小数乘小数', kps: ['积的小数位数', '积的小数位数不够补0'],
        text: '计算 0.25 × 0.4，积是几位小数？结果是多少？',
    },
    {
        id: 'M13', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '积的近似值与简便运算', kps: ['积的近似值', '小数乘法简便运算'],
        text: '0.83 × 4.7 的积保留两位小数约是多少？',
    },
    {
        id: 'M14', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '积的近似值与简便运算', kps: ['小数乘法简便运算'],
        text: '计算 1.25 × 3.6 × 8，怎样算比较简便？',
    },

    /* ── 第四单元：用字母表示（一） ── */
    {
        id: 'M15', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '用字母表示数', kps: ['用字母表示数'],
        text: '一本故事书 a 元，买 5 本需要（ ）元；当 a = 12 时，一共需要（ ）元。',
    },
    {
        id: 'M16', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '用字母表示数量关系', kps: ['用字母表示数量关系', '代入求值'],
        text: '一辆汽车每小时行 a 千米，3 小时行（ ）千米；当 a = 65 时，3 小时行（ ）千米。',
    },
    {
        id: 'M17', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '等式的性质', kps: ['等式的性质'],
        text: '如果 x + 12 = 30，那么 x =（ ），这样做的依据是什么？',
    },

    /* ── 第五单元：多边形的面积 ── */
    {
        id: 'M18', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '平行四边形的面积', kps: ['平行四边形的面积'],
        text: '一块平行四边形菜地，底是 24 米，高是 15 米，这块菜地的面积是多少平方米？',
    },
    {
        id: 'M19', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '三角形的面积', kps: ['三角形的面积'],
        text: '一个三角形的底是 8 分米，高是 6 分米，它的面积是多少平方分米？',
    },
    {
        id: 'M20', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '梯形的面积', kps: ['梯形的面积'],
        text: '一个梯形的上底是 5 厘米，下底是 9 厘米，高是 4 厘米，面积是多少平方厘米？',
    },
    {
        id: 'M21', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '组合图形的面积', kps: ['组合图形的面积'],
        text: '一个长方形长 10 米、宽 6 米，中间挖去一个底 4 米、高 3 米的三角形，剩下的面积是多少平方米？',
    },

    /* ── 第六单元：图形的位置与运动 ── */
    {
        id: 'M22', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '用数对表示位置', kps: ['用数对表示位置'],
        text: '小明坐在教室的第 3 列第 5 行，用数对表示是（ ， ）。',
    },
    {
        id: 'M23', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '图形的平移', kps: ['图形的平移', '平移的格数'],
        text: '把方格纸上的图形先向右平移 4 格，再向下平移 2 格，画出平移后的图形。',
    },

    /* ── 第七单元：倍数与因数 ── */
    {
        id: 'M24', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '倍数与因数', kps: ['找因数', '倍数与因数'],
        text: '写出 24 的所有因数，其中最大的因数是多少？',
    },
    {
        id: 'M25', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '2、5、3的倍数特征', kps: ['3的倍数特征', '2的倍数特征'],
        text: '在 15、24、30、47 这四个数中，哪些是 3 的倍数？哪些是 2 的倍数？',
    },
    {
        id: 'M26', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '质数与合数', kps: ['最大公因数与最小公倍数', '质数', '合数'],
        text: '求 12 和 18 的最大公因数和最小公倍数。',
    },

    /* ── 第八单元 / 数学好玩 ── */
    {
        id: 'M27', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '可能性', kps: ['可能性的大小'],
        text: '袋子里有 3 个红球和 1 个白球，任意摸出一个球，摸到红球的可能性比摸到白球的可能性（ ）。',
    },
    {
        id: 'M28', scenario: 'notebook', subject: '数学', book: '五年级上',
        section: '鸡兔同笼', kps: ['鸡兔同笼', '假设法'],
        text: '笼子里有鸡和兔共 10 只，一共有 28 条腿，鸡和兔各有多少只？',
    },

    /* ── 跨年级：混入六年级内容（不该硬塞进五上） ── */
    {
        id: 'X01', scenario: 'notebook', subject: '数学', book: '六年级上',
        section: '分数乘法', kps: ['分数乘分数'],
        text: '计算：3/4 × 2/5 =（ ）。',
        note: '六上内容；若被判进五上，说明册次先验起了反作用',
    },
    {
        id: 'X02', scenario: 'notebook', subject: '数学', book: '五年级下',
        section: '分数加减法', kps: ['异分母分数加减法'],
        text: '计算：1/2 + 1/3 =（ ）。',
        note: '五下内容，用来测"能不能跨到下一册"',
    },

    /* ── 跨学科：无本拍照，验学科判断与"不知道就不给清单" ── */
    {
        id: 'C01', scenario: 'nobody', subject: '语文', book: '小学',
        text: '修改下面的病句：通过这次社会实践活动，使我明白了团结的重要性。',
    },
    {
        id: 'C02', scenario: 'nobody', subject: '英语', book: '小学',
        text: 'Choose the correct form: She ______ (go) to school by bike every day.',
    },
];

/** 题库自检：id 唯一、场景合法 */
export function validateCases(cases: EvalCase[]): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const c of cases) {
        if (seen.has(c.id)) problems.push(`重复 id: ${c.id}`);
        seen.add(c.id);
        if (c.scenario === 'notebook' && !c.book) problems.push(`${c.id} 缺 book`);
        if (c.scenario === 'nobody' && c.kps?.length) problems.push(`${c.id} 无本场景不该期望知识点`);
    }
    return problems;
}
