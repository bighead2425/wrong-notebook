/**
 * 手动重新归位一道题的标签（两段式的第二段）。
 *
 * 什么时候会用到：
 *   · 第二段重试 2 次后仍失败（`tagStatus='failed'`）
 *   · 用户手动清空了标签，想让它重新推一遍
 *   · 词表更新后，想把某道题按新词表重新落一次
 *
 * 只是**入队**，不在这里执行 —— 队列保证同一时刻只跑一道（见 lib/ai/relocate-queue.ts）。
 * 真正的进度看 `GET /api/error-items/[id]/relocate`（返回 tagStatus + 队列位置）。
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getAppConfig } from "@/lib/config";
import { enqueueRelocate, relocateQueueState } from "@/lib/ai/relocate-service";

const logger = createLogger('api:error-items:relocate');

/** 取当前用户 + 校验这道题归他 */
async function resolveItem(id: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return { error: 'unauthorized' as const };

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return { error: 'unauthorized' as const };

    const item = await prisma.errorItem.findFirst({
        where: { id, userId: user.id },
        select: { id: true, tagStatus: true },
    });
    if (!item) return { error: 'notFound' as const };

    return { item };
}

export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        const r = await resolveItem(id);
        if (r.error === 'unauthorized') return unauthorized("Authentication required");
        if (r.error === 'notFound') return notFound("Item not found");

        /* 开关关着的时候不该有这个机会：说明用户没开两段式，标签是单段给的 */
        if (!getAppConfig().twoStage?.enabled) {
            return NextResponse.json(
                { error: "两段式分析未开启", hint: "设置 → 提示词 → 两段式分析" },
                { status: 400 },
            );
        }

        const q = enqueueRelocate(id);
        logger.info({ itemId: id, queued: q.queued, position: q.position }, '手动入队归位');

        return NextResponse.json({
            queued: q.queued,
            position: q.position,
            /* 已经在队列里时也是 200：前端统一按"正在归位"显示即可 */
            queue: relocateQueueState(),
        });
    } catch (e) {
        logger.error({ itemId: id, err: String(e) }, '入队归位失败');
        return internalError("Failed to enqueue relocation");
    }
}

/** 查询这道题的归位状态（详情页待机时可少取一次全量详情） */
export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const r = await resolveItem(id);
        if (r.error === 'unauthorized') return unauthorized("Authentication required");
        if (r.error === 'notFound') return notFound("Item not found");

        return NextResponse.json({
            tagStatus: r.item!.tagStatus ?? null,
            queue: relocateQueueState(),
        });
    } catch (e) {
        logger.error({ itemId: id, err: String(e) }, '查询归位状态失败');
        return internalError("Failed to read relocation status");
    }
}
