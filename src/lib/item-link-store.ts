import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { planMastery } from "@/lib/item-link";
import type { LinkCard, LinkNode, LinkOp, LinkRole, LinkView } from "@/lib/item-link";

/**
 * 【2026-10-10】题间从属关系的**数据库那一半**（规则在 `lib/item-link.ts`，纯函数）。
 *
 * 为什么单独一个文件：这套东西有**两个入口** ——
 *   ① `POST /api/error-items/link`（建立/取关/升变/恢复）；
 *   ② `PATCH /api/error-items/[id]`（"已掌握"要触发断开与传播）。
 * 两个入口共用同一套"装载 + 写库 + 留痕"，抽出来才不会再写第二份
 * —— 老规矩：规则只写一处，碰数据库的那层也一样。
 */

type ItemRow = {
    id: string;
    source: string | null;
    parentId: string | null;
    createdAt: Date;
    masteryLevel: number;
};

const SELECT = {
    id: true,
    source: true,
    parentId: true,
    createdAt: true,
    masteryLevel: true,
} as const;

export function toLinkNode(r: ItemRow): LinkNode {
    return {
        id: r.id,
        /** ⚠️ 老题可能没有题号 ⇒ 用 id 兜底（与打印那边 `source || id` 同一口径） */
        no: r.source || r.id,
        parentId: r.parentId,
        createdAt: r.createdAt.toISOString(),
        mastered: r.masteryLevel === 2,
    };
}

/** 把界面上给的"题号或 id"换成库里那一道题（必须属于当前用户、未软删） */
export async function resolveOwnedItem(userId: string, v: unknown): Promise<ItemRow | null> {
    const key = typeof v === "string" ? v.trim() : "";
    if (!key) return null;
    return prisma.errorItem.findFirst({
        where: { userId, deletedAt: null, OR: [{ id: key }, { source: key }] },
        select: SELECT,
    });
}

/**
 * 装载"参与判定的那一片"数据：这些题 + 各自的主题 + 各自名下的附题 + 主题的兄弟附题。
 *
 * 为什么连"兄弟"也要装：升变与"整棵并入"时兄弟附题要一起改挂，
 * 少装一层就会在库里造出"附题的附题"（而规则层是看不见它的，因为喂给它的数据本来就缺）。
 */
export async function loadLinkNodes(userId: string, seedIds: readonly string[]): Promise<LinkNode[]> {
    const ids = [...new Set(seedIds.filter(Boolean))];
    if (!ids.length) return [];
    const base: Prisma.ErrorItemWhereInput = { userId, deletedAt: null };

    const direct = await prisma.errorItem.findMany({ where: { ...base, id: { in: ids } }, select: SELECT });
    const parentIds = direct.map((d) => d.parentId).filter((v): v is string => !!v);
    const roots = parentIds.length
        ? await prisma.errorItem.findMany({ where: { ...base, id: { in: parentIds } }, select: SELECT })
        : [];
    const kidRows = await prisma.errorItem.findMany({
        where: { ...base, parentId: { in: [...ids, ...roots.map((r) => r.id)] } },
        select: SELECT,
    });

    const byId = new Map<string, LinkNode>();
    for (const r of [...direct, ...roots, ...kidRows]) byId.set(r.id, toLinkNode(r));
    return [...byId.values()];
}

