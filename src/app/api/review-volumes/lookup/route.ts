import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parsePageCode } from "@/lib/volume-code";

const logger = createLogger('api:review-volumes:lookup');

/**
 * 【2026-10-01 扫码用】`GET /api/review-volumes/lookup?code=RE20260930001-02`
 *
 * 纸面上的**页二维码**内容就是「卷号-页码」（见 `lib/volume-code.ts` 的 `buildPageCode`）。
 * 扫到它 ⇒ 按卷号把整卷连同条目取回来，并告诉调用方**扫的是第几页**，
 * 前端据此把版面滚到那一页（他 2026-10-01 的要求）。
 *
 * 与 `/api/review-volumes/[id]` 的区别：那个按**内部 id** 取（前端从列表点进来的场景），
 * 这个按**纸上印着的卷号**取（从纸扫回来的场景）。两条入口各管一段，互不依赖。
 *
 * ⚠️ `ReviewVolume` **没有 userId**（卷目前是全局的，见 schema 里的模型定义），
 *    所以这里只按卷号取 —— 别照抄"按 userId 过滤"的习惯写法，那个字段根本不存在。
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const code = (new URL(req.url).searchParams.get("code") || "").trim();
        const parsed = parsePageCode(code);
        if (!parsed) return badRequest("Bad page code (expects e.g. RE20260930001-02)");

        const volume = await prisma.reviewVolume.findUnique({
            where: { volumeNo: parsed.volumeNo },
            include: { items: { orderBy: [{ seqInVolume: "asc" }] } },
        });
        if (!volume) return notFound("Review volume not found");

        // pageNo 直接回给前端用（超出总页数时由前端夹一下，这里不拦 —— 纸可能比库新）
        return NextResponse.json({ volume, pageNo: parsed.pageNo });
    } catch (error) {
        logger.error({ error }, "Failed to look up review volume by page code");
        return internalError();
    }
}
