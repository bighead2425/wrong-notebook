import fsp from "fs/promises";
import path from "path";
import zlib from "zlib";
import { Readable } from "stream";
import { PrismaClient } from "@prisma/client";
import { resolveDbFilePath } from "./db-snapshot";
import { extractTarStream, TarEmptyError, TarError } from "./tar-min";
import {
    SUMMARY_TABLES,
    pickMainDb,
    stampOfName,
    type ContentSummary,
    type RestorePlan,
    type TableCount,
} from "./restore-types";
import { createLogger } from "./logger";

export type { ContentSummary, RestorePlan, TableCount } from "./restore-types";

const logger = createLogger("restore");

/**
 * 【2026-10-24 空空】**恢复（把备份拉回来）**
 *
 * ── 为什么不是"把数据一条条写回去" ────────────────────────────────────
 * 库里 19 张表，彼此有外键。逐表 DELETE + INSERT 要处理删除顺序、外键延迟、
 * 自增序列、schema 漂移 —— 每一处都能写出"恢复了一半"的中间态。
 * 而**整库换文件**是 SQLite 官方推荐的恢复方式，没有中间态：
 * 要么换成功，要么原来的还在。
 *
 * ── 但应用自己换不掉自己的库 ──────────────────────────────────────────
 * Prisma 一直开着 `dev.db`，进程里覆盖这个文件 = 覆盖一个正被使用的文件，
 * 当前进程必然读到半截数据。所以恢复**必须发生在进程之外**：
 *
 *   ① 应用：校验包 → 写到 `data/.restore/pending.db` → 自己退出；
 *   ② 容器：`restart: always` 把容器拉起来；
 *   ③ entrypoint：起进程**之前**把 pending.db 换上去（连同删掉 -wal/-shm），
 *      旧库挪成 `before-restore.db` 留后悔药；
 *   ④ 进程起来了，Prisma 打开的就是新库。
 *
 * 也就是说：`docker-entrypoint.sh` 里那段 shell 才是真正干活的地方，
 * 这里（TypeScript）负责的是"把危险挡在门外" —— 包坏了、版本不对、
 * 用户看错了，都要在**退出之前**拦住。
 *
 * ── 为什么一定要两段式 ────────────────────────────────────────────────
 * 恢复是**不可逆的整库替换**。上传完直接把 pending 写上去，
 * 等于让人在没看清后果的情况下按下按钮。所以：
 *   · 上传 ⇒ 只解包 + 校验 + 出一份"会变成什么样"的报告，**什么都不动**；
 *   · 确认 ⇒ 才写 pending、才退出重启。
 */

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

/** 恢复工作目录：**必须和库文件同盘**，同盘 mv 才是原子操作 */
export function restoreRoot(): string {
    const db = resolveDbFilePath();
    const base = db ? path.dirname(db) : process.env.DATA_DIR || "/app/data";
    return path.join(base, ".restore");
}

/**
 * 一次上传的暂存目录。
 *
 * ⚠️ token 来自客户端，**必须校验形状**，否则 `../../` 就能写到别处去。
 *    只认 UUID：36 位、十六进制加连字符。
 */
export function incomingDir(token: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)) {
        throw new Error("恢复凭据格式不对");
    }
    return path.join(restoreRoot(), "incoming", token);
}

/** entrypoint 认这一个文件：它存在 = 下次启动前先换库 */
export function pendingDbPath(): string {
    return path.join(restoreRoot(), "pending.db");
}

export function pendingMetaPath(): string {
    return path.join(restoreRoot(), "pending.meta.json");
}

/* ------------------------------------------------------------------ */
/* 解包                                                                */
/* ------------------------------------------------------------------ */

/** 用户给的包有问题（能读但不是我们要的东西）⇒ 路由层回 400，不是 500 */
export class RestoreInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RestoreInputError";
    }
}

/** 解压后的单个文件上限 */
const MAX_FILE_BYTES = 600 * 1024 * 1024;
/** 解压后的总量上限 */
const MAX_TOTAL_BYTES = 800 * 1024 * 1024;

