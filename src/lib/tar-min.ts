import fs from "fs";
import fsp from "fs/promises";
import type { FileHandle } from "fs/promises";
import path from "path";
import { Readable } from "stream";

/**
 * 最小 tar 写入器（POSIX ustar）
 *
 * ── 为什么要自己写 ────────────────────────────────────────────────────
 * 只为"把一个 .db 和一个 config.json 放进一个包"引一个 npm 包，不划算：
 * 依赖会跟着镜像走、要审、要担心它哪天不维护。
 *
 * ── 为什么只做这一小撮功能 ────────────────────────────────────────────
 * 手写 tar 的全部风险都在**格式细节**上（八进制字段、校验和、512 对齐）。
 * 少一个特性就少一处能写错的地方。所以：
 *   · 不建目录、不存软链、不处理长文件名（>100 字节要扩展头，我们不需要）；
 *   · 文件名一律扁平，短。
 *
 * 格式参考：POSIX ustar，每块 512 字节，结束是两个全零块。
 */

const BLOCK = 512;

/** 八进制字段：左补 0，末尾留一个 NUL */
function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
    const digits = Math.max(0, value).toString(8).padStart(length - 1, "0");
    buf.write(digits.slice(-(length - 1)) + "\0", offset, length, "ascii");
}

export function buildTarHeader(name: string, size: number, mode: number, mtimeSec: number): Buffer {
    const buf = Buffer.alloc(BLOCK, 0);

    buf.write(name.slice(0, 100), 0, 100, "utf8");        // name
    writeOctal(buf, 100, 8, mode);                        // mode
    writeOctal(buf, 108, 8, 0);                           // uid
    writeOctal(buf, 116, 8, 0);                           // gid
    writeOctal(buf, 124, 12, size);                       // size
    writeOctal(buf, 136, 12, mtimeSec);                   // mtime

    buf.write("0", 156, 1, "ascii");                      // typeflag = 普通文件
    buf.write("ustar\0", 257, 6, "ascii");                // magic
    buf.write("00", 263, 2, "ascii");                     // version

    // ⚠️ 校验和必须**最后**算：它覆盖整个 512 字节，
    //    包括 typeflag 和 magic。先算再写这两个字段，算出来就是错的
    //    （单测里正是这样抓到的：存进去 0o7264，重算却是另一个值）。
    // 规则：chksum 区先当 8 个空格参与求和。
    buf.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += buf[i];
    buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

    return buf;
}

export interface TarEntry {
    /** 包内文件名（扁平，不要带目录前缀） */
    name: string;
    /** 从磁盘上的这个文件读 */
    path?: string;
    /** 或者直接给内容（小文件用这个） */
    data?: Buffer;
}

/** 内容补齐到 512 的整数倍 */
function paddingFor(size: number): number {
    return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** 把若干文件打成 tar 字节流（**不压缩**，压缩交给外面那道 gzip） */
export async function* tarStream(entries: TarEntry[]): AsyncGenerator<Buffer> {
    for (const entry of entries) {
        const stat = entry.path ? await fsp.stat(entry.path) : null;
        const size = entry.data ? entry.data.length : stat!.size;
        const mtime = Math.floor((stat?.mtimeMs ?? Date.now()) / 1000);

        yield buildTarHeader(entry.name, size, 0o644, mtime);

        if (entry.data) {
            yield entry.data;
        } else if (entry.path) {
            for await (const chunk of fs.createReadStream(entry.path)) {
                yield chunk as Buffer;
            }
        }

        const pad = paddingFor(size);
        if (pad > 0) yield Buffer.alloc(pad, 0);
    }
    // tar 的结束标志：两个全零块
    yield Buffer.alloc(BLOCK * 2, 0);
}

/** 打包成 Node 可读流（边读边压，不把几十 MB 整个塞进内存） */
export function tarToNodeStream(entries: TarEntry[]): Readable {
    return Readable.from(tarStream(entries));
}

/* ================================================================== */
/* 解包（恢复用）                                                      */
/* ================================================================== */

/** 解包时遇到的格式问题。路由层要能分辨"包坏了"和"程序出错了" */
export class TarError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TarError";
    }
}

export interface ExtractedEntry {
    /** 包内文件名 */
    name: string;
    /** 原始大小（字节） */
    size: number;
    /** 落盘后的绝对路径 */
    path: string;
}

export interface ExtractOptions {
    /**
     * 决定这个文件要不要解、解到哪。
     *
     * 返回 `null` = 不要（比如目录条目、README 之类的附带文件）。
     * ⚠️ **白名单必须在这里做**：包是用户上传的，名字不可信。
     *    绝不能拿 name 直接拼路径 —— `../../etc/passwd` 这种就是这个口子。
     */
    destFor: (name: string) => string | null;
    /** 单个文件上限，默认 512MB */
    maxFileSize?: number;
    /** 解压总量上限，默认 1GB */
    maxTotalSize?: number;
}

/** 读 tar 头里的 name（NUL 截断，按 utf8 解） */
function readName(header: Buffer): string {
    const slice = header.subarray(0, 100);
    const nul = slice.indexOf(0);
    return slice.subarray(0, nul === -1 ? 100 : nul).toString("utf8");
}

