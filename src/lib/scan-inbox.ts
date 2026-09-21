import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getAppConfig } from "./config";
import { createLogger } from "./logger";

/**
 * 【custom-v29/v30 · 蓝图：外部扫描件投递隧道】「扫描收件箱」
 *
 * 场景：手机上用夸克扫描王拍下的试卷/作业，通过夸克的「分享 → 飞牛」
 * 投进 NAS 上的一个目录。容器把这个目录挂进来之后，错题本就能直接把里面的
 * 照片拉进流水线，**不用再从手机相册里一张张挑**。
 *
 * ── 为什么是「根目录 + 可配置子路径」两层，而不是一个写死的目录 ──────────
 *
 * Docker 挂载是**容器启动那一刻**由内核做好的，运行中的进程没有办法自己"凿"
 * 出一个新的挂载点。所以"在设置页里改路径"**不能替代** compose 里的挂载 ——
 * 门必须在启动时开好。但门的**数量**一旦定死，门后走哪条走廊是可以随时选的：
 *
 *   compose 挂一次： /vol2/1000/scan-inbox  →  /app/inbox   （根，只挂一次）
 *   设置页里选：     scan2wrong / 数学 / 语文 …              （子路径，随便改）
 *
 * 好处：以后换目录**不用改 compose、不用重建容器、不用碰命令行**，
 * 存盘即生效。这就是"开一次门，门后随便挑"。
 *
 * 环境变量：
 *   SCAN_INBOX_ROOT  容器内的**根目录**（compose 的挂载点），默认 /app/inbox
 *   SCAN_INBOX_PATH  【老式，仅保留兼容】直接挂到某个子目录上（如 /app/scan2wrong）。
 *                    检测到它就按"不可配置的单目录"模式工作，设置页里只读显示，
 *                    老 compose 不改也能照常跑。
 *   **根目录不存在时全部函数优雅降级**（available=false / status=no-root），
 *   界面上按钮直接不出现，而不是摆一个点了没反应的按钮。
 */

const logger = createLogger("scan-inbox");

/** 容器内根目录（compose 挂载点）。设置页里换的是根下的子文件夹，不是它 */
const ROOT_ENV = process.env.SCAN_INBOX_ROOT;
/** 老式单目录挂载：只在没配 ROOT 时兜底，保证老 compose 不用改也能跑 */
const LEGACY_PATH_ENV = process.env.SCAN_INBOX_PATH;
/** 新式默认根目录 */
const DEFAULT_ROOT = "/app/inbox";
/** 默认子文件夹名（沿用既有约定，老用户升级后不用做任何事） */
export const DEFAULT_INBOX_SUBPATH = "scan2wrong";
/** 子路径最大长度，防止有人塞一个超长字符串进来刷日志 */
const MAX_SUBPATH_LENGTH = 200;

/** 已导入台账：和 AI 配置同在一个持久化卷里（./config:/app/config） */
const STATE_FILE = path.join(process.cwd(), "config", "scan-inbox-state.json");

/**
 * 只认浏览器能直接画的格式。
 *
 * 为什么要过滤：收件箱是"谁都能往里丢"的公共目录，难免混进 HEIC / PDF / 视频。
 * HEIC 尤其坑 —— Chrome/Firefox 的 <img> 根本解不了，拉进来只会拿到一张裂图，
 * 还白白占一个 batch 名额。宁可不显示，也不要给用户一个点开就崩的缩略图。
 */
const ALLOWED_EXT: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

/** 小于这个体积的文件基本是占位/残缺图，不值得占名额 */
const MIN_SIZE_BYTES = 1024;

/** 台账里每个目录最多记多少条，超了按时间淘汰最老的 */
const MAX_STATE_ENTRIES = 500;

export interface ScanInboxFile {
    /** 文件名（含扩展名），取文件时用它作为 key */
    name: string;
    size: number;
    /** 修改时间（毫秒时间戳）；列表按它升序，和拍照顺序一致 */
    mtimeMs: number;
    /** 之前是否已经导入过（导入过的仍可重导，只是不再计为"新照片"） */
    imported: boolean;
}

