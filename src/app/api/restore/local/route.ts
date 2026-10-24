import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-utils";
import { badRequest, forbidden, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getInboxLocation } from "@/lib/scan-inbox";
import {
    buildPlan,
    classifyArchiveError,
    configExists,
    extractArchive,
    incomingDir,
    pruneIncoming,
} from "@/lib/restore";

const logger = createLogger("api:restore:local");

export const runtime = "nodejs";

/**
 * 【2026-10-24 空空】恢复 · 来源二：**NAS 上的每周自动备份**
 *
 * 宿主机 cron 每周六 03:00 跑 `backup.sh`，把整库快照打进
 * `/vol2/1000/scan-inbox/backup/wn-YYYY-MM-DD.tar.gz`（留 2 份）。
 * 那个目录在容器里就是 `<SCAN_INBOX_ROOT>/backup`（本机 = `/app/inbox/backup`）。
 *
 * ── 为什么要有这条来源 ────────────────────────────────────────────────
 * 灾难里最典型的场景是"软件已经打不开了"，但备份就在 NAS 上。
 * 让人先去电脑上找文件、再上传一遍，是把最后一步也变成风险：
 * 万一他在外面、万一那台电脑上没有那份包。
 *
 * 走这条路的额外好处：**不经过网络、不进内存**，直接从磁盘流式解。
 * 33MB 的包在本机上传反而更慢更容易断。
 */

/** 每周自动备份所在目录（容器内路径） */
function backupDir(): string {
    // 复用收件箱的根：compose 里 `- /vol2/1000/scan-inbox:/app/inbox`
    // 只读这一个挂载点，不额外开放宿主机路径。
    return path.join(getInboxLocation().root, "backup");
}

interface BackupFile {
    name: string;
    size: number;
    mtime: string;
}

/** 目录里有哪些备份包（按时间倒序，最新的在最前） */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Not authenticated");
    if (!requireAdmin(session)) return forbidden("只有管理员能恢复备份");

    const dir = backupDir();

    let names: string[];
    try {
        names = await fsp.readdir(dir);
    } catch {
        // 目录不存在很正常（还没跑过自动备份 / 没挂载）—— 不是错误
        return NextResponse.json({ ok: true, dir, exists: false, files: [] });
    }

    const files: BackupFile[] = [];
    for (const name of names) {
        if (!/\.(tar\.gz|tgz)$/i.test(name)) continue;
        const st = await fsp.stat(path.join(dir, name)).catch(() => null);
        if (!st?.isFile()) continue;
        files.push({ name, size: st.size, mtime: st.mtime.toISOString() });
    }

    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return NextResponse.json({ ok: true, dir, exists: true, files });
}

/** 选一个包，直接在本机校验（不上传） */
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Not authenticated");
    if (!requireAdmin(session)) return forbidden("只有管理员能恢复备份");

    let body: { name?: unknown };
    try {
        body = (await req.json()) as typeof body;
    } catch {
        return badRequest("请求格式不对");
    }

    const name = typeof body.name === "string" ? body.name : "";

    /**
     * 文件名来自客户端，**当它不可信**：
     *   · `path.basename(name) === name` ⇒ 不许带目录（挡掉 ../ 和绝对路径）
     *   · 必须以 .tar.gz 结尾 ⇒ 不许指到别的文件上去
     * 这两条之外，最后还有一道 realpath 边界检查。
     */
    if (!name || path.basename(name) !== name || name.includes("\0")) {
        return badRequest("文件名不合法");
    }
    if (!/\.(tar\.gz|tgz)$/i.test(name)) {
        return badRequest("只能选 .tar.gz 备份包");
    }

    const dir = backupDir();
    const full = path.join(dir, name);

    // realpath 边界：挡软链接指到目录外面去
    const realFile = await fsp.realpath(full).catch(() => null);
    const realRoot = await fsp.realpath(dir).catch(() => null);
    if (!realFile || !realRoot || !realFile.startsWith(realRoot + path.sep)) {
        return badRequest("这个文件不在备份目录里");
    }

    const token = randomUUID();
    const workDir = incomingDir(token);
    await fsp.mkdir(workDir, { recursive: true });

    try {
        // 直接从磁盘流式解，内存里只有 512 字节的头窗口
        const archive = await extractArchive(fs.createReadStream(realFile), workDir);

        const plan = await buildPlan(token, archive.dbPath, name, archive.hasConfig);

        if (plan.extraInBackup.length > 0) {
            await pruneIncoming();
            return badRequest(
                `这个包来自更新的版本（多出 ${plan.extraInBackup.join("、")}），` +
                    `当前软件版本不认识这些表，不能恢复。请先把软件升级到这个包的版本。`,
            );
        }

        await fsp.writeFile(path.join(workDir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");
        await pruneIncoming(token);

        logger.info(
            { token, source: name, stamp: plan.stamp, items: plan.backup.errorItems },
            "Restore package inspected (local)",
        );

        return NextResponse.json({
            ok: true,
            token,
            plan,
            source: name,
            currentHasConfig: await configExists(),
        });
    } catch (err) {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);

        const { code, message } = classifyArchiveError(err);
        if (code === 400) {
            logger.warn({ reason: message, source: name }, "Local restore rejected");
            return badRequest(message);
        }
        logger.error({ err, source: name }, "Local restore inspect failed");
        return internalError(message);
    }
}
