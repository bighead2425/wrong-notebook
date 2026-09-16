import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { exportErrorItemToObsidian, parseTags } from "@/lib/obsidian-export";

const logger = createLogger('api:error-items:id');

export async function GET(
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

        const errorItem = await prisma.errorItem.findUnique({
            where: {
                id: id,
            },
            include: {
                notebook: true,
                tags: true, // 包含标签关联
            },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        // Ensure the user owns this item
        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to access this item");
        }

        return NextResponse.json(errorItem);
    } catch (error) {
        logger.error({ error }, 'Error fetching item');
        return internalError("Failed to fetch error item");
    }
}

export async function PUT(
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

        const body = await req.json();
        const { knowledgePoints, gradeSemester, paperLevel, questionText, answerText, analysis, notebookId, wrongAnswerText, mistakeAnalysis, mistakeStatus } = body;

        const errorItem = await prisma.errorItem.findUnique({
            where: { id },
            include: { notebook: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to update this item");
        }

        // 构建更新数据
        const updateData: Prisma.ErrorItemUpdateInput = {};
        if (gradeSemester !== undefined) updateData.gradeSemester = gradeSemester;
        if (paperLevel !== undefined) updateData.paperLevel = paperLevel;
        if (questionText !== undefined) updateData.questionText = questionText;
        if (answerText !== undefined) updateData.answerText = answerText;
        if (analysis !== undefined) updateData.analysis = analysis;
        // ⚠️ Q4/G6：wrongAnswerText 已弃用，保留列但**不再写入**（仅接收用于推算 mistakeStatus）
        if (mistakeAnalysis !== undefined) updateData.mistakeAnalysis = mistakeAnalysis || null;
        if (notebookId !== undefined) {
            if (notebookId === "") {
                updateData.notebook = { disconnect: true };
            } else {
                // 验证目标错题本存在且属于该用户
                const targetNotebook = await prisma.notebook.findUnique({ where: { id: notebookId } });
                if (!targetNotebook || targetNotebook.userId !== user.id) {
                    return forbidden("Not authorized to move to this notebook");
                }
                updateData.notebook = { connect: { id: notebookId } };
            }
        }
        if (mistakeStatus !== undefined || wrongAnswerText !== undefined || mistakeAnalysis !== undefined) {
            const nextWrongAnswerText = wrongAnswerText !== undefined ? wrongAnswerText : errorItem.wrongAnswerText;
            const nextMistakeAnalysis = mistakeAnalysis !== undefined ? mistakeAnalysis : errorItem.mistakeAnalysis;
            updateData.mistakeStatus = normalizeMistakeStatusForSave(
                mistakeStatus,
                nextWrongAnswerText
            );
        }

        // 处理 knowledgePoints (标签)
        if (knowledgePoints !== undefined) {
            const tagNames: string[] = Array.isArray(knowledgePoints)
                ? knowledgePoints
                : typeof knowledgePoints === 'string'
                    ? JSON.parse(knowledgePoints)
                    : [];

            // 学科：直接读 Notebook.subject（5.5），不再从名字猜
            // 若本次请求同时换了本，则以新本为准；否则用原题所属本
            let subjectKey = errorItem.notebook?.subject || 'other';
            if (notebookId !== undefined && notebookId !== '') {
                const nb = await prisma.notebook.findUnique({ where: { id: notebookId } });
                if (nb?.subject) subjectKey = nb.subject;
            } else if (notebookId === '') {
                subjectKey = 'other';
            }

            const tagConnections: { id: string }[] = [];
            for (const tagName of tagNames) {
                let tag = await prisma.knowledgeTag.findFirst({
                    where: {
                        name: tagName,
                        OR: [
                            { isSystem: true },
                            { userId: user.id },
                        ],
                    },
                });

                if (!tag) {
                    // Determine grade context for the new tag
                    // Use the incoming gradeSemester (priority) or the existing one on the item
                    const contextGrade = gradeSemester !== undefined ? gradeSemester : errorItem.gradeSemester;

                    const parentId = await findParentTagIdForGrade(contextGrade, subjectKey);

                    tag = await prisma.knowledgeTag.create({
                        data: {
                            name: tagName,
                            subject: subjectKey,
                            isSystem: false,
                            userId: user.id,
                            parentId: parentId, // Link to Grade node
                        },
                    });
                }
                tagConnections.push({ id: tag.id });
            }

            // 更新标签关联: 先断开所有，再连接新的
            updateData.tags = {
                set: [], // 先清空
                connect: tagConnections,
            };

            // 保留旧字段兼容
            updateData.knowledgePoints = JSON.stringify(tagNames);
        }

        logger.info({ id }, 'Updating error item');

        const updated = await prisma.errorItem.update({
            where: { id },
            data: updateData,
            include: { tags: true, notebook: true },
        });

        // 同步导出到 Obsidian 仓库（覆盖写；失败仅记录，不影响更新结果）
        try {
            const qNo = updated.source || "";
            if (qNo) {
                const exp = await exportErrorItemToObsidian({
                    questionNo: qNo,
                    subjectName: updated.notebook?.displayName || "",
                    gradeSemester: updated.gradeSemester || "",
                    tags: parseTags(updated.knowledgePoints),
                    questionText: updated.questionText,
                    originalImageUrl: updated.originalImageUrl,
                    analysis: updated.analysis,
                    answerText: updated.answerText,
                    mistakeAnalysis: updated.mistakeAnalysis,
                });
                if (exp.ok) {
                    logger.info({ notePath: exp.notePath }, 'Exported to Obsidian on update');
                } else {
                    logger.warn({ error: exp.error }, 'Obsidian export failed on update (non-fatal)');
                }
            }
        } catch (expErr) {
            logger.warn({ error: expErr }, 'Obsidian export threw on update (non-fatal)');
        }

        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error updating item');
        return internalError("Failed to update error item");
    }
}
