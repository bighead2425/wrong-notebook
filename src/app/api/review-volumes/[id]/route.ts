import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { normalizeBlankLines, VOLUME_VARIANTS } from "@/lib/review-card";
import {
    attachInsightFigures,
    parseVolumeItems,
    resolvePageCount,
    normalizeVolumeTitle,
} from "@/lib/volume-input";
import { VOLUME_KINDS, type VolumeKind } from "@/lib/volume-code";
import { ensureVolumeEmojiMark } from "@/lib/emoji-mark-store";

const logger = createLogger("api:review-volumes/[id]");

/**
 * 单份卷：读 / 覆盖保存 / 删除。
 *
 * ── `PATCH` 就是他要的「**更新组卷**」────────────────────────────
 * 场景：卷已经组好（有卷号、有页二维码），他只是在同一个页面里
 * **调了留白或题图大小**，题目一道没增没减。
 * 这时不该换卷号 —— 卷号是"印出去的那张纸"的身份，换了号，
 * 已经印出来/发出去的纸就对不上了。所以：**原地覆盖**条目与页数，卷号与学期保持不动。
 *
 * 什么时候该走 POST（新卷号）：**选题集合变了**（增/减/换题）。
 * 那个判断在客户端（`print-preview` 里比对选题指纹），服务端不猜——
 * 服务端的职责是"按你说的做"，不是"替你决定要不要换号"。
 */

type Ctx = { params: Promise<{ id: string }> };

async function loadVolume(id: string) {
    return prisma.reviewVolume.findUnique({
        where: { id },
        select: {
            id: true,
            volumeNo: true,
            title: true,
            kind: true,
            semester: true,
            gradeSemester: true,
            pageCount: true,
            defaultBlankLines: true,
            emojiMark: true,
            createdAt: true,
            updatedAt: true,
        },
    });
}

/** GET /api/review-volumes/[id] —— 单份卷（含条目快照，供管理页右栏预览） */
export async function GET(_request: Request, ctx: Ctx) {
    const session = await getServerSession(authOptions);
    if (!session) return unauthorized();

    const { id } = await ctx.params;

    try {
        const volume = await prisma.reviewVolume.findUnique({
            where: { id },
            include: {
                items: {
                    orderBy: [{ seqInVolume: "asc" }],
                },
            },
        });
        if (!volume) return notFound("Review volume not found");
        /**
         * 📌 这里**不做归属校验**：`ReviewVolume` 表本身没有 userId
         *    （卷目前是全局的，见 schema）。早先想着"顺手补一道闸"，
         *    结果 tsc 直接报 `Property 'userId' does not exist` ——
         *    这正是"改属性的接口不替调用方做主"的同一类教训：
         *    **先看模型里有没有这个字段，再决定闸怎么设**。
         */
        /**
         * 【2026-10-03 需求第 10 条】旧卷还没 emoji 标识的，**打开这张纸的这一刻**补一个
         * 并写回库里（惰性生成，不做数据回填）。已有值直接原样返回。
         */
        const emojiMark = await ensureVolumeEmojiMark(volume);
        return NextResponse.json({ volume: { ...volume, emojiMark } });
    } catch (error) {
        logger.error({ error, id }, "Failed to read review volume");
        return internalError();
    }
}

/**
 * PATCH /api/review-volumes/[id] —— **覆盖保存**（"更新组卷"）。
 * Body 与 POST 相同（kind 忽略：卷别不允许在这里改，要换卷别就新组一份）。
 */
