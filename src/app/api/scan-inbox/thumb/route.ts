import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { MAX_THUMB_BYTES, saveInboxThumb } from "@/lib/scan-inbox";

const logger = createLogger("api:scan-inbox:thumb");

/**
 * POST /api/scan-inbox/thumb   （multipart/form-data：`file` = 缩略图本体，`name` = 原图文件名）
 *
 * 【2026-10-09】收件箱缩略图的**回传入口**。
 *
 * ── 为什么要有这个接口 ────────────────────────────────────────────────
 * 收件箱列表原先每个小格子都在下载**整张原图**（3~5MB × 30 张 ≈ 上百 MB），
 * 局域网都要等，外网更不用提。有了缩略图（几十 KB），列表就快得多。
 * 而**缩略图由浏览器生成**（打开页面的那台机器顺手用 canvas 缩到 320px 再传回来）——
 * 这样服务端不需要引入 sharp / jimp 这类原生依赖（镜像会变重、CI 会变慢），
 * 代价只是"第一次打开还是慢一次"。
 *
 * ── 这是全项目**第二个**"把调用方给的字节写进 NAS"的接口 ────────────────
 * 所以六道闸必须齐（与 `/api/scan-inbox/upload` 同规格，见 `lib/scan-inbox.ts`
 * 的 `saveInboxThumb` 注释）：
 *   ① 必须登录（下面这两行）；② 文件名**服务端生成**：客户端只传"这是哪张原图的名字"，
 *   服务端校验它确实是收件箱里已存在的普通图片文件，再自己拼出 `<原名>.thumb.jpg`；
 *   ③ 只看文件头是不是真图片；④ 先看 Content-Length 再解析 + 单张上限；
 *   ⑤ 目标目录 realpath 必须在挂载根之下；⑥ tmp + rename 原子写。
 *
 * ── 失败无所谓，不要打扰用户 ────────────────────────────────────────
 * 缩略图是**锦上添花**：传不上去，前端照样用原图，功能一点不缺。
 * 所以这里返回 200 `{ok:false}` 而不是 5xx，日志也只记 warn。
 */
export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return unauthorized("Authentication required");
        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!user) return unauthorized("Authentication required");

        // 先看声明的大小：`formData()` 会把 body 整个读进内存，等读完再判就晚了
        const declared = Number(req.headers.get("content-length") || 0);
        if (Number.isFinite(declared) && declared > MAX_THUMB_BYTES + 64 * 1024) {
            return NextResponse.json(
                { ok: false, error: `请求体过大，缩略图上限 ${Math.round(MAX_THUMB_BYTES / 1024)} KB` },
                { status: 413 },
            );
        }

        const form = await req.formData().catch(() => null);
        const file = form?.get("file");
        const name = form?.get("name");
        if (!file || typeof file === "string") return badRequest("Missing file field");
        if (typeof name !== "string" || !name) return badRequest("Missing name field");
        if (file.size === 0) return badRequest("Empty file");
        if (file.size > MAX_THUMB_BYTES) {
            return NextResponse.json(
                { ok: false, error: `缩略图超过 ${Math.round(MAX_THUMB_BYTES / 1024)} KB，已拒绝` },
                { status: 413 },
            );
        }

        /** 【2026-10-05】`?dir=` = 写进哪个收件箱（子目录）；不传 = 默认那个（录错题用的） */
        const dir = new URL(req.url).searchParams.get("dir");
        const data = Buffer.from(await file.arrayBuffer());
        const result = await saveInboxThumb(data, name, dir);
        if (!result.ok) {
            // 缩略图失败不是用户的错、也不影响使用 ⇒ 记一笔就够，别弹给他
            logger.warn({ error: result.error, name, bytes: file.size }, "缩略图回传被拒");
            return NextResponse.json({ ok: false, error: result.error });
        }
        return NextResponse.json({ ok: true, name: result.name });
    } catch (err) {
        logger.error({ error: String(err) }, "缩略图回传异常");
        return internalError("Failed to save thumbnail");
    }
}
