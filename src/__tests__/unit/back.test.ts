/**
 * `lib/back.ts` —— "从哪来、回哪去"的统一做法。
 *
 * 这个文件最要紧的不是"能返回"，是**别把 back 变成一个开放重定向口子**：
 * 它可以被任何人写进地址栏，所以只认站内路径。
 */
import { describe, expect, it } from "vitest";
import { sanitizeBack, withBack, hasBackParam } from "@/lib/back";

describe("sanitizeBack：只认站内路径", () => {
    it("正常站内路径原样返回", () => {
        expect(sanitizeBack("/notebooks/abc")).toBe("/notebooks/abc");
        expect(sanitizeBack("/scan?vol=RE001&item=x")).toBe("/scan?vol=RE001&item=x");
    });

    it("外站一律拒绝", () => {
        expect(sanitizeBack("https://evil.com")).toBeNull();
        expect(sanitizeBack("http://evil.com/x")).toBeNull();
        // 协议相对：浏览器会当成 //evil.com，这是最常见的绕法
        expect(sanitizeBack("//evil.com")).toBeNull();
        expect(sanitizeBack("//evil.com/path")).toBeNull();
        // javascript: 伪协议
        expect(sanitizeBack("javascript:alert(1)")).toBeNull();
    });

    it("空值 / 超长拒绝", () => {
        expect(sanitizeBack(null)).toBeNull();
        expect(sanitizeBack(undefined)).toBeNull();
        expect(sanitizeBack("")).toBeNull();
        expect(sanitizeBack("/" + "a".repeat(4096))).toBeNull();
    });
});

describe("withBack：给入口挂来源", () => {
    it("没有 query 的路径用 ? 连接", () => {
        expect(withBack("/print-preview", "/notebooks/x")).toBe(
            "/print-preview?back=%2Fnotebooks%2Fx",
        );
    });

    it("已有 query 的路径用 & 连接", () => {
        expect(withBack("/print-preview?ids=1", "/notebooks/x")).toBe(
            "/print-preview?ids=1&back=%2Fnotebooks%2Fx",
        );
    });

    it("已经带 back 的不重复挂（防止 back 套娃）", () => {
        const once = withBack("/a", "/from");
        expect(withBack(once, "/other")).toBe(once);
    });

    it("来源里的 ? 和 & 会被转义，不会被当成新参数", () => {
        const out = withBack("/a", "/scan?vol=RE1&item=x");
        expect(out).toBe("/a?back=%2Fscan%3Fvol%3DRE1%26item%3Dx");
        // 解回来仍是原来那一条
        const back = new URLSearchParams(out.split("?")[1]).get("back");
        expect(back).toBe("/scan?vol=RE1&item=x");
    });
});

describe("hasBackParam", () => {
    it("认得出来", () => {
        expect(hasBackParam("/a?back=%2Fb")).toBe(true);
        expect(hasBackParam("/a?x=1&back=%2Fb")).toBe(true);
    });
    it("没有就是没有", () => {
        expect(hasBackParam("/a")).toBe(false);
        expect(hasBackParam("/a?x=1")).toBe(false);
    });
});
