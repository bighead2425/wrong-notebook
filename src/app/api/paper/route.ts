import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { badRequest, forbidden, unauthorized } from "@/lib/api-errors";
import { getAppConfig, updateAppConfig } from "@/lib/config";
import { DEFAULT_PAPER_CONFIG, type PaperConfig } from "@/lib/paper";

export const runtime = "nodejs";

/**
 * 【2026-10-24 幅面】四种纸各用多大。
 *
 * 只读，**任何登录用户都能看** —— 打印预览、扫到的卷页、积累纸打印页
 * 都要靠它决定页高；不给权限的话，孩子看到的纸和爸爸印出来的会对不上。
 *
 * 缺项一律补 B5（老配置里没有 `paper` 字段是常态）。
 */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Not authenticated");

    const cfg = getAppConfig().paper;
    const paper: PaperConfig = {
        deepDive: cfg?.deepDive ?? DEFAULT_PAPER_CONFIG.deepDive,
        review: cfg?.review ?? DEFAULT_PAPER_CONFIG.review,
        imitate: cfg?.imitate ?? DEFAULT_PAPER_CONFIG.imitate,
        build: cfg?.build ?? DEFAULT_PAPER_CONFIG.build,
    };

    return NextResponse.json({ paper });
}

/**
 * 改某一种纸的幅面。
 *
 * 用途：打印预览页「第X页装不下」的提示里有一个按钮，点了直接切幅面 ——
 * 不用先跑回设置页改一圈再回来。
 *
 * ⚠️ 只有管理员能改。孩子看得到幅面（GET），但改不了。
 */
export async function PATCH(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Not authenticated");
    if ((session.user as { role?: string }).role !== "admin") {
        return forbidden("只有管理员能改幅面");
    }

    let body: { kind?: unknown; value?: unknown };
    try {
        body = (await req.json()) as typeof body;
    } catch {
        return badRequest("请求格式不对");
    }

    const kind = body.kind;
    const value = body.value;
    // 白名单：kind 必须是四种纸之一，value 必须是 B5/A4。
    // 不做白名单的话，`{kind:"aiProvider", value:...}` 这类请求会写坏配置。
    if (kind !== "deepDive" && kind !== "review" && kind !== "imitate" && kind !== "build") {
        return badRequest("纸型不对");
    }
    if (value !== "B5" && value !== "A4") {
        return badRequest("幅面只能是 B5 或 A4");
    }

    const cfg = getAppConfig();
    const paper: PaperConfig = {
        deepDive: cfg.paper?.deepDive ?? DEFAULT_PAPER_CONFIG.deepDive,
        review: cfg.paper?.review ?? DEFAULT_PAPER_CONFIG.review,
        imitate: cfg.paper?.imitate ?? DEFAULT_PAPER_CONFIG.imitate,
        build: cfg.paper?.build ?? DEFAULT_PAPER_CONFIG.build,
        [kind]: value,
    };
    updateAppConfig({ paper });

    return NextResponse.json({ ok: true, paper });
}
