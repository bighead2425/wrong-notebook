import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, createErrorResponse, ErrorCode } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { chatVision } from "@/lib/ai/text-chat";
import { generateRecoverReviewPrompt } from "@/lib/ai/prompts";
import {
    classifyRecoveryCode,
    resolveRecoveryLookup,
    buildReviewPageMap,
    parseReviewReading,
    type RecoveryRow,
} from "@/lib/review-recover";

const logger = createLogger('api:recover:review');

/**
 * POST /api/recover/review —— **复练纸回录**（纸回录的第二步）。
 *
 * Body: `{ imageBase64, pageCode, language? }`，其中 `pageCode` 是纸上的页二维码
 * （形如 `RE20260926001-02`）。
 *
 * 做的事（与 `api/recover` 同一套写法，区别只在"地图"的来源）：
 *   ① 解页二维码 ⇒ 拿到「卷号 + 页码」；
 *   ② 按卷号把整卷取回来 ⇒ 挑出**这一页**的条目，拼成"版面地图"；
 *   ③ 把「照片 + 地图」交给 AI（`chatVision`），要它**在已知位置上读出她标的记号**
 *      （对 / 错 / 没标 / 看不清）—— **不是**让它判卷、不是让它做题；
 *   ④ `parseReviewReading` 把 AI 的标签读数解析成"每格她标了什么"。
 *
 * ⚠️ **只返回，不落库** —— 保存由客户端在用户校对后走
 *    `PATCH /api/review-volumes/[id]`（卷行标记）+ `PUT /api/error-items/[id]`（题目复习历史）。
 *    这样她能先在**校对表格**里改 AI 读错的格子，再确认保存。
 * ⚠️ **不碰等级 / 不改题目类型** —— 这一步只如实记录她标了什么。
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const pageCode = typeof body.pageCode === 'string' ? body.pageCode.trim() : '';
        const language: 'zh' | 'en' = body.language === 'en' ? 'en' : 'zh';
        const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';

        if (!pageCode) return badRequest("pageCode is required");
        if (!imageBase64) return badRequest("imageBase64 is required");

        const route = classifyRecoveryCode(pageCode);
        if (route.route !== 'review-page') {
            // 客户端本应按类型分流；这里再挡一道，免得"拿积累纸/错码"走到这条路上来
            return badRequest('这一页不是复练纸', {
                reason: route.route === 'build-page' ? 'build-page' : 'not-review',
            });
        }

        const volume = await prisma.reviewVolume.findUnique({
            where: { volumeNo: route.volumeNo },
            include: {
                items: {
                    orderBy: [{ seqInVolume: 'asc' }],
                    include: { errorItem: { select: { reviewOutcomes: true } } },
                },
            },
        });

        const items: RecoveryRow[] = (volume?.items ?? []).map((it) => ({
            rowId: it.id,
            pageIndex: it.pageIndex,
            columnIndex: it.columnIndex,
            seqInColumn: it.seqInColumn,
            seqInVolume: it.seqInVolume,
            itemNo: it.itemNo,
            questionText: it.questionText,
            errorItemId: it.errorItemId,
            markState: it.markState,
            reviewOutcomes: it.errorItem?.reviewOutcomes ?? null,
        }));

        const resolved = resolveRecoveryLookup(
            { volumeNo: route.volumeNo, pageNo: route.pageNo },
            { volume: volume ? { id: volume.id, volumeNo: volume.volumeNo, kind: volume.kind } : null, items },
        );
        if (resolved.status !== 'ready') {
            // 把结构化原因放进 details，客户端据此给出**具体**的提示（卷查不到 / 码不是本卷 / 这一页是空的）
            return badRequest('这一页打不开', { reason: resolved.reason, detail: resolved.detail });
        }

        const pageMap = buildReviewPageMap(resolved.rows);
        const system = generateRecoverReviewPrompt(pageMap, language);

        logger.info(
            { userId: user.id, volumeNo: resolved.volumeNo, pageNo: resolved.pageNo, rows: resolved.rows.length },
            'Calling AI for review-paper recover',
        );
        const raw = await chatVision({
            system,
            user: '请按上面的格式，读出这张复练纸上每一格她标的记号。',
            imageBase64,
            timeoutMs: 120000,
        });

        const reading = parseReviewReading(raw);

        logger.info(
            { userId: user.id, volumeNo: resolved.volumeNo, slots: Object.keys(reading.marksBySlot).length },
            'Review-paper recover succeeded',
        );
        return NextResponse.json({
            volumeId: resolved.volumeId,
            volumeNo: resolved.volumeNo,
            pageNo: resolved.pageNo,
            rows: resolved.rows,
            reading,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'Review-paper recover failed');

        let errorMessage = message || 'AI 分析失败';
        if (message.includes('AI_RESPONSE_ERROR') || message.includes('Zod') || message.includes('validate')) {
            errorMessage = 'AI_RESPONSE_ERROR';
        }
        return createErrorResponse(errorMessage, 500, ErrorCode.AI_ERROR, message);
    }
}
