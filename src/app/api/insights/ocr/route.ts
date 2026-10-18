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
 * ── 2026-10-18 第二次扩：**印刷体和她手写的分开读** ─────────────────
 * 他的原话："红框是印刷或打印出来的文字……蓝框是孩子自己手写的内容，
 *            这样就把别人说的话和孩子自己说的话区分开了。"
 *
 * ⇒ Body 支持三种写法：
 *   · `{ image }`                     —— 老路，整张读，返回 `{ text }`
 *   · `{ printed, handwritten }`      —— 两张图**分别**读（哪张没有就不传）
 *   · 两个都有 ⇒ 返回 `{ printed, handwritten, text }`
 *
 * ⚠️ **为什么要两次请求，而不是一张图上让模型自己分**：
 *    一张图上"哪句是书上的、哪句是她写的"靠模型猜，猜错一次这张卡就变成
 *    "她说了老师的话"，而这正是这本词典最要命的一种错。
 *    **框是孩子自己画的** —— 她画框这个动作，本身就是最可靠的标注。
 *
 * ⚠️ **图不留底**：请求结束图就没了。他 2026-10-18 定的：
 *   "图不要留底了，就留下 OCR 的内容就行了，就算是留底了，文字内容留底比较简单也比较容易查。"
 *   ⇒ 这里**不写库**。
 */

type Role = 'whole' | 'printed' | 'handwritten';

/** 抄字提示词。**只抄，不整理** —— 整理是下一步（`/api/insights/ai`）的事 */
function ocrPrompt(role: Role): string {
    const who =
        role === 'printed'
            ? '这段是**书或习题册上印出来的文字**（别人写的）。'
            : role === 'handwritten'
              ? '这段是**孩子自己手写的字**（她自己的话）。'
              : '这张图上可能是印刷体、手写体混在一起。';

    return `你在帮一个小学生把她拍到的东西**原样抄下来**。

${who}

【只做一件事：抄字】
- 印刷体、手写体都抄，照原样，**一个字都不要改**：
  错别字保留、标点保留、她自己的断句保留、涂改划掉的部分不要抄进来。
- 保留原来的分行：她写了几行就几行（分行本身有信息，不要并成一大段）。
- 看不清的字写 [?]，**不要猜**、不要用"（此处不清）"这类说明。
- 图上还有题号、页码、边框、出版社字样这类"不是要做笔记的内容"，
  **只抄正文**；实在分不清是不是正文，就抄上（宁可多，不要漏）。

【绝对不要做】
- 不要整理、不要压缩、不要改通顺、不要纠正错别字。
- 不要解释、不要总结、不要写"以下是图片中的文字"。
- 不要用代码块或引号把结果包起来。

直接输出抄下来的文字。`;
}

/** 去掉模型很爱包的 ``` 与首尾空白 */
function cleanText(raw: string): string {
    return (raw || '')
        .replace(/^```[a-zA-Z]*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({ where: { email: session.user.email } });
        }
        if (!user) return unauthorized("Authentication required");

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const pick = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '');

        const image = pick('image');
        const printed = pick('printed');
        const handwritten = pick('handwritten');

        const jobs: { role: Role; image: string }[] = [];
        if (printed) jobs.push({ role: 'printed', image: printed });
        if (handwritten) jobs.push({ role: 'handwritten', image: handwritten });
        // 两张都没传 ⇒ 走老的单图路径（兼容已上线的调用方）
        if (jobs.length === 0 && image) jobs.push({ role: 'whole', image });

        if (jobs.length === 0) return badRequest("image is required");

        /**
         * 并发两次（印刷一张、手写一张）。
         * ⚠️ 用 `allSettled` 而不是 `all`：**一张读失败不该把另一张也扔掉** ——
         *    她拍了两个框，读到一半全没了，比只少一张难受得多。
         */
        const settled = await Promise.allSettled(
            jobs.map(async (job) => {
                const raw = await chatVision({
                    system: ocrPrompt(job.role),
                    user: '请把这张图上的字抄下来。',
                    imageBase64: job.image,
                    timeoutMs: 120000,
                });
                return { role: job.role, text: cleanText(raw) };
            }),
        );

        const got: Partial<Record<Role, string>> = {};
        settled.forEach((r, i) => {
            if (r.status === 'fulfilled') got[jobs[i].role] = r.value.text;
            else logger.error({ role: jobs[i].role, error: r.reason }, 'Insight OCR job failed');
        });

        // 双通道：分开返回，正文里"别人的话"和"她的话"才排得开
        if (jobs.some((j) => j.role !== 'whole')) {
            const printedText = got.printed ?? '';
            const handText = got.handwritten ?? '';
            if (!printedText && !handText) return internalError("这张图上没读到字，换一张清楚点的试试");
            return NextResponse.json({
                printed: printedText,
                handwritten: handText,
                text: [printedText, handText].filter(Boolean).join('\n\n'),
            });
        }

        const text = got.whole ?? '';
        if (!text) return internalError("这张图上没读到字，换一张清楚点的试试");
        return NextResponse.json({ text });
    } catch (error) {
        logger.error({ error }, 'Insight OCR failed');
        return internalError("读图失败，请重试");
    }
}
