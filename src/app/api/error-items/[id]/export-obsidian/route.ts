import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { exportErrorItemToObsidian, parseTags } from "@/lib/obsidian-export";

const logger = createLogger('api:error-items:export-obsidian');

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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

        const item = await prisma.errorItem.findUnique({
            where: { id },
            include: { notebook: true },
        });
        if (!item) {
            return notFound("Item not found");
        }
        if (item.userId !== user.id) {
            return forbidden("Not authorized to export this item");
        }

        const questionNo = item.source || "";
        if (!questionNo) {
            return NextResponse.json(
                { ok: false, error: "该题尚未生成题号(source)，无法导出" },
                { status: 400 }
            );
        }

        const result = await exportErrorItemToObsidian({
            questionNo,
            subjectName: item.notebook?.displayName || "",
            gradeSemester: item.gradeSemester || "",
            tags: parseTags(item.knowledgePoints),
            questionText: item.questionText,
            originalImageUrl: item.originalImageUrl,
            analysis: item.analysis,
            answerText: item.answerText,
            mistakeAnalysis: item.mistakeAnalysis,
        });

        if (result.ok) {
            logger.info({ notePath: result.notePath }, 'Exported to Obsidian via manual button');
            return NextResponse.json({ ok: true, notePath: result.notePath });
        }
        logger.warn({ error: result.error }, 'Obsidian manual export failed');
        return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    } catch (error) {
        logger.error({ error }, 'Error exporting to Obsidian');
        return internalError("Failed to export to Obsidian");
    }
}
