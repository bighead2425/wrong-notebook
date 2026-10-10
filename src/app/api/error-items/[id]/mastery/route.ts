import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
// 【2026-10-10】"已掌握"要过一遍题间从属关系规则（人工标记才断开关联、主题向下传播）
import type { LinkOp } from "@/lib/item-link";
import { applyLinkOps, applyMastery, planMasteryChange } from "@/lib/item-link-store";

const logger = createLogger('api:error-items:mastery');

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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

        const { masteryLevel } = await req.json();
        /** 只在 0 / 1 / 2 三档里取（0=待复习 / 1=复习中 / 2=已掌握）—— 别的值不认 */
        const raw = Number(masteryLevel);
        if (!Number.isFinite(raw) || raw < 0 || raw > 2) {
            return badRequest("masteryLevel must be 0, 1 or 2");
        }
        const next = Math.round(raw);

        // Verify ownership before update
        const existingItem = await prisma.errorItem.findUnique({
            where: { id },
            select: { userId: true },
        });

        if (!existingItem) {
            return NextResponse.json({ message: "Item not found" }, { status: 404 });
        }

        if (existingItem.userId !== user.id) {
            return NextResponse.json({ message: "Not authorized to update this item" }, { status: 403 });
        }

        /**
         * 【2026-10-10】改成"已掌握"不只是改个数字，要先问一遍**题间从属关系**的规则
         * （规则本身在 `lib/item-link.ts`，这里只负责按它说的写库）：
         *   · 人工把**附题**标已掌握 ⇒ 与主题断开（变孤题，**能一键恢复**）；
         *   · 把**主题**标已掌握 ⇒ 名下附题跟着标，而**关系一动不动**。
         * ⚠️ 必须在写库**之前**算：规则看的是"现在是不是已掌握"。
         */
        let plan: { ops: LinkOp[]; propagateIds: string[]; message: string } = {
            ops: [],
            propagateIds: [],
            message: "",
        };
        try {
            plan = await planMasteryChange(user.id, id, next === 2);
        } catch (error) {
            // 关系规则出问题**不该让"改掌握状态"整个失败**，但必须被看见
            logger.error({ error, itemId: id }, 'Failed to plan item link on mastery change');
        }

        const errorItem = await prisma.errorItem.update({
            where: {
                id,
            },
            data: {
                masteryLevel: next,
            },
        });

        try {
            if (plan.ops.length) await applyLinkOps(user.id, plan.ops);
            if (plan.propagateIds.length) {
                await applyMastery(user.id, plan.propagateIds, next === 2, { excludeId: id });
            }
        } catch (error) {
            logger.error({ error, itemId: id }, 'Failed to apply item link on mastery change');
        }

        /** `linkNote` = 这一步顺带对关联做了什么（界面上显示一句话，而不是让他自己发现"它怎么自己动了"） */
        return NextResponse.json({ ...errorItem, linkNote: plan.message });
    } catch (error) {
        logger.error({ error }, 'Error updating item');
        return internalError("Failed to update error item");
    }
}
