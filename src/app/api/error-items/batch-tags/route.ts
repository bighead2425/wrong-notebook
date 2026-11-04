/**
 * 【2026-11-04】**批量改标签** —— 给选中的 N 道题统一加/删标签。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────
 *   改标签原来只能一题一题进详情页。一道题挂错了册，得点几十次；
 *   而"这批题都该有同一个标签"是极常见的动作（一次整理一个单元）。
 *
 * ── 为什么是「加 / 删」，不是「覆盖」──────────────────────────
 *   覆盖太危险：一按下去那 23 道题原来的标签全没了，还没有撤销。
 *   "换标签" = 先加新的、再删旧的，两下做完，中间每一步都可控。
 *   这也是他原话"可以删除已有的标签，也给我一个框让我填写新的"的自然延伸。
 *
 * ── 为什么用 id 不是名字 ────────────────────────────────────────
 *   「小数减法」五上五下都有。按名字加，会把两册的题混到一个节点上。
 *   前端从标签树里选，拿到的是 id。
 *
 * Body: { ids: string[], add?: string[], remove?: string[] }
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger("api:error-items:batch-tags");

/** 一次最多改多少道 —— 与批量删除同一个量级（前端多选上限也在这里对齐） */
const MAX_ITEMS = 500;
/** SQLite 的 `IN (...)` 有变量上限，查询按批走 */
const CHUNK = 400;

const asIdArray = (v: unknown): string[] =>
    Array.isArray(v)
        ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim().length > 0))]
        : [];

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return unauthorized("Authentication required");

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return badRequest("请求格式不对");
    }

    const raw = (body ?? {}) as Record<string, unknown>;
    const ids = asIdArray(raw.ids);
    const add = asIdArray(raw.add);
    const remove = asIdArray(raw.remove);

    if (ids.length === 0) return badRequest("没选题目");
    if (ids.length > MAX_ITEMS) return badRequest(`一次最多改 ${MAX_ITEMS} 道（当前 ${ids.length} 道）`);
    if (add.length === 0 && remove.length === 0) return badRequest("没选要加或要删的标签");

    /* 同一个标签既加又删 —— 自相矛盾，直接拒，别让它产生"看顺序"的诡异结果 */
    const both = add.filter((id) => remove.includes(id));
    if (both.length > 0) return badRequest("同一个标签不能既加又删");

    try {
        /**
         * ① 归属校验：分片查，只留自己的题。
         *    别人的题一律跳过（不报错 —— 多选里混进别人的 id 时，
         *    整批失败会让他以为"这功能坏了"）。
         */
        const ownedIds: string[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const rows = await prisma.errorItem.findMany({
                where: { id: { in: chunk }, userId: session.user.id, deletedAt: null },
                select: { id: true },
            });
            ownedIds.push(...rows.map((r) => r.id));
        }
        if (ownedIds.length === 0) return badRequest("这些题都不在你的库里");

        /**
         * ② 标签也校验一次存在性（id 是前端从树上拿的，正常不会错；
         *    但接口是公开的，不能让"传个乱 id"把关联表写脏）。
         */
        const wantedTagIds = [...new Set([...add, ...remove])];
        const knownTags = await prisma.knowledgeTag.findMany({
            where: { id: { in: wantedTagIds } },
            select: { id: true, name: true },
        });
        const knownSet = new Set(knownTags.map((t) => t.id));
        const missing = wantedTagIds.filter((id) => !knownSet.has(id));
        if (missing.length > 0) return badRequest(`有 ${missing.length} 个标签不存在（可能已被删除）`);

        /**
         * ③ 逐题写关联。
         *    多对多关联不支持 `updateMany`，只能一条一条来；
         *    放在一个事务里 —— 中途失败就整批回滚，不会出现"改了一半"。
         */
        const result = await prisma.$transaction(
            ownedIds.map((id) =>
                prisma.errorItem.update({
                    where: { id },
                    data: {
                        tags: {
                            ...(add.length > 0 ? { connect: add.map((tagId) => ({ id: tagId })) } : {}),
                            ...(remove.length > 0 ? { disconnect: remove.map((tagId) => ({ id: tagId })) } : {}),
                        },
                        /**
                         * 人手动改过标签 ⇒ 把归位状态标成 done。
                         * 否则详情页可能还挂着"正在归位 / 让 AI 归位"，
                         * 而这时后台再跑一次会把人工结果覆盖掉（"人优先"必须留在数据库里）。
                         */
                        tagStatus: "done",
                    },
                }),
            ),
        );

        logger.info(
            { updated: result.length, add: add.length, remove: remove.length, skipped: ids.length - ownedIds.length },
            "批量改标签完成",
        );

        return NextResponse.json({
            updated: result.length,
            /** 请求里有、但不属于他的（正常应该是 0） */
            skipped: ids.length - ownedIds.length,
            addNames: knownTags.filter((t) => add.includes(t.id)).map((t) => t.name),
            removeNames: knownTags.filter((t) => remove.includes(t.id)).map((t) => t.name),
        });
    } catch (error) {
        logger.error({ error }, "批量改标签失败");
        return internalError("批量改标签失败，已全部回滚");
    }
}
