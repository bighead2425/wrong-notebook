import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import {
    VOLUME_KINDS,
    buildVolumeNo,
    nextVolumeSeq,
    parseVolumeNo,
    semesterOf,
    type VolumeKind,
} from "@/lib/volume-code";
import { normalizeBlankLines, VOLUME_VARIANTS } from "@/lib/review-card";
import {
    attachInsightFigures,
    parseVolumeItems,
    resolvePageCount,
    normalizeVolumeTitle,
} from "@/lib/volume-input";
import { codeToSubjectKey, subjectKeyToCode } from "@/lib/question-no";
import { termSearchVariants } from "@/lib/grade-term";
import { pickRandomEmoji } from "@/lib/emoji-mark";

const logger = createLogger("api:review-volumes");

/** 【2026-10-09】列表单次份数：默认给多少、最多给多少（只限单次，不限总量） */
const VOLUME_PAGE_DEFAULT = 50;
const VOLUME_PAGE_MAX = 200;

/**
 * POST /api/review-volumes —— **组建一份卷**（复练卷 RE… / 积累卷 BU…）。
 *
 * ── 为什么要落库（而不仅仅是"打印时现算"）────────────────────────
 * 卷页眉上的二维码内容是 **卷号-页码**。要能扫回这份卷、翻到那一页，
 * 这份卷就必须先**存在**。所以"组卷"是一个真实的写操作，不是预览副作用。
 *
 * ── 快照原则（回应"题删了卷怎么办"）──────────────────────────────
 * 每条卷内条目都把 **题号 / 题干 / 题图 / 等级 / 留白行数** 抄一份存下来。
 * 这份卷是**印出去的凭证**：重新打开时必须和当初印的一样，
 * 不能因为原题后来被改、被删、被合并就跟着变。
 * `errorItemId` 只是"还能点回去看看"的软链接 —— 题删了就置空，
 * 卷本身照常打开（**不会出现空洞、也不会整卷打不开**）。
 *
 * Body: {
 *   kind: "review" | "build",
 *   gradeSemester?: string,
 *   defaultBlankLines?: number,
 *   pageCount?: number,
 *   items: [{
 *     errorItemId?: string | null,
 *     seqInVolume: number, pageIndex: number, columnIndex?: number, seqInColumn?: number,
 *     itemNo?: string | null, questionText?: string | null, figureUrls?: string[] | string | null,
 *     manageType?: string | null, blankLines?: number
 *   }]
 * }
 */
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session) return unauthorized();

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return badRequest("Invalid JSON body");
    }

    const raw = (body ?? {}) as Record<string, unknown>;
    const kind = String(raw.kind ?? "").trim() as VolumeKind;
    if (!VOLUME_KINDS.includes(kind)) {
        return badRequest(`kind must be one of ${VOLUME_KINDS.join(" | ")}`);
    }

    const rawItems = Array.isArray(raw.items) ? raw.items : [];
    if (rawItems.length === 0) return badRequest("items must not be empty");

    const defaultBlankLines = normalizeBlankLines(
        raw.defaultBlankLines as number | null | undefined,
        VOLUME_VARIANTS[kind].defaultBlankLines,
    );

    try {
        /**
         * 当天的下一个序号。查"同类型、最近一批"就够 ——
         * 同一天最多也就几份卷，取最近 200 条足够覆盖（且不会全表扫）。
         */
        const recent = await prisma.reviewVolume.findMany({
            where: { kind },
            orderBy: { createdAt: "desc" },
            take: 200,
            select: { volumeNo: true },
        });
        const now = new Date();
        const seq = nextVolumeSeq(recent.map((r) => r.volumeNo), kind, now);
        const volumeNo = buildVolumeNo(kind, now, seq);

        // 条目规范化 + 总页数都走 lib/volume-input（与"更新组卷"共用同一处，避免两边分叉）
        const items = parseVolumeItems(rawItems, defaultBlankLines);
        // 【积累纸】挂了积累条目的行：图由服务端按 insightId 补进快照（前端手上没有图本体）
        await attachInsightFigures(items, async (insightId) => {
            const row = await prisma.insightPhoto.findUnique({
                where: { insightId },
                select: { data: true },
            });
            return row?.data ?? null;
        });
        const pageCount = resolvePageCount(raw.pageCount, items);

        const created = await prisma.reviewVolume.create({
            data: {
                volumeNo,
                kind,
                semester: semesterOf(now),
                gradeSemester: typeof raw.gradeSemester === "string" ? raw.gradeSemester : null,
                pageCount,
                defaultBlankLines,
                // 名字可选（管理页里还能改）；建卷时一般不给
                title: normalizeVolumeTitle(raw.title),
                /**
                 * 【2026-10-03 需求第 10 条】建卷时就把这份纸的随机 emoji 定下来。
                 * 建卷 = "生成这张纸"的那一刻，此后整卷所有页共用它、重印也不变。
                 */
                emojiMark: pickRandomEmoji(),
                items: { create: items },
            },
            select: {
                id: true,
                volumeNo: true,
                kind: true,
                pageCount: true,
                semester: true,
                title: true,
                emojiMark: true,
            },
        });

        logger.info(
            { volumeNo: created.volumeNo, kind, items: items.length, pageCount: created.pageCount },
            "Review volume created",
        );
        return NextResponse.json({ volume: created }, { status: 201 });
    } catch (error) {
        logger.error({ error, kind }, "Failed to create review volume");
        return internalError();
    }
}

