import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAIService } from "@/lib/ai";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, notFound, internalError } from "@/lib/api-errors";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { exportErrorItemToObsidian, parseTags } from "@/lib/obsidian-export";
import {
    subjectKeyToCode,
    formatDateStamp,
    formatQuestionNo,
    startOfToday,
} from "@/lib/question-no";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:merge');

/** 把 data URL 里的纯 base64 抠出来给多模态接口用；非 data URL 返回 null */
function extractBase64(url?: string | null): string | undefined {
    if (!url) return undefined;
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    return m ? m[2] : undefined;
}

/**
 * POST /api/error-items/merge
 * 合并错题（#14 / T6 · 电脑端多选）
 *
 * 流程：选中多道同错的题 → 把它们打包（图 + 原题 + 错因 + 解析）重送 AI →
 *       生成一道**新题**（新题号），原选中题**软删进回收箱**（不彻底删，可还原）。
 *
 * 落库口径：
 * - notebookId = 第一道题所属的本（跨本合并时以第 1 题为准）
 * - mergeSource = 原题号用 "+" 连接
 * - attention: 2 道→2；≥3 道→3（G8 关注档=难度档）
 *
 * Body: { ids: string[] }
 */
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

        const body = await req.json();
        const { ids } = body;

        if (!Array.isArray(ids) || ids.length < 2) {
            return badRequest("Select at least 2 items to merge");
        }

        if (ids.length > 10) {
            return badRequest("Cannot merge more than 10 items at once");
        }

        const items = await prisma.errorItem.findMany({
            where: { id: { in: ids }, userId: user.id },
            include: { notebook: true, tags: true },
            orderBy: { createdAt: "asc" },
        });

        if (items.length !== ids.length) {
            return notFound("Some items do not exist or are not owned by you");
        }

        // 第一题所在本 = 合并题归属（#14：跨本时新合并题存第 1 题的本）
        const first = items[0];
        const notebookId = first.notebookId || undefined;
        const notebook = notebookId
            ? await prisma.notebook.findUnique({ where: { id: notebookId } })
            : null;
        const subjectKey = notebook?.subject || "other";

        // ==== 打包送给 AI 的文本 ====
        const mergedQuestionText = items
            .map((it, i) => {
                const parts: string[] = [];
                parts.push(`【错题 ${i + 1}｜题号 ${it.source || it.id}】`);
                if (it.questionText) parts.push(`题目：${it.questionText}`);
                if (it.mistakeAnalysis) parts.push(`错因：${it.mistakeAnalysis}`);
                if (it.answerText) parts.push(`答案：${it.answerText}`);
                if (it.analysis) parts.push(`解析：${it.analysis}`);
                return parts.join("\n");
            })
            .join("\n\n");

        // ==== 图：取第一道题的原图（重送去由 AI 识别）====
        const imageBase64 = extractBase64(first.originalImageUrl);

        logger.info(
            { userId: user.id, idsCount: items.length, notebookId, subjectKey, hasImage: !!imageBase64 },
            'Merging error items'
        );

        const aiService = getAIService();
        let ai;
        try {
            ai = await aiService.reanswerQuestion(
                mergedQuestionText,
                "zh",
                subjectKey,
                imageBase64,
                first.gradeSemester
            );
        } catch (aiError: any) {
            logger.error({ error: aiError?.message }, 'AI merge failed');
            return internalError(`AI 合并失败：${aiError?.message || "AI merge failed"}`);
        }

        // ==== 标签处理（复用新建逻辑）====
        const tagNames: string[] = Array.isArray(ai.knowledgePoints)
            ? ai.knowledgePoints.filter((n: string) => typeof n === "string" && n.trim())
            : [];

        const tagConnections: { id: string }[] = [];
        for (const tagName of tagNames) {
            let tag = await prisma.knowledgeTag.findFirst({
                where: {
                    name: tagName,
                    OR: [{ isSystem: true }, { userId: user.id }],
                },
            });
            if (!tag) {
                const parentId = await findParentTagIdForGrade(first.gradeSemester, subjectKey);
                tag = await prisma.knowledgeTag.create({
                    data: {
                        name: tagName,
                        subject: subjectKey,
                        isSystem: false,
                        userId: user.id,
                        parentId,
                    },
                });
            }
            tagConnections.push({ id: tag.id });
        }

        // ==== 新题号 ====
        const code = subjectKeyToCode(subjectKey);
        const dateStamp = formatDateStamp(new Date());
        const todayCount = await prisma.errorItem.count({
            where: { userId: user.id, createdAt: { gte: startOfToday() } },
        });
        const questionNo = formatQuestionNo(code, dateStamp, todayCount + 1);

        // ==== 关注档：2 道设 2，≥3 道设 3（G8）====
        const attention = items.length === 2 ? 2 : 3;

        const merged = await prisma.errorItem.create({
            data: {
                userId: user.id,
                notebookId,
                originalImageUrl: first.originalImageUrl,
                questionText: mergedQuestionText,
                answerText: ai.answerText || "",
                analysis: ai.analysis || "",
                mistakeAnalysis: ai.mistakeAnalysis || null,
                mistakeStatus: normalizeMistakeStatusForSave(undefined, ai.wrongAnswerText),
                knowledgePoints: JSON.stringify(tagNames),
                gradeSemester: first.gradeSemester,
                paperLevel: first.paperLevel,
                source: questionNo,
                inputMethod: "merge",
                masteryLevel: 0,
                attention,
                mergeSource: items.map(it => it.source || it.id).join("+"),
                tags: { connect: tagConnections },
            },
            include: { tags: true, notebook: true },
        });

        // ==== 原题软删进回收箱（可还原，不是彻底删）====
        await prisma.errorItem.updateMany({
            where: { id: { in: ids } },
            data: { deletedAt: new Date() },
        });

        logger.info({ mergedId: merged.id, questionNo, trashed: ids.length }, 'Merge completed');

        try {
            const exp = await exportErrorItemToObsidian({
                questionNo,
                subjectName: notebook?.displayName || "",
                gradeSemester: first.gradeSemester || "",
                tags: parseTags(merged.knowledgePoints),
                questionText: mergedQuestionText,
                originalImageUrl: first.originalImageUrl,
                analysis: ai.analysis,
                answerText: ai.answerText,
                mistakeAnalysis: ai.mistakeAnalysis,
            });
            if (!exp.ok) {
                logger.warn({ error: exp.error }, 'Obsidian export failed on merge (non-fatal)');
            }
        } catch (expErr) {
            logger.warn({ error: expErr }, 'Obsidian export threw on merge (non-fatal)');
        }

        return NextResponse.json({ item: merged, trashedIds: ids }, { status: 201 });
    } catch (error) {
        logger.error({ error }, 'Error merging items');
        return internalError("Failed to merge error items");
    }
}
