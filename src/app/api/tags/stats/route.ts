import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import type { TagStats } from "@/types/api";

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
        /**
         * 【2026-11-06 空空】**使用统计要支持按年级/学科分组排行，所以这一版取的东西多了三样。**
         *
         * 原来只 `select: { tags: { select: { name: true } } }` —— 名字是对的，
         * 但**没有 id**（点不进题）、**没有学科**（分不了组）、**没有册**（排不了年级）。
         * 这就是为什么它一直只能做一个 top20 的名字列表。
         *
         * `stage` 的取法：沿 `parentId` 爬到**根节点**，根的名字就是"册"或"学段"——
         * 数学/物理/化学/生物按册（"五年级上"），语文/英语/政史地按学段（"小学/初中/高中"），
         * 与 `src/lib/tag-data/*.ts` 的结构一致。
         */
        const [errorItems, allTags] = await Promise.all([
            prisma.errorItem.findMany({
                where: { userId: user.id, deletedAt: null },
                select: {
                    knowledgePoints: true,
                    tags: { select: { id: true, name: true } },
                },
            }),
            prisma.knowledgeTag.findMany({
                where: { OR: [{ isSystem: true }, { userId: user.id }] },
                select: { id: true, name: true, subject: true, parentId: true, isSystem: true },
            }),
        ]);

        const tagById = new Map(allTags.map((t) => [t.id, t]));
        /** 爬到根：根名 = 册 / 学段。加层数上限，防脏数据成环。 */
        const rootNameOf = (id: string): string | null => {
            let cur = tagById.get(id);
            let guard = 0;
            while (cur?.parentId && guard++ < 12) {
                const parent = tagById.get(cur.parentId);
                if (!parent) break;
                cur = parent;
            }
            return cur?.name ?? null;
        };

        /** key：有 id 用 id；老数据（只有名字串）用 `name:` 前缀，避免和真 id 撞 */
        const acc = new Map<string, TagStats>();

        errorItems.forEach((item) => {
            const rel = item.tags ?? [];
            if (rel.length > 0) {
                for (const t of rel) {
                    const name = (t.name ?? "").trim();
                    if (!name) continue;
                    const meta = tagById.get(t.id);
                    const cur =
                        acc.get(t.id) ??
                        {
                            id: t.id,
                            name,
                            subject: meta?.subject ?? null,
                            stage: rootNameOf(t.id),
                            isSystem: meta?.isSystem ?? null,
                            count: 0,
                        };
                    cur.count += 1;
                    acc.set(t.id, cur);
                }
                return;
            }
            /* 兜底：老数据只有那列名字串（关系还没建）⇒ 没有 id、没有册、没有学科 */
            if (item.knowledgePoints) {
                try {
                    const parsed = JSON.parse(item.knowledgePoints);
                    if (Array.isArray(parsed)) {
                        for (const tag of parsed) {
                            if (!tag || typeof tag !== "string") continue;
                            const name = tag.trim();
                            if (!name) continue;
                            const key = `name:${name}`;
                            const cur =
                                acc.get(key) ??
                                { id: null, name, subject: null, stage: null, isSystem: null, count: 0 };
                            cur.count += 1;
                            acc.set(key, cur);
                        }
                    }
                } catch {
                    logger.warn({ knowledgePoints: item.knowledgePoints }, 'Failed to parse knowledgePoints for item');
                }
            }
        });

        /**
         * 只保留"真的挂了题"的标签（他明确说的：没有题的标签没必要排行），
         * 次数从高到低；同次数按名字排，保证每次刷新顺序稳定。
         */
        const stats = [...acc.values()]
            .filter((s) => s.count > 0)
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"));

        return NextResponse.json({
            stats,
            total: errorItems.length,
            uniqueTags: stats.length,
        });
    } catch (error) {
        logger.error({ error }, 'Error getting tag stats');
        return internalError("Failed to get tag statistics");
    }
}
