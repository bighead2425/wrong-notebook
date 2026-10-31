/**
 * 把**任何写法的"年级学期"**归一成词表里的册名。
 *
 * 【2026-11-01】为什么需要它：
 *   查线上库，同一个字段有 7 种写法 ——
 *     '五年级上'(64) / '六年级上'(33) / '五年级/上学期'(3) / '四年级上'(1)
 *     '五年级下'(1) / '五年级'(1) / 'Grade 6, 1st Semester'(1)
 *   而词表只认 '五年级上' 这种。认不出 ⇒ 两段式算 `currentOrder` 得 null ⇒
 *   **"当前册全册"一个都不进候选**，只能靠关键词撞运气。
 *
 * 注意：这个函数只服务两段式的「当前册」判断，
 * **不动 `lib/tag-scope.ts` 的 `bookKeyOf`** —— 那个是标签解析在用的，
 * 改它的影响面大得多，不该为了这个需求去动。
 */

const CN_DIGIT = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 词表里有的册名（与 MATH_GRADE_ORDER 一致；高中只到"高三"不上下分） */
export function isKnownBook(book: string | null | undefined): boolean {
    if (!book) return false;
    return /^[一二三四五六七八九]年级[上下]$/.test(book)
        || /^高[一二三][上下]$/.test(book)
        || book === '高三';
}

/**
 * 归一。认不出返回 null（而不是硬猜一个）。
 *
 * 认得出的写法：
 *   五年级上 / 五年级上学 / 五年级上学期 / 五年级/上学期 / 五年级（上）
 *   五年级 / 五年级上 / 五年级（下）
 *   Grade 6, 1st Semester / Grade 6 2nd Semester
 */
export function normalizeGradeBook(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const t = raw.trim().replace(/\s+/g, '');
    if (!t) return null;

    /* 英文：Grade 6, 1st Semester */
    const en = t.match(/grade(\d)[,，]?(\d)(?:st|nd|rd|th)?semester/i);
    if (en) {
        const gradeNo = Number(en[1]);
        const g = CN_DIGIT[gradeNo - 1];
        if (g) return `${g}年级${en[2] === '1' ? '上' : '下'}`;
    }

    /* 中文：年级 + 任意后缀 */
    const m = t.match(/^([一二三四五六七八九]年级|高[一二三])(.*)$/);
    if (!m) return null;
    const grade = m[1];
    const rest = m[2] ?? '';

    /* 高三在词表里就是一册，不分上下 */
    if (grade === '高三') return '高三';

    if (/上/.test(rest)) return `${grade}上`;
    if (/下/.test(rest)) return `${grade}下`;

    /* 只有年级、没有学期 —— 认不出是哪一册，不猜 */
    return null;
}

/**
 * 从「本子的年级 + 学期」拼出册名。
 *
 * 本子比题目记录可靠：本子是**按册建的**（"小五上数学"），
 * 而题目的 `gradeSemester` 是保存时按主页年级填的，可能和这道题真正所属的册不一致
 * （实例：大雁塔那道记的是"六年级上"，实际是四下，而它录在"五年级上"的本子里）。
 */
export function bookFromNotebook(
    grade: string | null | undefined,
    semester: string | null | undefined,
): string | null {
    if (!grade) return null;
    const g = grade.trim();
    if (!g) return null;
    const s = (semester ?? '').trim();
    const combined = `${g}${s}`;
    return normalizeGradeBook(combined) ?? normalizeGradeBook(g);
}
