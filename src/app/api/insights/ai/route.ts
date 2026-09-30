import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { chatText } from "@/lib/ai/text-chat";
import { getMistakeCategoryLabel } from "@/lib/mistake-category";

const logger = createLogger('api:insights:ai');

/** 【AI 送】的批注生成提示词 —— 判据只有这一份（界面说的和给 AI 看的必须是同一件事） */
const SYSTEM_PROMPT = [
    '你是一位小学生的学习教练。任务是：读完一个孩子自己写的"日积月累"（她从一道做错的题里攒下的收获），',
    '把她对这道题的理解与看法**理顺**成一段通顺的话，作为一条批注还给她。',
    '规矩：',
    '1. 只根据她写的内容 + 题目 + 错因说话，**不要替她做题、不要给新的解题步骤、不要拓新的知识点**。',
    '2. 用她的口吻和视角（"我这次明白的是……"），要说人话，不要术语堆砌。',
    '3. 她说得对的地方先肯定；她说得含糊的地方帮她点明"其实你是想说……"；她说错的地方温和指出。',
    '4. 输出**只有一段批注正文**，120 字以内，不要标题、不要列表、不要客套、不要任何 markdown 语法',
    '   （客户端会把整段包成斜体批注）。',
].join('\n');

/**
 * POST /api/insights/ai —— 【AI 送】的分析一步（2026-10-01 他拍板的形态）。
 *
 * Body: `{ errorItemNo, content }`
 *
 * 做的事：按**题号**把这道题找出来，把 **题干 + 错因（8 种里的那一个）+ 她写的积累**
 * 一起送给 AI，让它输出"孩子对这道题的理解与看法"，理顺成一段话返回。
 * ⚠️ **只返回批注文本，不落库** —— 怎么拼（另起一段、斜体批注）是客户端的事
 *    （他拍板：**保留她的原话，AI 写的内容用 md 斜体当批注**）。
 *    拼好之后的保存走 POST /api/insights（题号当钥匙，覆盖不重复建）。
 *
 * 为什么把题干和错因一起送（他拍板的第 2 项）：AI 要判断"她理解到哪一步"，
 * 光看那几句话往往不够，得有题目和错因当上下文。
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
            typeof body.errorItemNo === 'string' && body.errorItemNo.trim()
                ? body.errorItemNo.trim().toUpperCase()
                : '';
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!errorItemNo) return badRequest("errorItemNo is required");
        if (!content) return badRequest("她写的内容是 AI 分析的原料，不能为空");

        const item = await prisma.errorItem.findFirst({
            where: { userId: user.id, source: errorItemNo },
            select: { questionText: true, mistakeCategory: true, mistakeAnalysis: true },
        });
        if (!item) return badRequest("按题号没找到这道题");

        const reason = getMistakeCategoryLabel(item.mistakeCategory) || '没打错因';

        const prompt = [
            '【题目】',
            (item.questionText || '（无题干文本）').slice(0, 1200),
            '',
            `【错因】${reason}`,
            item.mistakeAnalysis ? `【错因分析】${item.mistakeAnalysis.slice(0, 600)}` : '',
            '',
            '【她写的日积月累】',
            content.slice(0, 2000),
        ]
            .filter((s) => s !== '')
            .join('\n');

        const note = (await chatText({ system: SYSTEM_PROMPT, user: prompt, timeoutMs: 120000 })).trim();
        if (!note) return internalError("AI 没有返回内容，请重试");

        return NextResponse.json({ note });
    } catch (error) {
        logger.error({ error }, 'Insight AI note failed');
        return internalError("AI 分析失败");
    }
}
