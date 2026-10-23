import path from "path";
import fsp from "fs/promises";
import { Readable } from "stream";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { forbidden, unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { createDbSnapshot, buildBackupArchive, restoreReadme, type TarEntry } from "@/lib/db-snapshot";

const logger = createLogger("api:export:snapshot");

/** 配置文件名（AI 密钥 / 三个转存目录 / 提示词都在这里，不走数据库） */
const CONFIG_FILE_PATH = path.join(process.cwd(), "config", "app-config.json");

/**
 * 【2026-10-24 空空】**下载完整备份**（整库快照 + 配置）
 *
 * 和老的 `GET /api/export` 的区别：
 *   · 老的：白名单式 JSON，只导 5 张表，**缺日积月累、复习卷、复习流水**；
 *   · 这个：整库快照，**自动全表**，以后加表也不用改代码。
 *
 * ⚠️ **必须 admin**：整库快照 = 全站所有人的数据（含 base64 图片）。
 *    普通用户哪怕只看自己那份，也不能让他下载别人的 —— 而快照是整块的，
 *    拆不出来"只含我自己"的版本。要按用户拆，那是老 JSON 导出干的事。
 */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Not authenticated");
    if ((session.user as { role?: string }).role !== "admin") {
        return forbidden("Admin role required");
    }

    let snapshot: Awaited<ReturnType<typeof createDbSnapshot>> | null = null;
    let cleaned = false;
    const cleanupOnce = async () => {
        if (cleaned || !snapshot) return;
        cleaned = true;
        await snapshot.cleanup().catch(() => undefined);
    };

    try {
        snapshot = await createDbSnapshot();
        const stamp = snapshot.stamp;

        const itemCount = await prisma.errorItem.count();

        const entries: TarEntry[] = [
            {
                name: "README-restore.txt",
                data: restoreReadme({ stamp, dbSize: snapshot.size, itemCount }),
            },
            { name: snapshot.downloadName, path: snapshot.filePath },
        ];

        // 配置文件可能不存在（刚部署、还没改过任何设置）—— 不存在就不放，不是错误
        try {
            await fsp.access(CONFIG_FILE_PATH);
            entries.push({ name: "app-config.json", path: CONFIG_FILE_PATH });
        } catch {
            logger.warn({ CONFIG_FILE_PATH }, "app-config.json not found, skipped");
        }

        const gz = buildBackupArchive(entries);

        // 流一结束（正常传完 / 客户端断开 / 出错）就删临时快照。
        // 三个事件都挂上：只挂 end 的话，用户中途取消下载就会留下一份 23MB 垃圾。
        gz.on("end", cleanupOnce);
        gz.on("close", cleanupOnce);
        gz.on("error", (err) => {
            logger.error({ err }, "backup stream failed");
            void cleanupOnce();
        });

        const body = Readable.toWeb(gz) as unknown as ReadableStream<Uint8Array>;

        logger.info({ itemCount, dbSize: snapshot.size }, "Full backup download started");

        return new Response(body, {
            headers: {
                "Content-Type": "application/gzip",
                "Content-Disposition": `attachment; filename="wn-backup-${stamp}.tar.gz"`,
                // 大文件、内容是现做的 ⇒ 绝不缓存
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        logger.error({ error }, "Failed to build full backup");
        await cleanupOnce();
        return internalError("Failed to build backup");
    }
}
