import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { addDays, format } from "date-fns";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { reviewStatusOf, type ReviewStatus } from "@/lib/review-status";
import { subjectLabel } from "@/lib/notebook-fields";

const logger = createLogger("api:analytics:queue");

/** 未来多少天的到期分布 */
const FORECAST_DAYS = 14;

/**
 * 【2026-10-25】**"该练什么、哪天练"的分析** —— 回答现有统计答不出的问题。
 *
 * 现有 `/api/analytics` 只有四个数（总数 / 已掌握 / 学科分布 / 近 7 天新增），
 * 看的是"积累了多少"，看不出"**接下来该干什么**"。
 *
 * 这个接口全部基于 `reviewStatusOf()`（`lib/review-status.ts`，纯函数）：
 *   · `urgency` 1–5 —— 就是"今天先练哪几道"的排序键（≥4 = 今天该练）
 *   · `nextDueKey` —— 下次该复习的日期，用来做"未来两周哪天会堆"
 *
 * ⚠️ 口径与错题本一致：**不含回收箱**（`deletedAt: null`）。
 * ⚠️ 只 `select` 需要的字段：`reviewOutcomes` 是字符串化的派生缓存，
 *    不带题图（那是 GB 级的坑，见 `/api/analytics` 文件头的血泪注释）。
 */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) return unauthorized();
    const userId = session.user.id;

    try {
        const items = await prisma.errorItem.findMany({
            where: { userId, deletedAt: null },
            select: {
                reviewOutcomes: true,
                notebook: { select: { subject: true } },
            },
        });

        const today = new Date();

        /** 每道题算一次状态；后面三张图都从这一份结果派生 */
        const rows = items.map((it) => ({
            status: reviewStatusOf(it.reviewOutcomes, today),
            subject: it.notebook?.subject ? subjectLabel(it.notebook.subject) : subjectLabel(null),
        }));

        // ── ① 该练队列：按紧迫度分档 ──────────────────────────────
        /** 5 = 新录入 / 连错 ≥2；4 = 错过一次；3 = 对一次；2 = 连对两次；1 = 连对三次 */
        const bucketOf = (s: ReviewStatus): number => (s.state === "retired" ? 0 : s.urgency);
        const counts = new Map<number, number>();
        for (const r of rows) {
            const k = bucketOf(r.status);
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const buckets = [5, 4, 3, 2, 1].map((u) => ({
            urgency: u,
            count: counts.get(u) ?? 0,
        }));
        const retired = counts.get(0) ?? 0;

        /** 今天该练 = 紧迫度 ≥ 4。阈值与 `lib/overview.ts` 的 OVERVIEW_URGENT_THRESHOLD 同一条线。 */
        const dueToday = buckets.filter((b) => b.urgency >= 4).reduce((n, b) => n + b.count, 0);

        // ── ② 学科 × 复习状态 ────────────────────────────────────
        /** 四档：还没练过 / 该练了 / 练习中 / 已掌握 */
        const bySubject = new Map<string, { fresh: number; due: number; practicing: number; mastered: number }>();
        for (const r of rows) {
            const cell = bySubject.get(r.subject) ?? { fresh: 0, due: 0, practicing: 0, mastered: 0 };
            if (r.status.state === "retired") cell.mastered += 1;
            else if (r.status.state === "new") cell.fresh += 1;
            else if (r.status.state === "due") cell.due += 1;
            else cell.practicing += 1;
            bySubject.set(r.subject, cell);
        }
        const subjects = [...bySubject.entries()]
            .map(([subject, v]) => ({
                subject,
                ...v,
                total: v.fresh + v.due + v.practicing + v.mastered,
            }))
            // 题多的排前面 —— 家长先看"哪一科积压最多"
            .sort((a, b) => b.total - a.total);

        // ── ③ 未来 14 天到期 ─────────────────────────────────────
        /**
         * 为什么值得看：间隔是 1/3/7/14/28 天，**到期是会扎堆的**。
         * 某天突然 40 道，靠的是提前一天知道，而不是当天被吓一跳。
         */
        const forecast: { date: string; count: number }[] = [];
        const keyToCount = new Map<string, number>();
        for (const r of rows) {
            const k = r.status.nextDueKey;
            if (!k) continue; // 已退休的没有下次
            keyToCount.set(k, (keyToCount.get(k) ?? 0) + 1);
        }
        for (let i = 0; i < FORECAST_DAYS; i += 1) {
            const d = addDays(today, i);
            // nextDueKey 是 `YYYY-MM-DD`（本地日键），这里也用同一个格式对
            const key = format(d, "yyyy-MM-dd");
            forecast.push({ date: format(d, "MM-dd"), count: keyToCount.get(key) ?? 0 });
        }

        /** 今天之前就该练、但还没练的（补练队列）—— 最容易被他忽略的一块 */
        const todayKey = format(today, "yyyy-MM-dd");
        let overdue = 0;
        for (const r of rows) {
            const k = r.status.nextDueKey;
            if (k && k < todayKey) overdue += 1;
        }

        // ── ④ 复习节奏热力（近 12 周）─────────────────────────────
        /**
         * 为什么要它：前三张图看"题目状态"，这张看**人**。
         * 间隔复习最怕"停一周"—— 一停，所有题同时到期，那时再补就是雪崩。
         *
         * 数的是 `ReviewEvent`（真的按了"对/错"），不是"打开过页面"。
         * 口径同错题本：不含回收箱的题（连 `userId` 一起过滤，事件表本身没有 `deletedAt`）。
         */
        const HEAT_DAYS = 84;
        const heatStart = format(addDays(today, -(HEAT_DAYS - 1)), "yyyy-MM-dd");
        const grouped = await prisma.reviewEvent.groupBy({
            by: ["occurredOn"],
            where: {
                userId,
                occurredOn: { gte: heatStart },
                errorItem: { deletedAt: null },
            },
            _count: { _all: true },
        });
        const heatMap = new Map<string, number>();
        for (const g of grouped) heatMap.set(g.occurredOn, g._count._all);

        const heat: { date: string; count: number }[] = [];
        for (let i = HEAT_DAYS - 1; i >= 0; i -= 1) {
            const d = addDays(today, -i);
            const key = format(d, "yyyy-MM-dd");
            heat.push({ date: key, count: heatMap.get(key) ?? 0 });
        }

        return NextResponse.json({
            total: rows.length,
            retired,
            dueToday,
            overdue,
            buckets,
            subjects,
            forecast,
            heat,
        });
    } catch (error) {
        logger.error({ error }, "Error fetching queue analytics");
        return internalError("Failed to fetch queue analytics");
    }
}
