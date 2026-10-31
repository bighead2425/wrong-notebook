/**
 * 标签链路 · 观测脚本（第四批）
 *
 * 回答三个数，用来决定"要不要做更贵的那套（两阶段检索）"：
 *   ① 最近 N 道题里，有多少条留下了 tagResolution（没有就无法核算）
 *   ② matchedBy 的分布（path / book-name / legacy / none）
 *   ③ 偏离默认册的记录里，有多少条没写判据（判据是审"AI 是不是瞎改册"的唯一线索）
 *
 * 跑法：
 *   npm run verify:tags
 *   VERIFY_TAKE=200 npm run verify:tags
 *
 * ⚠️ 写成 .mjs 而不是 .ts：容器/CI 里跑 ts-node 要处理 module 配置与路径别名，
 *    这是个只读的运维小工具，不值得为它引入一层编译。下面两段"口径"必须与
 *    `src/lib/ai/tag-scope.ts` 保持一致（高三归一、按学段建树的学科名单）。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TAKE = Number(process.env.VERIFY_TAKE || 50);

/** 与 tag-scope.ts 的 bookKeyOf 同口径：高三上/下 → 高三 */
function bookKeyOf(term) {
    if (!term) return null;
    const t = String(term).trim();
    if (!t) return null;
    if (t === '高三上' || t === '高三下' || t === '高三') return '高三';
    return t;
}

/** 与 tag-scope.ts 的 SUBJECT_SCOPE 同口径：这些学科按学段建树，book 写的是「小学/初中/高中」 */
const STAGE_SUBJECTS = new Set(['chinese', 'english', 'history', 'geography', 'politics']);

async function main() {
    const rows = await prisma.errorItem.findMany({
        orderBy: { createdAt: 'desc' },
        take: TAKE,
        select: {
            id: true,
            tagResolution: true,
            tagDeviation: true,
            notebook: { select: { grade: true, semester: true, subject: true } },
        },
    });

    let withResolution = 0;
    let deviationChecked = 0;
    let deviationMissing = 0;
    const dist = {};

    for (const row of rows) {
        if (!row.tagResolution) continue;
        withResolution += 1;

        let arr = [];
        try {
            arr = JSON.parse(row.tagResolution);
        } catch {
            continue;
        }
        if (!Array.isArray(arr)) continue;

        for (const t of arr) {
            const k = t.matchedBy || 'unknown';
            dist[k] = (dist[k] || 0) + 1;
        }

        const subject = row.notebook?.subject || '';
        if (STAGE_SUBJECTS.has(subject)) continue;
        if (!row.notebook?.grade) continue;

        const ownBook = bookKeyOf(`${row.notebook.grade}${row.notebook.semester || ''}`);
        const changed = arr.some((t) => t.book && ownBook && bookKeyOf(t.book) !== ownBook);
        if (changed) {
            deviationChecked += 1;
            if (!row.tagDeviation) deviationMissing += 1;
        }
    }

    const coverage = rows.length ? withResolution / rows.length : 0;
    /* "覆盖率 100%" 只在有数据时才有意义；空库直接判 PASS，避免新部署时永远红 */
    const ok = rows.length === 0 || (coverage >= 0.99 && deviationMissing === 0);

    console.log(`样本：最近 ${rows.length} 道题`);
    console.log(`① tagResolution 覆盖率：${withResolution}/${rows.length}（${(coverage * 100).toFixed(1)}%）`);
    console.log(`② matchedBy 分布：${JSON.stringify(dist)}`);
    console.log(`③ 偏离默认册的记录：${deviationChecked} 条，其中没写判据 ${deviationMissing} 条`);
    console.log(ok ? 'PASS' : 'FAIL');
    if (!ok) process.exitCode = 1;
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