/**
 * 收件箱的状态。**界面靠它给出"到底卡在哪一步"的可读提示** ——
 * 只说"不可用"用户没法排查，说清楚是"根目录没挂进来"还是"子文件夹不存在"，
 * 用户自己就能改对。
 */
export type InboxStatus =
    | "ok"           // 正常
    | "no-root"      // 根目录（挂载点）不存在 —— compose 的 volumes 没配对
    | "no-subdir"    // 根在，但选中的子文件夹不存在 —— 去飞牛里建，或换个名字
    | "invalid"      // 子路径名字不合法（绝对路径 / .. / 隐藏目录…）
    | "error";       // 读目录时出错（权限等）

export interface ScanInboxListing {
    /** 能不能用（可用时界面上才显示入口） */
    available: boolean;
    status: InboxStatus;
    /** 实际读取的目录（容器内绝对路径） */
    path: string;
    /** 同上，语义更清楚的新名字（path 保留兼容） */
    dir: string;
    /** 根目录（Docker 挂载点）；设置页里只读展示 */
    root: string;
    /** 根下的相对子路径；设置页里可改 */
    subPath: string;
    /** false = 老式单目录挂载，路径在设置页里改不了 */
    configurable: boolean;
    /** 根目录下已有的子文件夹，给设置页做"点一下就填"的选项 */
    folders: string[];
    files: ScanInboxFile[];
    /** 目录存在但被过滤掉的非图片/残缺文件数量，用于解释"为什么没显示" */
    ignored: number;
    reason?: string;
}

/** 当前生效的收件箱位置 */
export interface InboxLocation {
    root: string;
    subPath: string;
    dir: string;
    configurable: boolean;
}

/* ------------------------------------------------------------------ */
/* 路径解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把用户填的子路径收敛成一个**安全的相对路径**；不合法返回 null。
 *
 * 这一层挡的是"用户手滑或被人诱导填了奇怪的东西"：
 *   `/etc`、`../../config`、`~`、`a//b`、`.hidden`、超长串…
 * 归一化后统一用 `/` 分隔、不留空段。
 */
export function normalizeSubPath(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const raw = input.trim().replace(/\\/g, "/");
    if (!raw) return null;
    if (raw.length > MAX_SUBPATH_LENGTH) return null;
    if (raw.startsWith("/") || raw.startsWith("~")) return null; // 绝对路径 / home → 拒
    if (raw.includes("\0")) return null;

    const segs = raw.split("/").filter((s) => s.length > 0);
    if (!segs.length) return null;
    for (const s of segs) {
        if (s === "." || s === "..") return null; // 越权写法 → 拒
        if (s.startsWith(".")) return null;       // 隐藏目录不收（不是给人用的）
    }
    return segs.join("/");
}

/**
 * 解析当前生效的收件箱位置。
 *
 * 每次调用都重新读配置（配置就是一个小 JSON），所以**在设置页改完保存即刻生效**，
 * 不需要重启容器 —— 这是整个设计的关键点。
 *
 * @param overrideSubPath 试连接用：临时用这个子路径替代已保存的配置。
 *                        传 null / undefined 表示"用配置里的"。
 */
export function getInboxLocation(overrideSubPath?: string | null): InboxLocation {
    // 老式：只有一个写死的挂载点，父目录不一定是挂进来的，不给改
    if (!ROOT_ENV && LEGACY_PATH_ENV) {
        return {
            root: path.dirname(LEGACY_PATH_ENV),
            subPath: path.basename(LEGACY_PATH_ENV),
            dir: LEGACY_PATH_ENV,
            configurable: false,
        };
    }

    const root = path.resolve(ROOT_ENV || DEFAULT_ROOT);
    const subPath =
        normalizeSubPath(overrideSubPath) ||
        normalizeSubPath(getAppConfig().scanInbox?.subPath) ||
        DEFAULT_INBOX_SUBPATH;

    return {
        root,
        subPath,
        dir: path.join(root, ...subPath.split("/")),
        configurable: true,
    };
}

/* ------------------------------------------------------------------ */
/* 台账（哪些文件已经拉过）                                             */
/* ------------------------------------------------------------------ */

