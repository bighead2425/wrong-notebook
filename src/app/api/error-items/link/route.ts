import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import {
    planLink,
    planPromote,
    planRestore,
    planUnlink,
    roleOf,
    type LinkNode,
    type LinkOp,
} from "@/lib/item-link";

const logger = createLogger("api:error-items:link");

/**
 * POST /api/error-items/link —— 题间**从属关系**（主题 / 附题）的唯一写入口。
 *
 * 【2026-10-10】他要的东西：两道题考点一致（甚至只是题干变了变）⇒ 一道当主题、
 * 其余当附题挂上去；以后模仿纸就是"照着主题的答案和解析去做附题"。
 *
 * ── 为什么四个动作合成一个路由 ──────────────────────────────────────
 * 它们共用**同一套装载 + 同一套规则 + 同一套留痕**（规则全在 `lib/item-link.ts`）。
 * 拆成四个路由 = 那套逻辑抄四遍，迟早有一遍先被改。动作用 `action` 区分：
 *   · `link`    建立关联（`child` 挂到 `target` 那棵树下；两边都是主题时要他拍板）
 *   · `unlink`  取关（附题变孤题）
 *   · `promote` 升变（附题顶掉原主题，原主题降为附题）
 *   · `restore` 一键恢复（人工标已掌握断开的那些，写回原主题 —— 依据留痕，不翻旧账）
 *
 * Body（题号与 id 都收：**他在界面上说的是题号**，扫出来的也是题号）：
 *   `{ action, child?: string, childId?: string, target?, targetId?, chooseRootId? , id?/itemId? }`
 *   —— `child`/`target` 里可以给**题号或 id**，服务端自己认（认不出报"找不到"）。
 *
 * 返回：`{ ok, message, choice?, state }`
 *   · `choice` 非空 ⇒ **一个字都没写**，等他选"谁当主题"（前端弹选择框）。
 *   · `state` = 这次涉及的那棵树现在的样子（题号 / 角色 / 挂谁），前端直接照着刷新。
 */
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized("Authentication required");
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return unauthorized("Authentication required");

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return badRequest("Invalid JSON body");
    }
    const raw = (body ?? {}) as Record<string, unknown>;
    const action = String(raw.action ?? "").trim();
    const chooseRootId = typeof raw.chooseRootId === "string" ? raw.chooseRootId : undefined;

    try {
        /** 把"界面上的一个指代"（题号或 id）换成库里的题 */
        const resolve = async (v: unknown) => resolveItem(user.id, v);
        /**
         * 需要参与判定的题：**两道题 + 各自的主题 + 各自的附题**。
         * 只装这一片就够了 —— 规则只看"谁挂谁"，深度只有一层（见 lib/item-link.ts）。
         */
        const loadTree = async (seeds: (string | null)[]): Promise<LinkNode[]> => {
            const ids = new Set<string>();
            for (const s of seeds) if (s) ids.add(s);
            const direct = await prisma.errorItem.findMany({
                where: { userId: user.id, id: { in: [...ids] }, deletedAt: null },
                select: { id: true, source: true, parentId: true, createdAt: true, masteryLevel: true },
            });
            // 往上：各自的主题
            const parentIds = direct.map((d) => d.parentId).filter((v): v is string => !!v);
            // 往下：各自名下的附题
            const kidRows = await prisma.errorItem.findMany({
                where: { userId: user.id, parentId: { in: [...ids] }, deletedAt: null },
                select: { id: true, source: true, parentId: true, createdAt: true, masteryLevel: true },
            });
            const roots = await prisma.errorItem.findMany({
                where: { userId: user.id, id: { in: parentIds }, deletedAt: null },
                select: { id: true, source: true, parentId: true, createdAt: true, masteryLevel: true },
            });
            /** 主题的**兄弟附题**也要装（升变/并入时要一起改挂，否则会造出"附题的附题"） */
            const siblings = await prisma.errorItem.findMany({
                where: { userId: user.id, parentId: { in: roots.map((r) => r.id) }, deletedAt: null },
                select: { id: true, source: true, parentId: true, createdAt: true, masteryLevel: true },
            });
            const byId = new Map<string, LinkNode>();
            for (const r of [...direct, ...kidRows, ...roots, ...siblings]) {
                byId.set(r.id, toNode(r));
            }
            return [...byId.values()];
        };

        if (action === "link") {
            const child = await resolve(raw.child ?? raw.childId);
            const target = await resolve(raw.target ?? raw.targetId);
            if (!child || !target) {
                return NextResponse.json({ ok: false, message: "有一道题找不到（可能已被删除）" });
            }
            const nodes = await loadTree([child.id, target.id]);
            const plan = planLink(nodes, child.id, target.id, chooseRootId);
            if (plan.choice) {
                // 需要他拍板 ⇒ 一个字都不写
                return NextResponse.json({
                    ok: false,
                    message: plan.message,
                    choice: plan.choice,
                    state: stateOf(nodes),
                });
            }
            if (!plan.ok) return NextResponse.json({ ok: false, message: plan.message, state: stateOf(nodes) });
            await applyOps(user.id, plan.ops);
            const after = await loadTree([child.id, target.id]);
            return NextResponse.json({ ok: true, message: plan.message, state: stateOf(after) });
        }

        /** 另外三个动作都只需要一道题 */
        const one = await resolve(raw.id ?? raw.itemId ?? raw.child ?? raw.childId);
        if (!one) return NextResponse.json({ ok: false, message: "这道题找不到（可能已被删除）" });
        const nodes = await loadTree([one.id]);
        const plan =
            action === "unlink"
                ? planUnlink(nodes, one.id)
                : action === "promote"
                  ? planPromote(nodes, one.id)
                  : action === "restore"
                    ? planRestore(nodes, one.id, await lastDetachedFrom(user.id, one.id))
                    : null;

        if (!plan) return badRequest(`Unknown action: ${action || "(empty)"}`);
        if (!plan.ok) return NextResponse.json({ ok: false, message: plan.message, state: stateOf(nodes) });
        await applyOps(user.id, plan.ops);
        const after = await loadTree([one.id]);
        return NextResponse.json({ ok: true, message: plan.message, state: stateOf(after) });
    } catch (error) {
        logger.error({ error, action }, "Failed to change item link");
        return internalError("Failed to change item link");
    }
}

