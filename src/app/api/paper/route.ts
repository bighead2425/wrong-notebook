import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { unauthorized } from "@/lib/api-errors";
import { getAppConfig } from "@/lib/config";
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
