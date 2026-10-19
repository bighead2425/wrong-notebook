import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, notFound, forbidden, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:insights:id:links');

/**
 * 【2026-10-19 真真】**给一条已经存在的积累加 / 删「参见」链接**。
 *
 * 背景：`InsightLink` 上一棒只做了"新建积累时随 `linkCodes` 一起落库"——
 * 那条路只覆盖"正在写的一条"。而管理页是对**已存在**的条目操作
 * （空空第 2 条要的就是管理页右栏也能扫码关联），必须有单独一个入口。
 *
 * ── 为什么 add / remove 挤一个接口 ──────────────────────────────────
 * 两个动作的入参、鉴权、查目标、错误处理**完全一样**，只有最后一句不同。
 * 拆成两个文件会让"改了 add 忘了 remove"这种分叉有机会出现（这项目吃过太多次）。
 *
 * ⚠️ **`createMany` 不带 `skipDuplicates`**：SQLite 上 Prisma 不支持那个参数。
 *    所以先查已有的、只插新的 —— 扫两次同一张纸不该报错。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const from = await prisma.insight.findUnique({ where: { id }, select: { userId: true, code: true } });
        if (!from) return notFound("Insight not found");
        if (from.userId !== user.id) return forbidden("Not authorized to update this insight");

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const action = body.action === 'remove' ? 'remove' : 'add';
        const codes = Array.isArray(body.codes)
            ? [...new Set(
                  body.codes
                      .filter((c): c is string => typeof c === 'string' && !!c.trim())
                      .map((c) => c.trim().toUpperCase()),
              )].slice(0, 20)
            : [];
        if (codes.length === 0) return badRequest("codes is required");

        /** 只认**自己的**条目，且**不许链自己**（自环没有意义，还会在列表里出现一条"参见自己"） */
        const targets = await prisma.insight.findMany({
            where: { userId: user.id, code: { in: codes }, NOT: { id } },
            select: { id: true },
        });
        if (targets.length === 0) return badRequest("没找到这些编号（或它们就是这一条本身）");
        const targetIds = targets.map((t) => t.id);

        if (action === 'remove') {
            const res = await prisma.insightLink.deleteMany({
                where: { fromId: id, toId: { in: targetIds } },
            });
            logger.info({ userId: user.id, code: from.code, removed: res.count }, 'Insight links removed');
            return NextResponse.json({ ok: true, removed: res.count });
        }

        /** 先查已有的，只插新的（SQLite 不支持 createMany 的 skipDuplicates） */
        const existing = await prisma.insightLink.findMany({
            where: { fromId: id, toId: { in: targetIds } },
            select: { toId: true },
        });
        const have = new Set(existing.map((e) => e.toId));
        const todo = targetIds.filter((t) => !have.has(t));
        if (todo.length > 0) {
            await prisma.insightLink.createMany({
                data: todo.map((t) => ({ fromId: id, toId: t })),
            });
        }
        logger.info({ userId: user.id, code: from.code, added: todo.length }, 'Insight links added');
        return NextResponse.json({ ok: true, added: todo.length });
    } catch (error) {
        logger.error({ error }, 'Error updating insight links');
        return internalError("Failed to update links");
    }
}
