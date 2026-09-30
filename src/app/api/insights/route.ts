import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError, conflict } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { formatInsightCode, nextInsightSeq } from "@/lib/insight-code";
import { writePhoto } from "@/lib/insight-photo";

const logger = createLogger('api:insights');

/**
 * GET /api/insights —— 日积月累条目列表。
 *
 * 筛选（2026-10-01 他定的）：
 *   `?grade=`                 年级/学期（「六年级上」口径 —— 他拍板弃用「2026-秋」）
 *   `?subjects=math,physics`  **学科多选**（可组合；逗号分隔）
 *   `?q=`                     关键词（搜编号或正文 —— "记得有个什么内容但想不起具体"）
 *   `?errorItemNo=`           只取某道题的那一条（详情页「日积月累」栏用）
 *
 * ⚠️ 按**编号倒序**排（日期只用来排先后，他不按日期筛）。
 * ⚠️ **不返回图片本体**（在 InsightPhoto 表，编辑某条时单独取 —— 2026-10-01 存储改正）。
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
        const subjects = (searchParams.get("subjects") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const q = (searchParams.get("q") || "").trim();
        const errorItemNo = (searchParams.get("errorItemNo") || "").trim().toUpperCase();

        const rows = await prisma.insight.findMany({
            where: {
                userId: user.id,
                ...(grade ? { gradeSemester: grade } : {}),
                ...(subjects.length ? { subject: { in: subjects } } : {}),
                ...(errorItemNo ? { errorItemNo } : {}),
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
        });

        // 有关联错题的条目，把**活的题**一起带回来（右栏要出错题卡）
        const questions = await loadQuestions(
            user.id,
            rows.map((r) => r.errorItemNo || ''),
        );

        return NextResponse.json({ insights: rows, questions });
    } catch (error) {
        logger.error({ error }, 'Error listing insights');
        return internalError("Failed to list insights");
    }
}

/**
 * POST /api/insights —— 新建**或覆盖**。
 *
 * Body: `{ dateKey, gradeSemester?, subject?, content?, photo?, errorItemNo?, source? }`
 *
 * ★ **题号当钥匙**（他 2026-10-01 拍板"一题一条"）：
 *   带了 `errorItemNo` 且库里已有这一题的条目 ⇒ **覆盖那一条**（编号不变），返回 `replaced: true`；
 *   没有才新建并发一个 JL 号。这样"AI 送 / 直送"随便按多少次都不会攒出重复条目，
 *   调用方也**不需要**记住"JL 号是多少"（他设计时担心的那件事，就这么化掉了）。
 *
 * ⚠️ `dateKey`（`YYYY-MM-DD`）由**客户端**给（容器跑 UTC，服务端自己分天会偏 8 小时）；
 *     只有**新建**时用得上（编号里的日期段），覆盖时不动原编号。
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
        const gradeSemester = typeof body.gradeSemester === 'string' && body.gradeSemester ? body.gradeSemester : null;
        const subject = typeof body.subject === 'string' && body.subject ? body.subject : null;
        const content = typeof body.content === 'string' ? body.content : null;
        const photo = typeof body.photo === 'string' && body.photo ? body.photo : body.photo === null ? null : undefined;
        const src = typeof body.source === 'string' && body.source ? body.source : null;
        const errorItemNo =
            typeof body.errorItemNo === 'string' && body.errorItemNo.trim()
                ? body.errorItemNo.trim().toUpperCase()
                : null;

        const dataForWrite = { gradeSemester, subject, content, source: src };

        // ★ 题号当钥匙：已有这一题的条目 ⇒ 覆盖（编号不变）。
        // ⚠️ 覆盖时**只动正文和来源**，不动 gradeSemester/subject ——
        //    那两项是日积月累页里她亲自设的，"从错题直送一次"不该把它们洗掉。
        if (errorItemNo) {
            const existing = await prisma.insight.findFirst({
                where: { userId: user.id, errorItemNo },
            });
            if (existing) {
                const updated = await prisma.insight.update({
                    where: { id: existing.id },
                    data: { content, source: src },
                });
                if (photo !== undefined) await writePhoto(updated.id, photo);
                logger.info({ userId: user.id, code: updated.code }, 'Insight overwritten by question no');
                return NextResponse.json({ ...updated, replaced: true });
            }
        }

        const dateKey = typeof body.dateKey === 'string' ? body.dateKey.trim() : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            return badRequest("dateKey must be YYYY-MM-DD (local date from the client)");
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
                ...dataForWrite,
                errorItemNo,
            },
        });
        if (photo) await writePhoto(created.id, photo);

        logger.info({ userId: user.id, code: created.code }, 'Insight created');
        return NextResponse.json(created);
    } catch (error) {
        if (typeof error === 'object' && error && (error as { code?: string }).code === 'P2002') {
            return conflict("Insight conflict, please retry");
        }
        logger.error({ error }, 'Error creating insight');
        return internalError("Failed to create insight");
    }
}

/** 给一批题号把活的题查回来（含回收箱标记 —— 回收箱里的题卡片上要有提示） */
async function loadQuestions(userId: string, nos: string[]) {
    const uniq = [...new Set(nos.filter((n): n is string => !!n))];
    if (uniq.length === 0) return {} as Record<string, unknown>;
    const rows = await prisma.errorItem.findMany({
        where: { userId, source: { in: uniq } },
        include: {
            notebook: { select: { id: true, displayName: true, subject: true } },
            tags: true,
        },
    });
    const map: Record<string, unknown> = {};
    for (const r of rows) {
        if (r.source) map[r.source] = { ...r, inTrash: r.deletedAt != null };
    }
    return map;
}
