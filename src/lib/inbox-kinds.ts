/**
 * 【2026-10-24】收件箱「三种用途」的**共享定义** —— 服务端和界面都从这里取。
 *
 * ── 为什么单独开一个文件 ────────────────────────────────────────────────
 * 这些常量原来写在 `lib/scan-inbox.ts` 里，而那个文件第一行就是
 * `import fs from "fs/promises"`。设置页是**浏览器里跑的**组件，
 * 它一旦去 import 那个文件，整个 Node 的文件系统模块就会被拉进客户端包
 * （直接构建失败），所以界面那边只能把常量**再抄一遍**。
 *
 * 抄两遍的代价不是"多打几个字"，而是：将来加第四种用途（比如"试卷宝"），
 * 改了一处忘了另一处 —— **不会报错**，只是那个槽位在设置页里根本不出现，
 * 或者出现了但保存到别的键上。这种错很难当场发现。
 *
 * ⚠️ 这个文件必须**永远保持零依赖**：不许 import 任何项目内的 lib、
 *    不许 import `fs` / `path` / `crypto` 之类的 Node 内置模块。
 *    它一旦带上服务端依赖，客户端就又炸 —— 而且报的错和这个文件
 *    看起来毫无关系（会说某某 node 模块找不到），极难查。
 */

/** 三种用途：录错题 / 回录分析 / PDF 中转 */
export type InboxKind = "wrong" | "recover" | "pdf";

/** 遍历顺序（设置页按它排布，顺序决定界面上下） */
export const INBOX_KINDS: readonly InboxKind[] = ["wrong", "recover", "pdf"] as const;

/** 三个槽位的出厂默认名（沿用既有约定，老用户升级后不用做任何事） */
export const DEFAULT_INBOX_SUBPATHS: Record<InboxKind, string> = {
    wrong: "scan2wrong",
    recover: "scan2recover",
    pdf: "scan2pdf",
};

/**
 * 老的单数形式，只为兼容既有 import 保留。
 * 语义是"录错题那一槽"的默认名（历史上只有这一个目录）。
 */
export const DEFAULT_INBOX_SUBPATH = DEFAULT_INBOX_SUBPATHS.wrong;

/**
 * 「出厂默认名 → 槽位」反查表。
 *
 * 为什么需要它：老调用方（`/recover` 页、`/batch?dir=scan2pdf`）是**按名字**传参的
 * （`subPath="scan2recover"`），压根不认识"槽位"这个概念。有了这张表，
 * 它们一行都不用改 —— 传 `scan2recover` 就自动落到 recover 槽的**当前值**上，
 * 于是"在设置页里改目录"对老代码也立刻生效。
 *
 * ⚠️ 这张表只在**入口**用一次（`getInboxLocation` 解析传参那一步）。
 *    内部函数一律收"已解析好的路径"，别再拿名字回查一遍 —— 否则一旦某个槽
 *    的值恰好等于别人的出厂名，就会多绕一道，把路径指到隔壁去。
 */
export const KIND_BY_LEGACY_NAME: Record<string, InboxKind> = {
    scan2wrong: "wrong",
    scan2recover: "recover",
    scan2pdf: "pdf",
};

/** 按名字查槽位；不是出厂名就返回 null */
export function inboxKindOfName(name: string | null | undefined): InboxKind | null {
    if (!name) return null;
    const hit = KIND_BY_LEGACY_NAME[name];
    return hit ?? null;
}

/** 子路径最大长度，防止有人塞一个超长字符串进来刷日志 */
const MAX_SUBPATH_LENGTH = 200;

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
 * 某个槽位「按界面上填的值」算出的生效目录名（空 = 用出厂默认）。
 *
 * 这是给**设置页**看的：那边拿不到配置，只有输入框里的字符串。
 */
export function effectiveSubPathOf(kind: InboxKind, value: string | null | undefined): string {
    return normalizeSubPath(value) ?? DEFAULT_INBOX_SUBPATHS[kind];
}

/** 设置页要提示的一条提醒 */
export type InboxDirWarning =
    | {
          /** 两个槽指向了同一个文件夹 —— 三条流水线会互相看见对方的照片 */
          type: "same-dir";
          kinds: InboxKind[];
          path: string;
      }
    | {
          /** 填的是别人的出厂名 —— 不算错，但看名字容易自己绕进去 */
          type: "borrowed-name";
          kind: InboxKind;
          name: string;
          owner: InboxKind;
      };

/**
 * 检查三个框有没有填出"自己会绊自己"的组合。
 *
 * 两类：
 *   ① **同名**：两个槽最后落在同一个文件夹。这才是真问题 ——
 *      录错题的界面里会冒出回录的卷子，两边互相把对方的文件标成"已导入"。
 *   ② **借名**：某个槽填的正好是别人的出厂名（比如「录错题」填 `scan2pdf`）。
 *      如果对方还叫原名，① 会同时命中；如果对方已经改了名，这里只剩一个
 *      "名字看着像别人的"的观感问题 —— 所以分成两级，提示语也分开写。
 *
 * 纯函数、无副作用：设置页每次输入都能直接调，不用等保存。
 */
export function analyzeInboxDirs(
    dirs: Record<InboxKind, string | null | undefined>,
): InboxDirWarning[] {
    const warnings: InboxDirWarning[] = [];
    const effective = new Map<InboxKind, string>();
    for (const kind of INBOX_KINDS) {
        effective.set(kind, effectiveSubPathOf(kind, dirs[kind]));
    }

    // ① 指向同一目录
    const seen = new Map<string, InboxKind[]>();
    for (const kind of INBOX_KINDS) {
        const p = effective.get(kind)!;
        const list = seen.get(p);
        if (list) list.push(kind);
        else seen.set(p, [kind]);
    }
    for (const [p, kinds] of seen) {
        if (kinds.length > 1) warnings.push({ type: "same-dir", kinds, path: p });
    }

    // ② 借了别人的出厂名
    //    同一个路径如果已经按 ① 说过"你俩撞一起了"，就不再补一句"这名字是别人的"——
    //    同一件事讲两遍，读者反而要花力气分辨这是两个问题还是一个。
    const reported = new Set(
        warnings
            .filter((w): w is Extract<InboxDirWarning, { type: "same-dir" }> => w.type === "same-dir")
            .map((w) => w.path),
    );
    for (const kind of INBOX_KINDS) {
        const p = effective.get(kind)!;
        if (reported.has(p)) continue;
        const owner = inboxKindOfName(p);
        if (owner && owner !== kind) {
            warnings.push({ type: "borrowed-name", kind, name: p, owner });
        }
    }

    return warnings;
}