/** 八进制字段；空字段按 0 处理（tar 允许全 NUL 表示未设置） */
function readOctal(buf: Buffer, offset: number, length: number): number {
    const str = buf
        .subarray(offset, offset + length)
        .toString("ascii")
        .replace(/\0.*$/, "")
        .trim();
    if (str === "") return 0;
    if (!/^[0-7]+$/.test(str)) {
        // base-256 编码（首字节 0x80）之类：我们只认八进制
        throw new TarError(`tar 头里的数字字段不是八进制："${str.slice(0, 12)}"`);
    }
    return parseInt(str, 8);
}

function isZeroBlock(block: Buffer): boolean {
    for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
    return true;
}

/** 校验和：chksum 那 8 个字节按空格参与求和 */
function checksumOk(header: Buffer): boolean {
    let stored: number;
    try {
        stored = readOctal(header, 148, 8);
    } catch {
        return false;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
        sum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    return sum === stored;
}

/**
 * 从 tar 字节流里解出**白名单内**的文件，边读边写盘。
 *
 * ── 为什么是流式 ──────────────────────────────────────────────────────
 * 备份包解开是 35MB 上下。`NAS` 空闲内存只有 200MB 左右，
 * 一次 `Buffer.concat` 到底很容易把进程顶死 —— 那台机器上"OOM 崩掉"
 * 不是慢，是整个容器重启。所以这里只保留一个 512 字节的头部窗口，
 * 数据边到边写。
 *
 * ── 它会拒绝什么 ──────────────────────────────────────────────────────
 *   · 头校验和不匹配（包坏了 / 被改过）
 *   · 单个文件或总量超上限（防炸包）
 *   · 数据被截断（包没传完）
 * 目录、扩展头、以及 `destFor` 返回 null 的文件，**整段跳过但不报错**。
 */
export async function extractTarStream(
    input: AsyncIterable<Buffer>,
    opts: ExtractOptions,
): Promise<ExtractedEntry[]> {
    const maxFileSize = opts.maxFileSize ?? 512 * 1024 * 1024;
    const maxTotalSize = opts.maxTotalSize ?? 1024 * 1024 * 1024;

    const out: ExtractedEntry[] = [];
    let total = 0;
    // 显式标成 `Buffer`（= Buffer<ArrayBufferLike>）：`Buffer.concat` 的返回类型
    // 是 ArrayBufferLike，而 `Buffer.alloc` 推断出来是 ArrayBuffer，两者赋不到一起。
    let carry: Buffer = Buffer.alloc(0);
    let ended = false;

    /** 当前正在处理的条目（可能收、也可能只是跳过） */
    let cur: {
        name: string;
        size: number;
        /** 还要吃掉多少字节：文件内容 + 512 对齐填充 */
        left: number;
        /** 已经写入的字节数 */
        written: number;
        dest: string | null;
        handle: FileHandle | null;
    } | null = null;

    for await (const raw of input) {
        if (ended) break;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;

        while (true) {
            if (cur) {
                if (carry.length === 0) break;
                const take = Math.min(carry.length, cur.left);

                if (cur.handle) {
                    // 只写"数据段"，末尾的对齐填充不写进文件
                    const dataPart = Math.min(take, cur.size - cur.written);
                    if (dataPart > 0) {
                        await cur.handle.write(carry.subarray(0, dataPart));
                        cur.written += dataPart;
                    }
                }

                carry = carry.subarray(take);
                cur.left -= take;

                if (cur.left === 0) {
                    if (cur.handle) {
                        await cur.handle.close();
                        out.push({ name: cur.name, size: cur.size, path: cur.dest! });
                    }
                    cur = null;
                }
                continue;
            }

            if (carry.length < BLOCK) break;

            const header = carry.subarray(0, BLOCK);
            carry = carry.subarray(BLOCK);

            // 结束标志（一般是两个全零块）
            if (isZeroBlock(header)) {
                ended = true;
                break;
            }

            if (!checksumOk(header)) {
                throw new TarError("包内文件头校验和对不上，包可能已损坏或被截断");
            }

            const name = readName(header);
            const size = readOctal(header, 124, 12);
            const typeflag = header[156];
            // '0' 或 NUL = 普通文件；'5' = 目录；'x'/'g' = 扩展头
            const isPlainFile = typeflag === 0x30 || typeflag === 0x00;

            if (size > maxFileSize) {
                throw new TarError(`包内文件过大：${name}（${size} 字节）`);
            }

            const pad = paddingFor(size);
            const dest = isPlainFile ? opts.destFor(name) : null;

            if (dest) {
                total += size;
                if (total > maxTotalSize) {
                    throw new TarError("解压后的总大小超过上限，已中止");
                }
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                cur = {
                    name,
                    size,
                    left: size + pad,
                    written: 0,
                    dest,
                    handle: await fsp.open(dest, "w"),
                };
            } else {
                cur = { name, size, left: size + pad, written: 0, dest: null, handle: null };
            }
        }
    }

    if (cur) {
        if (cur.handle) await cur.handle.close();
        throw new TarError("包不完整：最后一个文件的数据没读完（上传可能中断了）");
    }
    if (out.length === 0) {
        throw new TarError("包里没有找到可用的文件");
    }
    return out;
}