/**
 * v2 结构：**按子路径分组**。
 *
 * 为什么必须分组：换目录之后，两个目录里完全可能有同名照片（相机/夸克都爱用
 * `IMG_0001.jpg` 这种名字）。如果台账只有一层，B 目录里的新照片会被 A 目录的
 * 旧记录误判成"已导入"，直接从「收到 N 张新照片」里消失。
 */
interface StateShape {
    version: 2;
    /** 相对子路径 → (文件名 → 首次导入时间 ISO) */
    inbox: Record<string, Record<string, string>>;
}

const emptyState = (): StateShape => ({ version: 2, inbox: {} });

function readStateSync(): StateShape {
    try {
        if (!fsSync.existsSync(STATE_FILE)) return emptyState();
        const parsed = JSON.parse(fsSync.readFileSync(STATE_FILE, "utf-8"));

        // 旧格式（v1：{ imported: { 文件名: 时间 } }）→ 迁到当前子路径的分组下。
        // 迁移时机放在读取时，用户升级后第一次打开页面就自动完成，不用手工做什么。
        if (parsed && typeof parsed === "object" && !parsed.inbox && typeof parsed.imported === "object") {
            const bucket = { ...(parsed.imported as Record<string, string>) };
            const migrated: StateShape = {
                version: 2,
                inbox: { [getInboxLocation().subPath]: bucket },
            };
            writeStateSync(migrated);
            logger.info(
                { count: Object.keys(bucket).length },
                "旧版收件箱台账已迁移为按目录分组的新格式",
            );
            return migrated;
        }

        if (!parsed || typeof parsed !== "object" || !parsed.inbox || typeof parsed.inbox !== "object") {
            return emptyState();
        }

        const inbox: Record<string, Record<string, string>> = {};
        for (const [dirKey, bucket] of Object.entries(parsed.inbox)) {
            if (bucket && typeof bucket === "object") {
                inbox[dirKey] = { ...(bucket as Record<string, string>) };
            }
        }
        return { version: 2, inbox };
    } catch (err) {
        logger.warn({ error: String(err) }, "读取收件箱台账失败，按空台账处理");
        return emptyState();
    }
}

function writeStateSync(state: StateShape) {
    try {
        fsSync.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        /**
         * 先写临时文件、再 rename 覆盖 —— 同目录 rename 是原子操作。
         *
         * 为什么不能直接 writeFileSync：容器重启 / NAS 断电打断在写入中途，
         * 会留下半截 JSON。读取侧虽然有 catch 兜底，但兜底结果是「空台账」，
         * 也就是**所有已经导过的照片会重新变回"新照片"**，一按就重复导入。
         */
        const tmp = `${STATE_FILE}.tmp`;
        fsSync.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
        fsSync.renameSync(tmp, STATE_FILE);
    } catch (err) {
        // 台账写不了不该阻断主流程 —— 最坏结果是下次多显示几张"新照片"
        logger.error({ error: String(err) }, "写入收件箱台账失败");
    }
}

/** 取出（必要时新建）某个子路径的记录桶 */
function bucketOf(state: StateShape, subPath: string): Record<string, string> {
    if (!state.inbox[subPath]) state.inbox[subPath] = {};
    return state.inbox[subPath];
}

/**
 * 清理某个分组的台账：去掉已不存在的文件、超出上限的老记录、清空的分组。
 *
 * @param alive 传了就按"只有这些文件还活着"来剔（用户在 NAS 上手工删过的）；
 *              不传只做上限淘汰。
 */
function pruneBucket(state: StateShape, subPath: string, alive?: Set<string>) {
    const bucket = state.inbox[subPath];
    if (!bucket) return;

    if (alive) {
        for (const n of Object.keys(bucket)) if (!alive.has(n)) delete bucket[n];
    }

    const names = Object.keys(bucket);
    if (names.length > MAX_STATE_ENTRIES) {
        // 按导入时间从旧到新排，淘汰最老的
        const sorted = names
            .sort((a, b) => String(bucket[a]).localeCompare(String(bucket[b])));
        for (const n of sorted.slice(0, names.length - MAX_STATE_ENTRIES)) delete bucket[n];
    }

    // 分组空了就连键一起删掉，别留一堆空对象
    if (!Object.keys(bucket).length) delete state.inbox[subPath];
}

