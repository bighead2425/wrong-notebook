import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";

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
        const {
            knowledgePoints, gradeSemester, paperLevel, questionText, answerText, analysis,
            notebookId, wrongAnswerText, mistakeAnalysis, mistakeStatus,
            // 【custom-v28】批量里「重新分析已录入的题」时会带上新图（很可能重新裁过）。
            // 旧实现不收这个字段 —— 于是题目文本换成新的、原图还是旧的，图文对不上。
            // 注意：这里**不接受 source（题号）**，题号必须保持不变，见下方 updateData。
            originalImageUrl,
            // 【M1】框坐标。与 POST 同一套规矩：**形状不对当没提供**，不拒存整条更新。
            cropRegions,
            // ===== 状态字段（5.3 单一事实来源）=====
            attention,        // 关注档 1-5（难度档，G8 / T5）
            masteryLevel,     // 0 New / 1 Reviewing / 2 Mastered（=2 即四分法「已掌握」）
            userNotes,        // 备注（扫码「跳转原题备注」用）
        } = body;

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
        // 【custom-v28】重新分析时确实换过图（重新裁 / 重新擦）才更新原图；
        // 空串视为「不动」，免得手滑把原图清掉。
        // 题号 source 不在可更新字段里 —— 重新分析永远不改题号、不新增记录。
        if (originalImageUrl !== undefined && originalImageUrl !== '') {
            updateData.originalImageUrl = originalImageUrl;
        }
        /**
         * 【M1】框坐标。只有**形状像一份坐标**才写；否则当成"没提到这个字段"。
         * 与原图同理：不能让它把库里已有的坐标冲成空 ——
         * 详情页改个备注不该顺手把净版弄没。
         */
        if (typeof cropRegions === 'string' && cropRegions.trim()) {
            try {
                const parsed = JSON.parse(cropRegions);
                const okShape =
                    parsed && typeof parsed === 'object' &&
                    Array.isArray(parsed.boxes) &&
                    parsed.base && typeof parsed.base === 'object' &&
                    Number.isFinite(parsed.base.w) && Number.isFinite(parsed.base.h);
                if (okShape) updateData.cropRegions = cropRegions;
            } catch {
                // 坏 JSON 当没传，不动库里的旧值
            }
        }
        if (answerText !== undefined) updateData.answerText = answerText;
        if (analysis !== undefined) updateData.analysis = analysis;
        // ⚠️ Q4/G6：wrongAnswerText 已弃用，保留列但**不再写入**（仅接收用于推算 mistakeStatus）
        if (mistakeAnalysis !== undefined) updateData.mistakeAnalysis = mistakeAnalysis || null;
        if (userNotes !== undefined) updateData.userNotes = userNotes || null;

        // 关注档 1-5（G8 难度档）：夹到 1..5，非法值忽略
        if (attention !== undefined) {
            const n = Number(attention);
            if (Number.isFinite(n) && n >= 1 && n <= 5) {
                updateData.attention = Math.round(n);
            }
        }

        // 掌握状态：0=New / 1=Reviewing / 2=Mastered（=2 即四分法「已掌握」，扫码「已会」写此位）
        if (masteryLevel !== undefined) {
            const m = Number(masteryLevel);
            if (Number.isFinite(m) && m >= 0 && m <= 2) {
                updateData.masteryLevel = Math.round(m);
            }
        }
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

        // 注：按用户要求，保存错题时**不再自动导出**到 Obsidian。
        //     需要导出时走错题详情页的「导出到 ob」按钮（本文件的 export-obsidian 路由）。

        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error updating item');
        return internalError("Failed to update error item");
    }
}

/**
 * PATCH /api/error-items/[id]
 * 动作型更新，不覆盖字段，只做自增/置位：
 *  - { action: "redo" }  复做计次 +1（H1 不闭环，仅计次 / T7）
 *  - { action: "restore" } 从回收箱还原（H2 / T2）
 */
export async function PATCH(
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
            where: { id },
            select: { id: true, userId: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to update this item");
        }

        const body = await req.json().catch(() => ({}));
        const action = String(body?.action || "");

        const updateData: Prisma.ErrorItemUpdateInput = {};
        if (action === "redo") {
            updateData.redoCount = { increment: 1 };
        } else if (action === "restore") {
            updateData.deletedAt = null;
        } else {
            return badRequest("Unknown action. Supported: redo | restore");
        }

        const updated = await prisma.errorItem.update({
            where: { id },
            data: updateData,
            include: { tags: true, notebook: true },
        });

        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error patching item');
        return internalError("Failed to patch error item");
    }
}

/**
 * DELETE /api/error-items/[id]
 * 软删进回收箱（H2 / T2）。带 ?hard=1 才彻底删除。
 * 回收箱内的题再删一次必须走 hard=1 —— 前端负责传，服务端不替用户决定。
 */
export async function DELETE(
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

        const { searchParams } = new URL(req.url);
        const hard = searchParams.get("hard") === "1";

        const errorItem = await prisma.errorItem.findUnique({
            where: { id },
            select: { id: true, userId: true, deletedAt: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to delete this item");
        }

        if (hard) {
            await prisma.errorItem.delete({ where: { id } });
            logger.info({ id }, 'Error item permanently deleted');
            return NextResponse.json({ id, permanent: true });
        }

        const updated = await prisma.errorItem.update({
            where: { id },
            data: { deletedAt: new Date() },
        });

        logger.info({ id, alreadyInTrash: !!errorItem.deletedAt }, 'Error item moved to trash');
        return NextResponse.json({ id, deletedAt: updated.deletedAt, permanent: false });
    } catch (error) {
        logger.error({ error }, 'Error deleting item');
        return internalError("Failed to delete error item");
    }
}
