import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, badRequest, internalError } from "@/lib/api-errors";
import { chatText, TextChatError } from "@/lib/ai/text-chat";
import { buildNotebookMeta } from "@/lib/notebook-fields";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:notebooks:analyze');

const ANALYSIS_SYSTEM_PROMPT = `你是一位有经验的家庭学习辅导教练，擅长从孩子的错题记录里看出真实的薄弱环节。

你会拿到一份「某本教科书的错题清单」，每行格式大致是：题号｜知识点｜错因。

请输出三部分（用 Markdown 小标题）：

## 薄弱点
指出 2-5 个最突出的知识/能力薄弱点，每个都要说明「从哪几道题看出来的」（引用题号）。

## 能力欠缺
区分「知识点没掌握」和「习惯/能力问题」（如审题不清、计算粗心、单位漏写、步骤跳跃），分别给证据。

## 下一步建议
给家长可执行的 3 条建议，必须是明天就能做的具体动作，不要空泛的鼓励。

要求：只根据给出的错题证据说话，不要臆测没有出现的知识点；语言朴素，写给家长看。`;

/**
 * GET /api/notebooks/[id]/analyze
 * 打包本集「未掌握题」的题号 + 错因，供前端对话框编辑 / 复制（#15 / T9）
 *
 * 只收未软删、未掌握（masteryLevel < 2）的题。
 */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const notebook = await prisma.notebook.findUnique({ where: { id } });
        if (!notebook) return notFound("Notebook not found");
        if (notebook.userId !== user.id) return forbidden("Not authorized");

        const items = await prisma.errorItem.findMany({
            where: {
                notebookId: id,
                userId: user.id,
                deletedAt: null,
                masteryLevel: { lt: 2 },
            },
            include: { tags: true },
            orderBy: { createdAt: "asc" },
        });

        const packed = items.map(it => {
            const tags = (it.tags || []).map(x => x.name).join("、");
            const cause = (it.mistakeAnalysis || "").replace(/\s*\n+\s*/g, " ").trim()
                || (it.analysis || "").replace(/\s*\n+\s*/g, " ").slice(0, 60).trim()
                || "（未记录错因）";
            return `${it.source || it.id}｜${tags || "无标签"}｜${cause}`;
        }).join("\n");

        const header = `本：${notebook.displayName}（${buildNotebookMeta(notebook)}）\n未掌握题数：${items.length}\n\n`;

        return NextResponse.json({
            notebook: {
                id: notebook.id,
                displayName: notebook.displayName,
                meta: buildNotebookMeta(notebook),
            },
            count: items.length,
            packed: header + packed,
        });
    } catch (error) {
        logger.error({ error }, 'Error packing notebook analysis');
        return internalError("Failed to pack notebook analysis");
    }
}

/**
 * POST /api/notebooks/[id]/analyze
 * 提交给 AI 分析（#15 / T9）
 * Body: { content: string }   —— 允许前端编辑过的内容
 */
export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const notebook = await prisma.notebook.findUnique({ where: { id } });
        if (!notebook) return notFound("Notebook not found");
        if (notebook.userId !== user.id) return forbidden("Not authorized");

        const body = await req.json();
        const content = String(body?.content || "").trim();
        if (!content) return badRequest("分析内容不能为空");

        logger.info({ notebookId: id, contentLength: content.length }, 'Submitting notebook analysis');

        const result = await chatText({
            system: ANALYSIS_SYSTEM_PROMPT,
            user: content,
        });

        return NextResponse.json({ result });
    } catch (error) {
        if (error instanceof TextChatError) {
            return NextResponse.json({ message: error.message, detail: error.detail }, { status: 502 });
        }
        logger.error({ error }, 'Error analyzing notebook');
        return internalError("Failed to analyze notebook");
    }
}