/**
 * GET /api/review-volumes —— 列出已组的卷（"到哪里去找已经打印出来的复练纸"就靠这一支）。
 *
 * 筛选：
 *   `?kind=review|build`
 *   `?semester=2026-秋`        老口径（标签，按学期翻卷）
 *   `?term=五年级上`           【2026-10-09】年级·学期（规范键，如 `五年级上`）
 *   `?subject=math`            【2026-10-09】学科（按卷内题号的 2 字简拼匹配）
 *   `?q=第五单元`               【2026-10-09】关键词（搜卷号 / 名字 / 年级学期）
 *
 * 翻页（【2026-10-09】加的）：
 *   `?limit=`   一次给多少份（默认 50，上限 200）
 *   `?cursor=`  上一批最后一份的 id（原样带回）；返回里的 `nextCursor` 非 null ⇒ 还有更早的
 *
 * ⚠️ **这次改动修掉一个隐患**：原来前端写死 `limit=200` 并且**在拿到的那批里做本地筛选**
 *    ⇒ 卷一旦超过 200 份，第 201 份及更早的**既看不到、也搜不到**（页面上凭空消失）。
 *    现在筛选全部在服务端做、单次只给一页、滚到底再要下一页 ⇒ **总量不再有上限**。
 *    ⚠️ 所以"筛选必须在服务端"是这套翻页的**配套条件**，只加翻页不改筛选等于没修。
 */