export interface ExtractedArchive {
    /** 主库落盘路径（在 dir 里） */
    dbPath: string;
    /** 包内的库文件名，用来取日期 */
    dbName: string;
    /** 有没有带配置文件 */
    hasConfig: boolean;
    /** 包内带的配置文件名（`app-config.json`、`scan-inbox-state.json` …） */
    configFiles: string[];
}

/** 配置文件的个数上限：正常就两三个，多了说明不是我们的包 */
const MAX_CONFIG_FILES = 20;

/**
 * 把一个 `.tar.gz` 解出「主库 + 配置」。
 *
 * **上传**和**从 NAS 备份目录选**两条路都走这里 —— 白名单、上限、
 * 主库挑选规则只有这一份。分成两处写，迟早改了一处漏一处，
 * 而漏的那一处就是"以为校验过、其实没校验"。
 *
 * 原始 gzip 流进，边解边写盘（NAS 内存小，不能整包读进内存）。
 */
export async function extractArchive(input: Readable, dir: string): Promise<ExtractedArchive> {
    await fsp.mkdir(dir, { recursive: true });

    const dbCandidates: { name: string; path: string }[] = [];
    const configNames: string[] = [];
    const configDir = path.join(dir, "config");
    let dbCount = 0;

    const destFor = (rawName: string): string | null => {
        // 包内名字不可信：先取最后一段，杜绝 ../ 和绝对路径
        const name = path.basename(rawName);

        if (name.endsWith(".db")) {
            dbCount += 1;
            const p = path.join(dir, `cand-${dbCount}.db`);
            dbCandidates.push({ name, path: p });
            return p;
        }

        // 【2026-10-24 补】不只是 app-config.json：config 目录下所有 .json 都要
        // （scan-inbox-state.json 是收件箱台账，漏了会导致恢复后照片重复导入）
        if (name.endsWith(".json") && /^[A-Za-z0-9._-]+\.json$/.test(name)) {
            if (configNames.includes(name)) return null; // 同名只留第一份
            if (configNames.length >= MAX_CONFIG_FILES) return null;
            configNames.push(name);
            return path.join(configDir, name);
        }

        return null;
    };

    const gz = zlib.createGunzip();
    input.on("error", (e) => gz.destroy(e));
    input.pipe(gz);

    try {
        await extractTarStream(gz as unknown as AsyncIterable<Buffer>, {
            destFor,
            maxFileSize: MAX_FILE_BYTES,
            maxTotalSize: MAX_TOTAL_BYTES,
        });
    } catch (err) {
        // 包是好的 tar，但里面一个能收的文件都没有 ⇒ 传错包了，不是包坏了。
        // 这两句话给用户的指引完全不同（"重新传一个" vs "这个包坏了"）。
        if (err instanceof TarEmptyError) {
            throw new RestoreInputError(
                "这个包里没有能用的东西 —— 看起来不是本软件的备份包。" +
                    "请确认传的是「下载完整备份」得到的那个 .tar.gz 原包，不是解开后的文件。",
            );
        }
        throw err;
    }

    // 两种包的库文件名不同：应用内导出是 wn-日期.db，宿主机每周备份是 dev.db
    const mainName = pickMainDb(dbCandidates.map((c) => c.name));
    const pick = mainName ? dbCandidates.find((c) => c.name === mainName) ?? null : null;

    if (!pick) {
        throw new RestoreInputError(
            dbCandidates.length === 0
                ? "包里没找到数据库文件。请确认传的是完整备份的 .tar.gz 原包，别解开后再传。"
                : `包里有好几个 .db（${dbCandidates.map((c) => c.name).join("、")}），分不清哪个是主库。`,
        );
    }

    // 【2026-10-24 修】解包时为了避免"多个 .db 互相覆盖"，每个候选都写成 cand-N.db；
    // 挑完之后必须**统一改名成 restore.db** —— `stageForRestore` 认的就是这个名字。
    // 早先漏了这一步，现象是点「开始恢复」报
    //   ENOENT: ... incoming/<token>/restore.db
    const finalPath = path.join(dir, "restore.db");
    if (pick.path !== finalPath) {
        await fsp.rename(pick.path, finalPath);
    }

    return {
        dbPath: finalPath,
        dbName: pick.name,
        hasConfig: configNames.length > 0,
        configFiles: configNames,
    };
}

