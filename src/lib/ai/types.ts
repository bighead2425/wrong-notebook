// Re-export the Zod-validated type from schema.ts
export type { ParsedQuestionFromSchema as ParsedQuestion } from './schema';
import type { ParsedQuestionFromSchema } from './schema';

// Import and re-export MistakeStatus from the single source of truth
import type { MistakeStatus } from '../mistake-status';
export type { MistakeStatus };

export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'harder';

export interface ReanswerQuestionResult {
    answerText: string;
    analysis: string;
    knowledgePoints: string[];
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: MistakeStatus;
}

export interface AIService {
    analyzeImage(imageBase64: string, mimeType?: string, language?: 'zh' | 'en', grade?: number | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema>;
    generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language?: 'zh' | 'en', difficulty?: DifficultyLevel, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema>;
    reanswerQuestion(questionText: string, language?: 'zh' | 'en', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult>;
}

export interface AIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    /**
     * 【2026-11-08 空空】**单次请求超时（毫秒），由设置页的「AI 分析超时」传进来。**
     *
     * 原来 provider 里写死 180 秒，而设置页那个值**只作用在前端**（`apiClient` 的 timeout）——
     * 于是用户把设置调到 300 秒也没用：服务端 180 秒就断，前端等再久也是白等。
     * 举一反三（要输出好几道题的完整解析）就是这么超时的。
     */
    timeoutMs?: number;

    /**
     * 【2026-11-09 空空】**探测出来的能力，决定这次请求带什么参数。**
     *
     * 由 `/api/ai/probe` 现场问厂商得到，存进实例配置。
     * 有这个字段就按它下发（能限档就带 `reasoning_effort`、能关就带 `thinking`）；
     * 没有就不带——**不认识参数的老厂商不该被我们搞崩**。
     */
    /**
     * 【2026-11-09 空空】**最大输出长度（token），设置页可调。**
     *
     * 原来是硬编码 8192，对"会思考"的模型不够 —— reasoning 会先吃掉一大截，
     * 轮到输出时就没额度了，表现为 `content` 空。
     */
    maxTokens?: number;

    /**
     * 思考强度。留空 = 按探测出来的能力自动决定（能关就关、关不掉取 low）。
     *
     * 小学阶段的题（一两步计算 + 模式识别）**不需要深度推理**：
     * 实测 `glm-5.3-flash` 用 low 档 24 秒就能出正确答案与完整解析，
     * 而默认无限制时要 198 秒甚至想空。所以这里允许显式压到最低。
     */
    reasoningEffort?: 'off' | 'low' | 'high' | 'max';

    capabilities?: {
        image: boolean;
        reasoning: boolean;
        thinkingOff: boolean;
        effortLevels: string[];
    };
    // Azure OpenAI 特有字段
    azureDeployment?: string;   // Azure 部署名称
    azureApiVersion?: string;   // API 版本 (如 2024-02-15-preview)
}
