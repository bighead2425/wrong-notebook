import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { planLink, planPromote, planRestore, planUnlink, roleOf, type LinkNode } from "@/lib/item-link";
// 碰数据库那一半抽在 lib 里共用（PATCH 的"已掌握"也要用同一套装载/写库/留痕）
import {
    applyLinkOps,
    lastDetachedFrom,
    loadLinkNodes,
    resolveOwnedItem,
} from "@/lib/item-link-store";

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
        const resolve = async (v: unknown) => resolveOwnedItem(user.id, v);
        /**
         * 参与判定的题：**两道题 + 各自的主题 + 各自的附题（含兄弟）**。
         * ⚠️ 装在 `lib/item-link-store.ts` 里，与 PATCH 的"已掌握"共用同一套
         *    —— 少装一层就会在库里造出"附题的附题"，而规则层看不见它。
         */
        const loadTree = async (seeds: (string | null)[]): Promise<LinkNode[]> =>
            loadLinkNodes(user.id, seeds.filter((x): x is string => !!x));

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
            await applyLinkOps(user.id, plan.ops);
            const after = await loadTree([child.id, target.id]);
            return NextResponse.json({ ok: true, message: plan.message, state: stateOf(after) });
        }

        if (action === "linkGroup") {
            /**
             * 【2026-10-10】批量建立关联（列表页"多选 → 建立关联"用）。
             * 语义：`root` 那道当**主题**，`children` 全部挂到它名下。
             *
             * ⚠️ 逐条调用**同一个规则**（`planLink`），而且**每条之后重新装载一次**数据 ——
             *    前一条可能刚把一整棵小树并了过来，拿旧快照算第二条就会漏
             *    （老规矩：规则只写一处，且喂给它的数据必须是当下这一刻的）。
             * ⚠️ 传 `chooseRootId = root`：他已经明确指定了主题，所以两边都是主题时也不要停下来问。
             * ⚠️ 一次最多 20 条 —— 这是"人点一下"的批处理，不是导入接口。
             */
            const rawChildren = Array.isArray(raw.children) ? raw.children : [];
            if (!rawChildren.length) return badRequest("children is required");
            if (rawChildren.length > 20) return badRequest("一次最多关联 20 道题");

            const root = await resolve(raw.root ?? raw.target ?? raw.targetId);
            if (!root) return NextResponse.json({ ok: false, message: "主题那道题找不到（可能已被删除）" });

            const linked: string[] = [];
            const failed: { no: string; message: string }[] = [];
            for (const candidate of rawChildren) {
                const child = await resolve(candidate);
                if (!child) {
                    failed.push({ no: String(candidate), message: "这道题找不到（可能已被删除）" });
                    continue;
                }
                if (child.id === root.id) continue;

                const nodes = await loadTree([child.id, root.id]);
                const plan = planLink(nodes, child.id, root.id, root.id);
                if (!plan.ok || plan.choice) {
                    failed.push({ no: child.source || child.id, message: plan.message });
                    continue;
                }
                await applyLinkOps(user.id, plan.ops);
                linked.push(child.source || child.id);
            }

            const after = await loadTree([root.id]);
            return NextResponse.json({
                ok: true,
                message: linked.length
                    ? `已把 ${linked.length} 道题挂到「${root.source || root.id}」名下。`
                    : "没有需要新挂的题。",
                linked,
                failed,
                state: stateOf(after),
            });
        }

        /** 另外三个动作都只需要一道题 */        const one = await resolve(raw.id ?? raw.itemId ?? raw.child ?? raw.childId);
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
        await applyLinkOps(user.id, plan.ops);
        const after = await loadTree([one.id]);
        return NextResponse.json({ ok: true, message: plan.message, state: stateOf(after) });
    } catch (error) {
        logger.error({ error, action }, "Failed to change item link");
        return internalError("Failed to change item link");
    }
}

/** 把那棵树现在的样子回给前端（题号 / 角色 / 挂谁），界面据此直接刷新 */
function stateOf(nodes: LinkNode[]) {
    return nodes
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((n) => ({ id: n.id, no: n.no, parentId: n.parentId, role: roleOf(nodes, n.id) }));
}
