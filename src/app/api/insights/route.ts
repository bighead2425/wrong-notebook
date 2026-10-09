import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError, conflict } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { formatInsightCode, nextInsightSeq } from "@/lib/insight-code";
import { writePhoto } from "@/lib/insight-photo";
import { decodeCursor, encodeCursor } from "@/lib/list-cursor";

const logger = createLogger('api:insights');

/** 【2026-10-09】列表单次条数：默认给多少、最多给多少（只限单次，不限总量） */
const INSIGHT_PAGE_DEFAULT = 50;
const INSIGHT_PAGE_MAX = 200;
/** 【2026-10-09】按编号清单查询（`?codes=`）一次最多认多少个编号 */
const INSIGHT_CODES_MAX = 200;

/**
 * GET /api/insights —— 日积月累条目列表。
 *
 * 筛选（2026-10-01 他定的）：
 *   `?grade=`                 年级/学期（「六年级上」口径 —— 他拍板弃用「2026-秋」）
 *   `?subjects=math,physics`  **学科多选**（可组合；逗号分隔）
 *   `?q=`                     关键词（搜编号或正文 —— "记得有个什么内容但想不起具体"）
 *   `?errorItemNo=`           只取某道题的那一条（详情页「日积月累」栏用）
 *   `?codes=JL…,JL…`          【2026-10-09】只取这几个编号（积累纸扫码预览用它问"这一页上
 *                             那些编号里，哪些关联了错题"—— 见 `insight-scan-view.tsx`）
 *
 * 翻页（【2026-10-09】加的）：
 *   `?limit=`   一次给多少条（默认 50，上限 200）
 *   `?cursor=`  上一批最后一条的位置（原样带回；不给 = 从最新一批开始）
 *   返回里的 `nextCursor` 非 null ⇒ 还有更早的，拿它再要一批。
 *
 * ⚠️ **为什么必须有这个上限**：原来这条接口**一次把全部条目拉出来**
 *    （还带着每条的正文）。条目只会越攒越多，打开页面就会越来越慢 ——
 *    而"每次只给一页、滚到底再要下一页"之后，**总量再多也不影响单次的耗时**。
 *    上限只限**单次**，不限总量：只要还有，就一直能往下翻（他要的就是这个）。
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
        /**
         * 【2026-10-09】按**编号清单**取（积累纸扫码预览用）。
         *
         * 为什么需要它：那个页面要知道"这张纸上那几十个 JL 编号，哪些关联了错题"，
         * 而原来的做法是**取回全部条目**再在本地建表 —— 列表一改成分页，那种取法就会
         * **悄悄取不全**（老条目全被判成"未关联"，颜色错了还看不出来）。
         * 现在按需要问，一次问清。
         *
         * ⚠️ 数量钉上限：这只是"按清单查"的便利入口，不该变成"绕过翻页拉全表"的后门。
         */
        const codes = (searchParams.get("codes") || "")
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
            .slice(0, INSIGHT_CODES_MAX);
        /** 【2026-10-09】单次条数（默认 50、上限 200） */
        const limitParam = Number(searchParams.get("limit"));
        const limit = Number.isFinite(limitParam) && limitParam > 0
            ? Math.min(INSIGHT_PAGE_MAX, Math.round(limitParam))
            : INSIGHT_PAGE_DEFAULT;
        /**
         * 【2026-10-09】游标 = 上一批最后一条的 `日期|当日序号`。
         * 拆不开就当作没传（从最新一批开始）—— 坏值不该换来一个 500。
         */
        const cursorParts = decodeCursor(searchParams.get("cursor"), 2);
        const anchorSeq = cursorParts ? Number(cursorParts[1]) : NaN;
        const anchor = cursorParts && Number.isFinite(anchorSeq)
            ? { dateKey: cursorParts[0], seq: anchorSeq }
            : null;

        const filters: Prisma.InsightWhereInput[] = [{ userId: user.id }];
        if (grade) filters.push({ gradeSemester: grade });
        if (subjects.length) filters.push({ subject: { in: subjects } });
        if (errorItemNo) filters.push({ errorItemNo });
        if (codes.length) filters.push({ code: { in: codes } });
        if (q) {
            filters.push({
                OR: [
                    { code: { contains: q } },
                    { content: { contains: q } },
                ],
            });
        }
        /**
         * 游标按 `(dateKey desc, seq desc)` 这个**复合序**往后走：
         * "日期更早" 或 "同一天但序号更小" —— 两条都要写。
         * ⚠️ 只写日期那一条会**漏掉同一天的条目**（同一天往往有好几条，这是常态）。
         */
        if (anchor) {
            filters.push({
                OR: [
                    { dateKey: { lt: anchor.dateKey } },
                    { AND: [{ dateKey: anchor.dateKey }, { seq: { lt: anchor.seq } }] },
                ],
            });
        }

        const rows = await prisma.insight.findMany({
            where: { AND: filters },
            orderBy: [{ dateKey: 'desc' }, { seq: 'desc' }],
            // 多要一条来判断"还有没有"：比再发一次 count 查询便宜
            take: limit + 1,
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        const nextCursor = hasMore && last ? encodeCursor(last.dateKey, last.seq) : null;

        // 有关联错题的条目，把**活的题**一起带回来（右栏要出错题卡）—— 只查这一页用到的
        const questions = await loadQuestions(
            user.id,
            page.map((r) => r.errorItemNo || ''),
        );

        return NextResponse.json({ insights: page, questions, nextCursor });
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