/* ------------------------------------------------------------------ */
/* 安全校验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把外部传来的文件名收敛成一个"只能指向收件箱内部"的相对路径。
 *
 * 收件箱对夸克是公开投递口，文件名可能被别的 App 写成奇怪的样子，
 * 所以这里必须挡住 `../`、绝对路径、以 `.` 开头的隐藏文件三种越权写法。
 */
export function resolveInboxPath(name: string, dir?: string): string | null {
    if (!name || typeof name !== "string") return null;
    const base = path.basename(name);
    if (!base || base !== name) return null;        // 带了目录分隔符 → 拒绝
    if (base.startsWith(".")) return null;          // 隐藏文件 → 拒绝
    const ext = path.extname(base).toLowerCase();
    if (!ALLOWED_EXT[ext]) return null;             // 非受支持的图片格式 → 拒绝
    return path.join(dir ?? getInboxLocation().dir, base);
}

function mimeOf(name: string): string {
    return ALLOWED_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";
}

/**
 * 放行判定（纯函数，便于单测）：必须是**普通文件**，且真实路径就在收件箱目录里。
 *
 * @param isPlainFile `lstat` 的结果是否为普通文件 —— 软链接 / 目录 / 设备 / 管道都算 false
 * @param realPath    `realpath` 解析出的真实路径
 * @param baseDir     收件箱自身的真实路径
 */
export function isSafeInboxEntry(isPlainFile: boolean, realPath: string, baseDir: string): boolean {
    if (!isPlainFile) return false;
    return path.dirname(realPath) === baseDir;
}

/**
 * 拿到一个**确认安全的**绝对路径：必须是收件箱目录里的真实普通文件。
 *
 * 【为什么光靠 resolveInboxPath 不够 —— 这是一条真实的任意文件读取通道】
 * 收件箱是外部 App（夸克、飞牛、其它服务）可写的目录。谁都能在里面放一个
 * **符号链接**，比如 `evil.jpg -> /app/config/app-config.json`（那里面存着 AI 密钥）。
 * 名字看着是图片、扩展名也过关，`resolveInboxPath` 全部通过，而 `fs.readFile`
 * **默认跟随软链接** —— 于是这个接口就等于"读容器内任意文件"。
 * 更阴的是：`readdir({withFileTypes:true})` 的 `entry.isFile()` 用的是 lstat 语义，
 * 软链接返回 false，会被列表过滤掉 —— 也就是**界面上看不见，接口却读得到**。
 *
 * 两道闸：
 *   ① `lstat` 不跟随软链接，不是**普通文件**（软链接/目录/设备/管道）一律拒；
 *   ② 再 realpath 一次，确认解出来的真实路径的父目录就是收件箱本身。
 *
 * 【这道闸拦不住什么（如实说明）】硬件链接（hard link）与 bind mount 进来、
 * 指向目录外文件的情况仍然拦不住 —— 但那两种都需要 NAS 上的 root 权限才能造出来，
 * 而有 root 的人本来就能读这些文件，不算本接口新开的口子。
 */
export async function resolveSafeFilePath(name: string, dir?: string): Promise<string | null> {
    const targetDir = dir ?? getInboxLocation().dir;
    const full = resolveInboxPath(name, targetDir);
    if (!full) return null;
    try {
        const lst = await fs.lstat(full);
        const real = await fs.realpath(full);
        const baseDir = await fs.realpath(targetDir);
        return isSafeInboxEntry(lst.isFile(), real, baseDir) ? real : null;
    } catch {
        // 不存在 / 权限不足 / 目录被卸载 —— 一律当作"取不到"
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* 对外能力                                                            */
/* ------------------------------------------------------------------ */

async function isDir(p: string): Promise<boolean> {
    try {
        const st = await fs.stat(p);
        return st.isDirectory();
    } catch {
        return false;
    }
}

/** 根目录下已有的子文件夹（给设置页做选项，省得用户凭记忆拼名字） */
export async function listSubFolders(loc: InboxLocation = getInboxLocation()): Promise<string[]> {
    try {
        const entries = await fs.readdir(loc.root, { withFileTypes: true });
        return entries
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, "zh-CN"));
    } catch {
        return [];
    }
}

