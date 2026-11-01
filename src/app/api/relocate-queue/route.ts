/**
 * 标签归位队列的全局状态（给批量保存后用）。
 *
 * 为什么要有这个接口：
 *   批量保存十几道题之后，前端只知道自己发完请求了，不知道**后面还有几道在算**。
 *   他这时候会想"能不能关掉页面"——答案是能（队列在服务端跑），
 *   但得有个东西让他看见"确实还在跑、还有 3 道"。
 *
 * 队列是**进程级**的，不分用户 —— 本机单用户部署，够用。
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { relocateQueueState, isRelocateIdle } from "@/lib/ai/relocate-service";

const logger = createLogger('api:relocate-queue');

export async function GET() {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return unauthorized("Authentication required");

        const { current, waiting } = relocateQueueState();
        return NextResponse.json({
            current,
            waiting,
            /** true = 队列空了，标签都补完了 */
            idle: isRelocateIdle(),
        });
    } catch (e) {
        logger.error({ err: String(e) }, '读取归位队列状态失败');
        return internalError("Failed to read queue state");
    }
}
