import { z } from 'zod';

/**
 * Zod schema for validating AI-parsed questions
 * Ensures type safety and business rule compliance
 */
export const ParsedQuestionSchema = z.object({
    questionText: z.string().min(1, "题目文本不能为空"),
    answerText: z.string().min(1, "答案不能为空"),
    analysis: z.string().min(1, "解析不能为空"),
    wrongAnswerText: z.string().optional().default(""),
    mistakeAnalysis: z.string().optional().default(""),
    mistakeStatus: z.enum(["not_attempted", "wrong_attempt", "unknown"]).optional().default("unknown"),
    subject: z.enum([
        "数学", "物理", "化学", "生物",
        "英语", "语文", "历史", "地理",
        "政治", "其他"
    ]),
    knowledgePoints: z.array(z.string()).max(5, "知识点最多 5 个"),
    /**
     * 【2026-10-31】AI 交回的**坐标**（册/章/节/名）。
     *
     * `knowledgePoints` 保留不动（前端、打印、统计都在读它），这里只是**多存一份位置**。
     * 落库时按 册+节+名 → 册+名 → 放弃 三级降级，见 `lib/tag-ref.ts`。
     *
     * 用 `.optional()`：旧模型/旧配置没按新格式输出时，这个字段为空，
     * 解析端会退回逗号切分并标 `legacy: true`。
     */
    knowledgeRefs: z.array(z.object({
        book: z.string().optional(),
        chapter: z.string().optional(),
        section: z.string().optional(),
        name: z.string(),
        legacy: z.boolean().optional(),
    })).optional(),
    /**
     * AI 把「册」判成**与她当前在读不同的那一册**时，必须交一句判据。
     * 用来审"它是真读了题，还是顺着默认值走"。
     */
    bookReason: z.string().optional(),
    /**
     * 【2026-10-30】AI 给的**错因初判**——当靶子，不当事实。
     *
     * 用 string 而不是 z.enum：错因枚举还在长（这次刚从 8 条加到 11 条），
     * 在校验层硬编码会让"加一条错因"变成"改两处"。落库前一律过
     * `normalizeMistakeCategory`，非法值降级为 null（宁缺勿错）。
     */
    mistakeCategory: z.string().optional(),
    requiresImage: z.boolean().optional().default(false), // 题目是否依赖图片（如几何题）
});

/**
 * Type inference from Zod schema
 * Use this type instead of manually defining ParsedQuestion
 */
export type ParsedQuestionFromSchema = z.infer<typeof ParsedQuestionSchema>;

/**
 * Validates and parses AI response JSON
 * @param data - Raw JSON data from AI
 * @returns Validated ParsedQuestion object
 * @throws ZodError if validation fails
 */
export function validateParsedQuestion(data: unknown): ParsedQuestionFromSchema {
    return ParsedQuestionSchema.parse(data);
}

/**
 * Safe validation that returns success/error object
 * @param data - Raw JSON data from AI
 */
export function safeParseParsedQuestion(data: unknown) {
    return ParsedQuestionSchema.safeParse(data);
}

/* ==================== 回录分析（纸回录）· 走读她的反思 ==================== */

/**
 * 【2026-10-04】**回录分析**第一步（深挖纸回录）AI 读到的东西。
 *
 * 她会在深挖纸**正面下半部分**手写"我卡在哪 / 我当时怎么想的"。系统把这张照片
 * 连同"这是哪道题"一起交给 AI，让它在有上下文的情况下把她的手写内容读出来、理顺。
 *
 * ⚠️ 三个字段的分工（这就是"能区分她的话和 AI 的话"的落点）：
 *   · `herWords`  —— **她写的原话**（尽量原样转录；看不清就写「［看不清］」，不许猜）
 *   · `organized` —— **AI 整理的正文**（保留她的口吻，只讲她写过的内容；存进日积月累时整段加斜体）
 *   · `unclear`   —— AI 明知看不清 / 拿不准的片段（给她复核用；没有就空）
 *
 * `organized` 必填且非空 —— 它才是这条日积月累的正文；空即视为 AI 读失败（不静默入库）。
 * 另外两个允许空：她可能一个字都没写清楚，或整张都看得清。
 */
export const RecoverReadingSchema = z.object({
    herWords: z.string().optional().default(""),
    organized: z.string().min(1, "AI 整理的日积月累正文不能为空"),
    unclear: z.string().optional().default(""),
});

/** 类型推断：回录分析读出的一段内容 */
export type RecoverReadingFromSchema = z.infer<typeof RecoverReadingSchema>;

/** 安全校验：AI 回录读数 → 结构化对象（失败时由调用方决定怎么提示，不抛） */
export function safeParseRecoverReading(data: unknown) {
    return RecoverReadingSchema.safeParse(data);
}
