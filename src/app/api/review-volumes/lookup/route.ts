import { NextResponse } from "next/server";
import { stripExcludedFigures } from "@/lib/insight-photo";
import { resolveFigureRefs } from "@/lib/volume-figure-ref";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parsePageCode, parseVolumeNo } from "@/lib/volume-code";
import { ensureVolumeEmojiMark } from "@/lib/emoji-mark-store";

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
        /**
         * 【2026-10-20 如如】**这个接口要同时吃两种写法**（`custom-v109` 那个"没找到这份卷"的根因）：
         *
         *   · `RE20260930001-02` —— **页二维码**（纸上印的），能定位到第几页
         *   · `RE20260930001`    —— **整卷号**（`/recover` 的「这一趟要回录的」里点的就是它）
         *
         * 原来只认第一种：`parsePageCode` 解析失败就 `badRequest`
         * ⇒ 前端 catch 到，统一显示成"没找到这份卷（纸上的卷号在库里查不到）"。
         * **跟 emoji 无关**（他猜是 emoji 混进了卷号，实际 `Link` 里 emoji 在 span 外面、
         *  `volumeNo` 本身是干净的）—— 真因是"整卷号没带 `-NN` 就被判成非法"。
         *
         * ⇒ 解析失败时再试一次「整卷号」，成功就按**第 1 页**打开。
         */
        const asPage = parsePageCode(code);
        const asVolume = asPage ? null : parseVolumeNo(code);
        if (!asPage && !asVolume) return badRequest("Bad code (expects RE20260930001 or RE20260930001-02)");

        const volumeNo = asPage?.volumeNo ?? asVolume!.volumeNo;
        const pageNo = asPage?.pageNo ?? 1;

        const volume = await prisma.reviewVolume.findUnique({
            where: { volumeNo },
            include: { items: { orderBy: [{ seqInVolume: "asc" }] } },
        });
        if (!volume) return notFound("Review volume not found");

        /**
         * 【2026-10-03 需求第 10 条】扫纸上的页二维码打开卷时，若这份卷还没有 emoji 标识，
         * 就**这一刻**补一个并写回（惰性生成，不做数据回填）。
         */
        const emojiMark = await ensureVolumeEmojiMark(volume);

        // pageNo 直接回给前端用（超出总页数时由前端夹一下，这里不拦 —— 纸可能比库新）
        /**
         * 【2026-10-25】扫码预览这条也要按当前入版开关清图。
         * 漏了它就会出现"打印页没了、扫码页还挂着"—— 事实上就是这样被发现的。
         */
        const items = await resolveFigureRefs(await stripExcludedFigures(volume.items));
        return NextResponse.json({ volume: { ...volume, items, emojiMark }, pageNo });
    } catch (error) {
        logger.error({ error }, "Failed to look up review volume by page code");
        return internalError();
    }
}
