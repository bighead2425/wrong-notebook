import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { exportErrorItemToObsidian, parseTags } from "@/lib/obsidian-export";

const logger = createLogger('api:error-items:export-all-obsidian');

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }
        if (!user) {
            return unauthorized("Authentication required");
        }

        const items = await prisma.errorItem.findMany({
            where: { userId: user.id },
            include: { subject: true },
        });

        let succeeded = 0;
        const errors: { id: string; questionNo: string; error: string }[] = [];

        for (const item of items) {
            const questionNo = item.source || "";
            if (!questionNo) {
                errors.push({ id: item.id, questionNo, error: "该题无题号(source)，跳过" });
                continue;
            }
            const result = await exportErrorItemToObsidian({
                questionNo,
                subjectName: item.subject?.name || "",
                gradeSemester: item.gradeSemester || "",
                tags: parseTags(item.knowledgePoints),
                questionText: item.questionText,
                originalImageUrl: item.originalImageUrl,
                analysis: item.analysis,
                answerText: item.answerText,
                mistakeAnalysis: item.mistakeAnalysis,
            });
            if (result.ok) {
                succeeded += 1;
            } else {
                errors.push({ id: item.id, questionNo, error: result.error || "unknown" });
            }
        }

        logger.info({ total: items.length, succeeded, failed: errors.length }, 'Batch export to Obsidian finished');
        return NextResponse.json({
            ok: true,
            total: items.length,
            succeeded,
            failed: errors.length,
            errors,
        });
    } catch (error) {
        logger.error({ error }, 'Error in batch export to Obsidian');
        return internalError("Failed to batch export to Obsidian");
    }
}
