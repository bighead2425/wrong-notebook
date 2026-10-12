import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, badRequest, conflict, internalError } from "@/lib/api-errors";
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
            /**
             * 【2026-10-12 需求第 9 条】重名不许更新。
             *
             * 表上本来就有 `@@unique([displayName, userId])`，但直接撞上去会抛 Prisma 的
             * P2002 ⇒ 500，界面只能弹一句"更新失败"，他不知道是哪儿的问题。
             * 所以在写之前**先查一次**，把话说明白（返回 409，界面按冲突提示）。
             * ⚠️ 只比自己比自己之外的行；名字没改（原样提交）时不该被自己拦下。
             */
            const duplicate = await prisma.notebook.findFirst({
                where: { userId: user.id, displayName: finalDisplayName, id: { not: id } },
                select: { id: true },
            });
            if (duplicate) {
                return conflict(`Notebook "${finalDisplayName}" already exists`);
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
         * 【2026-10-12 需求第 8 条】"空本"的定义跟着展示口径走 = **没有还在用的题**
         * （`deletedAt: null`）。回收箱里那几道不算"没空"。
         *
         * 他原话："如果一个空错题本中删除的题在回收箱中，则在删除这个错题本同时，
         *          先将从这个错题本中删除到回收箱的所有题进行彻底删除，然后再删除这个错题本。"
         *
         * 【custom-v25 的老话仍然成立】本子删除是**级联删除**（ErrorItem.notebook 是
         * onDelete: Cascade）⇒ 回收箱里那些题一起没了。差别只在于：
         * 原来是**连招呼都不打**地连带删掉（而且要用户先把回收箱清干净才肯放行），
         * 现在是把这件事**做在明处**：先真删、再删本，并把删了几道如实回报。
         *
         * ⚠️ 只在"这本还没有在用题"时才走到这里：**有**在用题（哪怕回收箱是空的）
         *    仍然拒删 —— 这条老规矩不能松，否则一次误点就丢一整本的题。
         */
        const liveItemCount = await prisma.errorItem.count({
            where: { notebookId: id, deletedAt: null },
        });
        if (liveItemCount > 0) {
            return badRequest("Cannot delete notebook with error items. Please move or delete all items first.");
        }

        const purged = await prisma.errorItem.deleteMany({
            where: { notebookId: id, deletedAt: { not: null } },
        });

        await prisma.notebook.delete({
            where: { id },
        });

        logger.info({ id, purgedItems: purged.count }, 'Notebook deleted (trash items purged first)');
        return NextResponse.json({
            message: "Notebook deleted successfully",
            /** 顺带彻底删掉的回收箱题目数（界面可以据此说一句实话） */
            purgedItems: purged.count,
        });
    } catch (error) {
        logger.error({ error }, 'Error deleting notebook');
        return internalError("Failed to delete notebook");
    }
}
