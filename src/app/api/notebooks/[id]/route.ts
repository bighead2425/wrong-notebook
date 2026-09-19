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
                // 【custom-v25】行数统计排除回收箱里的题 —— 与列表页口径统一。
                // 否则详情页写着"共 3 道"、列表页写"2 道"，两处对不上。
                _count: {
                    select: {
                        errorItems: { where: { deletedAt: null } },
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
                // 【custom-v25】同上：排除回收箱，保证各处显示的行数一致
                _count: {
                    select: {
                        errorItems: { where: { deletedAt: null } },
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
        });

        if (!notebook) {
            return notFound("Notebook not found");
        }

        if (notebook.userId !== user.id) {
            return forbidden("Not authorized to delete this notebook");
        }

        /**
         * 检查是否有错题。
         *
         * 【custom-v25】这里必须数**含回收箱**的全部题，不能跟着展示口径一起过滤 ——
         * 删除本子是级联删除（schema 里 errorItems 关系是 onDelete: Cascade），
         * 回收箱里那些题的 notebookId 还指着它，一旦放行连回收箱里的也一并没了。
         * 所以单独查一次 count，而不用上面带 where 的 _count。
         */
        const anyItemCount = await prisma.errorItem.count({ where: { notebookId: id } });
        if (anyItemCount > 0) {
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
