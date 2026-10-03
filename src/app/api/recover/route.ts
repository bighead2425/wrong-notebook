import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, createErrorResponse, ErrorCode } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { chatVision } from "@/lib/ai/text-chat";
import { generateRecoverAnalysisPrompt } from "@/lib/ai/prompts";
import { getMistakeCategoryLabel } from "@/lib/mistake-category";
import { subjectLabel } from "@/lib/notebook-fields";
import {
    buildRecoverQuestionContext,
    parseRecoveryReading,
    composeRecoveryContent,
} from "@/lib/recover-analysis";

const logger = createLogger('api:recover');

/**
 * POST /api/recover —— **回录分析**（深挖纸回录）的第一步：读她手写的反思。
 *
 * Body: `{ imageBase64, errorItemNo, language? }`
 *
 * 做的事（跟着 `api/analyze` 的写法：图片 → AI → 结构化结果 → zod 校验）：
 *   ① 按**题号**把这道题找出来（题干当"地图"）；
 *   ② 把「照片 + 题干 + 学科 + 错因」一起交给 AI（`chatVision`），
 *      要它只依据照片整理成 `her_words` / `organized` / `unclear` 三段；
 *   ③ `parseRecoveryReading` 走 zod 校验，`composeRecoveryContent` 拼成 md 正文。
 *
 * ⚠️ **只返回，不落库** —— 日积月累的保存由客户端在用户校对后走 `POST /api/insights`
 *    （题号当钥匙，一题一条，覆盖不重复建）。这样她能在保存前改 AI 读错的地方。
 * ⚠️ **不碰等级 / 复习结果 / 题目类型** —— 这一步只读数，一个写操作都没有。
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
        const errorItemNo =
            typeof body.errorItemNo === 'string' ? body.errorItemNo.trim().toUpperCase() : '';
        const language: 'zh' | 'en' = body.language === 'en' ? 'en' : 'zh';
        const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';

        if (!errorItemNo) return badRequest("errorItemNo is required");
        if (!imageBase64) return badRequest("imageBase64 is required");

        const item = await prisma.errorItem.findFirst({
            where: { userId: user.id, source: errorItemNo },
            select: {
                questionText: true,
                mistakeCategory: true,
                gradeSemester: true,
                notebook: { select: { subject: true } },
            },
        });
        if (!item) return badRequest("按题号没找到这道题");

        const context = buildRecoverQuestionContext({
            no: errorItemNo,
            questionText: item.questionText,
            subject: subjectLabel(item.notebook?.subject) || null,
            mistakeReason: getMistakeCategoryLabel(item.mistakeCategory) || null,
        });

        /**
         * 【2026-10-04 他要求】这道题**已经记过日积月累**时，要把"原来的 + 这次读到的"
         * **有机合并**后再覆盖（不是直接盖掉）。
         *
         * 合并的分工（两边各管一头，见 `lib/recover-analysis.ts`）：
         *   · **她的话** —— 客户端**累积保留**（旧的留着、新的接在后面），不经过模型改写；
         *   · **AI 的整理** —— 交给模型**融合**（所以要在这里把旧正文喂进提示词）。
         * ⚠️ 这里只**读**它用来拼提示词，**不写库** —— 落库仍然由用户在页面上校对后
         *    走 `POST /api/insights`（题号当钥匙，覆盖不重复建）。
         */
        const previous = await prisma.insight.findFirst({
            where: { userId: user.id, errorItemNo },
            select: { content: true },
        });

        const system = generateRecoverAnalysisPrompt(
            context,
            language,
            undefined,
            item.gradeSemester,
            previous?.content ?? null,
        );

        logger.info({ userId: user.id, errorItemNo }, 'Calling AI for recover analysis');
        const raw = await chatVision({
            system,
            user: '请按上面的格式，读取这张照片上孩子手写的分析。',
            imageBase64,
            timeoutMs: 120000,
        });

        const reading = parseRecoveryReading(raw);
        // ② 拼正文：她的话**累积保留**（上次的 + 这次的）、AI 的整理用刚融合出来的那段
        const content = composeRecoveryContent(reading, previous?.content ?? null);

        logger.info(
            { userId: user.id, errorItemNo, organizedLen: reading.organized.length },
            'Recover analysis succeeded',
        );
        return NextResponse.json({ reading, content, questionNo: errorItemNo });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'Recover analysis failed');

        // 与 analyze 路由同一套错误口径：把 AI/校验类错误统一报成 AI_RESPONSE_ERROR，前端好判。
        let errorMessage = message || 'AI 分析失败';
        if (
            message.includes('AI_RESPONSE_ERROR') ||
            message.includes('Zod') ||
            message.includes('validate')
        ) {
            errorMessage = 'AI_RESPONSE_ERROR';
        }
        return createErrorResponse(errorMessage, 500, ErrorCode.AI_ERROR, message);
    }
}
