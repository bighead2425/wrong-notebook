/**
 * 单个标签的信息（给「按知识点看题」那一页用）。
 *
 * 返回三样：
 *   · `path`      —— 它在树上的完整位置（册 › 章 › 节 › 点）
 *   · `itemCount` —— **含整棵子树**的题数（点一个"节"要能看见下面各知识点的题）
 *   · `childCount`—— 直接子节点数（页面上可以提示"含 N 个子知识点"）
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unauthorized, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { decorateTagPaths, collectSubtreeIds } from "@/lib/tag-path";

const logger = createLogger('api:tags:id');

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return unauthorized("Authentication required");

        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!user) return unauthorized("Authentication required");

        const tag = await prisma.knowledgeTag.findUnique({
            where: { id },
            select: { id: true, name: true, parentId: true, subject: true, isSystem: true },
        });
        if (!tag) return notFound("Tag not found");

        const subtreeIds = await collectSubtreeIds(id, true);
        const [itemCount, childCount, decorated] = await Promise.all([
            prisma.errorItem.count({
                where: { userId: user.id, deletedAt: null, tags: { some: { id: { in: subtreeIds } } } },
            }),
            prisma.knowledgeTag.count({ where: { parentId: id } }),
            decorateTagPaths([tag]),
        ]);

        return NextResponse.json({
            ...tag,
            path: decorated[0]?.path ?? tag.name,
            itemCount,
            childCount,
            subtreeSize: subtreeIds.length,
        });
    } catch (e) {
        logger.error({ tagId: id, err: String(e) }, '读取标签失败');
        return internalError("Failed to read tag");
    }
}
