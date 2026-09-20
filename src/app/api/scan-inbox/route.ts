import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import {
    deleteInboxFiles,
    listInboxFiles,
    markImported,
} from "@/lib/scan-inbox";

const logger = createLogger("api:scan-inbox");

/**
 * 【custom-v29】「扫描收件箱」—— 手机 App（夸克扫描王等）投到 NAS 的试卷照片。
 *
 * 三个动作：
 *   GET    列出目录里的图片（含"是否已导入"标记）；目录没挂载时返回 available=false，
 *          前端据此**整个隐藏入口**，而不是摆一个点了没反应的按钮。
 *   POST   把一批文件标成「已导入」—— 之后不再计入「新照片」，但文件仍在、可重导。
 *   DELETE 真的从 NAS 目录里删掉文件（定期清理用），逐个返回结果，失败的单独列出。
 */
async function currentUser() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

export async function GET() {
    try {
        const user = await currentUser();
        if (!user) return unauthorized("Authentication required");

        const listing = await listInboxFiles();
        return NextResponse.json(listing);
    } catch (err) {
        logger.error({ error: String(err) }, "列出收件箱失败");
        return internalError("Failed to list scan inbox");
    }
}

export async function POST(req: Request) {
    try {
        const user = await currentUser();
        if (!user) return unauthorized("Authentication required");

        const body = await req.json().catch(() => ({}));
        const names = Array.isArray(body?.names) ? body.names : [];
        if (!names.length) return badRequest("Missing field: names");

        const n = await markImported(names);
        logger.info({ count: n }, "收件箱文件标记为已导入");
        return NextResponse.json({ ok: true, imported: n });
    } catch (err) {
        logger.error({ error: String(err) }, "标记已导入失败");
        return internalError("Failed to mark files as imported");
    }
}

export async function DELETE(req: Request) {
    try {
        const user = await currentUser();
        if (!user) return unauthorized("Authentication required");

        const body = await req.json().catch(() => ({}));
        const names = Array.isArray(body?.names) ? body.names : [];
        if (!names.length) return badRequest("Missing field: names");

        const result = await deleteInboxFiles(names);
        logger.info(
            { deleted: result.deleted.length, failed: result.failed.length },
            "清理收件箱文件",
        );
        return NextResponse.json({ ok: true, ...result });
    } catch (err) {
        logger.error({ error: String(err) }, "清理收件箱文件失败");
        return internalError("Failed to delete scan inbox files");
    }
}