/** 写库：逐条改 parentId，并**留痕**（"一键恢复关联"与排查都靠它） */
export async function applyLinkOps(userId: string, ops: readonly LinkOp[]): Promise<void> {
    if (!ops.length) return;
    const ids = ops.map((o) => o.id);
    /** ⚠️ 只改**自己的**题（ops 来自按 userId 过滤后的数据，这里是第二道闸） */
    const owned = await prisma.errorItem.findMany({
        where: { userId, id: { in: ids } },
        select: { id: true, parentId: true },
    });
    const ownedIds = new Set(owned.map((o) => o.id));
    const fromById = new Map(owned.map((o) => [o.id, o.parentId]));

    await prisma.$transaction(
        ops
            .filter((o) => ownedIds.has(o.id))
            .flatMap((o) => [
                prisma.errorItem.update({ where: { id: o.id }, data: { parentId: o.parentId } }),
                prisma.stateChangeLog.create({
                    data: {
                        errorItemId: o.id,
                        field: "parentId",
                        fromValue: fromById.get(o.id) ?? null,
                        toValue: o.parentId,
                        actor: "user",
                        actorUserId: userId,
                        note: "题间从属关系变动（主题/附题）",
                    } satisfies Prisma.StateChangeLogUncheckedCreateInput,
                }),
            ]),
    );
}

/* ------------------------------------------------------------------ */
/* 写：改"已掌握"要连带做的从属关系动作                                  */
/* ------------------------------------------------------------------ */

/**
 * 给"改成已掌握 / 改回未掌握"算一遍**从属关系**要连带做的事。
 *
 * ⚠️ 为什么单独一个函数：**会改掌握状态的入口有两个** ——
 *   ① `PATCH /api/error-items/[id]`（保存表单，表单里带 masteryLevel）；
 *   ② `PATCH /api/error-items/[id]/mastery`（卡片与详情页那个"已掌握"按钮）。
 *    不抽出来就是同一套规则抄两份，两处迟早不一致。
 *
 * ⚠️ **必须在写库之前调用**：规则看的是"现在是不是已掌握"，值没变就什么都不做
 *    （同一份表单重复提交不该反复触发断开、也不该刷出一堆假留痕）。
 * ⚠️ 只**规划**不写库：主字段、关系改动、向下传播三者的写入顺序由调用方决定。
 */
export async function planMasteryChange(
    userId: string,
    itemId: string,
    nextMastered: boolean,
): Promise<{ ops: LinkOp[]; propagateIds: string[]; message: string }> {
    const empty = { ops: [] as LinkOp[], propagateIds: [] as string[], message: "" };
    const nodes = await loadLinkNodes(userId, [itemId]);
    const self = nodes.find((n) => n.id === itemId);
    if (!self || self.mastered === nextMastered) return empty;
    const plan = planMastery(nodes, itemId, nextMastered, { manual: true });
    return {
        ops: plan.ops,
        /** 要跟着改状态的（= 主题名下的附题，去掉它自己） */
        propagateIds: plan.masteryIds.filter((x) => x !== itemId),
        message: plan.message,
    };
}

/**
 * 找"当初被断开时挂在谁下面" —— 恢复关联的唯一依据。
 *
 * ⚠️ 只看 `field='parentId' && toValue IS NULL` 的**最后一条**：
 *    那正是"人工标已掌握 ⇒ 断开"留下的那条。别去翻更早的账（那是别的操作留下的）。
 */
export async function lastDetachedFrom(userId: string, itemId: string): Promise<string | null> {
    const row = await prisma.stateChangeLog.findFirst({
        where: { errorItemId: itemId, field: "parentId", toValue: null, actorUserId: userId },
        orderBy: { createdAt: "desc" },
        select: { fromValue: true },
    });
    return row?.fromValue ?? null;
}

/**
 * 批量改"已掌握"状态并留痕（供"主题标已掌握 ⇒ 附题跟着标"那条规则用）。
 *
 * ⚠️ 只改**真的变了**的：同一个值重复提交不该反复写库、也不该刷出一堆假留痕。
 */
