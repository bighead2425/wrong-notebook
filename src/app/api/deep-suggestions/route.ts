import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { normalizeReviewOutcomes } from "@/lib/review-outcomes";
import {
    upgradeSuggestions,
    CABINET_DEFAULT_OPTIONS,
    type CabinetQuestion,
} from "@/lib/cabinet";

const logger = createLogger("api:deep-suggestions");

/**
 * 【2026-10-20 真真】「建议深挖」页的数据与动作（空空第 6 条）。
 *
 * ── 判据**不在这里** ─────────────────────────────────────────────────
 * "哪些题建议升深挖"仍然只有 `lib/cabinet.ts` 的 `upgradeSuggestions()` 一处实现。
 * 这一页和内阁的任务卡**必须**给出同一批题 —— 否则又是"卡片说 3 道、点进去 5 道"。
 *
 * ── 升级 / 降级不存"我记得" ───────────────────────────────────────────
 * 升级 = 把 `ErrorItem.manageType` 改成 `deep`。那一列**本来就有**，详情页改属性
 * 也是改它 ⇒ 界面读这一列就知道"已升级"没有。
 * 只有**"留级"**（她确认不升）才需要落库 —— 它不是状态变更，没地方记。
 */
export async function GET() {
    const session = await getServerSession(authOptions);

    try {
        let userId: string | null = null;
        if (session?.user?.email) {
            const user = await prisma.user.findUnique({ where: { email: session.user.email } });
            userId = user?.id ?? null;
        }
        if (!userId) return unauthorized("Authentication required");

        /** 与内阁任务卡同一批判据输入（字段够用就行，不必整表） */
        const rows = await prisma.errorItem.findMany({
            where: { userId, deletedAt: null },
            select: {
                id: true,
                source: true,
                manageType: true,
                printCount: true,
                lastPrintedAt: true,
                reviewOutcomes: true,
                masteryLevel: true,
                levelCountdown: true,
                notebookId: true,
                questionText: true,
                gradeSemester: true,
                notebook: { select: { displayName: true, subject: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        const questions: CabinetQuestion[] = rows.map((r) => ({
            id: r.id,
            source: r.source,
            manageType: r.manageType,
            printCount: r.printCount,
            lastPrintedAt: r.lastPrintedAt,
            reviewOutcomes: r.reviewOutcomes,
            masteryLevel: r.masteryLevel,
            levelCountdown: r.levelCountdown,
            notebookId: r.notebookId,
            subjectKey: r.notebook?.subject ?? null,
        }));

        const keptRows = await prisma.upgradeDecision.findMany({
            where: { userId, decision: "kept" },
            select: { errorItemId: true, wrongCountAtDecision: true },
        });
        const keptWrongCounts = new Map(keptRows.map((r) => [r.errorItemId, r.wrongCountAtDecision]));

        const suggestions = upgradeSuggestions(questions, { ...CABINET_DEFAULT_OPTIONS, keptWrongCounts });
        const byId = new Map(rows.map((r) => [r.id, r]));
        const toItem = (id: string, wrongCount: number) => {
            const r = byId.get(id);
            return {
                id,
                source: r?.source ?? null,
                manageType: r?.manageType ?? null,
                /** 现在是不是已经是深挖（界面用它决定按钮写「升级」还是「已升级」） */
                isDeep: r?.manageType === "deep",
                wrongCount,
                notebookId: r?.notebookId ?? null,
                notebookName: r?.notebook?.displayName ?? null,
                subject: r?.notebook?.subject ?? null,
                gradeSemester: r?.gradeSemester ?? null,
                content: r?.questionText ?? null,
            };
        };

        const suggestedIds = new Set(suggestions.map((s) => s.question.id));

        /**
         * 【2026-10-20 空空改主意了】**留级的题不再从页面消失**，而是落到下面「留级题」那一栏。
         *
         * 他的原话："留级是一个记号，记录这道题用户目前不想升级，不用再提醒了，
         *            但如果用户想升级的时候，还是可以进入『建议深挖』页面对其进行升级的。"
         *
         * 三条件同时满足才进这一栏：
         *   ① 有留级记录；
         *   ② **不是深挖**（"留级题如果被升级了，再从这个页面消失"）；
         *   ③ **没有回到"建议中"**（她又错得更多时，判据不再压着它 —— 那时它算"建议"，
         *      不该同时出现在下面那一栏里）。
         */
        const keptItems = rows
            .filter((r) => keptWrongCounts.has(r.id) && r.manageType !== "deep" && !suggestedIds.has(r.id))
            .map((r) => toItem(r.id, keptWrongCounts.get(r.id) ?? 0));

        return NextResponse.json({
            items: suggestions.map((s) => toItem(s.question.id, s.wrongCount)),
            keptItems,
            /** 判据阈值一起回给前端，界面上能写清"错到几次才建议" */
            suggestUpgradeMinWrong: CABINET_DEFAULT_OPTIONS.suggestUpgradeMinWrong,
        });
    } catch (error) {
        logger.error({ error }, "Error listing deep suggestions");
        return internalError("Failed to list suggestions");
    }
}

/**
 * POST /api/deep-suggestions
 *
 * Body: `{ action: "upgrade" | "downgrade" | "keep", ids: string[] }`
 *
 * | action | 做什么 | 落在哪 |
 * |---|---|---|
 * | `upgrade` | 复练 → 深挖 | `ErrorItem.manageType = 'deep'` |
 * | `downgrade` | 深挖 → 复练（"已升级"再点一次 = 撤回） | `ErrorItem.manageType = 'review'` |
 * | `keep` | 确认**不升**，以后别再提示 | `UpgradeDecision`（记下当时错了几次） |
 *
 * ⚠️ `keep` 记 `wrongCountAtDecision` 是**故意**的：判据是"错 ≥2 次"，
 *    她留级之后又错到第 3、4 次时情况已经变了，还压着就是替她做了一个过时的决定。
 *    ⇒ 只有"错得不比当时多"才继续压着（见 `lib/cabinet.ts` 的判据）。
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let userId: string | null = null;
        if (session?.user?.email) {
            const user = await prisma.user.findUnique({ where: { email: session.user.email } });
            userId = user?.id ?? null;
        }
        if (!userId) return unauthorized("Authentication required");

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const action = body.action;
        const ids = Array.isArray(body.ids)
            ? [...new Set(body.ids.filter((v): v is string => typeof v === "string" && !!v))].slice(0, 200)
            : [];
        if (ids.length === 0) return badRequest("ids is required");
        if (action !== "upgrade" && action !== "downgrade" && action !== "keep") {
            return badRequest("action must be upgrade / downgrade / keep");
        }

        /** 只动**自己的**题（`userId` 进 where，不是先查再判断） */
        const own = await prisma.errorItem.findMany({
            where: { id: { in: ids }, userId, deletedAt: null },
            select: { id: true, reviewOutcomes: true, manageType: true },
        });
        if (own.length === 0) return badRequest("没找到这些题");

        if (action === "upgrade" || action === "downgrade") {
            const to = action === "upgrade" ? "deep" : "review";
            const changed = own.filter((q) => q.manageType !== to);
            if (changed.length > 0) {
                await prisma.errorItem.updateMany({
                    where: { id: { in: changed.map((q) => q.id) }, userId },
                    data: { manageType: to },
                });
                /**
                 * 留痕：等级变更走 `StateChangeLog`（与别处改等级同一张表）。
                 * 写失败**不影响主流程**（沿用项目里"留痕失败不阻断"的规矩）。
                 */
                /**
                 * 【2026-10-20 改】升级了就**删掉留级记号** ——
                 * "留级题如果被升级了，再从这个页面消失"（他明确要求）。
                 * 不删的话，万一以后又被降回复练，它会带着一条过期的留级记录冒出来。
                 */
                await prisma.upgradeDecision.deleteMany({
                    where: { userId, errorItemId: { in: changed.map((q) => q.id) } },
                });
                try {
                    await prisma.stateChangeLog.createMany({
                        data: changed.map((q) => ({
                            errorItemId: q.id,
                            field: "manageType",
                            fromValue: q.manageType,
                            toValue: to,
                            actor: "user",
                            actorUserId: userId,
                            note: action === "upgrade" ? "建议深挖：升级" : "建议深挖：撤回升级",
                        })),
                    });
                } catch (e) {
                    logger.warn({ error: e }, "state change log failed (ignored)");
                }
            }
            return NextResponse.json({ ok: true, changed: changed.length });
        }

        /** keep：留级 —— 记下"当时错了几次"，之后只有错得更多才会重新提示 */
        let kept = 0;
        for (const q of own) {
            const planned = normalizeReviewOutcomes(q.reviewOutcomes).planned;
            const wrongCount = planned.filter((v) => v === "wrong").length;
            await prisma.upgradeDecision.upsert({
                where: { userId_errorItemId: { userId, errorItemId: q.id } },
                create: { userId, errorItemId: q.id, decision: "kept", wrongCountAtDecision: wrongCount },
                update: { decision: "kept", wrongCountAtDecision: wrongCount },
            });
            kept += 1;
        }
        return NextResponse.json({ ok: true, kept });
    } catch (error) {
        logger.error({ error }, "Error applying deep suggestion action");
        return internalError("Failed to apply action");
    }
}