export async function PATCH(request: Request, ctx: Ctx) {
    const session = await getServerSession(authOptions);
    if (!session) return unauthorized();

    const { id } = await ctx.params;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return badRequest("Invalid JSON body");
    }

    const raw = (body ?? {}) as Record<string, unknown>;
    const rawItems = Array.isArray(raw.items) ? raw.items : [];
    /**
     * 两条路：
     *   · 带 items ⇒ **覆盖整卷**（"更新组卷"）
     *   · 只带 title ⇒ **只改名**（管理页里"改个名"不该逼客户端把整卷条目再传一遍）
     */
    const hasItems = rawItems.length > 0;
    const hasTitle = Object.prototype.hasOwnProperty.call(raw, "title");
    /**
     * 【2026-10-02 第三条路】只改**卷里某一行的标记**（扫码页那颗三态圆）。
     * 刻意不复用"整卷覆盖"：那条路要客户端把整卷条目再传一遍，
     * 而这里只想动一个字段 —— 传整卷既慢、又容易把别处刚改的东西冲掉。
     */
    const markItemId = typeof raw.markItemId === "string" ? raw.markItemId : null;
    if (!hasItems && !hasTitle && !markItemId) return badRequest("items must not be empty");

    try {
        const existing = await loadVolume(id);
        if (!existing) return notFound("Review volume not found");

        if (markItemId) {
            // 只认 'right' / 'wrong'，其余（含显式 null）一律当"撤销标记"
            const markState =
                raw.markState === "right" || raw.markState === "wrong" ? raw.markState : null;
            /**
             * ⚠️ where 里**必须带 volumeId**：卷 id 来自 URL、行 id 来自 body，
             *    不校验的话，"改这一卷的某行"就变成了"改任意一卷的任意行"（越权）。
             */
            const res = await prisma.reviewVolumeItem.updateMany({
                where: { id: markItemId, volumeId: id },
                data: { markState },
            });
            if (res.count === 0) return notFound("Volume item not found");
            return NextResponse.json({ item: { id: markItemId, markState } });
        }

        if (!hasItems) {
            const renamed = await prisma.reviewVolume.update({
                where: { id },
                data: { title: normalizeVolumeTitle(raw.title) },
                select: {
                    id: true,
                    volumeNo: true,
                    title: true,
                    kind: true,
                    pageCount: true,
                    semester: true,
                    emojiMark: true,
                },
            });
            logger.info({ volumeNo: renamed.volumeNo, titled: !!renamed.title }, "Review volume renamed");
            return NextResponse.json({ volume: renamed });
        }

        // 卷别以**库里的**为准（body 里的 kind 不参与），默认留白沿用该卷别
        const kind = existing.kind as VolumeKind;
        const fallbackBlank = VOLUME_KINDS.includes(kind)
            ? VOLUME_VARIANTS[kind].defaultBlankLines
            : existing.defaultBlankLines;
        const defaultBlankLines = normalizeBlankLines(
            raw.defaultBlankLines as number | null | undefined,
            existing.defaultBlankLines || fallbackBlank,
        );

        const items = parseVolumeItems(rawItems, defaultBlankLines);
        // 【积累纸】与建卷同一处补图（共用 `attachInsightFigures`，不写第二份）
        await attachInsightFigures(items, async (insightId) => {
            const row = await prisma.insightPhoto.findUnique({
                where: { insightId },
                select: { data: true },
            });
            return row?.data ?? null;
        });
        const pageCount = resolvePageCount(raw.pageCount, items);

        /**
         * 条目**整批替换**（先清后建）放在一个事务里：
         * 卷是印出去的凭证，最怕"清掉了但没建上"这种半成品状态。
         */
        const updated = await prisma.$transaction(async (tx) => {
            await tx.reviewVolumeItem.deleteMany({ where: { volumeId: id } });
            return tx.reviewVolume.update({
                where: { id },
                data: {
                    pageCount,
                    defaultBlankLines,
                    // 覆盖保存**不动名字**（除非这次显式带了）
                    ...(hasTitle ? { title: normalizeVolumeTitle(raw.title) } : {}),
                    gradeSemester:
                        typeof raw.gradeSemester === "string" ? raw.gradeSemester : existing.gradeSemester,
                    items: { create: items },
                },
                select: {
                    id: true,
                    volumeNo: true,
                    title: true,
                    kind: true,
                    pageCount: true,
                    semester: true,
                    emojiMark: true,
                },
            });
        });

        logger.info(
            { volumeNo: updated.volumeNo, items: items.length, pageCount: updated.pageCount },
            "Review volume overwritten",
        );
        return NextResponse.json({ volume: updated });
    } catch (error) {
        logger.error({ error, id }, "Failed to overwrite review volume");
        return internalError();
    }
}

/** DELETE /api/review-volumes/[id] —— 删整卷（条目靠 onDelete: Cascade 一起走） */
export async function DELETE(_request: Request, ctx: Ctx) {
    const session = await getServerSession(authOptions);
    if (!session) return unauthorized();

    const { id } = await ctx.params;

    try {
        const existing = await loadVolume(id);
        if (!existing) return notFound("Review volume not found");
        await prisma.reviewVolume.delete({ where: { id } });
        logger.info({ volumeNo: existing.volumeNo }, "Review volume deleted");
        return NextResponse.json({ id, volumeNo: existing.volumeNo, deleted: true });
    } catch (error) {
        logger.error({ error, id }, "Failed to delete review volume");
        return internalError();
    }
}
