import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
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
export async function GET() {
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
                where: { userId, deletedAt: null },
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
                },
            }),
            prisma.insight.findMany({
                where: { userId },
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
            notebookId: it.notebookId,
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