/* ------------------------------------------------------------------ */
/* 错误归类                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把"解包阶段的异常"翻译成给用户看的话。
 *
 * 两条来源（上传 / NAS 选文件）共用它，免得一处回 400、另一处回 500 —— 
 * 同一个坏包在两个入口得到两种反应，用户会以为是两个不同的毛病。
 */
export function classifyArchiveError(err: unknown): { code: 400 | 500; message: string } {
    if (err instanceof TarError) {
        return { code: 400, message: `这个包读不了：${err.message}` };
    }
    if (err instanceof RestoreInputError) {
        return { code: 400, message: err.message };
    }

    const msg = err instanceof Error ? err.message : String(err);

    if (/超过 \d+MB 上限/.test(msg)) return { code: 400, message: msg };

    // gzip 头不对 = 不是 .tar.gz（传错文件，或者传了一半）
    if (/incorrect header check|invalid distance|unexpected end of file/i.test(msg)) {
        return { code: 400, message: "这个文件不是有效的 .tar.gz 压缩包（可能传错了文件，或者没传完）" };
    }

    return { code: 500, message: `校验备份包失败：${msg}` };
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export interface DbProbe {
    size: number;
    /** `PRAGMA integrity_check` 的原文，正常就是 "ok" */
    integrity: string;
    tables: TableCount[];
}

/** 把库里的 count 结果统一成 number（Prisma 对 SQLite 整数可能给 bigint） */
function toNumber(v: unknown): number {
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "number") return v;
    return Number(v ?? 0);
}

/** 表名进 SQL 前用双引号包住，内部双引号翻倍（SQLite 的转义规则） */
function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 打开一个**任意**的 .db 文件验一遍，不碰当前库。
 *
 * 用独立的 PrismaClient 连它是安全的：`$queryRawUnsafe` 是直通 SQL，
 * 不校验 schema，所以哪怕是几个版本前的旧库也能数出行数。
 */
export async function probeDb(dbPath: string): Promise<DbProbe> {
    const st = await fsp.stat(dbPath);
    if (st.size === 0) throw new RestoreInputError("包里的库文件是空的（0 字节）");

    const probe = new PrismaClient({
        datasources: { db: { url: `file:${dbPath}` } },
        log: [],
    });

    try {
        const ic = (await probe.$queryRawUnsafe("PRAGMA integrity_check")) as Array<
            Record<string, unknown>
        >;
        // 不写死列名：正常返回的是 `integrity_check` 这一列，但驱动版本变了
        // 列名就可能不同。取第一个值更稳 —— 这是"能不能恢复"的第一道门，
        // 不能因为一个列名对不上就把所有包都判成坏的。
        const firstRow = ic?.[0];
        const integrity = firstRow ? String(Object.values(firstRow)[0] ?? "") : "";
        if (integrity !== "ok") {
            throw new RestoreInputError(
                `库文件自检没通过（${integrity || "无返回"}），这个包不能用`,
            );
        }

        const raw = (await probe.$queryRawUnsafe(
            "SELECT name FROM sqlite_master WHERE type='table' " +
                "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name",
        )) as Array<{ name: string }>;

        const tables: TableCount[] = [];
        for (const { name } of raw) {
            const c = (await probe.$queryRawUnsafe(
                `SELECT count(*) AS n FROM ${quoteIdent(name)}`,
            )) as Array<Record<string, unknown>>;
            tables.push({ name, rows: toNumber(c?.[0]?.n) });
        }

        if (tables.length === 0) throw new RestoreInputError("包里的库一张表都没有，不像本软件的备份");

        return { size: st.size, integrity, tables };
    } finally {
        await probe.$disconnect().catch(() => undefined);
    }
}