export interface ListOptions {
    /**
     * 试连接：临时改用这个子路径，并且**一个字节都不落盘**（不写台账）。
     * 设置页的「检查连接」用它 —— 用户改了输入框还没保存，也想先知道能不能读到。
     */
    probeSubPath?: string;
}

/**
 * 列出收件箱里的图片。
 *
 * 顺带做两件"自洁"的事（只在非 probe 模式下）：
 *   ① 台账里已不存在的文件会被剔除（用户在 NAS 上手工删过）；
 *   ② 每组台账最多留 500 条，避免无限膨胀。
 */
export async function listInboxFiles(opts: ListOptions = {}): Promise<ScanInboxListing> {
    const probing = opts.probeSubPath !== undefined;

    const loc = getInboxLocation(opts.probeSubPath ?? null);
    const base = {
        path: loc.dir,
        dir: loc.dir,
        root: loc.root,
        subPath: loc.subPath,
        configurable: loc.configurable,
        files: [] as ScanInboxFile[],
        ignored: 0,
    };

    // 试连接时名字不合法就直说，别悄悄退回默认值让用户以为路径对了
    if (probing && normalizeSubPath(opts.probeSubPath) === null) {
        return {
            ...base,
            available: false,
            status: "invalid",
            folders: await listSubFolders(loc),
            reason: "子路径不合法",
        };
    }

    const folders = await listSubFolders(loc);

    // ① 根目录（挂载点）在不在 —— 不在就是 compose 的 volumes 没配好
    if (!(await isDir(loc.root))) {
        return {
            ...base,
            available: false,
            status: "no-root",
            folders,
            reason: `${loc.root} 不存在或不可读`,
        };
    }

    // ② 子文件夹在不在 —— 根挂好了但这个目录还没建
    if (!(await isDir(loc.dir))) {
        return {
            ...base,
            available: false,
            status: "no-subdir",
            folders,
            reason: `${loc.dir} 不存在`,
        };
    }

    // ③ 正常列文件
    let entries;
    try {
        entries = await fs.readdir(loc.dir, { withFileTypes: true });
    } catch (err) {
        return {
            ...base,
            available: false,
            status: "error",
            folders,
            reason: err instanceof Error ? err.message : String(err),
        };
    }

    const state = probing ? emptyState() : readStateSync();
    const bucket = state.inbox[loc.subPath] || {};
    const files: ScanInboxFile[] = [];
    let ignored = 0;

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXT[ext]) {
            ignored++;
            continue;
        }
        try {
            const st = await fs.stat(path.join(loc.dir, entry.name));
            if (st.size < MIN_SIZE_BYTES) {
                ignored++;
                continue;
            }
            files.push({
                name: entry.name,
                size: st.size,
                mtimeMs: st.mtimeMs,
                imported: probing ? false : Boolean(bucket[entry.name]),
            });
        } catch {
            ignored++;
        }
    }

    // 旧 → 新：和拍照顺序一致，导入后逐道审阅时不会前后颠倒
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    // 台账瘦身：用户在 NAS 上手工删过的文件要从记录里剔掉。
    // **剔完必须回写** —— 只改内存的话，下次进程重启那些名字又回来了，
    // 台账会随着照片越攒越多一路膨胀。
    if (!probing) {
        const before = Object.keys(bucket).length;
        pruneBucket(state, loc.subPath, new Set(files.map((f) => f.name)));
        const after = state.inbox[loc.subPath] ? Object.keys(state.inbox[loc.subPath]).length : 0;
        if (after !== before) writeStateSync(state);
    }

    return { ...base, available: true, status: "ok", folders, files, ignored };
}

/** 目录是否可用（挂载了 + 子目录在 + 有读权限）。界面靠它决定要不要显示入口 */
export async function isInboxAvailable(): Promise<boolean> {
    const loc = getInboxLocation();
    return (await isDir(loc.dir));
}

