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
    12: ['高三上', '高三下'],
};

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
