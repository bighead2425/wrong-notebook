import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { maybeSettleDaily, normalizeTodayKey } from "@/lib/daily-settle";
import { subjectLabel } from "@/lib/notebook-fields";
import { normalizeManageType } from "@/lib/manage-type";
import {
    buildCabinetTasks,
    CABINET_DEFAULT_OPTIONS,
    type CabinetInsight,
    type CabinetQuestion,
    type CabinetVolume,
} from "@/lib/cabinet";

const logger = createLogger("api:cabinet");

/**
 * GET /api/cabinet —— 「总理内阁」一页所需的数据。
 *
 * 三块（见返回体）：
 *   ① 统计总览：**不在这里** —— 那一块前端直接复用主页统计中心（`WrongAnswerStats` → `/api/analytics`），
 *      别在接口里再算一份，否则两处迟早对不上。
 *   ② 错题本一览：本书 / 每本题数与构成（学科 / 掌握状态 / 错题等级）。
 *   ③ 任务台：六类任务的计数与清单 —— 判据**只**在 `lib/cabinet.ts` 实现，这里只负责取数。
 *
 * ⚠️ 一律按 `userId` 过滤（本项目多用户）。
 * ⚠️ `ReviewVolume` 表**没有 userId 列**（历史设计：卷是"印出去的凭证"，全局存放）。
 *    这里按"卷里至少有一道**当前用户**的题"来认领，避免把别人家的卷摆到他的任务台。
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let userId: string | null = null;
        if (session?.user?.email) {
            const user = await prisma.user.findUnique({
                where: { email: session.user.email },
                select: { id: true },
            });
            userId = user?.id ?? null;
        }
        if (!userId) return unauthorized("Authentication required");

        /**
         * 【2026-10-15 新】**每日等级结算的惰性触发点**。
         *
         * 内阁页是"打开错题本"的主入口 ⇒ 在这儿顺手检查"今天结算过没有"，
         * 没结算就跑一次（`docs\14` 第五节）。**不做定时任务** —— 宿主 crontab /
         * 调度容器都绑在 NAS 上，换机器要重配；惰性触发全在应用里，可移植。
         *
         * ⚠️ `?today=YYYY-MM-DD`：**客户端传自己的"今天"**（浏览器天生知道用户在哪个时区）。
         *    不传 / 传得不合理 ⇒ 退回服务器日期。见 `normalizeTodayKey` 的注释。
         * ⚠️ **必须 await 且吞异常**：`maybeSettleDaily` 自己保证不抛
         *    —— 结算失败绝不能让"打开内阁"失败。
         * ⚠️ 绝大多数请求在这里只花**一次查询**（`lastSettledOn === 今天` 就直接返回）。
         */
        const todayParam = new URL(req.url).searchParams.get("today");
        await maybeSettleDaily(userId, normalizeTodayKey(todayParam));

        const [notebooks, items, insights, volumesRaw] = await Promise.all([
            prisma.notebook.findMany({
                where: { userId, archiveStatus: { not: "archived" } },
                orderBy: { createdAt: "desc" },
                select: {
                    id: true,
                    displayName: true,
                    subject: true,
                    grade: true,
                    semester: true,
                    gradeStage: true,
                },
            }),
            prisma.errorItem.findMany({
                where: {
                    userId,
                    deletedAt: null,
                    /**
                     * 【2026-10-04 审理补】口径与**主库**（`/api/error-items/list` 的 scope=main）一致：
                     * **归档本里的题不算"在用错题"**。
                     * 不改的话，下面 `notebooks` 排除了归档本、这里却把它们的题算进
                     * "错题总数 / 学科分布 / 掌握构成" ⇒ 同一页上三个数字自相矛盾，
                     * 且归档本的题因为 `notebookSubject` 查不到会整批掉进"其他"学科。
                     *
                     * ⚠️ 只排除"归属归档本"的题；`notebookId=null`（还没归档到本）的题照常统计。
                     * ⚠️ 这里**不**按 masteryLevel 过滤 —— "掌握构成"就是要显示已掌握的那些。
                     */
                    OR: [{ notebookId: null }, { notebook: { is: { archiveStatus: { not: "archived" } } } }],
                },
                select: {
                    id: true,
                    notebookId: true,
                    source: true,
                    manageType: true,
                    printCount: true,
                    lastPrintedAt: true,
                    reviewOutcomes: true,
                    masteryLevel: true,
                    createdAt: true,
                    /** 【2026-10-13 底账】错因（覆盖率要数它） */
                    mistakeCategory: true,
                    /**
                     * 【2026-10-15 真真】知识点统计要它 —— 真源是**多对多 `tags`**，
                     * 不是 `ErrorItem.knowledgePoints` 那列（已 `[DEPRECATED]`）。
                     * ⚠️ 只取统计用得到的两列；**别在这里顺手加别的 include**（会拖慢列表）。
                     */
                    tags: { select: { name: true, subject: true } },
                    /** 【2026-10-13 底账】学科只在 Notebook 上（题自己不存）⇒ 连本子一起取 */
                    notebook: { select: { subject: true } },
                },
            }),
            prisma.insight.findMany({
                /** 【2026-10-13】草稿（暂存）不算"未打印的日积月累" —— 它还没整理，不是待印内容 */
                where: { userId, status: { not: 'draft' } },
                select: {
                    id: true,
                    code: true,
                    subject: true,
                    errorItemNo: true,
                    volumeItems: { select: { volumeId: true } },
                },
            }),
            prisma.reviewVolume.findMany({
                where: { kind: "review" },
                select: {
                    id: true,
                    volumeNo: true,
                    kind: true,
                    createdAt: true,
                    items: {
                        select: {
                            markState: true,
                            errorItem: { select: { userId: true } },
                        },
                    },
                },
            }),
        ]);

        // 题 → 纯逻辑输入
        const questions: CabinetQuestion[] = items.map((it) => ({
            id: it.id,
            source: it.source,
            manageType: it.manageType,
            printCount: it.printCount,
            lastPrintedAt: it.lastPrintedAt,
            reviewOutcomes: it.reviewOutcomes,
            /** 【2026-10-13】⑦「今天先练」要用它把"已掌握"的排除掉（上面 select 里本来就有） */
            masteryLevel: it.masteryLevel,
            notebookId: it.notebookId,
            /** 【2026-10-13 底账】学科从本子来；没归本的题 = null（底账里落「未归本」） */
            subject: it.notebook?.subject ?? null,
            /** 【2026-10-13 底账】错因 */
            mistakeCategory: it.mistakeCategory,
            /** 【2026-10-15 真真】知识点（多对多）—— 知识点统计的唯一输入 */
            tags: it.tags.map((t) => ({ name: t.name, subject: t.subject })),
        }));

        // 日积月累 → 纯逻辑输入（记下它被编进过哪些卷）
        const cabinetInsights: CabinetInsight[] = insights.map((i) => ({
            id: i.id,
            code: i.code,
            subject: i.subject,
            errorItemNo: i.errorItemNo,
            volumeIds: i.volumeItems.map((v) => v.volumeId),
        }));

        // 卷 → 纯逻辑输入（只认领"含当前用户题目"的卷）
        const volumes: CabinetVolume[] = volumesRaw
            .filter((v) => v.items.some((it) => it.errorItem?.userId === userId))
            .map((v) => ({
                id: v.id,
                volumeNo: v.volumeNo,
                kind: v.kind,
                createdAt: v.createdAt,
                items: v.items.map((it) => ({ markState: it.markState })),
            }));

        const tasks = buildCabinetTasks({
            questions,
            insights: cabinetInsights,
            volumes,
            now: new Date(),
            options: CABINET_DEFAULT_OPTIONS,
        });

        // ===== 错题本一览（按本聚合 + 全局构成）=====
        const perNotebook = new Map<
            string,
            { count: number; manageType: { deep: number; review: number; undecided: number }; mastery: { fresh: number; reviewing: number; mastered: number } }
        >();
        const emptyBucket = () => ({
            count: 0,
            manageType: { deep: 0, review: 0, undecided: 0 },
            mastery: { fresh: 0, reviewing: 0, mastered: 0 },
        });

        const overallManageType = { deep: 0, review: 0, undecided: 0 };
        const overallMastery = { fresh: 0, reviewing: 0, mastered: 0 };

        for (const it of items) {
            const key = it.notebookId ?? "__none__";
            if (!perNotebook.has(key)) perNotebook.set(key, emptyBucket());
            const bucket = perNotebook.get(key)!;
            bucket.count += 1;

            const mt = normalizeManageType(it.manageType);
            const mtKey = mt ?? "undecided";
            bucket.manageType[mtKey] += 1;
            overallManageType[mtKey] += 1;

            const ms = it.masteryLevel >= 2 ? "mastered" : it.masteryLevel === 1 ? "reviewing" : "fresh";
            bucket.mastery[ms] += 1;
            overallMastery[ms] += 1;
        }

        const notebookRows = notebooks.map((nb) => {
            const bucket = perNotebook.get(nb.id) ?? emptyBucket();
            return {
                id: nb.id,
                displayName: nb.displayName,
                subject: nb.subject,
                subjectLabel: subjectLabel(nb.subject),
                grade: nb.grade,
                semester: nb.semester,
                gradeStage: nb.gradeStage,
                count: bucket.count,
                byManageType: bucket.manageType,
                byMastery: bucket.mastery,
            };
        });

        // 学科分布：按"本"的学科归类（题随本走；无本的题归"其他"）
        const subjectCount = new Map<string, number>();
        const notebookSubject = new Map(notebooks.map((nb) => [nb.id, nb.subject]));
        for (const it of items) {
            const subj = (it.notebookId && notebookSubject.get(it.notebookId)) || "other";
            subjectCount.set(subj, (subjectCount.get(subj) ?? 0) + 1);
        }

        return NextResponse.json({
            generatedAt: new Date().toISOString(),
            overview: {
                notebookCount: notebooks.length,
                questionCount: items.length,
                bySubject: [...subjectCount.entries()]
                    .map(([subject, count]) => ({ subject, label: subjectLabel(subject), count }))
                    .sort((a, b) => b.count - a.count),
                byManageType: overallManageType,
                byMastery: overallMastery,
            },
            notebooks: notebookRows,
            tasks,
        });
    } catch (error) {
        logger.error({ error }, "Error building cabinet data");
        return internalError("Failed to build cabinet data");
    }
}
