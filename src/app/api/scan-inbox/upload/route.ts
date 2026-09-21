import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { MAX_UPLOAD_BYTES, saveInboxImage } from "@/lib/scan-inbox";

const logger = createLogger("api:scan-inbox:upload");

/**
 * POST /api/scan-inbox/upload   （multipart/form-data，字段名 file）
 *
 * 【custom-v31】把错题本**自己拍**的照片反向存进收件箱。
 *
 * 场景：手机拍摄能力强、电脑加工能力强，这两件事不该捆在一步里做完。
 * 连拍拍完直接转存到 NAS，点「完成」就能收工；回头在电脑上打开
 * 「收件箱」再导入，走的还是同一条流水线（待处理 → 加工 → 送 AI → 录入）。
 *
 * 这是全项目**唯一一个把调用方给的字节写进 NAS 目录**的接口，所以：
 *   · 必须登录（收件箱是挂载进来的宿主机目录，不能对外开着）
 *   · 文件名由服务端生成，客户端传什么都不用
 *   · 文件头必须是真图片（JPG / PNG / WebP），扩展名跟着文件头走
 *   · 单张上限 MAX_UPLOAD_BYTES
 *   · 目标目录 realpath 后必须仍在挂载根之下（防子目录被做成软链接）
 *
 * 一次只收一张：逐张上传才能给出"正在转存 i/n"的进度，
 * 也能让"这一张失败了"这件事落到具体某张图上（失败的会退回待处理队列，绝不丢）。
 */
export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return unauthorized("Authentication required");
        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!user) return unauthorized("Authentication required");

        // 先看声明的大小：`formData()` 会把整个 body 读进内存，等读完再判就晚了。
        // 前端永远逐张上传，正常几百 KB；这里只拦"明显不对劲"的请求。
        const declared = Number(req.headers.get("content-length") || 0);
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) {
            const mb = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
            return NextResponse.json(
                { ok: false, error: `请求体过大，单张上限 ${mb} MB` },
                { status: 413 },
            );
        }

        const form = await req.formData().catch(() => null);
        const file = form?.get("file");
        // FormData 的值不是 File 就是 string；是字符串说明调用方字段名用错了
        if (!file || typeof file === "string") return badRequest("Missing file field");
        if (file.size === 0) return badRequest("Empty file");
        if (file.size > MAX_UPLOAD_BYTES) {
            const mb = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
            return NextResponse.json(
                { ok: false, error: `图片过大，单张上限 ${mb} MB` },
                { status: 413 },
            );
        }

        const data = Buffer.from(await file.arrayBuffer());
        const result = await saveInboxImage(data);
        if (!result.ok) {
            logger.warn({ error: result.error, bytes: file.size }, "转存照片到收件箱失败");
            return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
        }

        logger.info({ name: result.name, bytes: file.size }, "照片已转存到收件箱");
        return NextResponse.json({ ok: true, name: result.name });
    } catch (err) {
        logger.error({ error: String(err) }, "转存照片到收件箱异常");
        return internalError("Failed to save photo to scan inbox");
    }
}
