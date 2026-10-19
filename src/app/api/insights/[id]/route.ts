import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, notFound, forbidden, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { writePhoto, setPhotoPrintIncluded } from "@/lib/insight-photo";
// 【2026-10-19 如如】词头：正文第一行的归一化结果（主附积累的落库依据）
import { headwordOfContent } from "@/lib/insight-headword";

const logger = createLogger('api:insights:id');

/**
 * PATCH /api/insights/[id] —— 改一条日积月累。
 *
 * 可改：年级学期 / 学科 / 正文 / **配图（photo）** / 关联错题的题号（errorItemNo）/ 来源。
 * **编号（JL…）与日期段不可改** —— 它是这条记录的身份证（也是"哪天写的"这件事本身），
 * 改了就等于换了一条记录，那应该新建一条。
 *
 * `photo`：字符串 = 建或换（本体进 InsightPhoto 表，2026-10-01 存储改正）；null = 删图；
 *          **不传 = 不动**（改个正文不该顺手把图弄没 —— 与 cropRegions 同一条规矩）。
 * 其余传 `null` 表示清空该字段；**没提到的字段一律不动**。
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
            /**
             * 【2026-10-19 如如】词头跟着正文走。
             * 改标题 = 这条搬到另一个词头底下，所以**每次正文变更都要重算**，
             * 不能只在建的时候算一次（那会让"改了标题的条目"一直挂在老词头上）。
             */
            data.headword = headwordOfContent(typeof body.content === 'string' ? body.content : null);
        }
        if ('errorItemNo' in body) {
            const no = typeof body.errorItemNo === 'string' && body.errorItemNo.trim()
                ? body.errorItemNo.trim().toUpperCase()
                : null;
            // 唯一约束会拦"一题两条"，这里先把最常见的冲突查出来给一句人话
            if (no && no !== existing.errorItemNo) {
                const taken = await prisma.insight.findFirst({
                    where: { userId: user.id, errorItemNo: no, id: { not: id } },
                    select: { code: true },
                });
                if (taken) {
                    return badRequest(`这道题已经有日积月累了（${taken.code}）。一题一条 —— 去那条上改。`);
                }
            }
            data.errorItemNo = no;
        }
        if ('source' in body) {
            data.source = typeof body.source === 'string' && body.source ? body.source : null;
        }
        /** 【2026-10-13】暂存 ⇄ 正式（录入页的"保存"就是把草稿转正） */
        if ('status' in body) {
            if (body.status !== 'draft' && body.status !== 'final') {
                return badRequest("status must be 'draft' or 'final'");
            }
            data.status = body.status;
        }

        /**
         * ⚠️ 守卫必须把 `photoIncludedInPrint` 也算进来：他只动那个开关时
         *    `data` 是空的（那个字段存在 InsightPhoto 表上，不在主表）——
         *    漏了它，点一下开关会收到 400 "nothing to update"。
         */
        if (
            Object.keys(data).length === 0 &&
            !('photo' in body) &&
            !('photoIncludedInPrint' in body)
        ) {
            return badRequest("nothing to update");
        }

        let updated;
        if (Object.keys(data).length > 0) {
            updated = await prisma.insight.update({ where: { id }, data });
        } else {
            updated = existing;
        }

        if ('photo' in body) {
            const photo = typeof body.photo === 'string' && body.photo ? body.photo : null;
            await writePhoto(id, photo);
        }

        /**
         * 【2026-10-13 第 6 条】「入版」开关 —— **与 `photo` 分开传**：
         *   `photo` 是"图是什么"，这个是"这张图要不要进纸"。合成一个字段
         *   会逼前端每次点开关都重传几百 KB 的 data URL。
         */
        if ('photoIncludedInPrint' in body) {
            await setPhotoPrintIncluded(id, body.photoIncludedInPrint === true);
        }

        logger.info({ userId: user.id, id }, 'Insight updated');
        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error updating insight');
        return internalError("Failed to update insight");
    }
}

/**
 * GET /api/insights/[id] —— 取一条（**含图片本体**与关联的活题）。
 * 编辑右栏选中某条时调它：列表不背图片，这里才给。
 */
export async function GET(
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

        const row = await prisma.insight.findUnique({
            where: { id },
            include: { photo: { select: { data: true, includedInPrint: true } } },
        });
        if (!row) return notFound("Insight not found");
        if (row.userId !== user.id) return forbidden("Not authorized to read this insight");

        let question: unknown = null;
        if (row.errorItemNo) {
            const q = await prisma.errorItem.findFirst({
                where: { userId: user.id, source: row.errorItemNo },
                include: {
                    notebook: { select: { id: true, displayName: true, subject: true } },
                    tags: true,
                },
            });
            if (q) question = { ...q, inTrash: q.deletedAt != null };
        }

        const { photo, ...rest } = row;

        /**
         * 【2026-10-19 空空第 4 条】这条积累**扫码链出去的**那几条（"参见"）。
         * 只给"编号 + 开头一段"：右栏那块地方小，全文放不下也没必要 ——
         * 真要看全文，点一下去那一条。
         */
        const links = await prisma.insightLink.findMany({
            where: { fromId: id },
            orderBy: { createdAt: 'asc' },
            select: { to: { select: { id: true, code: true, content: true } } },
        });

        return NextResponse.json({
            ...rest,
            photo: photo?.data ?? null,
            /**
             * 【2026-10-13 第 6 条】"入版"开关 —— 组成积累纸时这张图跟不跟着进去。
             * ⚠️ 没有图时给 `true`（与 schema 默认一致）：打印页据此判断"要不要排这张图"，
             *    没图时反正排不出来，给 true 才不会让"有没有开关"这件事变得不可预测。
             */
            photoIncludedInPrint: photo?.includedInPrint ?? true,
            /** 【2026-10-19 第 4 条】扫码链出去的那几条（见上面那段说明） */
            links: links.map((l) => ({ id: l.to.id, code: l.to.code, content: l.to.content })),
            question,
        });
    } catch (error) {
        logger.error({ error }, 'Error reading insight');
        return internalError("Failed to read insight");
    }
}

/** DELETE /api/insights/[id] —— 删一条（真删；图片随级联一起没了） */
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
