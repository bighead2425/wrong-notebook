import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { badRequest, forbidden, internalError, notFound, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:notes');

/**
 * PATCH /api/error-items/[id]/notes —— 只改「我的笔记」这一列。
 *
 * ⚠️【2026-10-29 审计修复】原实现只校验"登录"，`update({ where: { id } })`
 * **没有带 userId** —— 任何登录账号改一下 URL 里的 id 就能覆盖别人的笔记。
 * 这是全站唯一一个"零归属校验的写接口"。
 *
 * 改法（与 `[id]/mastery` 同一套语义）：
 *   ① `updateMany({ where: { id, userId } })` —— 归属条件直接进 where，天然幂等；
 *   ② 命中 0 行时**再查一次**，把"不存在(404)"和"不是本人的(403)"分开 ——
 *      不查的话两种情况都只能返回 404，前端提示会误导人（他明明有这道题，只是不归他）；
 *   ③ 返回体仍然是那道题的完整行：调用方（详情页）虽然目前不读返回值，
 *      但接口的形状不能因为内部实现换了就变。
 *
 * 同时补上入参类型校验：原来直接把 body 里的 `userNotes` 塞进库，
 * 传对象/数字会在 Prisma 层炸成 500（前端只看到"保存失败"，查不出原因）。
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

        const body = (await req.json().catch(() => null)) as { userNotes?: unknown } | null;
        const userNotes = body?.userNotes;
        if (typeof userNotes !== "string") {
            return badRequest("userNotes 必须是字符串（清空请传空串）");
        }

        const updated = await prisma.errorItem.updateMany({
            where: { id, userId: user.id },
            data: { userNotes },
        });

        if (updated.count === 0) {
            const exists = await prisma.errorItem.findUnique({
                where: { id },
                select: { id: true },
            });
            return exists ? forbidden("Not authorized to update this item") : notFound("Item not found");
        }

        const errorItem = await prisma.errorItem.findUnique({ where: { id } });
        return NextResponse.json(errorItem);
    } catch (error) {
        logger.error({ error }, 'Error updating notes');
        return internalError("Failed to update notes");
    }
}
