import { describe, it, expect } from "vitest";
import {
    analyzeInboxDirs,
    effectiveSubPathOf,
    inboxKindOfName,
    normalizeSubPath,
    DEFAULT_INBOX_SUBPATHS,
    INBOX_KINDS,
    type InboxKind,
} from "@/lib/inbox-kinds";

/**
 * 【2026-10-24】收件箱三槽的"共享定义" + 撞车检测。
 *
 * 为什么这些用例值得写：常量从 `lib/scan-inbox.ts` 搬出来，是为了让设置页
 * 也能 import（那个文件带 `fs`，浏览器端用不了）。搬家本身没改行为，
 * 但 `analyzeInboxDirs` 是**新逻辑**，它出错的表现是"界面上少一句提示"
 * —— 不会崩、不会报错，只会让人在两个槽指向同一目录时毫无察觉。
 *
 * 所以这里要钉的不是"提示好不好看"，而是**什么时候必须提示**。
 */

const dirs = (v: Partial<Record<InboxKind, string>>): Record<InboxKind, string> => ({
    wrong: "",
    recover: "",
    pdf: "",
    ...v,
});

describe("inbox-kinds：出厂名反查", () => {
    it("认得三个出厂名", () => {
        expect(inboxKindOfName("scan2wrong")).toBe("wrong");
        expect(inboxKindOfName("scan2recover")).toBe("recover");
        expect(inboxKindOfName("scan2pdf")).toBe("pdf");
    });

    it("自定义名、空值、乱入的类型都返回 null", () => {
        expect(inboxKindOfName("数学")).toBeNull();
        expect(inboxKindOfName("")).toBeNull();
        expect(inboxKindOfName(undefined)).toBeNull();
        expect(inboxKindOfName(null)).toBeNull();
    });

    it("三个槽的默认名互不相同（撞车检测的前提）", () => {
        const names = INBOX_KINDS.map((k) => DEFAULT_INBOX_SUBPATHS[k]);
        expect(new Set(names).size).toBe(names.length);
    });
});

describe("inbox-kinds：空框算默认值", () => {
    it("留空 ⇒ 用该槽的出厂默认名", () => {
        for (const k of INBOX_KINDS) {
            expect(effectiveSubPathOf(k, "")).toBe(DEFAULT_INBOX_SUBPATHS[k]);
            expect(effectiveSubPathOf(k, "   ")).toBe(DEFAULT_INBOX_SUBPATHS[k]);
            expect(effectiveSubPathOf(k, undefined)).toBe(DEFAULT_INBOX_SUBPATHS[k]);
        }
    });

    it("不合法写法也退回避的默认名（界面上不会出现空路径）", () => {
        expect(effectiveSubPathOf("wrong", "/etc")).toBe(DEFAULT_INBOX_SUBPATHS.wrong);
        expect(effectiveSubPathOf("pdf", "../x")).toBe(DEFAULT_INBOX_SUBPATHS.pdf);
    });

    it("自定义名原样生效", () => {
        expect(effectiveSubPathOf("recover", " 回录 ")).toBe("回录");
    });
});

describe("inbox-kinds：撞车检测", () => {
    it("三个都留空 = 各用各的默认 ⇒ 没有警告", () => {
        expect(analyzeInboxDirs(dirs({}))).toEqual([]);
    });

    it("默认名都填上（等于留空）⇒ 还是没有警告", () => {
        expect(
            analyzeInboxDirs(dirs({ wrong: "scan2wrong", recover: "scan2recover", pdf: "scan2pdf" })),
        ).toEqual([]);
    });

    it("两个槽填成同一个自定义目录 ⇒ 一条 same-dir，报出涉及的两个槽", () => {
        const w = analyzeInboxDirs(dirs({ wrong: "数学", recover: "数学" }));
        expect(w).toHaveLength(1);
        expect(w[0].type).toBe("same-dir");
        if (w[0].type === "same-dir") {
            expect(w[0].path).toBe("数学");
            expect(w[0].kinds.sort()).toEqual(["recover", "wrong"]);
        }
    });

    it("填了别人的出厂名、而对方还是原名 ⇒ 只说一句（不重复报 borrowed）", () => {
        // 录错题填 scan2pdf，PDF 中转留空（= scan2pdf）⇒ 两者撞一起
        const w = analyzeInboxDirs(dirs({ wrong: "scan2pdf" }));
        expect(w).toHaveLength(1);
        expect(w[0].type).toBe("same-dir");
    });

    it("填了别人的出厂名、但对方已改名 ⇒ 改报 borrowed-name", () => {
        const w = analyzeInboxDirs(dirs({ wrong: "scan2pdf", pdf: "pdf中转" }));
        expect(w).toHaveLength(1);
        expect(w[0].type).toBe("borrowed-name");
        if (w[0].type === "borrowed-name") {
            expect(w[0].kind).toBe("wrong");
            expect(w[0].owner).toBe("pdf");
            expect(w[0].name).toBe("scan2pdf");
        }
    });

    it("自己的出厂名不算借名", () => {
        expect(analyzeInboxDirs(dirs({ wrong: "scan2wrong" }))).toEqual([]);
    });

    it("带斜杠/空白的写法归一化后再比 —— 看着不同其实同一个目录", () => {
        const w = analyzeInboxDirs(dirs({ wrong: "数学/", recover: " 数学 " }));
        expect(w).toHaveLength(1);
        expect(w[0].type).toBe("same-dir");
    });

    it("三个全撞一起 ⇒ 一条 warning 里含三个槽（不是三条）", () => {
        const w = analyzeInboxDirs(dirs({ wrong: "x", recover: "x", pdf: "x" }));
        expect(w).toHaveLength(1);
        if (w[0].type === "same-dir") expect(w[0].kinds).toHaveLength(3);
    });
});

describe("inbox-kinds：normalizeSubPath 仍是那道闸", () => {
    it("挡绝对路径、上级目录、隐藏目录", () => {
        expect(normalizeSubPath("/etc")).toBeNull();
        expect(normalizeSubPath("../../config")).toBeNull();
        expect(normalizeSubPath(".hidden")).toBeNull();
    });

    it("反斜杠与重复分隔符归一化", () => {
        expect(normalizeSubPath("a\\b//c")).toBe("a/b/c");
    });
});
