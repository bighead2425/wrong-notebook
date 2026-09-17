import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:scan');

/**
 * GET /api/scan?no=SX20260916001
 *
 * 二维码扫描解析（#11 / T8）。二维码内容就是题号本身。
 * **先查主库，主库没有再查回收箱**（H2/#12）——回收箱里的题不该从主检索里消失，
 * 但也不该和主库混淆，所以返回 source 字段，前端据此换界面底色。
 *
 * 返回：{ found: true, source: "main" | "trash", item } 或 { found: false }
 */
export async function GET(req: Request) {
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

        const url = new URL(req.url);
        const raw = (url.searchParams.get("no") || "").trim();

        if (!raw) {
            return badRequest("Missing query parameter: no");
        }

        // 容错：用户可能扫到带前后空格/大小写的题号
        const questionNo = raw.toUpperCase();

        const include = {
            notebook: true,
            tags: true,
        } as const;

        // 1) 主库
        const mainItem = await prisma.errorItem.findFirst({
            where: {
                userId: user.id,
                source: questionNo,
                deletedAt: null,
            },
            include,
        });

        if (mainItem) {
            logger.info({ questionNo, source: "main" }, 'Scan hit in main library');
            return NextResponse.json({ found: true, source: "main", item: mainItem });
        }

        // 2) 回收箱
        const trashItem = await prisma.errorItem.findFirst({
            where: {
                userId: user.id,
                source: questionNo,
                deletedAt: { not: null },
            },
            include,
        });

        if (trashItem) {
            logger.info({ questionNo, source: "trash" }, 'Scan hit in trash');
            return NextResponse.json({ found: true, source: "trash", item: trashItem });
        }

        logger.info({ questionNo }, 'Scan miss');
        return NextResponse.json({ found: false, source: null, item: null });
    } catch (error) {
        logger.error({ error }, 'Error in scan lookup');
        return internalError("Failed to look up question");
    }
}
