import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { badRequest, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:clear');

/**
 * DELETE /api/error-items/clear —— **清空当前用户的全部错题**（硬删，进不了回收箱）。
 *
 * ⚠️【2026-10-29 审计修复】原来这条是"登录了就能删光"，服务端**零确认**：
 *    一个手滑的 `apiClient.delete(url)`、或任何能带上会话的东西调一下，
 *    103 道题连同复习流水一起没了（SQLite 没有按时间点回滚，只能整库恢复）。
 *
 * 改法（**保持硬删语义不变**）：
 *   ① 必须带 `{ confirm: true }` —— 裸 DELETE 直接 400。
 *      为什么不改成软删：他要的就是"彻底清空"，软删之后"清了还在回收箱"是另一种 bug；
 *   ② 把**删了多少条**回给前端，界面上能说"已删除 103 道"，而不是只弹一句"成功"；
 *   ③ 顺手去掉 `@ts-ignore`（原来靠它绕过 `session.user.id` 的类型缺口）：
 *      显式断言 + 判空，比 `@ts-ignore` 安全——它至少会在真的没有 id 时拒绝，而不是传个 undefined 进 where。
 */
export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    const userId = (session.user as { id?: string }).id;
    if (!userId) {
        return unauthorized("Authentication required");
    }

    /* 裸 DELETE（没有 body / 没有 confirm）一律拒绝 —— 这是"误触"与"真要点"的分界线 */
    const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (body?.confirm !== true) {
        return badRequest("清空全部错题需要显式确认（请求体带 confirm: true）");
    }

    try {
        // 只删当前用户的（硬删：与全局"删除进回收箱"的约定不同，这里是"清空"）
        const result = await prisma.errorItem.deleteMany({
            where: { userId }
        });

        logger.warn({ userId, deleted: result.count }, 'All error items cleared by user');

        return NextResponse.json({
            message: "Error data cleared successfully",
            /** 删了多少条 —— 前端用它回显，别只说"成功" */
            deleted: result.count,
        });
    } catch (error) {
        logger.error({ error }, 'Error clearing error data');
        return internalError("Failed to clear error data");
    }
}
