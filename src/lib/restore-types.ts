/**
 * 【2026-10-24 空空】恢复功能 · 前后端共用的类型
 *
 * ── 为什么要单独一个文件 ──────────────────────────────────────────────
 * `lib/restore.ts` 里 import 了 Prisma（它要开库验数）。
 * 界面是跑在浏览器里的，引用那个文件会把整条数据库链路打进前端包 ——
 * 打不进去，编译直接炸。
 *
 * 但"恢复报告长什么样"这件事，**两边必须是同一个定义**，
 * 否则后端加一个字段、前端不认，界面上就少显示一行，而且不报错。
 *
 * 所以：类型放这里（零依赖），`restore.ts` 从这里取并 re-export。
 * 和 `lib/inbox-kinds.ts` 是同一个套路。
 */

/** 一张表的行数 */
export interface TableCount {
    name: string;
    rows: number;
}

/** 只列"真正是心血"的那几个数 —— 报告里就显示这些 */
export interface ContentSummary {
    errorItems: number;
    insights: number;
    insightPhotos: number;
    volumes: number;
    volumeItems: number;
    reviewEvents: number;
    users: number;
    tags: number;
}

/** `ContentSummary` 里每个字段对应的数据库表名 */
export const SUMMARY_TABLES: Record<keyof ContentSummary, string> = {
    errorItems: "ErrorItem",
    insights: "Insight",
    insightPhotos: "InsightPhoto",
    volumes: "ReviewVolume",
    volumeItems: "ReviewVolumeItem",
    reviewEvents: "ReviewEvent",
    users: "User",
    tags: "KnowledgeTag",
};

/** 报告里每一行的中文名（界面上按这个顺序排） */
export const SUMMARY_LABELS: { key: keyof ContentSummary; zh: string; en: string }[] = [
    { key: "errorItems", zh: "错题", en: "Questions" },
    { key: "insights", zh: "日积月累", en: "Accumulation" },
    { key: "insightPhotos", zh: "积累图片", en: "Accum. images" },
    { key: "volumes", zh: "复习卷", en: "Volumes" },
    { key: "volumeItems", zh: "卷里的题行", en: "Volume items" },
    { key: "reviewEvents", zh: "复习流水", en: "Review events" },
    { key: "tags", zh: "标签", en: "Tags" },
    { key: "users", zh: "账号", en: "Accounts" },
];

export interface RestorePlan {
    token: string;
    /** 备份日期（取自文件名 `wn-YYYY-MM-DD.db`） */
    stamp: string | null;
    dbSize: number;
    backup: ContentSummary;
    current: ContentSummary;
    /** 现在有、包里没有 ⇒ 备份更旧，迁移会补表 */
    missingInBackup: string[];
    /** 包里有、现在没有 ⇒ 备份更新，拒绝恢复 */
    extraInBackup: string[];
    hasConfig: boolean;
    warnings: string[];
}

/**
 * 从文件名里读备份日期。
 *
 * 三种名字都要认（前两种是同一个包在不同环节的名字）：
 *   · 下载时的包名     `wn-backup-2026-10-24.tar.gz`
 *   · 包里的库名       `wn-2026-10-24.db`
 *   · 宿主机每周备份   `wn-2026-10-24.tar.gz`（里面的库叫 `dev.db`）
 *
 * ⚠️ 早先只写了 `wn-日期`，于是应用内导出的包一律显示"备份日期 ?"——
 *    因为它的名字是 `wn-backup-…`，`wn-` 后面跟的是 backup。
 */
export function stampOfName(fileName: string): string | null {
    const m = /wn-(?:backup-)?(\d{4}-\d{2}-\d{2})/.exec(fileName);
    return m ? m[1] : null;
}

/**
 * 从包里的若干个 `.db` 文件名中挑出**主库**。
 *
 * 两种包的命名不一样，这是唯一需要"猜"的地方，所以单独抽出来测：
 *   · 应用内导出（`/api/export/snapshot`）：`wn-2026-10-24.db`
 *   · 宿主机每周自动备份（`backup.sh`）：`dev.db`
 *
 * 优先级：带日期的 > dev.db > 只有一个就用它 > 分不清了就放弃（返回 null）。
 * **宁可报错也不猜**：挑错了库去恢复，等于拿别人的数据覆盖自己。
 */
export function pickMainDb(names: readonly string[]): string | null {
    const dated = names.find((n) => /^wn-\d{4}-\d{2}-\d{2}\.db$/.test(n));
    if (dated) return dated;

    if (names.includes("dev.db")) return "dev.db";

    return names.length === 1 ? names[0] : null;
}

/** 这一步是不可逆的，所以要求用户亲手打这两个字（界面和服务端共用这一份） */
export const RESTORE_CONFIRM_WORD = "恢复";
