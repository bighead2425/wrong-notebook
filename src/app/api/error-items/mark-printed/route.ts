import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:mark-printed');

/**
 * POST /api/error-items/mark-printed
 * 打印落库计数（#10 / T4）
 *
 * 浏览器打印是纯前端行为，系统不知道用户到底打没打，所以在「点击打印」时 +1。
 * printCount 在详情页/列表只显不改，不提供手工修改入口。
 *
 * Body: { ids: string[] }
 */
export async function POST(req: Request) {
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

        if (ownedIds.length === 0) {
            return NextResponse.json({ updated: 0, failed: ids });
        }

        const result = await prisma.errorItem.updateMany({
            where: { id: { in: ownedIds } },
            data: {
                printCount: { increment: 1 },
                lastPrintedAt: new Date(),
            },
        });

        logger.info({ userId: user.id, count: result.count }, 'Print counts incremented');

        return NextResponse.json({
            updated: result.count,
            failed: ids.filter(id => !ownedIds.includes(id)),
        });
    } catch (error) {
        logger.error({ error }, 'Error marking printed');
        return internalError("Failed to record print count");
    }
}
