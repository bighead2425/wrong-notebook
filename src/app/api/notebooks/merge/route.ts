import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:notebooks:merge');

/**
 * POST /api/notebooks/merge
 * 【2026-10-12 需求第 7 条】把 A 本**整体并进** B 本，然后删掉 A 本。
 *
 * 他原话："点击确定则将目标卡片的所有题融入到那个其他卡片中所有题融入那个其他卡片中，
 *          即将目标卡片中的所有题所在错题本改为那个其他卡片，并将目标错题本卡片删除。"
 *
 * ── 这件事的本质（他后面自己点破了）──────────────────────────────
 * 就是"把一本书里的题全部改挂到另一本，然后把这本书删掉"。所以实现上**只有一个动作**：
 * `errorItem.notebookId = toId`，然后删本。**一个字段都不多改**。
 *
 * ⚠️⚠️ **题号（`source`）一个都不许碰** —— 他 2026-10-12 需求第 10 条把这条列为前置条件：
 *      "题号是一道题的主键值，一道题从录入到销毁一直伴随……只有这样，所有组卷的快照才能继续有用。"
 *      所以这里既不重算题号、也不动任何打印快照（`VolumeItem` 存的是快照，本来就与本题无关）。
 *
 * ⚠️ **回收箱里的题也要一起改挂**（他特意点名的"特别提醒"）：
 *      它们仍然 `notebookId = fromId`，是**级联删除**的连带受害者 ——
 *      不改挂的话，删 A 本会顺手把回收箱里来自 A 的题也删掉，而用户以为只是"并进 B 本"。
 *
 * ⚠️ 已归档的本**不参与**（界面上双击已归档卡片无效）。服务端也拦一道：
 *      "并入"会改变题在四分法里的归属（从归档本的题变成在用本的题），
 *      那是"跨区搬运"，得由他以后按年级归档规则显式做，不该从双击漏进来。
 *
 * 请求体：`{ fromId, toId }`（from = 被并入并删除的那本，to = 留下的那本）
 */
export async function POST(req: Request) {
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

        const body = await req.json().catch(() => ({}));
        const fromId = String(body?.fromId ?? "");
        const toId = String(body?.toId ?? "");

        if (!fromId || !toId) {
            return badRequest("fromId and toId are required");
        }
        if (fromId === toId) {
            return badRequest("Cannot merge a notebook into itself");
        }

        const [from, to] = await Promise.all([
            prisma.notebook.findUnique({ where: { id: fromId } }),
            prisma.notebook.findUnique({ where: { id: toId } }),
        ]);

        if (!from || !to) {
            return notFound("Notebook not found");
        }
        if (from.userId !== user.id || to.userId !== user.id) {
            return forbidden("Not authorized to merge these notebooks");
        }
        if (from.archiveStatus === "archived" || to.archiveStatus === "archived") {
            return badRequest("Archived notebooks cannot be merged");
        }

        /** 先数一下（只是给界面回一句实话），再在一个事务里改挂 + 删本 */
        const [liveCount, trashCount] = await Promise.all([
            prisma.errorItem.count({ where: { notebookId: fromId, deletedAt: null } }),
            prisma.errorItem.count({ where: { notebookId: fromId, deletedAt: { not: null } } }),
        ]);

        const moved = await prisma.$transaction(async (tx) => {
            const res = await tx.errorItem.updateMany({
                where: { notebookId: fromId, userId: user!.id },
                data: { notebookId: toId },
            });
            await tx.notebook.delete({ where: { id: fromId } });
            return res.count;
        });

        logger.info(
            { fromId, toId, moved, liveCount, trashCount },
            'Notebook merged into another',
        );

        return NextResponse.json({
            fromId,
            toId,
            /** 一共搬过去几道题（含回收箱里的） */
            movedItems: moved,
            /** 其中还在回收箱里的（界面可以据此提醒一句"它们也一起并过来了"） */
            movedTrashItems: trashCount,
        });
    } catch (error) {
        logger.error({ error }, 'Error merging notebooks');
        return internalError("Failed to merge notebooks");
    }
}
