import { GoogleGenAI } from "@google/genai";
import { AIService, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult } from "./types";
import { generateAnalyzePrompt, generateSimilarQuestionPrompt } from './prompts';
import { safeParseParsedQuestion } from './schema';
import { getAppConfig } from '../config';
import { getMathTagsFromDB, getTagsFromDB, getTagTree } from './tag-service';
import { SUBJECT_KEY_BY_NAME } from './tag-scope';
import { splitKnowledgePoints } from './knowledge-split';
import { parseTagRefs } from './tag-ref';
import { normalizeMistakeCategory } from '../mistake-category';
import { createLogger } from '../logger';
import { normalizeMistakeStatusForSave } from '../mistake-status';

const logger = createLogger('ai:gemini');

type GeminiContent = string | Array<
    { text: string } |
    { inlineData: { mimeType: string; data: string } }
>;

export class GeminiProvider implements AIService {
    private ai: GoogleGenAI;
    private modelName: string;
    private baseUrl: string;

    constructor(config?: AIConfig) {
        const apiKey = config?.apiKey;
        const baseUrl = config?.baseUrl;

        if (!apiKey) {
            throw new Error("AI_AUTH_ERROR: GOOGLE_API_KEY is required for Gemini provider");
        }

        // 使用 httpOptions.baseUrl 来配置自定义 API 地址，避免全局 setDefaultBaseUrls 的竞态条件
        // 参考：@google/genai 的 GoogleGenAIOptions.httpOptions.baseUrl
        this.ai = new GoogleGenAI({
            apiKey,
            httpOptions: baseUrl ? {
                baseUrl: baseUrl
            } : undefined
        });

        this.modelName = config?.model || 'gemini-2.0-flash';
        this.baseUrl = baseUrl || 'https://generativelanguage.googleapis.com';

        logger.info({
            provider: 'Gemini',
            model: this.modelName,
            baseUrl: this.baseUrl,
            apiKeyPrefix: apiKey.substring(0, 8) + '...'
        }, 'AI Provider initialized');
    }

    private async retryOperation<T>(operation: () => Promise<T>, maxRetries: number = 3): Promise<T> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                const msg = error instanceof Error ? error.message.toLowerCase() : String(error);

                // Identify retryable errors
                const isRetryable =
                    msg.includes('fetch failed') ||
                    msg.includes('network') ||
                    msg.includes('connect') ||
                    msg.includes('503') ||
                    msg.includes('502') ||  // Bad Gateway
                    msg.includes('504') ||  // Gateway Timeout
                    msg.includes('overloaded') ||
                    msg.includes('timeout') ||
                    msg.includes('etimedout') ||  // Connection timeout
                    msg.includes('enotfound') ||  // DNS resolution failed
                    msg.includes('econnreset') ||
                    msg.includes('econnrefused') ||  // Connection refused
                    msg.includes('unavailable');

                if (!isRetryable || attempt === maxRetries) {
                    throw error;
                }

