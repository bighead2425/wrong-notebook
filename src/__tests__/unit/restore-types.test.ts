import { describe, it, expect } from "vitest";
import {
    pickMainDb,
    stampOfName,
    SUMMARY_LABELS,
    SUMMARY_TABLES,
    RESTORE_CONFIRM_WORD,
} from "@/lib/restore-types";

/**
 * 两种备份包的库文件名不同，挑错了就是"拿别的库覆盖自己"。
 * 这条规则是本次适配的核心，单独钉死。
 */
describe("restore-types · 从包里挑主库", () => {
    it("应用内导出的包：wn-日期.db", () => {
        expect(pickMainDb(["wn-2026-10-24.db"])).toBe("wn-2026-10-24.db");
    });

    it("宿主机每周自动备份：dev.db", () => {
        expect(pickMainDb(["dev.db"])).toBe("dev.db");
    });

    it("两个都在 ⇒ 带日期的优先（那是应用内导出的、带配置的整包）", () => {
        expect(pickMainDb(["dev.db", "wn-2026-10-24.db"])).toBe("wn-2026-10-24.db");
        // 顺序不影响结果
        expect(pickMainDb(["wn-2026-10-24.db", "dev.db"])).toBe("wn-2026-10-24.db");
    });

    it("只有一个不认识的 .db ⇒ 用它（老版本的包可能叫别的）", () => {
        expect(pickMainDb(["backup.db"])).toBe("backup.db");
    });

    it("好几个不认识的 ⇒ 放弃，不猜", () => {
        expect(pickMainDb(["a.db", "b.db"])).toBeNull();
    });

    it("空数组 ⇒ null", () => {
        expect(pickMainDb([])).toBeNull();
    });

    it("日期格式不对的不算 wn-*（避免把 wn-latest.db 当主库）", () => {
        expect(pickMainDb(["wn-latest.db", "dev.db"])).toBe("dev.db");
    });

    it("大小写敏感：DEV.DB 不算 dev.db", () => {
        expect(pickMainDb(["DEV.DB"])).toBe("DEV.DB"); // 只有一个，仍然用它
        expect(pickMainDb(["DEV.DB", "dev.db"])).toBe("dev.db"); // 两个时认小写的
    });
});

describe("restore-types · 报告字段", () => {
    it("每个显示项都有对应的表名，且不重名", () => {
        const tables = SUMMARY_LABELS.map((l) => SUMMARY_TABLES[l.key]);
        expect(tables.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
        expect(new Set(tables).size).toBe(tables.length);
    });

    it("报告顺序固定：错题排第一（那是他最关心的）", () => {
        expect(SUMMARY_LABELS[0].key).toBe("errorItems");
    });

    it("确认词是「恢复」，不能被意外改掉", () => {
        expect(RESTORE_CONFIRM_WORD).toBe("恢复");
    });
});

/**
 * 应用内导出的包叫 `wn-backup-YYYY-MM-DD.tar.gz`（注意中间有 backup），
 * 早先只认 `wn-日期`，于是报告里"备份日期"一直显示 `?`。
 */
describe("restore-types · 备份日期", () => {
    it("三种名字都认", () => {
        expect(stampOfName("wn-backup-2026-10-24.tar.gz")).toBe("2026-10-24"); // 下载时的包名
        expect(stampOfName("wn-2026-10-24.db")).toBe("2026-10-24"); // 包里的库名
        expect(stampOfName("wn-2026-10-24.tar.gz")).toBe("2026-10-24"); // 宿主机每周备份
    });

    it("认不出就是 null，不瞎猜", () => {
        expect(stampOfName("dev.db")).toBeNull();
        expect(stampOfName("backup.tar.gz")).toBeNull();
        expect(stampOfName("")).toBeNull();
    });

    it("日期格式不对的不认", () => {
        expect(stampOfName("wn-backup-2026-1-5.tar.gz")).toBeNull();
    });
});
