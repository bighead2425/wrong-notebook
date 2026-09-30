import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:mark-printed');

/**
 * POST /api/error-items/mark-printed
 * 打印落库计数（#10 / T4 / 2026-09-30 扩展）
 *
 * 浏览器打印是纯前端行为，系统不知道用户到底打没打，所以在「点击打印」时 +1。
 * printCount 在详情页/列表只显不改，不提供手工修改入口。
 *
 * Body: { ids: string[], kind?: "deep" | "review" }
 *   · 不给 / "deep" ⇒ `printCount` +1（深挖纸、错题卡、练习卷 —— 沿用老口径）
 *   · "review"      ⇒ `reviewPrintCount` +1（**复练纸 / 积累纸**，即"印了一份卷"）
 *
 * ⚠️ 两者**分开记**（他要并排显示"深挖纸打印次数 | 复练纸印刷次数"）：
 *    两种纸用途不同，混成一个数就看不出这题是深挖过还是复练过。
 * ⚠️ 印卷**不动** `lastPrintedAt`：那个字段服务于「打印本册未打印」的三级打印，
 *    语义是"这题还没上过纸"；被复练卷捎带着改掉，那个筛选就名不副实了。
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        const body = await req.json();
        const { ids, kind } = body;

        if (!Array.isArray(ids) || ids.length === 0) {
            return badRequest("ids must be a non-empty array");
        }
        const isReviewPrint = kind === "review";

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
            data: isReviewPrint
                ? { reviewPrintCount: { increment: 1 } }
                : {
                      printCount: { increment: 1 },
                      lastPrintedAt: new Date(),
                  },
        });

        logger.info(
            { userId: user.id, count: result.count, kind: isReviewPrint ? 'review' : 'deep' },
            'Print counts incremented',
        );

        return NextResponse.json({
            updated: result.count,
            kind: isReviewPrint ? 'review' : 'deep',
            failed: ids.filter(id => !ownedIds.includes(id)),
        });
    } catch (error) {
        logger.error({ error }, 'Error marking printed');
        return internalError("Failed to record print count");
    }
}
