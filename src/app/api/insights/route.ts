import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError, conflict } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { formatInsightCode, nextInsightSeq } from "@/lib/insight-code";

const logger = createLogger('api:insights');

/**
 * GET /api/insights —— 日积月累条目列表。
 *
 * 支持 `?grade=&subject=&q=`（年级学期 / 学科 / 关键词），按**编号倒序**（新的在前）。
 * 一次性返回全部（不翻页）：日积月累是"攒下来的一句话"，量级跟错题不在一个数量级，
 * 左栏是一条条滚动的清单，分页反而碍事。
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const { searchParams } = new URL(req.url);
        const grade = searchParams.get("grade") || "";
        const subject = searchParams.get("subject") || "";
        const q = (searchParams.get("q") || "").trim();

        const insights = await prisma.insight.findMany({
            where: {
                userId: user.id,
                ...(grade ? { gradeSemester: grade } : {}),
                ...(subject ? { subject } : {}),
                /**
                 * 关键词同时搜编号与正文 —— 他找一条积累时，可能记得编号（JL…），
                 * 也可能只记得里面写过什么。两样都搜，找起来最快。
                 */
                ...(q
                    ? {
                          OR: [
                              { code: { contains: q } },
                              { content: { contains: q } },
                          ],
                      }
                    : {}),
            },
            orderBy: [{ dateKey: 'desc' }, { seq: 'desc' }],
            // 关联的错题只取"点进详情页/显示二维码"要用的字段
            include: {
                errorItem: { select: { id: true, source: true, questionText: true } },
            },
        });

        return NextResponse.json({ insights });
    } catch (error) {
        logger.error({ error }, 'Error listing insights');
        return internalError("Failed to list insights");
    }
}

/**
 * POST /api/insights —— 新建一条。
 *
 * Body: `{ dateKey, gradeSemester?, subject?, content?, photoUrl?, errorItemId? }`
 *
 * ⚠️ `dateKey`（`YYYY-MM-DD`）**必须由客户端给**：容器跑在 UTC，
 *    服务端自己分"天"会把半夜录的条目记到前一天去（见 `lib/insight-code.ts` 文件头）。
 *    编号 = `JL` + 日期 + 当日流水，流水号在服务端算（多设备同时建也不会撞号）。
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const dateKey = typeof body.dateKey === 'string' ? body.dateKey.trim() : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            return badRequest("dateKey must be YYYY-MM-DD (local date from the client)");
        }

        // 关联错题要先确认**是本人的**（不能拿别人的 id 挂上去）
        const errorItemId = typeof body.errorItemId === 'string' && body.errorItemId ? body.errorItemId : null;
        if (errorItemId) {
            const owner = await prisma.errorItem.findUnique({
                where: { id: errorItemId },
                select: { userId: true },
            });
            if (!owner || owner.userId !== user.id) {
                return badRequest("errorItemId not found");
            }
        }

        const maxUsed = await prisma.insight.aggregate({
            where: { userId: user.id, dateKey },
            _max: { seq: true },
        });
        const seq = nextInsightSeq(maxUsed._max.seq);

        const created = await prisma.insight.create({
            data: {
                userId: user.id,
                code: formatInsightCode(dateKey, seq),
                dateKey,
                seq,
                gradeSemester: typeof body.gradeSemester === 'string' && body.gradeSemester ? body.gradeSemester : null,
                subject: typeof body.subject === 'string' && body.subject ? body.subject : null,
                content: typeof body.content === 'string' ? body.content : null,
                photoUrl: typeof body.photoUrl === 'string' && body.photoUrl ? body.photoUrl : null,
                errorItemId,
            },
            include: { errorItem: { select: { id: true, source: true, questionText: true } } },
        });

        logger.info({ userId: user.id, code: created.code }, 'Insight created');
        return NextResponse.json(created);
    } catch (error) {
        // 极端并发下撞了唯一约束 ⇒ 让客户端重试一次即可（同一秒两条的概率极低）
        if (typeof error === 'object' && error && (error as { code?: string }).code === 'P2002') {
            return conflict("Insight code conflict, please retry");
        }
        logger.error({ error }, 'Error creating insight');
        return internalError("Failed to create insight");
    }
}
