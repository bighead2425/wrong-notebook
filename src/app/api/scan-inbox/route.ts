import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import {
    deleteInboxFiles,
    listInboxFiles,
    setInboxMeta,
} from "@/lib/scan-inbox";

const logger = createLogger("api:scan-inbox");

/**
 * 【custom-v29】「扫描收件箱」—— 手机 App（夸克扫描王等）投到 NAS 的试卷照片。
 *
 * 三个动作：
 *   GET    列出目录里的图片（含"是否已导入"标记）；目录没挂载时返回 available=false，
 *          前端据此**整个隐藏入口**，而不是摆一个点了没反应的按钮。
 *          【custom-v30】带 ?subPath=xxx 时是"试连接"：临时用这个子路径去读，
 *          **不写任何台账**，供设置页在保存前先验证填的名字对不对。
 *   POST   把一批文件标成「已导入」—— 之后不再计入「新照片」，但文件仍在、可重导。
 *   DELETE 真的从 NAS 目录里删掉文件（定期清理用），逐个返回结果，失败的单独列出。
 */
async function currentUser() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

export async function GET(req: Request) {
    try {
        const user = await currentUser();
        if (!user) return unauthorized("Authentication required");

        // 没有 subPath 参数 = 正常列目录；带参数 = 试连接（只读探测，不落盘）
        const probe = new URL(req.url).searchParams.get("subPath");
        const listing = probe === null
            ? await listInboxFiles()
            : await listInboxFiles({ probeSubPath: probe });
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

        /**
         * 两个字段刻意**分开校验**而不是照单全收：
         * 前端把 "0"、null、undefined 混着传进来的情况太多了，这里只认真正的
         * boolean / number，其余一律当"没提这个要求"，免得把已录入的照片误标回"新"。
         */
        const patch: { imported?: boolean; rotation?: number } = {};
        if (typeof body?.imported === "boolean") patch.imported = body.imported;
        if (typeof body?.rotation === "number" && Number.isFinite(body.rotation)) {
            patch.rotation = body.rotation;
        }

        const n = await setInboxMeta(names, patch);
        logger.info({ count: n, ...patch }, "更新收件箱文件属性");
        return NextResponse.json({ ok: true, updated: n });
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
