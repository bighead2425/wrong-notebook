import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { createLogger } from "./logger";

/**
 * 【custom-v29 · 蓝图：外部扫描件投递隧道】「扫描收件箱」
 *
 * 场景：手机上用夸克扫描王拍下的试卷/作业，通过夸克的「分享 → 飞牛」
 * 投进 NAS 的固定目录（当前约定 /vol2/1000/scan2wrong）。容器把这个目录
 * 挂到 /app/scan2wrong 之后，错题本就能直接把里面的照片拉进流水线，
 * **不用再从手机相册里一张张挑**。
 *
 * 为什么这么设计：
 *   1. 采集层不重做 —— 拍照、拉正、去阴影交给夸克（它做得比我们好），
 *      本模块只负责"把成品照片搬进来"，属于**管理层**能力；
 *   2. 目录是**单向投递口**：夸克只管往里丢文件，错题本只管往外取，
 *      两边不需要互相认识，也不需要夸克开放任何接口；
 *   3. 取走不等于删除 —— 文件依然留着，随时可以重新拉进来（"留一个活口"），
 *      靠 **imported 状态**（记录在 config/scan-inbox-state.json）区分新旧。
 *
 * 环境变量：
 *   SCAN_INBOX_PATH  容器内挂载点，默认 /app/scan2wrong（见 docker-compose.yml）
 *   **未挂载时全部函数优雅降级**（返回 available=false），界面上按钮直接不出现。
 */

const logger = createLogger("scan-inbox");

/** 容器内挂载点；不配置就用一个不存在的默认路径，界面上自动隐藏入口 */
export const SCAN_INBOX_PATH = process.env.SCAN_INBOX_PATH || "/app/scan2wrong";

/** 已导入台账：和 AI 配置同在一个持久化卷里（./config:/app/config） */
const STATE_FILE = path.join(process.cwd(), "config", "scan-inbox-state.json");

/**
 * 只认浏览器能直接画的格式。
 *
 * 为什么要过滤：收件箱是"谁都能往里丢"的公共目录，难免混进 HEIC/ PDF / 视频。
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

export interface ScanInboxFile {
    /** 文件名（含扩展名），取文件时用它作为 key */
    name: string;
    size: number;
    /** 修改时间（毫秒时间戳）；列表按它升序，和拍照顺序一致 */
    mtimeMs: number;
    /** 之前是否已经导入过（导入过的仍可重导，只是不再计为"新照片"） */
    imported: boolean;
}

export interface ScanInboxListing {
    available: boolean;
    path: string;
    files: ScanInboxFile[];
    /** 目录存在但被过滤掉的非图片/残缺文件数量，用于在界面上解释"为什么没显示" */
    ignored: number;
    reason?: string;
}

