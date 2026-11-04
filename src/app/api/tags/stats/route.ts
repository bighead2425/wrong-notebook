import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:tags:stats');

export const dynamic = "force-dynamic";


/**
 * GET /api/tags/stats —— 当前用户的知识点使用频率。
 *
 * ⚠️【2026-10-29 审计修复】原来这个接口**既没有鉴权、也没有按用户过滤**：
 *    `findMany({ select: { knowledgePoints: true } })` —— 未登录的人直接 GET 一下，
 *    就能拿到全站所有人的知识点词频。全仓只有它一个业务接口是这种状态
 *    （`middleware.ts` 明确把 `/api` 排除了，所以每个接口必须自己鉴权）。
 *
 * 改了两件事，别的都没动：
 *   ① 加 `getServerSession` + 找用户，没登录就 401；
 *   ② 查询加 `where: { userId }`。
 * ⚠️ 口径没改：仍然**包含回收箱里的题**（与修复前一致）。要改口径是另一件事，
 *    会改变他看到的数字，不能顺手做。
 */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return unauthorized("Authentication required");
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        if (!user) {
            return unauthorized("Authentication required");
        }

        // 只统计当前用户的题
        /**
         * 【2026-11-04 审计 A4】**读 `tags` 关系，不是那列已废弃的 `knowledgePoints`。**
         *
         * 两段式归位只写关系、不写那列 ⇒ 原来这些题在这里恒为 0，
         * 标签树上的 `(N)` 计数跟着全错（他看到的"这个词有 5 道题"是假的）。
         * 那列还带着读一次，只为兼容"关系还没建"的老数据。
         */
        const errorItems = await prisma.errorItem.findMany({
            where: { userId: user.id, deletedAt: null },
            select: {
                knowledgePoints: true,
                tags: { select: { name: true } },
            },
        });

        // 统计标签使用频率
        const tagStats: Record<string, number> = {};

        errorItems.forEach((item) => {
            /* 首选：标签关系（真源）。`?.` 是给"老测试 mock 没给这一列"兜底 */
            const rel = item.tags ?? [];
            if (rel.length > 0) {
                rel.forEach((t) => {
                    const name = (t.name ?? "").trim();
                    if (name) tagStats[name] = (tagStats[name] || 0) + 1;
                });
                return;
            }
            /* 兜底：老数据只有那一列 */
            if (item.knowledgePoints) {
                try {
                    const tags = JSON.parse(item.knowledgePoints);
                    if (Array.isArray(tags)) {
                        tags.forEach((tag: string) => {
                            if (tag && typeof tag === 'string') {
                                tagStats[tag] = (tagStats[tag] || 0) + 1;
                            }
                        });
                    }
                } catch {
                    logger.warn({ knowledgePoints: item.knowledgePoints }, 'Failed to parse knowledgePoints for item');
                }
            }
        });

        // 转换为数组并按使用次数排序
        const sortedStats = Object.entries(tagStats)
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);

        return NextResponse.json({
            stats: sortedStats,
            total: errorItems.length,
            uniqueTags: sortedStats.length,
        });
    } catch (error) {
        logger.error({ error }, 'Error getting tag stats');
        return internalError("Failed to get tag statistics");
    }
}
