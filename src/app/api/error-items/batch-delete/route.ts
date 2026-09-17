import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:batch-delete');

/**
 * POST /api/error-items/batch-delete
 * 批量删除错题
 *
 * H2/T2：默认**软删**进回收箱；body 带 { permanent: true } 才彻底删除。
 *
 * Body: { ids: string[], permanent?: boolean }
 */
export async function POST(req: Request) {
    logger.info('POST /api/error-items/batch-delete called');

    const session = await getServerSession(authOptions);

    try {
        const body = await req.json();
        const { ids, permanent = false } = body;

        // 验证参数
        if (!Array.isArray(ids) || ids.length === 0) {
            return badRequest("ids must be a non-empty array");
        }

        if (ids.length > 100) {
            return badRequest("Cannot delete more than 100 items at once");
        }

        // 验证用户身份
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }

        if (!user) {
            return unauthorized("Authentication required");
        }

        logger.info({ userId: user.id, idsCount: ids.length, permanent }, 'Batch delete request');

        const itemsToDelete = await prisma.errorItem.findMany({
            where: {
                id: { in: ids },
            },
            select: {
                id: true,
                userId: true,
            },
        });

        // 过滤出属于当前用户的错题
        const ownedIds = itemsToDelete
            .filter(item => item.userId === user.id)
            .map(item => item.id);

        const unauthorizedIds = ids.filter(id => !ownedIds.includes(id));

        if (unauthorizedIds.length > 0) {
            logger.warn({ unauthorizedIds }, 'Some items do not belong to user or do not exist');
        }

        // 执行删除：permanent=true 真删；否则软删（写 deletedAt 进回收箱）
        let affectedCount = 0;
        if (ownedIds.length > 0) {
            if (permanent) {
                const result = await prisma.errorItem.deleteMany({
                    where: { id: { in: ownedIds } },
                });
                affectedCount = result.count;
            } else {
                const result = await prisma.errorItem.updateMany({
                    where: { id: { in: ownedIds } },
                    data: { deletedAt: new Date() },
                });
                affectedCount = result.count;
            }
        }

        logger.info({ affectedCount, requestedCount: ids.length, permanent }, 'Batch delete completed');

        return NextResponse.json({
            deleted: affectedCount,
            permanent,
            failed: unauthorizedIds,
        });
    } catch (error) {
        logger.error({ error }, 'Error in batch delete');
        return internalError("Failed to delete items");
    }
}