export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session) return unauthorized();

    const { searchParams } = new URL(request.url);
    const kindParam = searchParams.get("kind");
    const semester = searchParams.get("semester");
    const term = (searchParams.get("term") || "").trim();
    const subject = (searchParams.get("subject") || "").trim();
    const q = (searchParams.get("q") || "").trim();
    const cursor = searchParams.get("cursor");
    const limitParam = Number(searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(VOLUME_PAGE_MAX, Math.round(limitParam))
        : VOLUME_PAGE_DEFAULT;

    try {
        const filters: Prisma.ReviewVolumeWhereInput[] = [];
        if (kindParam && VOLUME_KINDS.includes(kindParam as VolumeKind)) {
            filters.push({ kind: kindParam });
        }
        if (semester) filters.push({ semester });

        /**
         * 年级·学期：库里那句"年级学期"可能是**跨本组卷**（`六年级上·五年级上`），
         * 也可能用别名写法（`小五上` / `5年级上`）。SQL 只会做字符串包含，
         * 所以把这一学期的**各种写法**都列出来 OR 一遍
         *（口径与客户端那个 `volumeMatchesTerm` 等价 —— 见 `lib/grade-term.ts`）。
         */
        if (term) {
            const variants = termSearchVariants(term);
            if (variants.length) {
                filters.push({ OR: variants.map((v) => ({ gradeSemester: { contains: v } })) });
            }
        }

        /**
         * 学科：卷里只存了**题号**（`SX20260928013`），学科要从题号前缀反推。
         * 这里直接查"卷内**是否存在**一道该学科的题" —— 比前端那种"取前 20 条采样"更准
         *（跨本组卷里两种学科都会命中，正是想要的行为）。
         */
        if (subject) {
            filters.push({ items: { some: { itemNo: { startsWith: subjectKeyToCode(subject) } } } });
        }

        if (q) {
            filters.push({
                OR: [
                    { volumeNo: { contains: q } },
                    { title: { contains: q } },
                    { gradeSemester: { contains: q } },
                ],
            });
        }

        /**
         * 游标 = 上一批最后一份的 id。
         * 排序是 `(createdAt desc, id desc)` —— **必须带 id 这个第二关键字**：
         * 同一毫秒建的两份卷 createdAt 可能相同，只按它排，翻页时那两份的先后是不确定的，
         * 于是"上一批的最后一份"可能在下一批里**再出现一次**（重复）或直接**跳过**。
         */
        if (cursor) {
            const anchor = await prisma.reviewVolume.findUnique({
                where: { id: cursor },
                select: { createdAt: true, id: true },
            });
            if (anchor) {
                filters.push({
                    OR: [
                        { createdAt: { lt: anchor.createdAt } },
                        { AND: [{ createdAt: anchor.createdAt }, { id: { lt: anchor.id } }] },
                    ],
                });
            }
        }

        const rows = await prisma.reviewVolume.findMany({
            where: filters.length ? { AND: filters } : {},
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            // 多要一条来判断"还有没有"
            take: limit + 1,
            select: {
                id: true,
                volumeNo: true,
                title: true,
                kind: true,
                semester: true,
                gradeSemester: true,
                pageCount: true,
                defaultBlankLines: true,
                createdAt: true,
                _count: { select: { items: true } },
                /**
                 * 【2026-09-30】复练卷页要按**学科**筛卷，而卷里只存了题号（如 `SX20260928013`）
                 * ⇒ 取题号前 2 位反推学科。只取题号、限量 20 条：一份卷里学科基本是一致的，
                 * 拿前几条足够定学科，不必把整卷条目读出来。
                 * （【2026-10-09】这只是**显示**用的采样；真正筛选已改到服务端，见上面 subject 那段。）
                 */
                items: { select: { itemNo: true }, orderBy: { seqInVolume: "asc" }, take: 20 },
            },
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];

        // 卷号格式有问题的，在这里就被 parseVolumeNo 挡掉了（不猜、不抛）
        return NextResponse.json({
            volumes: page.map((v) => ({
                ...v,
                /**
                 * 这道卷里有几道**题**。
                 *
                 * ⚠️【2026-10-11】模仿卷要**减 1**：它的卷内条目里有一行是**左栏的主题**
                 * （`columnIndex: 0` / `seqInVolume: 0`，只记题号），那不是"这道卷收的题"。
                 * 不减的话界面上会写成"3 题"而实际只收了 2 道附题 —— 他一眼就会看出来数不对。
                 * 依据是建卷时的不变量：**模仿卷有且只有一行左栏**（见打印预览的 `buildVolumeItems`）。
                 */
                itemCount: Math.max(0, v._count.items - (v.kind === "imitate" ? 1 : 0)),
                /**
                 * 学科：从题号前缀反推（`SX…` → math）。
                 * 一份卷可能跨学科（跨本组卷），所以回的是**去重后的数组**，
                 * 前端"按学科筛"时命中任一即算。
                 */
                subjectKeys: [...new Set((v.items || []).map((it) => codeToSubjectKey(it.itemNo?.slice(0, 2))))],
                parsed: parseVolumeNo(v.volumeNo),
                items: undefined,
                _count: undefined,
            })),
            nextCursor: hasMore && last ? last.id : null,
        });
    } catch (error) {
        logger.error({ error }, "Failed to list review volumes");
        return internalError();
    }
}