                const delay = Math.pow(2, attempt - 1) * 1000; // Exponential backoff: 1s, 2s, 4s
                logger.warn({ attempt, maxRetries, error: msg, nextRetryDelayMs: delay }, 'Gemini operation failed, retrying...');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }

    private extractTag(text: string, tagName: string): string | null {
        const startTag = `<${tagName}>`;
        const endTag = `</${tagName}>`;
        const startIndex = text.indexOf(startTag);
        if (startIndex === -1) return null;

        const contentStartIndex = startIndex + startTag.length;
        const endIndex = text.indexOf(endTag, contentStartIndex);
        if (endIndex !== -1) {
            if (contentStartIndex >= endIndex) return null;
            return text.substring(contentStartIndex, endIndex).trim();
        }

        // 【custom-v27】闭标签丢失（多为 max_tokens 截断）时的兜底：截到下一个标签边界；
        // 说明详见 openai-provider.ts 中同名方法。
        const rest = text.substring(contentStartIndex);
        const nextTagAt = rest.search(/<\/?[a-zA-Z_][a-zA-Z0-9_]*>/);
        if (nextTagAt === -1) {
            logger.warn({ tagName }, 'Closing tag missing, reading to end (likely truncated)');
            return rest.trim() || null;
        }
        logger.warn({ tagName, nextTagAt }, 'Closing tag missing, truncated at next tag boundary');
        return rest.slice(0, nextTagAt).trim() || null;
    }

    private parseResponse(text: string): ParsedQuestion {
        logger.debug({ textLength: text.length }, 'Parsing AI response');

        const questionText = this.extractTag(text, "question_text");
        const answerText = this.extractTag(text, "answer_text");
        const analysis = this.extractTag(text, "analysis");
        const subjectRaw = this.extractTag(text, "subject");
        const knowledgePointsRaw = this.extractTag(text, "knowledge_points");
        const requiresImageRaw = this.extractTag(text, "requires_image");
        const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
        const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
        const mistakeStatusRaw = this.extractTag(text, "mistake_status");

        /* 【2026-10-30】错因初判：AI 只当"靶子"，非法值降级为 undefined（宁缺勿错） */
        const mistakeCategory = normalizeMistakeCategory(this.extractTag(text, "mistake_category")) ?? undefined;

        // Basic Validation
        if (!questionText || !answerText || !analysis) {
            logger.error({ rawTextSample: text.substring(0, 500) }, 'Missing critical XML tags');
            throw new Error("Invalid AI response: Missing critical XML tags (<question_text>, <answer_text>, or <analysis>)");
        }

        // Process Subject
        let subject: ParsedQuestion['subject'] = '其他';
        const validSubjects = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"];
        if (subjectRaw && validSubjects.includes(subjectRaw)) {
            subject = subjectRaw as ParsedQuestion['subject'];
        }

        /**
         * 【2026-10-31】知识点：优先按新协议解析坐标（<kp book/chapter/section/name/>）。
         * 一条都解析不出就退回旧的逗号切分，并标 legacy —— 没有位置信息，只能进待确认。
         */
        let knowledgePoints: string[] = [];
        let knowledgeRefs = parseTagRefs(knowledgePointsRaw);
        if (knowledgeRefs.length > 0) {
            knowledgePoints = knowledgeRefs.map((r) => r.name);
        } else if (knowledgePointsRaw) {
            knowledgePoints = splitKnowledgePoints(knowledgePointsRaw);
            knowledgeRefs = knowledgePoints.map((name) => ({ name, legacy: true }));
        }

        /** 册次判据：只有 AI 换了默认册才该有内容 */
        const bookReason = this.extractTag(text, "book_reason") || undefined;

        // Process requiresImage
        const requiresImage = requiresImageRaw?.toLowerCase().trim() === 'true';
        const mistakeStatus = normalizeMistakeStatusForSave(mistakeStatusRaw, wrongAnswerText);

        // Construct Result
        const result: ParsedQuestion = {
            questionText,
            answerText,
            analysis,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            subject,
            knowledgePoints,
            knowledgeRefs,
            bookReason,
            mistakeCategory,
            requiresImage
        };

        // Final Schema Validation
        const validation = safeParseParsedQuestion(result);
        if (validation.success) {
            logger.debug('Validated successfully via XML tags');
            return validation.data;
        } else {
            logger.warn({ validationError: validation.error.format() }, 'Schema validation warning');
            return result;
        }
    }

    async analyzeImage(imageBase64: string, mimeType: string = "image/jpeg", language: 'zh' | 'en' = 'zh', grade?: number | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();

        // 【2026-10-31】学科未知时不再预取任何学科的标签（原来会把五科全拉来，见 openai-provider 同段说明）
        const prefetchedMathTags = subject === '数学' ? await getMathTagsFromDB(grade || null) : [];
        const prefetchedPhysicsTags = subject === '物理' ? await getTagsFromDB('physics') : [];
        const prefetchedChemistryTags = subject === '化学' ? await getTagsFromDB('chemistry') : [];
        const prefetchedBiologyTags = subject === '生物' ? await getTagsFromDB('biology') : [];
        const prefetchedEnglishTags = subject === '英语' ? await getTagsFromDB('english') : [];

        /**
         * 【2026-10-30】结构化的数学标签树（按单元分组）。
         * 只有数学走这条路；其他学科没有小学数据，保持平铺，避免建出一棵空树。
         */
        /**
         * 【2026-10-31】不再只给数学拉树。
         * 语文/英语/政史地改成"按学段分组"之后，它们也需要树 ——
         * 否则提示词退回平铺，AI 又会看到别的学段的条目。
         */
        /** 【2026-10-31】学科未知 ⇒ subjectKey 为 null，一棵树都不拉（原来兜底成 'math'） */
        const subjectKey = subject ? (SUBJECT_KEY_BY_NAME[subject] ?? null) : null;
        const tagTree = subjectKey ? await getTagTree(subjectKey, grade ?? null) : [];

        const prompt = generateAnalyzePrompt(language, grade, subject, {
            customTemplate: config.prompts?.analyze,
            prefetchedMathTags,
            prefetchedPhysicsTags,
            prefetchedChemistryTags,
            prefetchedBiologyTags,
            prefetchedEnglishTags,
            tagTree,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.modelName,
            language,
            grade: grade || 'all'
        });
        logger.box('📝 Full Prompt', prompt);

        try {
            // 构建请求参数（用于日志显示）
            const requestParamsForLog = {
                model: this.modelName,
                contents: [
                    {
                        text: prompt
                    },
                    {
                        inlineData: {
                            data: `[...${imageBase64.length} bytes base64 data...]`,
                            mimeType: mimeType
                        }
                    }
                ]
            };

            logger.box('📤 API Request (发送给 AI 的原始请求)', JSON.stringify(requestParamsForLog, null, 2));

            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                contents: [
                    {
                        text: prompt
                    },
                    {
                        inlineData: {
                            data: imageBase64,
                            mimeType: mimeType
                        }
                    }
                ]
            }));

            logger.box('📦 Full API Response Metadata', {
                usageMetadata: response.usageMetadata
            });

            const text = response.text || '';

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during AI analysis', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language: 'zh' | 'en' = 'zh', difficulty: DifficultyLevel = 'medium', gradeSemester?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();
        const prompt = generateSimilarQuestionPrompt(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: config.prompts?.similar
        }, gradeSemester);

        logger.box('🎯 Generate Similar Question Request', {
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            originalQuestion: originalQuestion.substring(0, 100) + '...',
            knowledgePoints: knowledgePoints.join(', '),
            difficulty,
            language
        });
        logger.box('📝 Full Prompt', prompt);

        try {
            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                contents: prompt
            }));

            const text = response.text || '';

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during question generation', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async reanswerQuestion(questionText: string, language: 'zh' | 'en' = 'zh', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult> {
        const { generateReanswerPrompt } = await import('./prompts');
        const prompt = generateReanswerPrompt(language, questionText, subject, undefined, gradeSemester);

        logger.info({
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        }, 'Reanswer Question Request');
        logger.debug({ prompt }, 'Full prompt');

        try {
            // 根据是否有图片构建不同的请求内容
            let contents: GeminiContent;
            if (imageBase64) {
                // 移除 data:image/xxx;base64, 前缀（如果存在）
                const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
                contents = [
                    { text: prompt },
                    { inlineData: { mimeType: 'image/jpeg', data: base64Data } }
                ];
            } else {
                contents = prompt;
            }

            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                contents
            }));

            const text = response.text || '';

            logger.debug({ rawResponse: text }, 'AI raw response');

            if (!text) throw new Error("Empty response from AI");

            // 解析响应
            const answerText = this.extractTag(text, "answer_text") || "";
            const analysis = this.extractTag(text, "analysis") || "";
            const knowledgePointsRaw = this.extractTag(text, "knowledge_points") || "";
            const knowledgePointsParsed = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
            const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
            const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
            const mistakeStatus = normalizeMistakeStatusForSave(
                this.extractTag(text, "mistake_status"),
                wrongAnswerText
            );

            logger.info('Reanswer parsed successfully');

            return { answerText, analysis, knowledgePoints: knowledgePointsParsed, wrongAnswerText, mistakeAnalysis, mistakeStatus };

        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during reanswer');
            this.handleError(error);
            throw error;
        }
    }

    private handleError(error: unknown) {
        logger.error({ error }, 'Gemini error');
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('connect')) {
                throw new Error("AI_CONNECTION_FAILED");
            }
            // 超时错误 (包括 408 Request Timeout)
            if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted') || msg.includes('408')) {
                throw new Error("AI_TIMEOUT_ERROR");
            }
            // 配额/频率限制错误
            if (msg.includes('quota') || msg.includes('额度') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
                throw new Error("AI_QUOTA_EXCEEDED");
            }
            // 权限/403 错误
            if (msg.includes('403') || msg.includes('forbidden') || msg.includes('permission')) {
                throw new Error("AI_PERMISSION_DENIED");
            }
            // 资源不存在/404 错误
            if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
                throw new Error("AI_NOT_FOUND");
            }
            // 服务器错误 (500/502/503/504)
            if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') ||
                msg.includes('无可用') || msg.includes('overloaded') || msg.includes('unavailable')) {
                throw new Error("AI_SERVICE_UNAVAILABLE");
            }
            if (msg.includes('invalid json') || msg.includes('parse')) {
                throw new Error("AI_RESPONSE_ERROR");
            }
            if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
                throw new Error("AI_AUTH_ERROR");
            }
        }
        throw new Error("AI_UNKNOWN_ERROR");
    }
}