/** 当前在跑的库有哪些表 */
export async function currentTables(): Promise<TableCount[]> {
    const { prisma } = await import("./prisma");
    const raw = (await prisma.$queryRawUnsafe(
        "SELECT name FROM sqlite_master WHERE type='table' " +
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name",
    )) as Array<{ name: string }>;

    const out: TableCount[] = [];
    for (const { name } of raw) {
        const c = (await prisma.$queryRawUnsafe(
            `SELECT count(*) AS n FROM ${quoteIdent(name)}`,
        )) as Array<Record<string, unknown>>;
        out.push({ name, rows: toNumber(c?.[0]?.n) });
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

/** 只看这几个数：它们才是"我这些天的心血"（字段与表名的对应在 restore-types 里） */
function summarize(tables: TableCount[]): ContentSummary {
    const byName = new Map(tables.map((t) => [t.name, t.rows]));
    const out = {} as ContentSummary;
    for (const [key, table] of Object.entries(SUMMARY_TABLES) as [keyof ContentSummary, string][]) {
        out[key] = byName.get(table) ?? 0;
    }
    return out;
}

/**
 * 出一份"按下去会变成什么样"的报告。
 *
 * 这里**绝不改任何东西**，只读。
 */
export async function buildPlan(
    token: string,
    stagedDbPath: string,
    dbFileName: string,
    hasConfig: boolean,
): Promise<RestorePlan> {
    const probe = await probeDb(stagedDbPath);
    const now = await currentTables();

    const backup = summarize(probe.tables);
    const current = summarize(now);

    const backupNames = new Set(probe.tables.map((t) => t.name));
    const currentNames = new Set(now.map((t) => t.name));

    // 现在有 / 包里没有 ⇒ 备份来自更早的版本（正常，迁移会补表）
    const missingInBackup = [...currentNames].filter((n) => !backupNames.has(n)).sort();
    // 包里有 / 现在没有 ⇒ 备份来自更新的版本（不支持：migrate 只会往前走）
    const extraInBackup = [...backupNames].filter((n) => !currentNames.has(n)).sort();

    const warnings: string[] = [];

    if (extraInBackup.length > 0) {
        warnings.push(
            `这个包里有当前版本还没有的表（${extraInBackup.join("、")}），` +
                `说明它比现在跑的版本更新。这种情况不做恢复，请先把软件升级上去。`,
        );
    }

    if (missingInBackup.length > 0) {
        warnings.push(
            `这是旧版本的备份（当年还没有 ${missingInBackup.length} 张表：` +
                `${missingInBackup.join("、")}）。恢复时会把表结构自动升级到当前版本，数据保留。`,
        );
    }

    const delta = (label: string, b: number, c: number) => {
        if (b === c) return;
        if (b < c) {
            warnings.push(`${label}：现在是 ${c}，恢复后会变成 ${b}（**会少 ${c - b}**）`);
        } else {
            warnings.push(`${label}：现在是 ${c}，恢复后会变成 ${b}（会多 ${b - c}）`);
        }
    };

    delta("错题", backup.errorItems, current.errorItems);
    delta("日积月累", backup.insights, current.insights);
    delta("复习卷", backup.volumes, current.volumes);
    delta("卷里的题行", backup.volumeItems, current.volumeItems);
    delta("复习流水", backup.reviewEvents, current.reviewEvents);
    delta("标签", backup.tags, current.tags);
    delta("账号", backup.users, current.users);

    if (backup.users < current.users) {
        warnings.push("恢复后多出来的账号会消失，他们登录不上。");
    }

    return {
        token,
        stamp: stampOfName(dbFileName),
        dbSize: probe.size,
        backup,
        current,
        missingInBackup,
        extraInBackup,
        hasConfig,
        warnings,
    };
}

/* ------------------------------------------------------------------ */
/* 暂存与清理                                                          */
/* ------------------------------------------------------------------ */

/** 现在的库有没有 app-config.json（决定"要不要一起恢复配置"这个选项显不显示） */
export async function configExists(): Promise<boolean> {
    try {
        const st = await fsp.stat(path.join(process.cwd(), "config", "app-config.json"));
        return st.isFile() && st.size > 0;
    } catch {
        return false;
    }
}

/** 清掉旧的上传暂存（只留最近一次，别把 NAS 塞满） */
export async function pruneIncoming(keepToken?: string): Promise<void> {
    const root = path.join(restoreRoot(), "incoming");
    let names: string[];
    try {
        names = await fsp.readdir(root);
    } catch {
        return;
    }
    for (const name of names) {
        if (name === keepToken) continue;
        await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * 把校验通过的文件放到 entrypoint 认的位置。
 *
 * ⚠️ 这一步之后就**只差重启**了。所以它必须是 apply（用户确认过）才调。
 */
export async function stageForRestore(opts: {
    token: string;
    withConfig: boolean;
    plan: RestorePlan;
}): Promise<void> {
    const dir = incomingDir(opts.token);
    const srcDb = path.join(dir, "restore.db");
    await fsp.stat(srcDb); // 不存在就往上报，别静默成功

    await fsp.mkdir(restoreRoot(), { recursive: true });

    // 上一次没消耗掉的 pending 先清掉，避免混淆
    await fsp.rm(pendingDbPath(), { force: true });

    // ⚠️ 顺序不能反：**先把配置挪出来，再 rename 库，最后才清目录**。
    //    早先写成 rename → prune → 拷配置，prune 会把还没拷的 config 一起删掉。
    const pendingCfgDir = path.join(restoreRoot(), "pending-config");
    await fsp.rm(pendingCfgDir, { recursive: true, force: true });

    if (opts.withConfig) {
        const srcCfgDir = path.join(dir, "config");
        const names = await fsp
            .readdir(srcCfgDir)
            .then((ns) => ns.filter((n) => n.endsWith(".json")))
            .catch(() => [] as string[]);

        if (names.length === 0) {
            // 用户勾了"恢复设置"但包里没有 ⇒ 不静默，交给上层报错
            throw new RestoreInputError("你选了同时恢复设置，但这个包里没有配置文件");
        }

        await fsp.mkdir(pendingCfgDir, { recursive: true });
        for (const n of names) {
            await fsp.copyFile(path.join(srcCfgDir, n), path.join(pendingCfgDir, n));
        }
    }

    // 同盘 mv：这一步是原子的，不会出现"半个 pending.db"
    await fsp.rename(srcDb, pendingDbPath());

    // 库已经挪走，incoming 里剩下的都是废料
    await pruneIncoming();

    await fsp.writeFile(
        pendingMetaPath(),
        JSON.stringify(
            {
                stagedAt: new Date().toISOString(),
                stamp: opts.plan.stamp,
                withConfig: opts.withConfig,
                backup: opts.plan.backup,
                current: opts.plan.current,
            },
            null,
            2,
        ),
        "utf8",
    );

    logger.warn(
        { stamp: opts.plan.stamp, withConfig: opts.withConfig },
        "Restore staged, container will replace DB on next boot",
    );
}

/** 设置页打开时看一眼：上次恢复成功了没有、失败了怎么办 */
export async function readRestoreState(): Promise<{
    pending: boolean;
    lastRestore: Record<string, unknown> | null;
    beforeRestoreSize: number | null;
}> {
    const pending = await fsp
        .stat(pendingDbPath())
        .then(() => true)
        .catch(() => false);

    let lastRestore: Record<string, unknown> | null = null;
    try {
        lastRestore = JSON.parse(
            await fsp.readFile(path.join(restoreRoot(), "last-restore.json"), "utf8"),
        ) as Record<string, unknown>;
    } catch {
        lastRestore = null;
    }

    const beforeRestoreSize = await fsp
        .stat(path.join(restoreRoot(), "before-restore.db"))
        .then((s) => s.size)
        .catch(() => null);

    return { pending, lastRestore, beforeRestoreSize };
}
