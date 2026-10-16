import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { forbidden, internalError, notFound, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
// ⚠️ 读流水也走 `lib/review-events.ts`（唯一碰那张表的地方）——
//    免得"读一处、写一处"，两边的排序口径迟早分叉（有看门测试盯着这个字面量）。
import { listReviewEventRows } from "@/lib/review-events";
import { RECENT_REVIEW_LIMIT } from "@/lib/review-outcomes";

const logger = createLogger('api:error-items:review-events');

/**
 * 【2026-10-16 如如】这道题的**复习流水**（详情页 / 扫到的单题页那张表要读的东西）。
 *
 * 出处：`docs\18` §4.2 —— "详情页「复习结果」是表格（时间 / 来源 / 结果），**最多 4 行**"。
 *
 * ── 为什么单开一个接口、而不是塞进 `GET /api/error-items/[id]` ──────────────
 *   ① 那张表只在这一处用；塞进主 GET 会让**每次打开详情页**都多两次查询，
 *      而详情页正是 `docs\17` 点名"打开慢"的那个页面；
 *   ② 记录 / 改 / 删之后**只重拉这一小块**，不用重拉整条题（不闪、不打断操作）。
 *
 * 返回：`{ events: [...] }` —— **正序**（末尾 = 最近一次）；界面自己决定倒着显示。
 * ⚠️ `createdAt` 是**入库时刻**（审计用）；"这次复习是哪天"一律看 `occurredOn`
 *    （客户端算好的本地日）。界面上"迁移前"那一条（`source = 'legacy'`）**不显示日期** ——
 *    老数据里根本没有日期，补流水时只能拿创建日顶，显示出来就是假的。
 */
export async function GET(
    _req: Request,
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

        const item = await prisma.errorItem.findUnique({
            where: { id },
            select: { userId: true },
        });

        if (!item) return notFound("Item not found");
        if (item.userId !== user.id) return forbidden("Not authorized to read this item");

        const events = await listReviewEventRows(user.id, id, RECENT_REVIEW_LIMIT);

        return NextResponse.json({ events });
    } catch (error) {
        logger.error({ error, itemId: id }, 'Failed to list review events');
        return internalError("Failed to list review events");
    }
}
