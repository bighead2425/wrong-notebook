import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { calculateGrade } from "@/lib/grade-calculator";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { subjectKeyToCode, formatDateStamp, formatQuestionNo, startOfToday } from "@/lib/question-no";

const logger = createLogger('api:error-items');

export async function POST(req: Request) {
    logger.info('POST /api/error-items called');

    const session = await getServerSession(authOptions);

    try {
        const body = await req.json();
        const {
            questionText,
            answerText,
            analysis,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            knowledgePoints,
            originalImageUrl,
            notebookId,
            gradeSemester,
            paperLevel,
            source,
            inputMethod,
        } = body;

        // 记录请求参数（不记录完整图片数据）
        logger.debug({
            hasQuestionText: !!questionText,
            questionTextLength: questionText?.length || 0,
            hasAnswerText: !!answerText,
            hasAnalysis: !!analysis,
            hasWrongAnswerText: !!wrongAnswerText,
            hasMistakeAnalysis: !!mistakeAnalysis,
            mistakeStatus,
            knowledgePointsCount: Array.isArray(knowledgePoints) ? knowledgePoints.length : 0,
            hasImage: !!originalImageUrl,
            imageSize: originalImageUrl?.length || 0,
            notebookId,
            gradeSemester,
            paperLevel,
            source,
            inputMethod,
        }, 'Request parameters received');

        // 查找用户
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
            logger.debug({ userId: user?.id, email: session.user.email }, 'User lookup result');
        } else {
            logger.warn('No session email found');
        }

        if (!user) {
            logger.warn({ sessionEmail: session?.user?.email }, 'User not found in DB');
            return unauthorized("No user found in DB");
        }

        // ========== 去重检查：2秒内同一用户提交相同题目视为重复 ==========
        const DEDUP_WINDOW_MS = 2000; // 2秒去重窗口
        const questionTextPrefix = questionText?.substring(0, 100) || ''; // 取前100字符比较

        if (questionTextPrefix) {
            const recentDuplicate = await prisma.errorItem.findFirst({
                where: {
                    userId: user.id,
                    questionText: {
                        startsWith: questionTextPrefix,
                    },
                    createdAt: {
                        gte: new Date(Date.now() - DEDUP_WINDOW_MS),
                    },
                },
                include: {
                    tags: true,
                },
            });

            if (recentDuplicate) {
                logger.info({
                    existingId: recentDuplicate.id,
                    userId: user.id,
                    timeDiff: Date.now() - recentDuplicate.createdAt.getTime()
                }, 'Duplicate submission detected within dedup window, returning existing record');

                return NextResponse.json({
                    ...recentDuplicate,
                    duplicate: true, // 标记为重复提交
                }, { status: 200 }); // 返回 200 而非 201
            }
        }

        // 计算年级
        let finalGradeSemester = gradeSemester;
        if (!finalGradeSemester && user.educationStage && user.enrollmentYear) {
            finalGradeSemester = calculateGrade(user.educationStage, user.enrollmentYear);
            logger.debug({ finalGradeSemester, educationStage: user.educationStage, enrollmentYear: user.enrollmentYear }, 'Grade calculated');
        }

        // 处理知识点标签
        const tagNames: string[] = Array.isArray(knowledgePoints) ? knowledgePoints : [];
        const tagConnections: { id: string }[] = [];

        // 学科：直接读 Notebook.subject（5.5）——不再从显示名反推
        const notebook = await prisma.notebook.findUnique({ where: { id: notebookId || '' } });
        const subjectKey = notebook?.subject || 'other';
        logger.debug({ notebookId, notebookName: notebook?.displayName, subjectKey }, 'Subject resolved from Notebook');

        // 处理每个标签
        for (const tagName of tagNames) {
            try {
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
                    const parentId = await findParentTagIdForGrade(finalGradeSemester, subjectKey);
                    logger.debug({ tagName, parentId, subjectKey }, 'Creating new custom tag');

                    tag = await prisma.knowledgeTag.create({
                        data: {
                            name: tagName,
                            subject: subjectKey,
                            isSystem: false,
                            userId: user.id,
                            parentId: parentId,
                        },
                    });
                    logger.debug({ tagId: tag.id, tagName }, 'Custom tag created');
                } else {
                    logger.debug({ tagId: tag.id, tagName, isSystem: tag.isSystem }, 'Existing tag found');
                }

                tagConnections.push({ id: tag.id });
            } catch (tagError) {
                logger.error({ tagName, error: tagError }, 'Error processing tag');
                throw tagError;
            }
        }

        logger.info({ tagNames, tagConnectionsCount: tagConnections.length }, 'Creating ErrorItem with tags');

        // 生成题号（source）：若客户端未提供，则自动生成
        // 格式：<学科2字简拼> + <8位日期 YYYYMMDD> + <3位当日流水>
        let finalSource = typeof source === 'string' && source.trim() ? source.trim() : '';
        if (!finalSource) {
            const code = subjectKeyToCode(subjectKey);
            const dateStamp = formatDateStamp(new Date());
            const todayCount = await prisma.errorItem.count({
                where: {
                    userId: user.id,
                    createdAt: { gte: startOfToday() },
                },
            });
            finalSource = formatQuestionNo(code, dateStamp, todayCount + 1);
            logger.debug({ finalSource, code, dateStamp, todayCount }, 'Auto-generated question number (source)');
        }

        // 创建错题记录
        try {
            const errorItem = await prisma.errorItem.create({
                data: {
                    userId: user.id,
                    notebookId: notebookId || undefined,
                    originalImageUrl,
                    questionText,
                    answerText,
                    analysis,
                    // ⚠️ Q4/G6：错误解答原文已弃用，保留列但**停止写入**（错答看原图）
                    mistakeAnalysis: mistakeAnalysis || null,
                    mistakeStatus: normalizeMistakeStatusForSave(mistakeStatus, wrongAnswerText),
                    knowledgePoints: JSON.stringify(tagNames),
                    gradeSemester: finalGradeSemester,
                    paperLevel: paperLevel,
                    source: finalSource,
                    inputMethod: inputMethod || null,
                    masteryLevel: 0,
                    tags: {
                        connect: tagConnections,
                    },
                },
                include: {
                    tags: true,
                },
            });

            logger.info({ errorItemId: errorItem.id, tagsCount: errorItem.tags?.length || 0 }, 'ErrorItem created successfully');

            // 注：按用户要求，保存错题时**不再自动导出**到 Obsidian（避免每次保存都写盘）。
            //     需要导出时走错题详情页的「导出到 ob」按钮，即 /api/error-items/[id]/export-obsidian。

            return NextResponse.json(errorItem, { status: 201 });
        } catch (dbError) {
            logger.error({
                error: dbError,
                userId: user.id,
                notebookId,
                tagConnectionsCount: tagConnections.length
            }, 'Database error creating ErrorItem');
            throw dbError;
        }
    } catch (error) {
        logger.error({
            error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined
        }, 'Error saving item');
        return internalError("Failed to save error item");
    }
}
