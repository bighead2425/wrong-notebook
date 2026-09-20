import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, unauthorized } from "@/lib/api-errors";
import { readInboxFile } from "@/lib/scan-inbox";

/**
 * GET /api/scan-inbox/file?name=xxx.jpg
 *
 * 【custom-v29】把收件箱里的一张照片原样吐给浏览器。
 * 前端拿到 blob 后包装成 File，直接走现成的「收图 → 待处理」流程，
 * 所以下游（编辑器、AI、入库）完全不用知道这张图是从 NAS 来的还是相册选的。
 *
 * 安全：文件名交给 lib 里的 resolveInboxPath 校验，
 * 非图片扩展名、带路径分隔符、隐藏文件一律拒绝，杜绝目录穿越。
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Authentication required");
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return unauthorized("Authentication required");

    const name = new URL(req.url).searchParams.get("name") || "";
    if (!name) return badRequest("Missing query parameter: name");

    const found = await readInboxFile(name);
    if (!found) return notFound("File not found or not a supported image");

    return new NextResponse(new Uint8Array(found.data), {
        status: 200,
        headers: {
            "Content-Type": found.mime,
            "Content-Length": String(found.data.byteLength),
            // 照片随时会被替换，禁掉缓存
            "Cache-Control": "no-store",
        },
    });
}
