import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:restore');

/**
 * POST /api/error-items/restore
 * 批量从回收箱还原（H2 四分法 · 回收箱 -> 主库）
 *
 * 只清 deletedAt，不动其它字段。还原后题目回到原本（notebookId 未变）。
 * Body: { ids: string[] }
 */
export async function POST(req: Request) {
    logger.info('POST /api/error-items/restore called');

    const session = await getServerSession(authOptions);

    try {
        const body = await req.json();
        const { ids } = body;

        if (!Array.isArray(ids) || ids.length === 0) {
            return badRequest("ids must be a non-empty array");
        }

        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }

        if (!user) {
            return unauthorized("Authentication required");
        }

        const items = await prisma.errorItem.findMany({
            where: { id: { in: ids } },
            select: { id: true, userId: true },
        });

        const ownedIds = items.filter(i => i.userId === user.id).map(i => i.id);

        let restoredCount = 0;
        if (ownedIds.length > 0) {
            const result = await prisma.errorItem.updateMany({
                where: { id: { in: ownedIds } },
                data: { deletedAt: null },
            });
            restoredCount = result.count;
        }

        logger.info({ userId: user.id, restoredCount }, 'Restore completed');

        return NextResponse.json({
            restored: restoredCount,
            failed: ids.filter(id => !ownedIds.includes(id)),
        });
    } catch (error) {
        logger.error({ error }, 'Error in restore');
        return internalError("Failed to restore items");
    }
}
