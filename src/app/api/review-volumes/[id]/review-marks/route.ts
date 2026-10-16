import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { internalError, notFound, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
// ⚠️ 读流水也走 `lib/review-events.ts`（唯一碰那张表的地方）
import { listVolumeReviewMarks } from "@/lib/review-events";

const logger = createLogger('api:review-volumes:review-marks');

/**
 * 【2026-10-16 如如】**这一张卷上**每道题的复习记录 —— 卷页那圈绿/粉与"轮次角标"的数据源。
 *
 * 出处：`docs\18` §4.3（回显规则 / 轮次角标）+ 他 2026-10-02 定的"圆态按卷判断"。
 *
 * 返回 `{ marks: [{ errorItemId, mark, eventId, rounds }] }`：
 *   · `mark`     —— 这道题**在这张卷上**最近一条的结果（`right` / `wrong`）；没录过 ⇒ 不在数组里
 *   · `eventId`  —— 最近那条的 id（长按菜单"删除这一条"要删它）
 *   · `rounds`   —— 这道题在这张卷上录过几条（`>1` ⇒ 圈上画上标）
 *
 * ── 两个刻意的选择 ──────────────────────────────────────────────────
 * ① **一次性返回整卷**（不是"每道题问一次"）：卷页可能几十道题，
 *    慢来自查询次数多（`docs\17`）⇒ 服务端一次查完、在内存里分组。
 * ② **只认 `volumeId = 这张卷` 的流水** —— 别的卷上的记录不参与，
 *    所以"换一张没扫过的卷、哪怕这道题历史上有结果，也照样是灰圈"（他 2026-10-02 的原话）。
 *
 * 📌 与 `[id]/route.ts` 同一条：**这里不做归属校验** —— `ReviewVolume` 表本身没有 `userId`
 *    （那份代码里写着理由）。但**流水是有 `userId` 的** ⇒ 下面按 `user.id` 取，读不到别人的记录。
 */
export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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

        const volume = await prisma.reviewVolume.findUnique({
            where: { id },
            select: { id: true, items: { select: { errorItemId: true } } },
        });

        if (!volume) return notFound("Volume not found");

        const itemIds = volume.items
            .map((r) => r.errorItemId)
            .filter((v): v is string => typeof v === 'string' && v.length > 0);

        const rows = await listVolumeReviewMarks(user.id, id, itemIds);

        return NextResponse.json({
            marks: rows.map((m) => ({
                errorItemId: m.errorItemId,
                mark: m.outcome,
                eventId: m.eventId,
                rounds: m.rounds,
            })),
        });
    } catch (error) {
        logger.error({ error, volumeId: id }, 'Failed to list volume review marks');
        return internalError("Failed to list volume review marks");
    }
}
