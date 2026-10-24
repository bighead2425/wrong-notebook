import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTarHeader, tarStream, extractTarStream, TarError } from "@/lib/tar-min";
import { Readable } from "stream";
import fsp from "fs/promises";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * 手写 tar 最容易错的三件事：字段长度、八进制写法、校验和。
 * 这里逐项钉死 —— 打包错了在本地看不出来，等真出事解包失败才发现，那就晚了。
 */

/** 按 tar 规则重算校验和（把 chksum 区当 8 个空格），用来验证头里的值 */
function checksumOf(header: Buffer): number {
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += copy[i];
    return sum;
}

/** 读八进制字段（去掉 NUL 与空格） */
function readOctal(buf: Buffer, offset: number, length: number): number {
    const raw = buf.subarray(offset, offset + length).toString("ascii").replace(/[\0 ]/g, "");
    return parseInt(raw, 8);
}

async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of gen) parts.push(chunk);
    return Buffer.concat(parts);
}

describe("tar-min · 头部", () => {
    it("固定 512 字节", () => {
        expect(buildTarHeader("a.db", 10, 0o644, 1700000000).length).toBe(512);
    });

    it("文件名、大小、mode、mtime 都落在规定位置", () => {
        const name = "wn-2026-10-24.db";
        const h = buildTarHeader(name, 123456, 0o644, 1700000000);
        expect(h.subarray(0, name.length).toString("utf8")).toBe(name);
        expect(readOctal(h, 124, 12)).toBe(123456);
        expect(readOctal(h, 100, 8)).toBe(0o644);
        expect(readOctal(h, 136, 12)).toBe(1700000000);
    });

    it("magic 是 ustar，typeflag 是普通文件", () => {
        const h = buildTarHeader("x", 0, 0o644, 0);
        expect(h.subarray(257, 263).toString("ascii")).toBe("ustar\0");
        expect(h.subarray(263, 265).toString("ascii")).toBe("00");
        expect(h[156]).toBe(0x30); // '0'
    });

    it("校验和与逐字节求和一致", () => {
        const h = buildTarHeader("some-file.json", 42, 0o644, 1690000000);
        const expected = checksumOf(h);
        const stored = parseInt(h.subarray(148, 154).toString("ascii"), 8);
        expect(stored).toBe(expected);
        // 结尾必须是 NUL + 空格（不是两个 NUL）
        expect(h[154]).toBe(0);
        expect(h[155]).toBe(0x20);
    });
});

describe("tar-min · 打包", () => {
    it("内容按 512 补齐，末尾两个全零块", async () => {
        const data = Buffer.from("abc"); // 3 字节 ⇒ 补 509
        const out = await collect(tarStream([{ name: "a.txt", data }]));

        expect(out.length).toBe(512 + 512 + 1024);
        expect(out.subarray(512, 515).toString("utf8")).toBe("abc");
        // 补位区全零
        expect(out.subarray(515, 1024).every((b) => b === 0)).toBe(true);
        // 结束块全零
        expect(out.subarray(1024).every((b) => b === 0)).toBe(true);
    });

    it("正好 512 的整数倍时不额外补块", async () => {
        const data = Buffer.alloc(512, 0x41);
        const out = await collect(tarStream([{ name: "b.bin", data }]));
        expect(out.length).toBe(512 + 512 + 1024);
    });

    it("多个文件依次排列，各自的头都能对上", async () => {
        const out = await collect(tarStream([
            { name: "one.txt", data: Buffer.from("1") },
            { name: "two.txt", data: Buffer.from("22") },
        ]));

        // 第一条：头 512 + 内容 512 = 1024
        expect(out.subarray(0, 7).toString("utf8")).toBe("one.txt");
        expect(out.subarray(1024, 1031).toString("utf8")).toBe("two.txt");

        // 第二条大小 = 2
        expect(readOctal(out.subarray(1024, 1024 + 512), 124, 12)).toBe(2);
    });

    it("空包也要有结束标志", async () => {
        const out = await collect(tarStream([]));
        expect(out.length).toBe(1024);
        expect(out.every((b) => b === 0)).toBe(true);
    });
});

/* ================================================================== */
/* 解包（恢复链路吃的是用户上传的字节，每一条拒绝分支都要钉死）        */
/* ================================================================== */

/** 把 buffer 切成固定大小的小块，逼出"数据跨块"的拼接逻辑 */
function chunked(buf: Buffer, size: number): Readable {
    const parts: Buffer[] = [];
    for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
    return Readable.from(parts);
}

async function tarOf(entries: { name: string; data: Buffer }[]): Promise<Buffer> {
    return collect(tarStream(entries));
}

