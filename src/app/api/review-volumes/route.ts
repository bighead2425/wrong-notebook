import { NextResponse } from "next/server";
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
import { parseVolumeItems, resolvePageCount, normalizeVolumeTitle } from "@/lib/volume-input";

const logger = createLogger("api:review-volumes");

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
                items: { create: items },
            },
            select: { id: true, volumeNo: true, kind: true, pageCount: true, semester: true, title: true },
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
 * GET /api/review-volumes?kind=review&semester=2026-秋&limit=50
 * 列出已组的卷（他问的"到哪里去找已经打印出来的复练纸"就靠这一支）。
 */
export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session) return unauthorized();

    const { searchParams } = new URL(request.url);
    const kindParam = searchParams.get("kind");
    const semester = searchParams.get("semester");
    const limitParam = Number(searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(200, Math.round(limitParam)) : 50;

    try {
        const volumes = await prisma.reviewVolume.findMany({
            where: {
                ...(kindParam && VOLUME_KINDS.includes(kindParam as VolumeKind)
                    ? { kind: kindParam }
                    : {}),
                ...(semester ? { semester } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: limit,
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
            },
        });

        // 卷号格式有问题的，在这里就被 parseVolumeNo 挡掉了（不猜、不抛）
        return NextResponse.json({
            volumes: volumes.map((v) => ({
                ...v,
                itemCount: v._count.items,
                parsed: parseVolumeNo(v.volumeNo),
                _count: undefined,
            })),
        });
    } catch (error) {
        logger.error({ error }, "Failed to list review volumes");
        return internalError();
    }
}