export async function applyMastery(
    userId: string,
    ids: readonly string[],
    mastered: boolean,
    opts: { excludeId?: string } = {},
): Promise<number> {
    const targets = [...new Set(ids)].filter((x) => x !== opts.excludeId);
    if (!targets.length) return 0;
    const rows = await prisma.errorItem.findMany({
        where: { userId, id: { in: targets }, deletedAt: null },
        select: { id: true, masteryLevel: true },
    });
    const next = mastered ? 2 : 0;
    const changed = rows.filter((r) => r.masteryLevel !== next);
    if (!changed.length) return 0;

    await prisma.$transaction(
        changed.flatMap((r) => [
            prisma.errorItem.update({ where: { id: r.id }, data: { masteryLevel: next } }),
            prisma.stateChangeLog.create({
                data: {
                    errorItemId: r.id,
                    field: "masteryLevel",
                    fromValue: String(r.masteryLevel),
                    toValue: String(next),
                    actor: "user",
                    actorUserId: userId,
                    note: "主题的已掌握状态向下传播",
                } satisfies Prisma.StateChangeLogUncheckedCreateInput,
            }),
        ]),
    );
    return changed.length;
}

/* ------------------------------------------------------------------ */
/* 读：详情页要的"这道题在从属关系里的样子"                              */
/* ------------------------------------------------------------------ */

/**
 * 关联卡片要显示的字段。
 * ⚠️ **刻意不带 `originalImageUrl`**：那是 data URL（几百 KB 一条），
 *    而这批卡片只显示题干摘要 + 几个徽章 —— 一次带三张就把详情页拖慢。
 *    真要看图点进那道题自己的详情页。
 */
const CARD_SELECT = {
    id: true,
    source: true,
    questionText: true,
    masteryLevel: true,
    createdAt: true,
    manageType: true,
    mistakeCategory: true,
    attention: true,
    printCount: true,
    reviewPrintCount: true,
    reviewOutcomes: true,
    knowledgePoints: true,
    parentId: true,
    deepNudgeDismissed: true,
    tags: { select: { id: true, name: true } },
} as const;

type CardRow = Prisma.ErrorItemGetPayload<{ select: typeof CARD_SELECT }>;

/** 库里的行 → 界面用的卡片（`createdAt` 统一成 ISO，免得客户端拿到 Date 又被序列化一次） */
function toCard(r: CardRow): LinkCard {
    return { ...r, createdAt: r.createdAt.toISOString() };
}

/**
 * 取"这道题在从属关系里的样子"：角色 + 主题 + 附题（+ 可恢复的原主题）。
 *
 * 只读一次、只读一小片（我自己 + 我的主题 + 我的附题），**不做全表扫描** ——
 * 这个函数会被详情页每打开一道题就调一次。
 */
export async function loadLinkView(userId: string, itemId: string): Promise<LinkView | null> {
    const self = await prisma.errorItem.findFirst({
        where: { id: itemId, userId, deletedAt: null },
        select: { id: true, parentId: true, masteryLevel: true },
    });
    if (!self) return null;

    const parentRow = self.parentId
        ? await prisma.errorItem.findFirst({
              where: { id: self.parentId, userId, deletedAt: null },
              select: CARD_SELECT,
          })
        : null;
    const parent = parentRow ? toCard(parentRow) : null;

    /** 附题不用列附题（深度只有一层）；主题才列 */
    const childRows = self.parentId
        ? []
        : await prisma.errorItem.findMany({
              where: { userId, parentId: self.id, deletedAt: null },
              orderBy: { createdAt: "asc" },
              select: CARD_SELECT,
          });
    const children = childRows.map(toCard);

    const role: LinkRole = self.parentId ? "child" : children.length ? "root" : "lone";

    /**
     * "曾经挂在哪" —— **只有"孤题且已掌握"才去查**：那正是"人工标已掌握 ⇒ 断开"留下的痕迹。
     * 平时（绝大多数题）一次都不多查。
     */
    let detachedFrom: LinkCard | null = null;
    if (role === "lone" && self.masteryLevel === 2) {
        const from = await lastDetachedFrom(userId, self.id);
        if (from) {
            const row = await prisma.errorItem.findFirst({
                where: { id: from, userId, deletedAt: null },
                select: CARD_SELECT,
            });
            detachedFrom = row ? toCard(row) : null;
        }
    }

    return { role, parent, children, detachedFrom };
}
