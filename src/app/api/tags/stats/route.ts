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
        const errorItems = await prisma.errorItem.findMany({
            where: { userId: user.id },
            select: {
                knowledgePoints: true,
            },
        });

        // 统计标签使用频率
        const tagStats: Record<string, number> = {};

        errorItems.forEach((item) => {
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