/** 读文件内容，返回给浏览器直接渲染成图片（只认普通文件，见 resolveSafeFilePath） */
export async function readInboxFile(name: string): Promise<{ data: Buffer; mime: string } | null> {
    const full = await resolveSafeFilePath(name);
    if (!full) return null;
    try {
        const data = await fs.readFile(full);
        return { data, mime: mimeOf(name) };
    } catch (err) {
        logger.warn({ name, error: String(err) }, "读取收件箱文件失败");
        return null;
    }
}

/** 标记一批文件为"已导入过" —— 之后它们不再计入「新照片」，但仍可手工重导 */
export async function markImported(names: string[]): Promise<number> {
    if (!names.length) return 0;
    const { subPath } = getInboxLocation();
    const state = readStateSync();
    const bucket = bucketOf(state, subPath);
    const now = new Date().toISOString();

    let n = 0;
    for (const raw of names) {
        const base = path.basename(raw || "");
        if (!base || base !== raw || base.startsWith(".")) continue;
        if (!bucket[base]) n++;
        bucket[base] = now;
    }
    pruneBucket(state, subPath);
    writeStateSync(state);
    return n;
}

export interface DeleteResult {
    deleted: string[];
    failed: { name: string; error: string }[];
}

/** 真的把文件从 NAS 目录里删掉（定期清理用）。删不掉的单列出来，不让用户以为是全删了 */
export async function deleteInboxFiles(names: string[]): Promise<DeleteResult> {
    const result: DeleteResult = { deleted: [], failed: [] };
    if (!names.length) return result;

    const { dir, subPath } = getInboxLocation();
    const state = readStateSync();
    const bucket = state.inbox[subPath];

    for (const raw of names) {
        // 与读文件同一道闸：只有收件箱里的**普通图片文件**才允许删。
        // （unlink 本身不跟随软链接，但统一校验能保证"界面上看不见的，接口也动不了"。）
        const full = await resolveSafeFilePath(raw, dir);
        if (!full) {
            result.failed.push({ name: raw, error: "不是收件箱里的普通图片文件" });
            continue;
        }
        try {
            await fs.unlink(full);
            result.deleted.push(raw);
            if (bucket) delete bucket[raw];
        } catch (err) {
            result.failed.push({ name: raw, error: err instanceof Error ? err.message : String(err) });
        }
    }
    pruneBucket(state, subPath);
    writeStateSync(state);
    return result;
}

/* ------------------------------------------------------------------ */
/* 写入：错题本自己拍的照片，反向存进收件箱                              */
/* ------------------------------------------------------------------ */

/**
 * 【custom-v31】「连续拍摄」的落点改造。
 *
 * 起因：手机拍摄能力强、电脑美化/加工能力强，这两件事本来就不该捆在一步里做完。
 * 以前连拍是"拍一张就往当批队列里堆一张"，拍完必须紧接着面对
 * 待处理 → 预处理 → 送 AI → 录入这一长串，中间没法停。
 * 现在改成：**拍完直接转存进 NAS 收件箱**，拍摄与加工之间多一个断点 ——
 * 手机上拍完就能收工，回头在电脑上打开收件箱再导入，走的还是同一条流水线。
 *
 * 与「拉取」方向完全对称，安全闸也对称：
 *   读出去  → 只认收件箱里的普通文件（防软链接读走配置）
 *   写进来  → 只往收件箱的**真实路径**里写（防软链接把文件写到别处）
 */

/** 单张上限。连拍出的是压缩过的 JPEG（正常几百 KB），15 MB 是给足余量 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * 从文件头几字节判断这是不是一张真图片，返回建议扩展名；不是则 null。
 *
 * 为什么不信扩展名和 Content-Type：这个接口会把**调用方给的字节直接写进 NAS**，
 * 而收件箱里的东西之后会被当成图片读出来渲染。只看声明的类型，等于让调用方
 * 自己声明"我是图片"—— 随便塞个 HTML 进来也算通过。文件头骗不了人。
 */
export function sniffImageExt(buf: Buffer): string | null {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
    if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
        return ".webp";
    }
    return null;
}

