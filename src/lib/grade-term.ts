/**
 * 【2026-09-30】年级·学期（"小一上 … 高三下"）的**唯一一套说法**。
 *
 * 用途：
 *   ① 复练卷页的「年级/学期」筛选下拉（18 个学期，从 小一上 到 高三下）；
 *   ② 从错题本页跳进复练卷页时，带上"这本的年级学期"作为筛选。
 *
 * ── 为什么要"归一"而不是直接字符串比 ────────────────────────────
 *   库里 `ErrorItem.gradeSemester` 的实际写法不统一：纸面上见到的是 `六年级上`
 *   （见打印页眉"六年级上·五年级上"），而他嘴里说的是 `小六上`；
 *   初中还有 `初一` / `七年级` 两套叫法（列表接口的 buildGradeFilter 里就为此写了别名表）。
 *   所以这里统一：**先解析成"年级 + 学期"的规范键**（如 `六年级上`）再比 ——
 *   两边写法不同也能对上，不靠字符串碰巧相等。
 */

/** 规范年级键（库里的主写法） + 显示短名（他习惯的叫法：小六 / 初一 / 高三） */
const GRADES: { key: string; short: string; aliases: string[] }[] = [
    { key: '一年级', short: '小一', aliases: ['一年级', '小一', '一年', '1年级', '1年'] },
    { key: '二年级', short: '小二', aliases: ['二年级', '小二', '二年', '2年级', '2年'] },
    { key: '三年级', short: '小三', aliases: ['三年级', '小三', '三年', '3年级', '3年'] },
    { key: '四年级', short: '小四', aliases: ['四年级', '小四', '四年', '4年级', '4年'] },
    { key: '五年级', short: '小五', aliases: ['五年级', '小五', '五年', '5年级', '5年'] },
    { key: '六年级', short: '小六', aliases: ['六年级', '小六', '六年', '6年级', '6年'] },
    { key: '初一', short: '初一', aliases: ['初一', '七年级', '7年级', '七'] },
    { key: '初二', short: '初二', aliases: ['初二', '八年级', '8年级', '八'] },
    { key: '初三', short: '初三', aliases: ['初三', '九年级', '9年级', '九'] },
    { key: '高一', short: '高一', aliases: ['高一', '10年级'] },
    { key: '高二', short: '高二', aliases: ['高二', '11年级'] },
    { key: '高三', short: '高三', aliases: ['高三', '12年级'] },
];

const GRADE_BY_ALIAS: Record<string, { key: string; short: string }> = {};
for (const g of GRADES) {
    for (const a of g.aliases) GRADE_BY_ALIAS[a] = { key: g.key, short: g.short };
}

export interface GradeTerm {
    /** 规范键，如 `六年级上`（与库里主写法一致） */
    key: string;
    /** 显示名，如 `小六上` */
    label: string;
}

/** 18 个学期：小一上 → 高三下（顺序就是他说的那串） */
export const GRADE_TERMS: readonly GradeTerm[] = GRADES.flatMap((g) =>
    (['上', '下'] as const).map((sem) => ({ key: `${g.key}${sem}`, label: `${g.short}${sem}` })),
);

/** 把任意一种写法归一到规范键；认不出返回 null（**不猜**，免得筛出个空列表让人以为题没了） */
export function normalizeTerm(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = raw.replace(/\s/g, '');
    const m = s.match(/^(.*?)([上下])$/);
    if (!m) return null;
    const g = GRADE_BY_ALIAS[m[1]];
    return g ? `${g.key}${m[2]}` : null;
}

/**
 * 卷页眉那句"年级·学期"可能不止一个（跨本组卷：`六年级上·五年级上`），
 * 这里拆成规范键数组。
 */
export function splitGradeText(text: string | null | undefined): string[] {
    if (!text) return [];
    return text
        .split(/[·,，、/\s]+/)
        .map((p) => normalizeTerm(p))
        .filter((v): v is string => !!v);
}

/** 这份卷是否属于某个学期（跨本组卷的卷，**任一部分**命中就算） */
export function volumeMatchesTerm(gradeText: string | null | undefined, termKey: string): boolean {
    return splitGradeText(gradeText).includes(termKey);
}

/** 学期下拉的显示名（`六年级上` → `小六上`；认不出就原样显示） */
export function termLabel(termKey: string): string {
    const hit = GRADE_TERMS.find((t) => t.key === termKey);
    return hit ? hit.label : termKey;
}
