import fs from "fs";
import fsp from "fs/promises";
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
