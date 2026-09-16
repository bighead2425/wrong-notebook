import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:notebooks:id');

/**
 * GET /api/notebooks/[id]
 * 获取单个错题本详情
 */
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

        const notebook = await prisma.notebook.findUnique({
            where: { id },
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
        });

        if (!notebook) {
            return notFound("Notebook not found");
        }

        if (notebook.userId !== user.id) {
            return forbidden("Not authorized to access this notebook");
        }

        return NextResponse.json(notebook);
    } catch (error) {
        logger.error({ error }, 'Error fetching notebook');
        return internalError("Failed to fetch notebook");
    }
}

/**
 * PUT /api/notebooks/[id]
 * 更新错题本信息
 */
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

        const notebook = await prisma.notebook.findUnique({
            where: { id },
        });

        if (!notebook) {
            return notFound("Notebook not found");
        }

        if (notebook.userId !== user.id) {
            return forbidden("Not authorized to update this notebook");
        }

        const body = await req.json();
        // name 为旧字段别名，兼容老调用方
        const { displayName, name, gradeStage, grade, semester, subject, archiveStatus } = body;

        // 允许只更新四字段 / 归档状态（B14 / T3），displayName 仅在显式传入时校验
        const data: Record<string, unknown> = {};
        if (displayName !== undefined || name !== undefined) {
            const finalDisplayName = String(displayName ?? name ?? "").trim();
            if (!finalDisplayName) {
                return badRequest("Notebook name is required");
            }
            data.displayName = finalDisplayName;
        }
        if (gradeStage !== undefined) data.gradeStage = gradeStage;
        if (grade !== undefined) data.grade = grade;
        if (semester !== undefined) data.semester = semester;
        if (subject !== undefined) data.subject = subject;
        if (archiveStatus !== undefined) {
            if (archiveStatus !== 'active' && archiveStatus !== 'archived') {
                return badRequest("archiveStatus must be 'active' or 'archived'");
            }
            data.archiveStatus = archiveStatus;
        }

        if (Object.keys(data).length === 0) {
            return badRequest("Nothing to update");
        }

        const updated = await prisma.notebook.update({
            where: { id },
            data,
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
        });

        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error updating notebook');
        return internalError("Failed to update notebook");
    }
}

/**
 * DELETE /api/notebooks/[id]
 * 删除错题本
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

        const notebook = await prisma.notebook.findUnique({
            where: { id },
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
        });

        if (!notebook) {
            return notFound("Notebook not found");
        }

        if (notebook.userId !== user.id) {
            return forbidden("Not authorized to delete this notebook");
        }

        // 检查是否有错题
        if (notebook._count.errorItems > 0) {
            return badRequest("Cannot delete notebook with error items. Please move or delete all items first.");
        }

        await prisma.notebook.delete({
            where: { id },
        });

        return NextResponse.json({ message: "Notebook deleted successfully" });
    } catch (error) {
        logger.error({ error }, 'Error deleting notebook');
        return internalError("Failed to delete notebook");
    }
}
