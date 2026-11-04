import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:tags:suggestions');

/**
 * GET /api/tags/suggestions
 * 获取标签建议（支持搜索）
 * Query params: 
 *   - q: 搜索词
 *   - subject: 学科 (可选, e.g., 'math')
 *   - stage: 学段 (可选)
 * 
 * 现在从数据库 KnowledgeTag 表查询，包含系统标签和用户的自定义标签
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        const { searchParams } = new URL(req.url);
        const query = searchParams.get("q")?.toLowerCase() || "";
        /**
         * 【2026-11-01】返回条数。默认 30（打字筛选时够用）；
         * **空查询（点开输入框还没打字）时前端会要 300** —— 那是把标准标签库列出来挑的场景。
         */
        const limitRaw = Number.parseInt(searchParams.get("limit") || "", 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 300) : 30;
        const subject = searchParams.get("subject") || undefined;
        const stage = searchParams.get("stage") || undefined;

        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
                select: { id: true }
            });
        }

        // 如果没有 session, 尝试默认用户? 还是只返回系统标签? 
        // 按照现有逻辑，很多地方都有 fallback 到默认用户的逻辑，这里也保持一致比较好，
        // 或者只返回系统标签。稳妥起见，如果已登录则返回用户标签。

        const whereCondition: any = {
            ...(subject ? { subject } : {}),
            OR: [
                { isSystem: true },
                ...(user ? [{ userId: user.id }] : [])
            ]
        };

        // Fetch all system tags AND user tags for the subject
        const allTags = await prisma.knowledgeTag.findMany({
            where: whereCondition,
            select: {
                id: true,
                name: true,
                parentId: true,
                userId: true,
                isSystem: true,
                children: { select: { id: true } }, // Check if leaf
            },
        });

        // Identify leaf nodes (suggestions candidates)
        // A node is a leaf if it has no children in the fetched set
        // Actually, we can check children array length from the query
        // But the query for 'children' relies on the relation.
        // Let's filter in memory.

        const tagMap = new Map<string, typeof allTags[0]>();
        allTags.forEach(t => tagMap.set(t.id, t));

        let suggestions = allTags.filter(t => t.children.length === 0);

        // Filter by stage if provided
        if (stage) {
            const allowedGradePatterns: Record<string, string[]> = {
                'primary': ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'],
                'junior_high': ['七年级', '八年级', '九年级'],
                'senior_high': ['高一', '高二', '高三'],
            };

            const filters = allowedGradePatterns[stage];
            if (filters) {
                suggestions = suggestions.filter(tag => {
                    // Always show user custom tags (non-system tags) regardless of stage filter
                    // unless we want to enforce structure on them too? Usually custom tags have flattened structure or no parent
                    if (!tag.isSystem) {
                        return true;
                    }

                    let current = tag;
                    // Traverse up to find root
                    while (current.parentId && tagMap.get(current.parentId)) {
                        current = tagMap.get(current.parentId)!;
                    }
                    // Current is now the root (or top-most loaded ancestor)
                    const isMatch = filters.some(f => current.name.includes(f));
                    return isMatch;
                });
            }
        }

        // Filter by query
        if (query) {
            suggestions = suggestions.filter((tag) =>
                tag.name.toLowerCase().includes(query)
            );
        }

        // Secondary sorting by name match position (optional) or just name
        /**
         * 【2026-11-04 审计 A1】**带上 id 一起返回。**
         * 只回名字 ⇒ 下拉里选中的标签保存时只能按名字猜，跨册重名必废。
         */
        const finalSuggestions = suggestions
            .slice(0, limit)
            .map((s) => ({ id: s.id, name: s.name }));

        return NextResponse.json({
            suggestions: finalSuggestions,
            total: suggestions.length,
        });
    } catch (error) {
        logger.error({ error }, 'Error getting tag suggestions');
        return NextResponse.json(
            { message: "Failed to get tag suggestions" },
            { status: 500 }
        );
    }
}