/** shot-20260921-113045-a1b2c3.jpg —— 服务端生成，客户端传什么都不用 */
export function makeShotName(ext: string, at: Date): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const stamp =
        `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
        `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
    return `shot-${stamp}-${randomBytes(3).toString("hex")}${ext}`;
}

/**
 * 准备（必要时创建）收件箱子目录，并确认它的**真实路径**确实落在挂载根之下。
 *
 * 【为什么写入侧也要这道闸】读侧的软链接闸挡的是"读出去"，写入侧的风险是"写进去"：
 * 如果子目录本身是个软链接（`scan2wrong -> /app/config`），
 * 我们就会把照片写进配置目录 —— 哪怕只是照片，也是往不该写的地方写。
 * 这里把目录 realpath 解一次，确认解出来的真实路径在根的真实路径之下，否则拒绝。
 *
 * 注：`mkdir -p` 若沿途遇到软链接段，可能先建出一个空目录再被下面的校验拦下。
 * 留一个空目录无害，但**一个字节都不会写进去**。
 */
async function ensureWritableDir(): Promise<{ ok: true; dir: string } | { ok: false; reason: string }> {
    const loc = getInboxLocation();
    if (!(await isDir(loc.root))) {
        return { ok: false, reason: `收件箱根目录不可用：${loc.root}（检查 Docker 挂载）` };
    }
    try {
        await fs.mkdir(loc.dir, { recursive: true });
    } catch (err) {
        return { ok: false, reason: `建目录失败：${err instanceof Error ? err.message : String(err)}` };
    }
    try {
        const realRoot = await fs.realpath(loc.root);
        const realDir = await fs.realpath(loc.dir);
        if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
            return { ok: false, reason: "目标目录不在收件箱根目录内（疑似软链接），已拒绝写入" };
        }
        return { ok: true, dir: realDir };
    } catch (err) {
        return { ok: false, reason: `目录校验失败：${err instanceof Error ? err.message : String(err)}` };
    }
}

export interface SaveImageResult {
    ok: boolean;
    /** 落盘后的文件名（服务端生成） */
    name?: string;
    error?: string;
}

/**
 * 把一张图写进收件箱，返回服务端生成的文件名。
 *
 * 三个刻意的取舍：
 *  ① **文件名一律服务端生成**：客户端传什么都不用 —— 名字里带路径分隔符、带 `..`、
 *     或者与已有照片同名互相覆盖，这些坑一次性绕开。
 *  ② **tmp + rename 原子落盘**：进程中途被杀只会留一个 tmp 残片（列表不认它），
 *     不会让半截 JPEG 出现在收件箱里被当正常照片导进去。
 *  ③ 写完**不记台账** —— 新拍的照片理应显示为"新"，等用户真的导入了才记。
 *
 * @param at 生成文件名用的时间，默认取当前时刻（测试里传固定值）
 */
export async function saveInboxImage(data: Buffer, at: Date = new Date()): Promise<SaveImageResult> {
    if (!data || data.length === 0) return { ok: false, error: "空文件" };
    if (data.length > MAX_UPLOAD_BYTES) {
        return {
            ok: false,
            error: `超过单张上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`,
        };
    }
    const ext = sniffImageExt(data);
    if (!ext) return { ok: false, error: "不是可识别的图片（只支持 JPG / PNG / WebP）" };

    const ready = await ensureWritableDir();
    if (!ready.ok) return { ok: false, error: ready.reason };

    const name = makeShotName(ext, at);
    const finalPath = path.join(ready.dir, name);
    const tmpPath = path.join(ready.dir, `tmp-${randomBytes(6).toString("hex")}`);

    try {
        await fs.writeFile(tmpPath, data, { flag: "wx" });
    } catch (err) {
        return { ok: false, error: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
    try {
        await fs.rename(tmpPath, finalPath);
    } catch (err) {
        // 落盘失败就把残片收掉，别在目录里留垃圾
        await fs.unlink(tmpPath).catch(() => undefined);
        return { ok: false, error: `落盘失败：${err instanceof Error ? err.message : String(err)}` };
    }

    logger.info({ name, bytes: data.length }, "连续拍摄转存到收件箱");
    return { ok: true, name };
}
