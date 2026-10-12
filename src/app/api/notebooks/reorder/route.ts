import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, forbidden, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:notebooks:reorder');

/**
 * POST /api/notebooks/reorder
 * 【2026-10-12 需求第 6 / 12 条】把**一组**错题本按给定顺序重排。
 *
 * 他原话："点击某个卡片拖动…拖动放开后，将拖动的错题本卡片放到这个其他卡片的前面。"
 *
 * ── 为什么是"整组重写 0..n-1"而不是"和邻居换一下位次" ──────────────
 * 界面上的拖动是**一个人在一个组里**做的，但同一个人可能有好几组
 * （在用的 5 本、已归档·五年级 3 本、已归档·六年级 2 本…）。
 * 如果做"交换两个 sortOrder"，跨组交换时两组的编号会互相掺进对方的序列里，
 * 排序立刻变成一团乱麻（还很难看出是哪儿错的）。
 * 整组重写就没有这个问题：**谁排在谁前面是唯一的事实**，一次说清。
 *
 * 请求体：`{ ids: string[] }` —— 这一组**完整**的顺序（从前往后）。
 *
 * ⚠️ 只校验"这些 id 都是你自己的"，**不校验**它们的归档状态/年级是否一致：
 *    分组的判据在界面上（同一个年级组才允许拖），服务端再判一次等于把
 *    `grade` 的中文名比较规则搬到服务端，两处迟早不一致。
 *    真被绕过的后果也只是"某个组内的相对顺序不合预期"，不是数据损坏。
 */
export async function POST(req: Request) {
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

        const body = await req.json().catch(() => ({}));
        const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).map((v) => String(v)) : [];

        if (ids.length === 0) {
            return badRequest("ids is required");
        }
        if (new Set(ids).size !== ids.length) {
            return badRequest("ids contains duplicates");
        }

        /**
         * 先确认这些 id **全都**是这个用户的。
         * 少一个都不许写 —— 半截写入比不写更糟：界面会停在"一半新一半旧"的顺序上，
         * 而用户完全看不出来发生了什么。
         */
        const mine = await prisma.notebook.findMany({
            where: { id: { in: ids }, userId: user.id },
            select: { id: true },
        });
        if (mine.length !== ids.length) {
            const notMine = ids.filter((id) => !mine.some((m) => m.id === id));
            logger.warn({ notMine }, 'Reorder rejected: ids not owned by user');
            return forbidden("Some notebooks do not belong to you");
        }

        await prisma.$transaction(
            ids.map((id, index) =>
                prisma.notebook.update({ where: { id }, data: { sortOrder: index } }),
            ),
        );

        logger.info({ count: ids.length }, 'Notebooks reordered');
        return NextResponse.json({ ordered: ids.length });
    } catch (error) {
        logger.error({ error }, 'Error reordering notebooks');
        return internalError("Failed to reorder notebooks");
    }
}
