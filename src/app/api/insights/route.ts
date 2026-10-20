import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError, conflict } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { formatInsightCode, nextInsightSeq } from "@/lib/insight-code";
import { writePhoto, setPhotoPrintIncluded } from "@/lib/insight-photo";
import { decodeCursor, encodeCursor } from "@/lib/list-cursor";
// 【2026-10-19 如如】词头：正文第一行的归一化结果（主附积累的落库依据）
import { headwordOfContent } from "@/lib/insight-headword";
// 【2026-10-16】关联题的字段清单（唯一出处；默认不含题图）—— 见该文件头的性能说明
import { LIST_ITEM_SCALARS } from "@/lib/constants/error-item-list-fields";

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
        /**
         * 【2026-10-13 他定的】默认**不返回暂存条**（`status='draft'`）——
         * 打印页、内阁、"挑条目"都不该看见半成品（他：暂存 = 等待后续整理或删除）。
         * 管理页要看它们 ⇒ 带 `?drafts=1`。
         */
        if (searchParams.get('drafts') !== '1') {
            filters.push({ status: { not: 'draft' } });
        }
        if (grade) filters.push({ gradeSemester: grade });
        if (subjects.length) {
            /**
             * 【2026-10-19 真真】**点「其他」要把"没设学科"的也筛出来**（空空报的 bug）。
             *
             * 界面上 `subjectLabel(null)` 返回的就是"其他"（`lib/notebook-fields.ts:67`），
             * 所以她看到的"其他"里混着两种：真的选了 `other`、以及压根没选（`null`）。
             * 而这里原来只写 `subject: { in: subjects }` ⇒ **后者一条都筛不出来** ——
             * 她点「其他」看到空列表，会以为那些条目没了。
             *
             * ⚠️ 为什么不是"改显示"（把 null 显示成"未设学科"）：
             *    她已经在用"其他"这个词理解这些条目了，改显示等于让她重新学一遍。
             *    筛的时候把 null 并进来，与她的理解一致。
             */
            const wantsOther = subjects.includes('other');
            filters.push(
                wantsOther
                    ? { OR: [{ subject: { in: subjects } }, { subject: null }] }
                    : { subject: { in: subjects } },
            );
        }
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
         * 翻页前把筛选条件存一份 —— 下面"同词头共几条"要用**同一套筛选**，
         * 否则会出现"筛了数学，徽章却说这个词有 5 条"（那 5 条里有语文的）。
         */
        const filterBase = [...filters];
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

        /**
         * 【2026-10-19 如如】**同词头共几条** —— 主附积累那行小字要用。
         *
         * 一条 `groupBy` 问完这一页出现的所有词头，**不是**在前端数当前页：
         * 列表是游标翻页的，同词头的条目很可能一半在这一页、一半在下一批 ——
         * 前端数出来的是"本页 2 条"，而她看到的却是"这个词我记过 2 次"，两者不是一回事。
         *
         * ⚠️ 用 `filterBase`（不含游标）⇒ 数字与"当前筛选下能看到的总数"一致。
         * ⚠️ 词头为空的（摘抄、感受）不参与 —— 它们本来就没有"第几次"这件事。
         */
        const headwordKeys = Array.from(
            new Set(page.map((r) => r.headword).filter((k): k is string => !!k)),
        );
        const headwordCounts: Record<string, number> = {};
        if (headwordKeys.length > 0) {
            const grouped = await prisma.insight.groupBy({
                by: ['headword'],
                where: { AND: [...filterBase, { headword: { in: headwordKeys } }] },
                _count: { _all: true },
            });
            for (const g of grouped) {
                if (g.headword) headwordCounts[g.headword] = g._count._all;
            }
        }

        /**
         * 【2026-10-21 空空】每条积累**印过没有** —— 管理页要在没印的编号后面点一个红点。
         *
         * 判据与内阁的"未打印的日积月累"**同源**：这条没被任何一张积累卷收录
         * （`ReviewVolumeItem.insightId` 指向它）。这样"任务卡说有 5 条"和
         * "管理页里点了 5 个红点"永远是同一批。
         *
         * ⚠️ 只问**这一页**的 id（列表是游标翻页的，别为了一个红点扫全库）。
         */
        const pageIds = page.map((r) => r.id);
        const printedIds = new Set<string>();
        if (pageIds.length > 0) {
            const used = await prisma.reviewVolumeItem.findMany({
                where: { insightId: { in: pageIds } },
                select: { insightId: true },
                distinct: ['insightId'],
            });
            for (const u of used) if (u.insightId) printedIds.add(u.insightId);
        }
        const insights = page.map((r) => ({ ...r, printed: printedIds.has(r.id) }));

        return NextResponse.json({ insights, questions, nextCursor, headwordCounts });
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
        /**
         * 【2026-10-19 空空第 3 条】**录入时就能定"入版"**。
         * 只认显式的 `false`（缺省 = 入版，与 schema 默认一致）——
         * 老调用方（错题直送 / AI 送）不传这个字段，行为一个字都不变。
         */
        const photoIncludedInPrint = body.photoIncludedInPrint === false ? false : undefined;
        const src = typeof body.source === 'string' && body.source ? body.source : null;
        const errorItemNo =
            typeof body.errorItemNo === 'string' && body.errorItemNo.trim()
                ? body.errorItemNo.trim().toUpperCase()
                : null;

        /**
         * 【2026-10-13】暂存 / 正式：**只有显式传 'draft' 才当草稿**，
         * 其余一律 `final` —— 老调用方（错题直送、AI 送）不传也不受影响。
         */
        const status = body.status === 'draft' ? 'draft' : 'final';

        /**
         * 【2026-10-19 如如】`headword` 必须**跟着 content 一起写**。
         *
         * 它不是一个独立字段，是"正文第一行归一化后的值" —— 正文一改它就变了。
         * 所以放在 `dataForWrite` 里、由 content 现算，**不给调用方传**：
         * 传得进来就会有不一致（前端拼的 key 与后端规则不一样 ⇒ 同一组裂成两组）。
         */
        const dataForWrite = { gradeSemester, subject, content, source: src, status, headword: headwordOfContent(content) };

        // ★ 题号当钥匙：已有这一题的条目 ⇒ 覆盖（编号不变）。
        // ⚠️ 覆盖时**只动正文和来源**，不动 gradeSemester/subject ——
        //    那两项是日积月累页里她亲自设的，"从错题直送一次"不该把它们洗掉。
        if (errorItemNo) {
            const existing = await prisma.insight.findFirst({
                where: { userId: user.id, errorItemNo },
            });
            if (existing) {
                /**
                 * 【2026-10-19 第 4 条】录入页**扫码链接**进来的题，**绝不许覆盖**已有条目。
                 *
                 * 老行为（AI 送 / 直送）是"一题一条 ⇒ 再送一次就覆盖正文"，那是对的：
                 * 送的是同一道题的新分析。但录入页的语义完全不同 ——
                 * 她只是"把这条新积累链到那道题上"，覆盖会把那道题**原来那条积累的正文整段抹掉**，
                 * 而且是**静默**的（界面上只会显示"已保存"）。
                 * ⇒ 带 `linkQuestion: true` 时，冲突就明确拒绝，让她去那条上改。
                 */
                if (body.linkQuestion === true) {
                    return conflict(`这道题已经有积累了（${existing.code}）。一条积累只能链一道题 —— 去那条上改。`);
                }
                const updated = await prisma.insight.update({
                    where: { id: existing.id },
                    data: { content, source: src, headword: headwordOfContent(content) },
                });
                if (photo !== undefined) await writePhoto(updated.id, photo);
                if (photoIncludedInPrint === false) await setPhotoPrintIncluded(updated.id, false);
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
        if (photo && photoIncludedInPrint === false) await setPhotoPrintIncluded(created.id, false);

        /**
         * 【2026-10-19 空空第 4 条】**扫积累纸建立的那几条"参见"链接**，跟着这一条一起落库。
         *
         * 为什么在保存时才建、而不是扫码那一刻就建：
         *   扫码时这条积累**还不存在**（录入页是"进门就写"，没点保存就没有 id）。
         *   ⇒ 链接先挂在前端 state 上，保存时随 `linkCodes` 一起提交。
         *   ⚠️ 这样也顺带解决了"扫了但最后没保存"—— 没保存就没有链接，不会有孤儿。
         *
         * 只认 `JL…` 编号（不是内部 id）：与 `errorItemNo` 同一条规矩 ——
         * 扫码链路里手里只有纸上的编号，编号当钥匙最稳。
         */
        const linkCodes = Array.isArray(body.linkCodes)
            ? [...new Set(body.linkCodes.filter((c): c is string => typeof c === 'string' && !!c.trim()).map((c) => c.trim().toUpperCase()))].slice(0, 20)
            : [];
        if (linkCodes.length > 0) {
            const targets = await prisma.insight.findMany({
                where: { userId: user.id, code: { in: linkCodes } },
                select: { id: true },
            });
            if (targets.length > 0) {
                await prisma.insightLink.createMany({
                    data: targets.map((t) => ({ fromId: created.id, toId: t.id })),
                });
            }
        }

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
        /**
         * ⚠️⚠️【2026-10-16 真真】**性能修复：这里原来也没写 `select`。**
         *
         * 与错题本列表**同一个病根**（见 `lib/constants/error-item-list-fields.ts` 文件头）：
         * 不写 `select` ⇒ 返回 `ErrorItem` 的全部标量字段，**含 `originalImageUrl`（题图 base64）**。
         *
         * 而这一处的量比错题本还大 —— `INSIGHT_PAGE_SIZE = 50`，
         * 这一页 50 条日积月累关联的题**全部**被查回来：
         *
         * | 实测（真 Prisma + 真 SQLite，50 题 × 每张 400KB 图） | |
         * |---|---|
         * | 响应体 | **26.12 MB** |
         * | 查关联题 | **751 ms**（图全带回来了） |
         * | 序列化 | 346 ms |
         * | 纯传输（NAS 3.6MB/s） | **7.3 秒** |
         *
         * ⚠️ **而页面真正只用「当前选中那一条」的题**（`insights/page.tsx` 里
         *    只有 `questions[current.errorItemNo]` 这一处读它）—— 那一道题才 **0.4 KB**。
         *    右栏渲染的是 `ErrorItemCard`，**它一个图片字段都不用**（组件里没有 `<img>`）。
         *
         * ⇒ 与错题本列表用**同一份字段清单**（`LIST_ITEM_SCALARS`），**同样不带题图**。
         */
        select: {
            ...Object.fromEntries(LIST_ITEM_SCALARS.map((f) => [f, true])),
            notebook: { select: { id: true, displayName: true, subject: true } },
            tags: true,
        } as Prisma.ErrorItemSelect,
    });
    const map: Record<string, unknown> = {};
    for (const r of rows) {
        if (r.source) map[r.source] = { ...r, inTrash: r.deletedAt != null };
    }
    return map;
}
