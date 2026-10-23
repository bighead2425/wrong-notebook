import { describe, it, expect } from "vitest";
import { buildTarHeader, tarStream } from "@/lib/tar-min";

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