interface StateShape {
    /** 文件名 → 首次导入时间（ISO 字符串） */
    imported: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* 台账（哪些文件已经拉过）                                             */
/* ------------------------------------------------------------------ */

const EMPTY_STATE: StateShape = { imported: {} };

function readStateSync(): StateShape {
    try {
        if (!fsSync.existsSync(STATE_FILE)) return { ...EMPTY_STATE };
        const raw = fsSync.readFileSync(STATE_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || typeof parsed.imported !== "object") {
            return { ...EMPTY_STATE };
        }
        return { imported: { ...parsed.imported } };
    } catch (err) {
        logger.warn({ error: String(err) }, "读取收件箱台账失败，按空台账处理");
        return { ...EMPTY_STATE };
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

/* ------------------------------------------------------------------ */
/* 安全校验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把外部传来的文件名收敛成一个"只能指向收件箱内部"的相对路径。
 *
 * 收件箱对夸克是公开投递口，文件名可能被别的 App 写成奇怪的样子，
 * 所以这里必须挡住 `../`、绝对路径、以 `.` 开头的隐藏文件三种越权写法。
 */
export function resolveInboxPath(name: string): string | null {
    if (!name || typeof name !== "string") return null;
    const base = path.basename(name);
    if (!base || base !== name) return null;        // 带了目录分隔符 → 拒绝
    if (base.startsWith(".")) return null;          // 隐藏文件 → 拒绝
    const ext = path.extname(base).toLowerCase();
    if (!ALLOWED_EXT[ext]) return null;             // 非受支持的图片格式 → 拒绝
    return path.join(SCAN_INBOX_PATH, base);
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
export async function resolveSafeFilePath(name: string): Promise<string | null> {
    const full = resolveInboxPath(name);
    if (!full) return null;
    try {
        const lst = await fs.lstat(full);
        const real = await fs.realpath(full);
        const baseDir = await fs.realpath(SCAN_INBOX_PATH);
        return isSafeInboxEntry(lst.isFile(), real, baseDir) ? real : null;
    } catch {
        // 不存在 / 权限不足 / 目录被卸载 —— 一律当作"取不到"
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* 对外能力                                                            */
/* ------------------------------------------------------------------ */

/** 目录是否可用（挂载了 + 有读权限）。界面靠它决定要不要显示入口 */
export async function isInboxAvailable(): Promise<boolean> {
    try {
        await fs.access(SCAN_INBOX_PATH, fsSync.constants.R_OK);
        const stat = await fs.stat(SCAN_INBOX_PATH);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

/**
 * 列出收件箱里的图片。
 *
 * 顺带做两件"自洁"的事：
 *   ① 台账里已不存在的文件会被剔除（用户在 NAS 上手工删过）；
 *   ② 台账至少保留最近 500 条，避免无限膨胀。
 */
export async function listInboxFiles(): Promise<ScanInboxListing> {
    if (!(await isInboxAvailable())) {
        return { available: false, path: SCAN_INBOX_PATH, files: [], ignored: 0 };
    }

    let entries;
    try {
        entries = await fs.readdir(SCAN_INBOX_PATH, { withFileTypes: true });
    } catch (err) {
        return {
            available: false,
            path: SCAN_INBOX_PATH,
            files: [],
            ignored: 0,
            reason: err instanceof Error ? err.message : String(err),
        };
    }

    const state = readStateSync();
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
            const st = await fs.stat(path.join(SCAN_INBOX_PATH, entry.name));
            if (st.size < MIN_SIZE_BYTES) {
                ignored++;
                continue;
            }
            files.push({
                name: entry.name,
                size: st.size,
                mtimeMs: st.mtimeMs,
                imported: Boolean(state.imported[entry.name]),
            });
        } catch {
            ignored++;
        }
    }

    // 旧 → 新：和拍照顺序一致，导入后逐道审阅时不会前后颠倒
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    // 台账瘦身：用户在 NAS 上手工删过的文件要从记录里剔掉。
    // **剔完必须回写** —— 只改内存的话，下次进程重启那些名字又回来了，
    // 台账会随着照片越攒越多一路膨胀（这正是要解决的问题）。
    const before = Object.keys(state.imported).length;
    pruneState(state, new Set(files.map((f) => f.name)));
    if (Object.keys(state.imported).length !== before) writeStateSync(state);

    return { available: true, path: SCAN_INBOX_PATH, files, ignored };
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
    const state = readStateSync();
    const now = new Date().toISOString();
    let n = 0;
    for (const raw of names) {
        const base = path.basename(raw || "");
        if (!base || base !== raw || base.startsWith(".")) continue;
        if (!state.imported[base]) n++;
        state.imported[base] = now;
    }
    pruneState(state);
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

    const state = readStateSync();
    for (const raw of names) {
        // 与读文件同一道闸：只有收件箱里的**普通图片文件**才允许删。
        // （unlink 本身不跟随软链接，但统一校验能保证"界面上看不见的，接口也动不了"。）
        const full = await resolveSafeFilePath(raw);
        if (!full) {
            result.failed.push({ name: raw, error: "不是收件箱里的普通图片文件" });
            continue;
        }
        try {
            await fs.unlink(full);
            result.deleted.push(raw);
            delete state.imported[raw];
        } catch (err) {
            result.failed.push({ name: raw, error: err instanceof Error ? err.message : String(err) });
        }
    }
    writeStateSync(state);
    return result;
}

/** 清理台账：去掉已不存在的文件、超出 500 条的老记录 */
function pruneState(state: StateShape, alive?: Set<string>) {
    const names = Object.keys(state.imported);
    if (alive) {
        for (const n of names) if (!alive.has(n)) delete state.imported[n];
    }
    const remaining = Object.keys(state.imported);
    if (remaining.length <= 500) return;
    const sorted = remaining
        .sort((a, b) => String(state.imported[a]).localeCompare(String(state.imported[b])));
    for (const n of sorted.slice(0, remaining.length - 500)) delete state.imported[n];
}
