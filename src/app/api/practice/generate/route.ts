import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { getAIService } from "@/lib/ai";
import { notFound, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { subjectLabel } from "@/lib/notebook-fields";

const logger = createLogger('api:practice:generate');

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    try {
        const { errorItemId, language, difficulty } = await req.json();

        const errorItemWithSubject = await prisma.errorItem.findUnique({
            where: { id: errorItemId },
            /* 【2026-11-01】把标签关系一起取 —— 知识点的真源是 `tags`，不是那列废弃的 */
            include: { notebook: true, tags: true }
        });

        if (!errorItemWithSubject) {
            return notFound("Item not found");
        }

        /**
         * 【2026-11-01 修】**知识点要读 `tags` 关系，不是 `knowledgePoints` 那一列。**
         *
         * 那列在 schema 里早已标 `[DEPRECATED]`，`knowledge-stats.ts`、`cabinet.ts`、
         * `error-item-card.tsx` 都已经换成读关系了 —— 只有这里还留着。
         * 后果很具体：两段式归位只写关系、不写废弃列，所以开关一打开，
         * "举一反三"拿到的知识点永远是空数组，生成的相似题失去方向。
         */
        let tags: string[] = (errorItemWithSubject.tags ?? []).map((t) => t.name);

        /* 兜底：老数据可能只有那列（关系还没建） */
        if (tags.length === 0) {
            try {
                tags = JSON.parse(errorItemWithSubject.knowledgePoints || "[]");
            } catch {
                tags = [];
            }
        }

        const aiService = getAIService();
        const similarQuestion = await aiService.generateSimilarQuestion(
            errorItemWithSubject.questionText || "",
            tags,
            language,
            difficulty || 'medium',
            errorItemWithSubject.gradeSemester
        );

        // Inject the subject from the database with type safety
        const validSubjects = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"] as const;
        // 学科中文名取自 Notebook.subject（不再是显示名）
        const subjectName = subjectLabel(errorItemWithSubject.notebook?.subject);
        similarQuestion.subject = validSubjects.includes(subjectName as any) ? subjectName as typeof validSubjects[number] : "其他";

        return NextResponse.json(similarQuestion);
    } catch (error) {
        logger.error({ error }, 'Error generating practice');
        const errorMessage = error instanceof Error ? error.message : "Failed to generate practice question";
        return internalError(errorMessage);
    }
}
