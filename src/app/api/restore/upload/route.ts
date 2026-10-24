import { NextRequest, NextResponse } from "next/server";
import { Readable, Transform } from "stream";
import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-utils";
import { badRequest, forbidden, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import {
    buildPlan,
    classifyArchiveError,
    configExists,
    extractArchive,
    incomingDir,
    pruneIncoming,
} from "@/lib/restore";

const logger = createLogger("api:restore:upload");

export const runtime = "nodejs";

/** 上传的压缩包上限。家里正常备份 20~40MB，200MB 已是很宽的余量 */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/**
 * 【2026-10-24 空空】恢复 · 第一步（来源一：**电脑上选文件上传**）
 *
 * 只验包、只出报告，**什么都不动**。
 *
 * 另一个来源（NAS 上的 `/app/inbox/backup` 目录）走 `/api/restore/local`，
 * 两条路共用 `extractArchive` 和 `buildPlan`，所以"能恢复什么、怎么判"完全一致。
 *
 * ⚠️ 内存：NAS 空闲只有 200MB 左右。**绝不能 `await req.arrayBuffer()`**
 *    或 `formData()` —— 那会把整包读进内存，33MB 的包 + 解压后的 35MB
 *    很容易把进程顶死。这里全程流式：网络 → gunzip → tar 解析 → 落盘。
 */
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Not authenticated");
    if (!requireAdmin(session)) return forbidden("只有管理员能恢复备份");

    if (!req.body) return badRequest("没有收到文件");

    // 客户端把原始文件名带过来：宿主机每周备份的包里，日期只在**包名**上
    // （里面的库叫 dev.db），不传就取不到日期。
    let clientName = "";
    try {
        clientName = decodeURIComponent(req.headers.get("x-backup-filename") || "").trim();
    } catch {
        clientName = req.headers.get("x-backup-filename")?.trim() || "";
    }

    const token = randomUUID();
    const dir = incomingDir(token);
    await fsp.mkdir(dir, { recursive: true });

    /** 统计上传原始字节，防止有人往这里灌 10GB */
    let received = 0;
    const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            received += chunk.length;
            if (received > MAX_ARCHIVE_BYTES) {
                cb(new Error(`上传超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB 上限`));
                return;
            }
            cb(null, chunk);
        },
    });

    try {
        const webStream = req.body as unknown as Parameters<typeof Readable.fromWeb>[0];
        const source = Readable.fromWeb(webStream);

        const archive = await extractArchive(source.pipe(meter), dir);

        // 日期优先从包名取，取不到再退回包内库名
        const plan = await buildPlan(
            token,
            archive.dbPath,
            clientName || archive.dbName,
            archive.hasConfig,
        );

        // 有"当前版本还不认识的表" ⇒ 这是更新的版本做的包，不支持（migrate 只往前走）
        if (plan.extraInBackup.length > 0) {
            await pruneIncoming();
            return badRequest(
                `这个包来自更新的版本（多出 ${plan.extraInBackup.join("、")}），` +
                    `当前软件版本不认识这些表，不能恢复。请先把软件升级到这个包的版本。`,
            );
        }

        // 报告留在暂存目录，第二步（apply）直接读，不用重新解包
        await fsp.writeFile(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");

        // 只留这一次上传，清掉之前没确认的
        await pruneIncoming(token);

        logger.info(
            { token, stamp: plan.stamp, bytes: received, items: plan.backup.errorItems },
            "Restore package inspected (upload)",
        );

        return NextResponse.json({
            ok: true,
            token,
            plan,
            currentHasConfig: await configExists(),
        });
    } catch (err) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);

        const { code, message } = classifyArchiveError(err);
        if (code === 400) {
            logger.warn({ reason: message }, "Restore upload rejected");
            return badRequest(message);
        }
        logger.error({ err }, "Restore upload failed");
        return internalError(message);
    }
}
