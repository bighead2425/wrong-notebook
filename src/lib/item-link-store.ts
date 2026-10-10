import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { LinkNode, LinkOp } from "@/lib/item-link";

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
