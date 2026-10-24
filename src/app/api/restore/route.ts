import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-utils";
import { forbidden, unauthorized } from "@/lib/api-errors";
import { readRestoreState } from "@/lib/restore";

export const runtime = "nodejs";

/**
 * 【2026-10-24 空空】恢复状态
 *
 * 界面上只用来回答一句话：**上次恢复到底成没成**。
 * 恢复是"退出进程 → 换库 → 容器重启"，中间那几秒应用是死的，
 * 没有任何地方能记录结果 —— 只有 entrypoint 写的 `last-restore.json` 知道。
 */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Not authenticated");
    if (!requireAdmin(session)) return forbidden("只有管理员能看恢复状态");

    const state = await readRestoreState();
    return NextResponse.json({ ok: true, ...state });
}
