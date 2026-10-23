import fsp from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { randomUUID } from "node:crypto";
import { Readable } from "stream";
import { prisma } from "./prisma";
import { createLogger } from "./logger";
import { tarToNodeStream, type TarEntry } from "./tar-min";

// 路由层要拼条目清单，类型从这里转出去，省得它去认识 tar-min
export type { TarEntry };

const logger = createLogger("db-snapshot");

/**
 * 【2026-10-24 空空】**整库快照**（灾备导出）
 *
 * ── 为什么不接着用 JSON ────────────────────────────────────────────────
 * 老 `GET /api/export` 是**白名单式**的：它逐张表列举要导什么。
 * 库里有 18 张表，它只列了 5 张 —— 日积月累（3 张）、复习卷（2 张）、
 * 复习流水、每日结算、打印与回收（3 张）、状态日志、深挖决定，**一张没导**。
 *
 * 更糟的是这个缺陷**修不完**：以后每加一张表，都得记得同时改导出和导入两处。
 * 漏一次，就是一次"以为备了、其实没备"。而空空的用途是**灾难恢复**
 * （NAS 挂了，从网盘搬回来，接受回到一周前），不是挑着补几道题。
 * 那种用途下，**完整性比可读性重要一个数量级**。
 *
 * ⇒ 改成搬**整个库文件**：`VACUUM INTO` 出一份一致快照。
 *   它自动包含全表、包含未来新增的表、包含所有 base64 图片，
 *   而且没有"图片太大撑爆 50MB"那回事（base64 就躺在库里，不用再序列化一遍）。
 *
 * ── 为什么必须 VACUUM INTO，不能直接 cp ────────────────────────────────
 * 库跑在 WAL 模式下，直接拷主文件会漏掉还在 `-wal` 里没合并进主库的提交，
 * 拷出来的是一份"少了最近改动"的库 —— 灾备最怕这种静默残缺。
 * `VACUUM INTO` 由 SQLite 自己保证快照一致，顺带压掉碎片（34MB → 23MB）。
 */

/** 临时快照文件（用完必须删，否则 NAS 上会攒一堆） */
export interface SnapshotHandle {
    /** 快照文件的绝对路径 */
    filePath: string;
    /** 下载时给用户看的文件名，如 `wn-2026-10-24.db` */
    downloadName: string;
    /** 文件名里的日期段 `YYYY-MM-DD`（恢复说明里要引用） */
    stamp: string;
    size: number;
    /** 删掉临时文件；调用方在流结束后必须调一次 */
    cleanup: () => Promise<void>;
}

/** 从 DATABASE_URL 解析出 SQLite 文件的绝对路径；不是 file: 协议返回 null */
function sqliteFilePath(): string | null {
    const url = process.env.DATABASE_URL || "";
    if (!url.startsWith("file:")) return null;
    const raw = url.slice("file:".length).split("?")[0];
    if (!raw) return null;
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/** `YYYY-MM-DD`（本地时区 —— 文件名是给人看的，别用 UTC 免得跨时区错一天） */
function todayKey(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 生成一份整库快照。
 *
 * 两条路：
 *   ① 首选 `VACUUM INTO`：一致、不阻塞写、顺带压碎片；
 *   ② 兜底 `wal_checkpoint(TRUNCATE)` + 复制文件：万一某些 SQLite 构建
 *      不支持 `VACUUM INTO`，也不能让"灾备"这个功能整个不可用。
 *
 * ⚠️ 兜底的顺序不能反：**必须先 checkpoint 再复制**。
 *    先复制再 checkpoint，等于复制了一份旧库。
 */
export async function createDbSnapshot(): Promise<SnapshotHandle> {
    const dir = process.env.SNAPSHOT_TMP_DIR || os.tmpdir();
    const stamp = todayKey();
    const tmpPath = path.join(dir, `wn-snapshot-${randomUUID()}.db`);

    // 同名残留会让 VACUUM INTO 直接报错（它拒绝覆盖已存在的文件）
    await fsp.rm(tmpPath, { force: true });

    let used: "vacuum" | "copy" = "vacuum";
    try {
        await prisma.$executeRawUnsafe(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } catch (err) {
        logger.warn({ err }, "VACUUM INTO failed, falling back to checkpoint + copy");
        used = "copy";

        const src = sqliteFilePath();
        if (!src) throw err; // 连库文件都定位不到 ⇒ 兜底也无从谈起，把原错误抛上去

        // 把 WAL 里的提交合并回主库，之后复制才是完整的。
        // ⚠️ 用 query 而不是 execute：PRAGMA 会返回一行结果，
        //    走 executeRaw 会因"语句返回了结果"而报错。
        await prisma.$queryRawUnsafe(`PRAGMA wal_checkpoint(TRUNCATE)`);
        await fsp.copyFile(src, tmpPath);
    }

    const stat = await fsp.stat(tmpPath);
    logger.info({ used, size: stat.size, stamp }, "DB snapshot created");

    return {
        filePath: tmpPath,
        downloadName: `wn-${stamp}.db`,
        stamp,
        size: stat.size,
        cleanup: async () => {
            await fsp.rm(tmpPath, { force: true });
        },
    };
}

/** 打包成 `.tar.gz` 的 Node 可读流（边读边压，不把几十 MB 整个塞进内存） */
export function buildBackupArchive(entries: TarEntry[]): Readable {
    return tarToNodeStream(entries).pipe(zlib.createGzip({ level: 6 }));
}

/** 包里的恢复说明（纯文本；文件名用 ASCII，内容中文 —— 将来翻出来看得懂） */
export function restoreReadme(meta: { stamp: string; dbSize: number; itemCount: number }): Buffer {
    const mb = (meta.dbSize / 1024 / 1024).toFixed(1);
    const text = [
        `花生错题本 · 完整备份（${meta.stamp}）`,
        "",
        `数据库快照：wn-${meta.stamp}.db（${mb} MB，${meta.itemCount} 道错题）`,
        "应用配置：app-config.json（AI 密钥、三个转存目录、提示词等）",
        "",
        "── 怎么恢复 ──────────────────────────────────────────────",
        "这是**整库替换**，不是挑着补。恢复后，备份时间点之后的改动都会没有。",
        "",
        "1. 停掉容器；",
        "2. 把 wn-<日期>.db 改名为 dev.db，覆盖 /app/data/dev.db",
        "   （NAS 上对应的宿主机路径见 docker-compose 里 data 目录的挂载）；",
        "3. 把 app-config.json 覆盖 /app/config/app-config.json；",
        "4. 起容器。",
        "",
        "⚠️ 覆盖前先把现有的 dev.db 改名留一份，别直接删。",
        "",
        "── 这份包里为什么没有单独的图片文件 ──────────────────────",
        "题图、日积月累的图片都是**以 data URL 存在数据库里**的（不是外挂文件），",
        "所以跟着 .db 一起搬，不用单独打包。",
        "",
    ].join("\n");
    return Buffer.from(text, "utf8");
}
