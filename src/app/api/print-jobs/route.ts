import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import {
    buildPrintInstanceCode,
    isValidQuestionNo,
    SIDE_BACK,
    SIDE_FRONT,
} from "@/lib/print-instance";
import { nextInstanceNo, PRINT_JOB_STATUS } from "@/lib/print-job-state";

const logger = createLogger("api:print-jobs");

/**
 * POST /api/print-jobs
 * 为一批题创建「打印实例」，返回正反两面二维码的内容。
 *
 * ⚠️ 这是顺序上的实质改动（M0，设计依据 P25.1）：
 *   旧流程 = 「画二维码（只含题号）→ 打印 → 打完记 printCount」。
 *   但新规范要求二维码写成 <题号>-R<第几次>-<面>，而"第几次"**只在点打印那一刻才知道**。
 *   ⇒ 必须**先建实例拿到编号 → 用编号生成两个二维码 → 再打印**。
 *   所以本接口要在打印之前调用，返回 frontCode / backCode 供前端画码。
 *
 * 计数一致性：建实例与 ErrorItem.printCount 自增在**同一个事务**里完成，
 * 谁也不能单独前进 —— 否则两者漂移，而漂移不报错、只静默错。
 *
 * Body: {
 *   errorItemIds: string[],
 *   stage?: "initial" | "day7" | "day21",   // 默认 initial
 *   paperType?: "T1" | "T0",                // 默认 T1
 *   hasReplyPage?: boolean                  // 本批是否含回信页
 * }
 * 返回: { batchId, jobs: [...], failed: [{ errorItemId, reason }] }
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        const body = await req.json().catch(() => null);
        const errorItemIds = Array.isArray(body?.errorItemIds) ? (body.errorItemIds as string[]) : null;

        if (!errorItemIds || errorItemIds.length === 0) {
            return badRequest("errorItemIds must be a non-empty array");
        }

        const stage = typeof body?.stage === "string" ? body.stage : "initial";
        const paperType = typeof body?.paperType === "string" ? body.paperType : "T1";
        const hasReplyPage = body?.hasReplyPage === true;

        const user = session?.user?.email
            ? await prisma.user.findUnique({ where: { email: session.user.email } })
            : null;

        if (!user) {
            return unauthorized("Authentication required");
        }

        // 只受理属于当前用户的题
        const items = await prisma.errorItem.findMany({
            where: { id: { in: errorItemIds }, userId: user.id },
            select: { id: true, source: true },
        });
        const found = new Map(items.map((i) => [i.id, i]));

        const failed: { errorItemId: string; reason: string }[] = [];
        const ready: { id: string; questionNo: string }[] = [];

        for (const id of errorItemIds) {
            const item = found.get(id);
            if (!item) {
                failed.push({ errorItemId: id, reason: "not_found_or_not_owned" });
                continue;
            }

            const no = (item.source || "").trim().toUpperCase();
            if (!isValidQuestionNo(no)) {
                // 不猜、不自动补题号：题号会印进二维码，错号要等到扫回来才发现，返工成本极高。
                // 这里如实报出来，由前端提示"这题缺题号"。
                failed.push({ errorItemId: id, reason: "invalid_question_no" });
                continue;
            }

            ready.push({ id, questionNo: no });
        }

        if (ready.length === 0) {
            return NextResponse.json({ batchId: null, jobs: [], failed });
        }

        const result = await prisma.$transaction(async (tx) => {
            const batch = await tx.printBatch.create({
                data: { userId: user.id, hasReplyPage, itemCount: ready.length },
            });

            // 一次性取回所有相关实例，避免逐题查询
            const existingJobs = await tx.printJob.findMany({
                where: { errorItemId: { in: ready.map((r) => r.id) } },
                select: { errorItemId: true, instanceNo: true, status: true },
            });
            const byItem = new Map<string, { instanceNo: number; status: string }[]>();
            for (const job of existingJobs) {
                const list = byItem.get(job.errorItemId);
                if (list) list.push(job);
                else byItem.set(job.errorItemId, [job]);
            }

            const jobs: {
                id: string;
                errorItemId: string;
                questionNo: string;
                instanceNo: number;
                paperType: string;
                stage: string;
                frontCode: string;
                backCode: string;
            }[] = [];

            for (const r of ready) {
                const instanceNo = nextInstanceNo(byItem.get(r.id));

                const job = await tx.printJob.create({
                    data: {
                        errorItemId: r.id,
                        questionNo: r.questionNo,
                        instanceNo,
                        paperType,
                        stage,
                        batchId: batch.id,
                        status: PRINT_JOB_STATUS.printed,
                    },
                });

                await tx.errorItem.update({
                    where: { id: r.id },
                    data: { printCount: { increment: 1 }, lastPrintedAt: new Date() },
                });

                jobs.push({
                    id: job.id,
                    errorItemId: r.id,
                    questionNo: r.questionNo,
                    instanceNo,
                    paperType,
                    stage,
                    frontCode: buildPrintInstanceCode(r.questionNo, instanceNo, SIDE_FRONT),
                    backCode: buildPrintInstanceCode(r.questionNo, instanceNo, SIDE_BACK),
                });
            }

            return { batchId: batch.id, jobs };
        });

        logger.info(
            { userId: user.id, batchId: result.batchId, created: result.jobs.length, failed: failed.length },
            "Print jobs created",
        );

        return NextResponse.json({ ...result, failed });
    } catch (error) {
        logger.error({ error }, "Error creating print jobs");
        return internalError("Failed to create print jobs");
    }
}
