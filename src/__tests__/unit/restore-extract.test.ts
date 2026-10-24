import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "stream";
import zlib from "zlib";
import fsp from "fs/promises";
import path from "path";
import fs from "fs";
import { tarStream } from "@/lib/tar-min";
import { extractArchive, RestoreInputError } from "@/lib/restore";

/**
 * `extractArchive` 是"包 → 磁盘"的唯一入口，上传和 NAS 两条来源都走它。
 *
 * 为什么必须单独测：它和 `stageForRestore` 之间**靠文件名约定**连接 ——
 * 一个写 `cand-N.db`、另一个读 `restore.db`。这种约定 tsc 看不出来，
 * 上次就是这么漏的（点「开始恢复」报 ENOENT .../restore.db）。
 */

async function gzippedTar(entries: { name: string; data: Buffer }[]): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of tarStream(entries)) parts.push(chunk);
    return zlib.gzipSync(Buffer.concat(parts));
}

describe("restore · 解包后的文件名约定", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fsp.mkdtemp(path.join("/tmp", "wn-extract-"));
    });

    afterEach(async () => {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });

    it("应用内导出的包：库统一落成 restore.db（stageForRestore 认这个名字）", async () => {
        const gz = await gzippedTar([
            { name: "wn-2026-10-24.db", data: Buffer.from("DB-PAYLOAD") },
            { name: "app-config.json", data: Buffer.from("{}") },
            { name: "scan-inbox-state.json", data: Buffer.from("{}") },
            { name: "README-restore.txt", data: Buffer.from("说明，不该被解出来") },
        ]);

        const out = await extractArchive(Readable.from([gz]), dir);

        expect(path.basename(out.dbPath)).toBe("restore.db");
        expect(path.dirname(out.dbPath)).toBe(dir);
        expect(fs.existsSync(out.dbPath)).toBe(true);
        expect(await fsp.readFile(out.dbPath, "utf8")).toBe("DB-PAYLOAD");
        expect(out.dbName).toBe("wn-2026-10-24.db");
        expect(out.configFiles.sort()).toEqual(["app-config.json", "scan-inbox-state.json"]);
        expect(out.hasConfig).toBe(true);
        // README 不在白名单里，不能落盘
        expect(fs.existsSync(path.join(dir, "README-restore.txt"))).toBe(false);
    });

    it("宿主机 backup.sh 的包：库叫 dev.db，配置带目录前缀，也要认", async () => {
        const gz = await gzippedTar([
            { name: "data/_tmp-backup.db", data: Buffer.from("DEV") },
            { name: "config/app-config.json", data: Buffer.from('{"a":1}') },
            { name: "config/scan-inbox-state.json", data: Buffer.from('{"b":2}') },
            { name: "certs/cert.pem", data: Buffer.from("CERT") },
            { name: "docker-compose.yml", data: Buffer.from("services: {}") },
        ]);

        const out = await extractArchive(Readable.from([gz]), dir);

        expect(path.basename(out.dbPath)).toBe("restore.db");
        expect(await fsp.readFile(out.dbPath, "utf8")).toBe("DEV");
        expect(out.dbName).toBe("_tmp-backup.db");
        expect(out.configFiles.sort()).toEqual(["app-config.json", "scan-inbox-state.json"]);
        // 证书/编排文件不进暂存区
        expect(fs.existsSync(path.join(dir, "cert.pem"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "docker-compose.yml"))).toBe(false);
    });

    it("两个 .db 里优先带日期的那个（应用内导出的整包）", async () => {
        const gz = await gzippedTar([
            { name: "dev.db", data: Buffer.from("OLD") },
            { name: "wn-2026-10-24.db", data: Buffer.from("NEW") },
        ]);

        const out = await extractArchive(Readable.from([gz]), dir);
        expect(await fsp.readFile(out.dbPath, "utf8")).toBe("NEW");
    });

    it("包里没有库 ⇒ 明确报错（用户能看懂）", async () => {
        const gz = await gzippedTar([{ name: "readme.txt", data: Buffer.from("hi") }]);

        await expect(extractArchive(Readable.from([gz]), dir)).rejects.toBeInstanceOf(
            RestoreInputError,
        );
    });

    it("好几个分不清的库 ⇒ 报错而不是瞎挑", async () => {
        const gz = await gzippedTar([
            { name: "a.db", data: Buffer.from("1") },
            { name: "b.db", data: Buffer.from("2") },
        ]);

        await expect(extractArchive(Readable.from([gz]), dir)).rejects.toThrow(/好几个/);
    });
});