type ItemRow = {
    id: string;
    source: string | null;
    parentId: string | null;
    createdAt: Date;
    masteryLevel: number;
};

function toNode(r: ItemRow): LinkNode {
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
async function resolveItem(userId: string, v: unknown): Promise<ItemRow | null> {
    const key = typeof v === "string" ? v.trim() : "";
    if (!key) return null;
    const hit = await prisma.errorItem.findFirst({
        where: { userId, deletedAt: null, OR: [{ id: key }, { source: key }] },
        select: { id: true, source: true, parentId: true, createdAt: true, masteryLevel: true },
    });
    return hit;
}

/** 写库：逐条改 parentId，并**留痕**（恢复关联与排查都靠它） */
async function applyOps(userId: string, ops: LinkOp[]): Promise<void> {
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
async function lastDetachedFrom(userId: string, itemId: string): Promise<string | null> {
    const row = await prisma.stateChangeLog.findFirst({
        where: { errorItemId: itemId, field: "parentId", toValue: null, actorUserId: userId },
        orderBy: { createdAt: "desc" },
        select: { fromValue: true },
    });
    return row?.fromValue ?? null;
}

/** 把那棵树现在的样子回给前端（题号 / 角色 / 挂谁），界面据此直接刷新 */
function stateOf(nodes: LinkNode[]) {
    return nodes
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((n) => ({ id: n.id, no: n.no, parentId: n.parentId, role: roleOf(nodes, n.id) }));
}
