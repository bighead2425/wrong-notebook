import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { chatText } from "@/lib/ai/text-chat";
import { getMistakeCategoryLabel } from "@/lib/mistake-category";
/**
 * 【2026-10-18 如如】提示词**不再写死在这里** —— 从设置页读（`config.prompts.insights`），
 * 空则用默认模板。出处：空空原话"不要在软件中写死，要让用户自己配置"。
 * ⚠️ 结构（`#### ` 标题 / `> *AI: …*`）由 `normalizeInsightMarkdown` 再兜一次：
 *    纸面排版不能靠模型守规矩（详见 `lib/insight-note.ts` 文件头）。
 */
import { generateInsightsPrompt } from "@/lib/ai/prompts";
import { normalizeInsightMarkdown } from "@/lib/insight-note";
import { getAppConfig } from "@/lib/config";

const logger = createLogger('api:insights:ai');

/**
 * 【2026-10-18】这里原来是一段写死的 SYSTEM_PROMPT（"把她的理解理顺成一段批注"）。
 * 现在改由设置页的「日积月累提示词」提供（`DEFAULT_INSIGHTS_TEMPLATE` 是默认值），
 * 理由：① 空空要求"不要在软件中写死"；② 这个场景是开放的，提示词一定会反复调，
 *       每调一次就发一次版是不可接受的。
 */

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
        /**
         * 【2026-10-18 改】`errorItemNo` **从必填改成可选**。
         *
         * 原来这个接口只有一条来路：错题本 →「AI 送」→ 带着题号。
         * 现在多了第二条：日积月累**录入页**（`/insights/write`）—— 那里是"进门就写"，
         * 大部分时候**根本没在讲某道题**（书上一段话、老师随口一句、她自己的一个念头）。
         * 他 2026-10-13 也定过："日积月累**不绑定题**，是一本笔记"。
         * ⇒ 不带题号 = 按**笔记**处理（提示词里 `question_text` 本来就写好了这种情况的兜底：
         *    "（没有题干——这条可能与某道题无关，按笔记处理）"）。
         * ⚠️ 但如果**给了题号却查不到题**，仍然报错：那是"题号打错了"，
         *    静默降级成笔记会让他以为关联上了。
         */
        const errorItemNo =
            typeof body.errorItemNo === 'string' && body.errorItemNo.trim()
                ? body.errorItemNo.trim().toUpperCase()
                : '';
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        const bodySubject = typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim() : null;
        if (!content) return badRequest("她写的内容是 AI 分析的原料，不能为空");

        const item = errorItemNo
            ? await prisma.errorItem.findFirst({
                  where: { userId: user.id, source: errorItemNo },
                  select: { questionText: true, mistakeCategory: true, mistakeAnalysis: true },
              })
            : null;
        if (errorItemNo && !item) return badRequest("按题号没找到这道题");

        const reason = item ? getMistakeCategoryLabel(item.mistakeCategory) || '没打错因' : '';

        /**
         * 提示词：**用户在设置页填的那份**优先；没填就用默认模板。
         * 变量拼装在 `generateInsightsPrompt`（那里对原料做了长度截断 ——
         * 一整页手写 OCR 全塞进去，模型反而会被细节淹掉）。
         */
        const customTemplate = getAppConfig().prompts?.insights || '';

        /**
         * 【2026-10-18】把**同学科最近记过的几条**一起带上，让 AI 能"回指"。
         *
         * 空空的原话："后续可以开发将同学科的积累标题交给 AI，让 AI 分析当前这条
         * 和此前那条积累是有关系的，而且看是不是能调用那条相关积累来看看，
         * 这样积累和积累之间的关系就建立起来了。"
         *
         * 这一步只做**最轻的那半**：把旧条目的标题 + 开头给模型看，
         * 它愿意回指就在 AI 段里写一句（"这个你上次也写过"）。
         * **不建立任何数据库关系** —— 关系要落定，得等她真的看见并认可
         * （与"AI 只做错因归类、只建议不落定"同一条定盘星）。
         *
         * 取 8 条、每条截 120 字：多了会把这次的原料淹掉，模型会拿旧内容糊弄。
         * ⚠️ 只取 `final`：草稿是她还没想清楚的，不该被当成"以前的看法"引用。
         */
        const related = await prisma.insight.findMany({
            where: {
                userId: user.id,
                status: 'final',
                ...(bodySubject ? { subject: bodySubject } : {}),
                content: { not: null },
            },
            orderBy: { createdAt: 'desc' },
            take: 8,
            select: { code: true, content: true },
        });

        const prompt = generateInsightsPrompt({
            rawContent: content,
            subject: bodySubject,
            questionText: item?.questionText,
            mistakeReason: reason,
            mistakeAnalysis: item?.mistakeAnalysis,
            relatedNotes: related,
            customTemplate,
        });

        const raw = await chatText({
            // 模板里已经含了"她这次的原料"，所以整段放 system，user 只做一句启动
            system: prompt,
            user: '请按上面的要求直接输出这张卡片（不要任何解释或前后缀）。',
            timeoutMs: 120000,
        });

        /**
         * 【结构兜底】模型偶尔会写 `###`、`**AI:**`、或者包一层 ```。
         * 这些在**纸面上**就是破版 ⇒ 由程序统一成 `#### ` 与 `> *AI: …*`。
         * ⚠️ 只改结构、不改内容（内容怎么压缩是模型的事）。
         */
        const note = normalizeInsightMarkdown(raw);
        if (!note) return internalError("AI 没有返回内容，请重试");

        return NextResponse.json({ note });
    } catch (error) {
        logger.error({ error }, 'Insight AI note failed');
        return internalError("AI 分析失败");
    }
}
