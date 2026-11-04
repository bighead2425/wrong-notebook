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

        /**
         * 【2026-11-04 审计 B3】**不再"超过 100 就拒"，改成分片执行。**
         *
         * 原来直接 `badRequest(">100")`：跨页全选（他的"全选 20 道"再往上很多）很容易超，
         * 一超就整批失败，前端只弹一句通用英文，他以为程序坏了。
         *
         * 但也不能一把梭：SQLite 的 `IN (...)` **有变量个数上限**（默认 999），
         * 真塞 2000 个 id 会 "too many SQL variables"。所以查询和写入都按 500 一批。
         *
         * 保留一个很大的硬上限（5000）只为拦住异常调用，正常使用碰不到。
         */
        const HARD_LIMIT = 5000;
        const CHUNK = 500;
        if (ids.length > HARD_LIMIT) {
            return badRequest(`一次最多 ${HARD_LIMIT} 道（当前 ${ids.length} 道）`);
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

        /** 【B3】查归属也分片 —— 一次 `in` 太多 id 会撞 SQLite 变量上限 */
        const found: { id: string; userId: string }[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const rows = await prisma.errorItem.findMany({
                where: { id: { in: chunk } },
                select: { id: true, userId: true },
            });
            found.push(...rows);
        }
        const itemsToDelete = found;

        // 过滤出属于当前用户的错题
        const ownedIds = itemsToDelete
            .filter(item => item.userId === user.id)
            .map(item => item.id);

        const unauthorizedIds = ids.filter(id => !ownedIds.includes(id));

        if (unauthorizedIds.length > 0) {
            logger.warn({ unauthorizedIds: unauthorizedIds.slice(0, 20), count: unauthorizedIds.length }, 'Some items do not belong to user or do not exist');
        }

        // 执行删除：permanent=true 真删；否则软删（写 deletedAt 进回收箱）
        let affectedCount = 0;
        let detachedChildren = 0;
        for (let i = 0; i < ownedIds.length; i += CHUNK) {
            const chunk = ownedIds.slice(i, i + CHUNK);
            const result = permanent
                ? await prisma.errorItem.deleteMany({ where: { id: { in: chunk } } })
                : await prisma.errorItem.updateMany({
                    where: { id: { in: chunk } },
                    data: { deletedAt: new Date() },
                });
            affectedCount += result.count;

            /**
             * 【2026-11-04 审计 B4】**删掉"主题"题时，把它下面的附题解绑。**
             *
             * 不管软删还是硬删都要做：
             *   · 软删（回收箱）—— 外键不会触发（schema 注释里写明了"要由规则显式做"，一直没做）；
             *   · 硬删 —— SQLite 的迁移是纯 ADD COLUMN，**不落外键约束**，`onDelete: SetNull` 不生效。
             *
             * 不解绑的后果：附题还挂着 `parentId` ⇒ 列表里仍显示绿色"附题"角标，
             * 点进去 `loadLinkView` 找不到父题（父题已 `deletedAt`），既看不到主卡、
             * 也没有"解除关联"按钮 ⇒ **那几道题永久卡死**。
             */
            const detach = await prisma.errorItem.updateMany({
                where: { parentId: { in: chunk } },
                data: { parentId: null },
            });
            detachedChildren += detach.count;
        }

        logger.info({ affectedCount, detachedChildren, requestedCount: ids.length, permanent }, 'Batch delete completed');

        return NextResponse.json({
            deleted: affectedCount,
            permanent,
            failed: unauthorizedIds,
            /** 【B4】有几道附题因为主题被删而自动解绑（前端可以提一句） */
            detachedChildren,
        });
    } catch (error) {
        logger.error({ error }, 'Error in batch delete');
        return internalError("Failed to delete items");
    }
}
