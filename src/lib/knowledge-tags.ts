/**
 * 知识点标签工具函数
 * 
 * 注意：课程数据已迁移到数据库，通过 seed scripts 导入。
 * 此文件仅保留通用工具函数。
 */

/**
 * 根据教育阶段和入学年份计算当前年级数字
 *
 * 【2026-10-30】补齐小学（1–6）。
 * 原来只认初中/高中，小学一律返回 null —— 而 null 会让 `getMathTagsFromDB`
 * 走「无年级」分支、返回**初高中全部标签**，于是 AI 拿初中的词去标小学的题。
 * 现实里孩子填的是「小学 / 2021」，所以这条一直没被触发过：它一直在错着跑。
 *
 * @param educationStage 教育阶段 ('primary' | 'junior_high' | 'senior_high' | 'university')
 * @param enrollmentYear 入学年份
 * @returns 年级 (1-12) 或 null（大学/信息不足/超出范围）
 */
export function calculateGradeNumber(
    educationStage: string | null,
    enrollmentYear: number | null
): number | null {
    if (!enrollmentYear) {
        return null;
    }

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1; // 1-12

    // 计算入学后的年数
    let yearsInSchool = currentYear - enrollmentYear;

    // 如果当前月份在9月之前,说明还没开学,年级要减1
    if (currentMonth < 9) {
        yearsInSchool -= 1;
    }

    // 入学年份填成未来（或今年 9 月前还没入学）时不要算出 0 年级
    if (yearsInSchool < 0) {
        return null;
    }

    if (educationStage === 'primary') {
        // 小学: 入学第1年=一年级, 第6年=六年级
        const grade = 1 + yearsInSchool;
        return grade >= 1 && grade <= 6 ? grade : null;
    }

    if (educationStage === 'junior_high') {
        // 初中: 入学第1年=7年级, 第2年=8年级, 第3年=9年级
        const grade = 7 + yearsInSchool;
        return grade >= 7 && grade <= 9 ? grade : null;
    }

    if (educationStage === 'senior_high') {
        // 高中: 入学第1年=10年级(高一), 第2年=11年级(高二), 第3年=12年级(高三)
        const grade = 10 + yearsInSchool;
        return grade >= 10 && grade <= 12 ? grade : null;
    }

    // university 及其他：不参与知识点年级过滤
    return null;
}

/**
 * 从错题本名称推断学科
 * @param subjectName 错题本名称
 * @returns 学科标识
 */
export function inferSubjectFromName(subjectName: string | null): 'math' | 'physics' | 'chemistry' | 'biology' | 'english' | 'chinese' | 'history' | 'geography' | 'politics' | null {
    if (!subjectName) return null;

    const lowerName = subjectName.toLowerCase();

    if (lowerName.includes('math') || lowerName.includes('数学')) return 'math';
    if (lowerName.includes('physics') || lowerName.includes('物理')) return 'physics';
    if (lowerName.includes('chemistry') || lowerName.includes('化学')) return 'chemistry';
    if (lowerName.includes('biology') || lowerName.includes('生物')) return 'biology';
    if (lowerName.includes('english') || lowerName.includes('英语')) return 'english';
    if (lowerName.includes('chinese') || lowerName.includes('语文')) return 'chinese';
    if (lowerName.includes('history') || lowerName.includes('历史')) return 'history';
    if (lowerName.includes('geography') || lowerName.includes('地理')) return 'geography';
    if (lowerName.includes('politics') || lowerName.includes('政治')) return 'politics';

    return null;
}

/**
 * 把主页手填的「年级/学期」解析成年级数字。
 *
 * 【2026-10-30】**优先用它，不要再靠入学年份推算。**
 * 用户在主页填的是"她现在读几年级"，这是已知事实；
 * 用 enrollmentYear 推算是二次推断，一旦入学年份填错就整体偏一级
 * （2026-10-30 就出现过：填 2021，算出六年级上，而题是五年级的）。
 *
 * 认得的写法：一年级…六年级 / 初一…初三 / 七年级…九年级 / 高一…高三 / Grade 1-12。
 * 认不出就返回 null，由调用方退回旧逻辑——不猜。
 */
export function gradeTermToNumber(term: string | null | undefined): number | null {
    if (!term) return null;
    const t = term.trim();
    if (!t) return null;

    // Grade 7 / grade7
    const en = t.match(/grade\s*(\d{1,2})/i);
    if (en) {
        const n = Number(en[1]);
        return n >= 1 && n <= 12 ? n : null;
    }

    // 中文数字
    const cn: Record<string, number> = {
        一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
        七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
    };

    // 小学：X年级
    const primary = t.match(/([一二三四五六])年级/);
    if (primary) return cn[primary[1]] ?? null;

    // 初中：初一/初二/初三 或 七/八/九年级
    const junior = t.match(/初([一二三])/);
    if (junior) return 6 + (cn[junior[1]] ?? 0);
    const junior2 = t.match(/([七八九])年级/);
    if (junior2) return cn[junior2[1]] ?? null;

    // 高中：高一/高二/高三
    const senior = t.match(/高([一二三])/);
    if (senior) return 9 + (cn[senior[1]] ?? 0);

    return null;
}
