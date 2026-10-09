import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, notFound, unauthorized } from "@/lib/api-errors";
import { readInboxFile, readInboxThumb } from "@/lib/scan-inbox";

/**
 * GET /api/scan-inbox/file?name=xxx.jpg&dir=scan2recover&v=1728451234567[&thumb=1]
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

    const params = new URL(req.url).searchParams;
    const name = params.get("name") || "";
    if (!name) return badRequest("Missing query parameter: name");
    /** 【2026-10-05】`dir` = 读哪个收件箱（子目录）；不传 = 默认那个（录错题用的） */
    const dir = params.get("dir");
    /**
     * 【2026-10-09】`v` = 版本号（= 文件修改时间，由 `lib/scan-inbox-url.ts` 统一拼上）。
     *
     * ⚠️ 服务端**不校验**它的值，只把它当"客户端声明了这是哪一版"。
     *    它在不在，决定下面给不给长缓存 —— 这是本次改动的全部要害，见下。
     */
    const version = params.get("v");
    /**
     * 【2026-10-09】`thumb=1` ⇒ 取**缩略图**（`<收件箱>/.thumbs/<名字>.thumb.jpg`）。
     *
     * 为什么不另开一个路由：读文件这件事（只认普通文件 + realpath 父目录校验 +
     * 缓存策略）两边**一模一样**，分成两个路由就等于把那套闸写两遍 —— 迟早走偏。
     * 想取缩略图时，目标目录换成 `.thumbs` 而已（见 `readInboxThumb`）。
     *
     * ⚠️ 缩略图**不在**就直接 404，前端退回原图。这是正常路径（第一次打开必然没有），
     *    不是错误 —— 所以不加任何日志噪音。
     */
    const wantThumb = params.get("thumb") === "1";

    const found = wantThumb
        ? await readInboxThumb(name, dir)
        : await readInboxFile(name, dir);
    if (!found) return notFound("File not found or not a supported image");

    /**
     * 【2026-10-09 性能】缓存策略 —— 这一行就是"收件箱打开慢"的主修。
     *
     * ── 原来错在哪 ────────────────────────────────────────────────────
     * 原先一律 `no-store`（理由写的是"照片随时会被替换"）。但收件箱里的照片
     * **名字带时间戳、内容不会变**，唯一那种"替换"是手机 App 删了又传一个**同名**的
     * ——而那正是**版本号**要解决的问题，不该拿"禁止缓存"来兜。
     * 代价是：网格里每一张小格子都在下载**整张原图**（3~5MB × 30 张 ≈ 上百 MB），
     * 而且每次进页面、来回切页**全部重下**。他说"局域网也不快"，就是这个原因。
     *
     * ── 现在怎么定 ────────────────────────────────────────────────────
     *   · **带了 `v`** ⇒ 允许**长期缓存**：地址里已经含"哪一版"，内容不会再变，
     *     浏览器直接用手上那份，一次都不用问服务端。照片是私密内容，
     *     所以加 `private`（只允许**这个浏览器**存，中间代理 / CDN 不许存）。
     *   · **没带 `v`** ⇒ 退回 `no-store`：没有版本号时"名字"就是唯一缓存键，
     *     同名替换会拿到旧图。宁可慢，也不能给错图。
     *   · 不用 `immutable`：`max-age` 已经够（一年内不会来问），
     *     而 `immutable` 会让"刷新页面"也绕过缓存，更容易让人以为改坏了。
     */
    const cacheControl = version ? "private, max-age=31536000" : "no-store";

    return new NextResponse(new Uint8Array(found.data), {
        status: 200,
        headers: {
            "Content-Type": found.mime,
            "Content-Length": String(found.data.byteLength),
            "Cache-Control": cacheControl,
        },
    });
}
