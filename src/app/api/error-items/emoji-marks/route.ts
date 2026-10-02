import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { ensureErrorItemEmojiMarks } from "@/lib/emoji-mark-store";

const logger = createLogger('api:error-items:emoji-marks');

/**
 * POST /api/error-items/emoji-marks
 *
 * 【2026-10-03 需求第 10 条】**取这几道题的深挖纸 emoji 标识**。
 *
 * 深挖纸是"一题一张纸"，符号是**这道题这张纸**的属性（存在 `ErrorItem.emojiMark`）。
 * 老数据这一列是 NULL ⇒ 这里**惰性生成**一个并写回，再返回；已有值直接返回。
 * 于是重新打印同一道题的深挖纸，符号不变。
 *
 * ⚠️ 为什么不在 `/api/error-items/list` 里顺手补：列表接口在错题本/扫码等很多屏都用，
 *    打开列表就写库太重、也不该发生。只有"要打深挖纸了"这一刻才来问这个接口。
 *
 * Body: { ids: string[] }
 * 返回: { emojiMarks: { [itemId]: "😀" } }
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        const body = await req.json();
        const ids = body?.ids;
        if (!Array.isArray(ids) || ids.length === 0) {
            return badRequest("ids must be a non-empty array");
        }

        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const emojiMarks = await ensureErrorItemEmojiMarks(
            user.id,
            ids.map((id: unknown) => String(id)),
        );

        return NextResponse.json({ emojiMarks });
    } catch (error) {
        logger.error({ error }, 'Error assigning emoji marks');
        return internalError("Failed to assign emoji marks");
    }
}
