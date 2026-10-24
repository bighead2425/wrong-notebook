import { NextRequest, NextResponse } from "next/server";
import fsp from "fs/promises";
import path from "path";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-utils";
import { badRequest, forbidden, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { incomingDir, stageForRestore, type RestorePlan } from "@/lib/restore";

const logger = createLogger("api:restore:apply");

export const runtime = "nodejs";

/** 用户必须亲手打的确认词。防止手滑点两下就换库 */
const CONFIRM_WORD = "恢复";

/** 响应发完之后给多少毫秒再退出进程 */
const EXIT_DELAY_MS = 3000;

/**
 * 【2026-10-24 空空】恢复 · 第二步：**确认之后才动真的**
 *
 * 这一下做完，库文件就被换成包里那份了（下次容器启动时生效）。
 * 所以这里有三道闸：
 *   ① 必须是管理员；
 *   ② 必须打过确认词 —— 不看报告就点"确定"的人，会在这里停一下；
 *   ③ 凭据（token）必须对应一份**校验通过的**暂存，不能凭空造。
 *
 * ⚠️ 为什么是"退出进程"而不是自己换文件：
 *    Prisma 正开着 dev.db，进程里去覆盖它，等于给自己换心脏。
 *    正确做法是让进程退出，交给 `docker-entrypoint.sh` 在**进程起来之前**
 *    换好文件，再由 `restart: always` 把容器拉起来。见 `lib/restore.ts` 顶部。
 */
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Not authenticated");
    if (!requireAdmin(session)) return forbidden("只有管理员能恢复备份");

    let body: { token?: unknown; confirm?: unknown; withConfig?: unknown };
    try {
        body = (await req.json()) as typeof body;
    } catch {
        return badRequest("请求格式不对");
    }

    const token = typeof body.token === "string" ? body.token : "";
    const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";
    const withConfig = body.withConfig === true;

    if (confirm !== CONFIRM_WORD) {
        return badRequest(`请在确认框里输入「${CONFIRM_WORD}」两个字，确认你知道这会覆盖现在的全部数据`);
    }

    let plan: RestorePlan;
    try {
        const dir = incomingDir(token);
        plan = JSON.parse(await fsp.readFile(path.join(dir, "plan.json"), "utf8")) as RestorePlan;
    } catch {
        return badRequest("这份备份的校验结果已经失效（可能服务重启过），请重新上传一次备份包");
    }

    try {
        await stageForRestore({ token, withConfig, plan });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, token }, "Restore staging failed");
        return internalError(`暂存失败：${msg}`);
    }

    logger.warn(
        {
            token,
            stamp: plan.stamp,
            withConfig,
            from: plan.current.errorItems,
            to: plan.backup.errorItems,
        },
        "Restore confirmed — process will exit and entrypoint will swap the DB",
    );

    const res = NextResponse.json({
        ok: true,
        restarting: true,
        seconds: Math.round(EXIT_DELAY_MS / 1000),
        stamp: plan.stamp,
        backup: plan.backup,
        withConfig,
    });

    // 恢复后 User 表整体换了，当前 session 里的 userId 可能指向不存在的人。
    // 与其让页面半死不活，不如现在就把登录态清掉，让用户重新登录。
    res.cookies.set("next-auth.session-token", "", { path: "/", maxAge: 0 });
    res.cookies.set("__Secure-next-auth.session-token", "", {
        path: "/",
        maxAge: 0,
        secure: true,
    });

    // 响应要发出去之后再退出。`unref` 不能加：加了进程可能不等它就结束，
    // 反而变成"库已经换好、响应却没回"。
    setTimeout(() => {
        logger.warn("Exiting for restore; entrypoint will swap DB on next boot");
        process.exit(0);
    }, EXIT_DELAY_MS);

    return res;
}
