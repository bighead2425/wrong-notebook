import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { chatVision } from "@/lib/ai/text-chat";

const logger = createLogger('api:insights:ocr');

/**
 * POST /api/insights/ocr —— 把一张照片上的字**抄下来**（2026-10-18 他第 2 条）。
 *
 * 场景：孩子在书上、练习册上看到一段想记的，拍一张就进日积月累，
 *       **不要她再照着抄一遍**（"日积月累"的门槛必须比抄写低，否则她不会用）。
 *
 * Body: `{ image: string }`（data URL）
 * 返回: `{ text: string }`
 *
 * ⚠️ 这一层**只抄字，不整理**：
 *   · 不改错别字、不润色、不压缩、不判断对错 —— 那是「AI 整理」那一步的事
 *     （`/api/insights/ai`），两步**分开**，因为他可能只想抄下来自己再改。
 *   · 抄不准的地方标 `[?]` 而不是猜一个词：猜错比留问号更坏（正文要"正确"）。
 *
 * ⚠️ **图不留底**：这次请求结束，图片本体就没了。他 2026-10-18 定的：
 *   "图不要留底了，就留下 OCR 的内容就行了，就算是留底了，文字内容留底比较简单也比较容易查。"
 *   ⇒ 这里**不写库**，落不落盘由客户端决定（保存条目时如果她自己另配了图，那是另一回事）。
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
        const image = typeof body.image === 'string' ? body.image.trim() : '';
        if (!image) return badRequest("image is required");

        const text = await chatVision({
            system: `你在帮一个小学生把她拍到的东西**原样抄下来**。

【只做一件事：抄字】
- 印刷体、手写体都抄，照原样，**一个字都不要改**：
  错别字保留、标点保留、她自己的断句保留、涂改划掉的部分不要抄进来。
- 保留原来的分行：她写了几行就几行（分行本身有信息，不要并成一大段）。
- 看不清的字写 [?]，**不要猜**、不要用"（此处不清）"这类说明。
- 图上还有题号、页码、边框、出版社字样这类"不是她要做笔记的内容"，
  **只抄正文**；实在分不清是不是正文，就抄上（宁可多，不要漏）。

【绝对不要做】
- 不要整理、不要压缩、不要改通顺、不要纠正错别字。
- 不要解释、不要总结、不要写"以下是图片中的文字"。
- 不要用代码块或引号把结果包起来。

直接输出抄下来的文字。`,
            user: '请把这张图上的字抄下来。',
            imageBase64: image,
            timeoutMs: 120000,
        });

        const cleaned = (text || '')
            // 模型很爱包一层 ```（和整理那一步同一个毛病）
            .replace(/^```[a-zA-Z]*\n?/, '')
            .replace(/\n?```\s*$/, '')
            .trim();

        if (!cleaned) return internalError("这张图上没读到字，换一张清楚点的试试");

        return NextResponse.json({ text: cleaned });
    } catch (error) {
        logger.error({ error }, 'Insight OCR failed');
        return internalError("读图失败，请重试");
    }
}