describe("tar-min · 解包", () => {
    let dir: string;

    beforeAll(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wn-untar-"));
    });

    afterAll(async () => {
        await fsp.rm(dir, { recursive: true, force: true });
    });

    /** 只收 .db 和 .json，其余一律跳过 */
    const acceptDbAndJson = (name: string): string | null => {
        if (!/\.(db|json)$/.test(name)) return null;
        // 包内名字不可信：只取最后一段，杜绝 ../ 
        return path.join(dir, path.basename(name));
    };

    it("打包再解回来，内容逐字节一致", async () => {
        const payload = Buffer.from("hello restore");
        const tar = await tarOf([{ name: "a.db", data: payload }]);

        const got = await extractTarStream(chunked(tar, 7), { destFor: acceptDbAndJson });

        expect(got).toHaveLength(1);
        expect(got[0].name).toBe("a.db");
        expect(got[0].size).toBe(payload.length);
        expect(await fsp.readFile(got[0].path)).toEqual(payload);
    });

    it("512 / 513 / 1 字节三种边界都不多不少", async () => {
        const cases = [
            { name: "n512.db", data: Buffer.alloc(512, 0x41) },
            { name: "n513.db", data: Buffer.alloc(513, 0x42) },
            { name: "n1.db", data: Buffer.alloc(1, 0x43) },
            { name: "n0.db", data: Buffer.alloc(0) },
        ];
        const tar = await tarOf(cases);
        const got = await extractTarStream(chunked(tar, 100), { destFor: acceptDbAndJson });

        expect(got).toHaveLength(4);
        for (const c of cases) {
            const hit = got.find((g) => g.name === c.name)!;
            expect(hit.size, c.name).toBe(c.data.length);
            expect((await fsp.readFile(hit.path)).length, c.name).toBe(c.data.length);
        }
    });

    it("白名单外的文件整段跳过，不影响后面的文件", async () => {
        const tar = await tarOf([
            { name: "README-restore.txt", data: Buffer.from("说明") },
            { name: "wn.db", data: Buffer.from("DBDATA") },
            { name: "evil.sh", data: Buffer.from("rm -rf /") },
        ]);

        const got = await extractTarStream(chunked(tar, 64), { destFor: acceptDbAndJson });

        expect(got.map((g) => g.name)).toEqual(["wn.db"]);
        expect(await fsp.readFile(got[0].path, "utf8")).toBe("DBDATA");
        // 被拒绝的文件绝不能落到磁盘上
        expect(fs.existsSync(path.join(dir, "evil.sh"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "README-restore.txt"))).toBe(false);
    });

    it("带路径穿越的文件名也只会落到目标目录里", async () => {
        const tar = await tarOf([{ name: "../../escape.db", data: Buffer.from("x") }]);
        const got = await extractTarStream(chunked(tar, 64), { destFor: acceptDbAndJson });

        expect(got).toHaveLength(1);
        expect(path.dirname(got[0].path)).toBe(dir);
    });

    it("头校验和被改过 ⇒ 拒绝", async () => {
        const tar = await tarOf([{ name: "a.db", data: Buffer.from("abc") }]);
        // 改文件名区的一个字节，校验和立刻对不上
        tar[0] = 0x5a;

        await expect(
            extractTarStream(chunked(tar, 64), { destFor: acceptDbAndJson }),
        ).rejects.toBeInstanceOf(TarError);
    });

    it("数据被截断 ⇒ 拒绝（上传中断就是这种）", async () => {
        const tar = await tarOf([{ name: "a.db", data: Buffer.alloc(4096, 0x41) }]);
        const cut = tar.subarray(0, 512 + 100); // 头完整，数据只到 100 字节

        await expect(
            extractTarStream(chunked(cut, 32), { destFor: acceptDbAndJson }),
        ).rejects.toThrow(/不完整/);
    });

    it("单个文件超上限 ⇒ 拒绝", async () => {
        const tar = await tarOf([{ name: "big.db", data: Buffer.alloc(4096, 0x41) }]);

        await expect(
            extractTarStream(chunked(tar, 64), { destFor: acceptDbAndJson, maxFileSize: 1000 }),
        ).rejects.toThrow(/过大/);
    });

    it("解压总量超上限 ⇒ 拒绝（防炸包）", async () => {
        const tar = await tarOf([
            { name: "a.db", data: Buffer.alloc(600, 0x41) },
            { name: "b.db", data: Buffer.alloc(600, 0x42) },
        ]);

        await expect(
            extractTarStream(chunked(tar, 64), { destFor: acceptDbAndJson, maxTotalSize: 1000 }),
        ).rejects.toThrow(/总大小/);
    });

    it("只有结束块的空包 ⇒ 明确报错，而不是静默成功", async () => {
        await expect(
            extractTarStream(chunked(Buffer.alloc(1024), 64), { destFor: acceptDbAndJson }),
        ).rejects.toThrow(/没有找到可用的文件/);
    });
});
