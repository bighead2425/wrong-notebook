import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { startOfMonth, subMonths, format, startOfWeek, subDays } from "date-fns";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { subjectLabel } from "@/lib/notebook-fields";

const logger = createLogger('api:analytics');

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    // @ts-ignore
    const userId = session.user.id;

    try {
        /**
         * 【2026-10-04 口径统一】统计一律**不含回收箱**（`deletedAt != null` 的题）。
         * 他 2026-10-04 拍板："回收箱的错题可以不计入错题总数中"。
         * ⚠️ 必须**四处一起改**（总数 / 已掌握 / 学科分布 / 近 7 天活动）——
         *    只改总数会让"掌握率"的分子分母口径不一致（分子里还留着回收箱的题）。
         * 📌 与「总理内阁」页的**已知差别**：内阁还额外排除了**归档本**里的题
         *    （按主库 `scope=main` 口径）。所以两页若仍对不上，差的就是"归档学期"那一块。
         */
        // 1. Total Errors
        const totalErrors = await prisma.errorItem.count({
            where: { userId, deletedAt: null }
        });

        // 2. Mastered Count
        const masteredCount = await prisma.errorItem.count({
            where: {
                userId,
                deletedAt: null,
                masteryLevel: { gt: 0 }
            }
        });

        // 3. Mastery Rate
        const masteryRate = totalErrors > 0 ? ((masteredCount / totalErrors) * 100).toFixed(1) : 0;

        // 4. Subject Distribution - Get error items grouped by subject
        /**
         * ⚠️⚠️【2026-10-16 真真】**性能修复：这里原来没写 `select`，而且不分页。**
         *
         * 与错题本列表同一个病根（见 `lib/constants/error-item-list-fields.ts` 文件头）：
         * 不写 select ⇒ 返回 `ErrorItem` 全部标量字段，**含 `originalImageUrl`（题图 base64，单张最大约 1.37MB）**。
         *
         * ⚠️ 这一处**比错题本列表更危险** —— 它 `where` 只按 `userId`、**没有分页**，
         *    取的是**全部错题**。按 300 道题估：300 × 1.37MB ≈ **410MB**；题再多就是 GB 级。
         *
         * ⚠️ 而它**只用到 `item.notebook.subject` 一个字段**（下面 forEach 里就这一处）
         *    ⇒ 图是**纯浪费**。
         *
         * 📌 谁在调：`components/wrong-answer-stats.tsx` ⇒ **首页与内阁页都用它**
         *    （`app/cabinet/page.tsx` 的文件头写着"统计总览复用主页统计中心"）。
         */
        const errorItemsWithSubject = await prisma.errorItem.findMany({
            where: { userId, deletedAt: null },
            select: {
                id: true,
                notebook: { select: { subject: true } },
            },
        });

        const subjectMap = new Map<string, number>();
        errorItemsWithSubject.forEach(item => {
            const subjectName = item.notebook ? subjectLabel(item.notebook.subject) : 'Unknown';
            subjectMap.set(subjectName, (subjectMap.get(subjectName) || 0) + 1);
        });

        const subjectStats = Array.from(subjectMap.entries()).map(([name, value]) => ({
            name,
            value
        }));

        // 5. Activity Data (Last 7 days) - Track ErrorItem creation (not practice)
        const activityData = [];
        for (let i = 6; i >= 0; i--) {
            const targetDate = subDays(new Date(), i);
            const dateStr = format(targetDate, 'MM-dd');

            const startOfDay = new Date(targetDate);
            startOfDay.setHours(0, 0, 0, 0);

            const endOfDay = new Date(targetDate);
            endOfDay.setHours(23, 59, 59, 999);

            // Count error items created on this day（口径同上：不含回收箱）
            const count = await prisma.errorItem.count({
                where: {
                    userId,
                    deletedAt: null,
                    createdAt: {
                        gte: startOfDay,
                        lt: endOfDay
                    }
                }
            });

            activityData.push({
                date: dateStr,
                count
            });
        }

        return NextResponse.json({
            totalErrors,
            masteredCount,
            masteryRate,
            subjectStats,
            activityData
        });

    } catch (error) {
        logger.error({ error }, 'Error fetching analytics');
        return internalError("Failed to fetch analytics");
    }
}
