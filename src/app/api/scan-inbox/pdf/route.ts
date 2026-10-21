import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { convertInboxPdf, deleteInboxPdfs, listInboxPdfs } from "@/lib/scan-inbox";

const logger = createLogger("api:scan-inbox:pdf");

/**
 * 【2026-10-21 如如】PDF 转图片（举一反三从收件箱拉取）
 *
 * 背景：小白试卷宝**只能导出 PDF**，而举一反三整条链路吃图片 ⇒ 在中间加一层转图。
 *
 *   GET  ?dir=scan2pdf          → 列出这个子目录里的 PDF
 *   POST { dir, name, dpi? }    → 把这个 PDF 逐页转成 PNG（落在同一目录，`<名>-pNN.png`）
 *
 * ⚠️ 目录靠 `subPath` 传，与图片那套一致（`scan2wrong` / `scan2recover` / `scan2pdf`）。
 *    这里**不做白名单**：`getInboxLocation` 已经把路径钉死在挂载根以下，
 *    真正要防的是**文件名**（只认 basename + `.pdf`，见 `convertInboxPdf`）。
 * ⚠️ 转图依赖镜像里的 `pdftoppm`（Dockerfile 装 poppler-utils）。
 *    本地 Windows 没有 ⇒ 返回人话错误，不抛 ENOENT。
 */
async function currentUser() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

export async function GET(req: Request) {
    const user = await currentUser();
    if (!user) return unauthorized("Authentication required");

    try {
        /** 不传 dir ⇒ 与图片列表同一个默认目录（scan2wrong）；举一反三那条路会显式传 scan2pdf */
        const dir = new URL(req.url).searchParams.get("dir") || "scan2wrong";
        const res = await listInboxPdfs(dir);
        return NextResponse.json({ ok: true, ...res });
    } catch (error) {
        logger.error({ error }, "list pdf inbox failed");
        return internalError("Failed to list PDFs");
    }
}

export async function POST(req: Request) {
    const user = await currentUser();
    if (!user) return unauthorized("Authentication required");

    try {
        const body = (await req.json().catch(() => ({}))) as {
            dir?: string;
            name?: string;
            dpi?: number;
            action?: "convert" | "delete";
        };
        const dir = body.dir || "scan2wrong";
        const name = (body.name || "").trim();
        if (!name) return badRequest("name is required");

        /**
         * 【2026-10-21 空空】**在收件箱里直接删 PDF** —— 不用再跑去 NAS 上删。
         * 只认 `.pdf`、只认普通文件，路径校验在 `deleteInboxPdfs` 里。
         */
        if (body.action === "delete") {
            const res = await deleteInboxPdfs([name], dir);
            if (res.deleted.length === 0) {
                return NextResponse.json({ ok: false, error: res.failed[0]?.error || "删除失败" });
            }
            return NextResponse.json({ ok: true, deleted: res.deleted });
        }

        const dpi = Number.isFinite(body.dpi) && (body.dpi ?? 0) >= 72 && (body.dpi ?? 0) <= 300
            ? Number(body.dpi)
            : 150;

        const res = await convertInboxPdf(name, dir, dpi);
        if (!res.ok) {
            // 失败也回 200：前端要拿 `error` 原文提示（"没有 pdftoppm"这种话必须透出来）
            return NextResponse.json({ ok: false, error: res.error, pages: [] });
        }
        logger.info({ user: user.id, dir, name, pages: res.pages.length }, "pdf converted to images");
        return NextResponse.json({ ok: true, pages: res.pages });
    } catch (error) {
        logger.error({ error }, "convert pdf failed");
        return internalError("Failed to convert PDF");
    }
}
