import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, notFound, forbidden, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:insights:id');

/**
 * PATCH /api/insights/[id] —— 改一条日积月累。
 *
 * 可改：年级学期 / 学科 / 正文 / 配图 / 关联的错题。
 * **编号（JL…）与日期段不可改** —— 它是这条记录的身份证（也是"哪天写的"这件事本身），
 * 改了就等于换了一条记录，那应该新建一条。
 *
 * 传 `null` 表示清空该字段；**没提到的字段一律不动**（改个正文不该顺手把配图弄没）。
 */
export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const existing = await prisma.insight.findUnique({ where: { id } });
        if (!existing) return notFound("Insight not found");
        if (existing.userId !== user.id) return forbidden("Not authorized to update this insight");

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const data: Record<string, unknown> = {};

        if ('gradeSemester' in body) {
            data.gradeSemester = typeof body.gradeSemester === 'string' && body.gradeSemester ? body.gradeSemester : null;
        }
        if ('subject' in body) {
            data.subject = typeof body.subject === 'string' && body.subject ? body.subject : null;
        }
        if ('content' in body) {
            data.content = typeof body.content === 'string' ? body.content : null;
        }
        if ('photoUrl' in body) {
            data.photoUrl = typeof body.photoUrl === 'string' && body.photoUrl ? body.photoUrl : null;
        }
        if ('errorItemId' in body) {
            const nextId = typeof body.errorItemId === 'string' && body.errorItemId ? body.errorItemId : null;
            if (nextId) {
                // 与新建同一条规矩：只能挂到**本人的**错题上
                const owner = await prisma.errorItem.findUnique({
                    where: { id: nextId },
                    select: { userId: true },
                });
                if (!owner || owner.userId !== user.id) return badRequest("errorItemId not found");
            }
            data.errorItemId = nextId;
        }

        if (Object.keys(data).length === 0) return badRequest("nothing to update");

        const updated = await prisma.insight.update({
            where: { id },
            data,
            include: { errorItem: { select: { id: true, source: true, questionText: true } } },
        });

        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error updating insight');
        return internalError("Failed to update insight");
    }
}

/** DELETE /api/insights/[id] —— 删一条（真删：日积月累没有"回收箱"这一档） */
export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const existing = await prisma.insight.findUnique({ where: { id }, select: { userId: true } });
        if (!existing) return notFound("Insight not found");
        if (existing.userId !== user.id) return forbidden("Not authorized to delete this insight");

        await prisma.insight.delete({ where: { id } });
        return NextResponse.json({ ok: true });
    } catch (error) {
        logger.error({ error }, 'Error deleting insight');
        return internalError("Failed to delete insight");
    }
}
