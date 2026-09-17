/**
 * 纯文本 AI 对话（不依赖图片、不走结构化解析）
 *
 * 用途：本集 AI 分析（#15 / T9）——把一整本「未掌握题」的题号 + 错因打包成一坨文本，
 * 让 AI 输出自然语言的学习建议。既有 AIService 只有 analyzeImage / generateSimilarQuestion /
 * reanswerQuestion 三个**结构化**方法（返回固定标签），不适合这种开放式分析，
 * 所以单独做一个轻量通道。
 *
 * 支持三种 provider（与 lib/config.ts 的 aiProvider 一致）：
 *  - openai：OpenAI 兼容接口 POST {baseUrl}/chat/completions
 *  - azure ：POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=
 *  - gemini：POST {baseUrl}/v1beta/models/{model}:generateContent?key={apiKey}
 */

import { getAppConfig, getActiveOpenAIConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";

const logger = createLogger('ai:text-chat');

export class TextChatError extends Error {
    constructor(message: string, public detail?: string) {
        super(message);
        this.name = 'TextChatError';
    }
}

function buildUrl(base: string, path: string): string {
    return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function chatText(options: {
    system: string;
    user: string;
    timeoutMs?: number;
}): Promise<string> {
    const { system, user, timeoutMs = 120000 } = options;
    const config = getAppConfig();
    const provider = config.aiProvider || 'openai';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        if (provider === 'openai') {
            const inst = getActiveOpenAIConfig();
            if (!inst?.apiKey) {
                throw new TextChatError('未配置 OpenAI 实例（请在设置里填 Key / BaseURL / 模型）');
            }
            const url = buildUrl(inst.baseUrl || 'https://api.openai.com/v1', '/chat/completions');
            logger.info({ url, model: inst.model }, 'Text chat via OpenAI-compatible endpoint');

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${inst.apiKey}`,
                },
                body: JSON.stringify({
                    model: inst.model,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: user },
                    ],
                    max_tokens: 4096,
                    temperature: 0.4,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                logger.error({ status: res.status, detail }, 'OpenAI text chat failed');
                throw new TextChatError(`AI 接口返回 ${res.status}`, detail);
            }

            const json = await res.json() as {
                choices?: { message?: { content?: string } }[];
            };
            const text = json.choices?.[0]?.message?.content || '';
            if (!text) throw new TextChatError('AI 返回内容为空');
            return text;
        }

        if (provider === 'azure') {
            const az = config.azure;
            if (!az?.endpoint || !az?.deploymentName || !az?.apiKey) {
                throw new TextChatError('未完整配置 Azure OpenAI（endpoint / deployment / apiKey）');
            }
            const apiVersion = az.apiVersion || '2024-02-15-preview';
            const url = `${az.endpoint.replace(/\/+$/, "")}/openai/deployments/${az.deploymentName}/chat/completions?api-version=${apiVersion}`;
            logger.info({ url }, 'Text chat via Azure OpenAI');

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': az.apiKey,
                },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: user },
                    ],
                    max_tokens: 4096,
                    temperature: 0.4,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                logger.error({ status: res.status, detail }, 'Azure text chat failed');
                throw new TextChatError(`AI 接口返回 ${res.status}`, detail);
            }

            const json = await res.json() as { choices?: { message?: { content?: string } }[] };
            const text = json.choices?.[0]?.message?.content || '';
            if (!text) throw new TextChatError('AI 返回内容为空');
            return text;
        }

        // gemini
        const gm = config.gemini;
        if (!gm?.apiKey) {
            throw new TextChatError('未配置 Gemini API Key');
        }
        const model = gm.model || 'gemini-2.0-flash';
        const base = gm.baseUrl || 'https://generativelanguage.googleapis.com';
        const url = `${base.replace(/\/+$/, "")}/v1beta/models/${model}:generateContent?key=${gm.apiKey}`;
        logger.info({ model }, 'Text chat via Gemini');

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    { role: 'user', parts: [{ text: `${system}\n\n${user}` }] },
                ],
                generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            logger.error({ status: res.status, detail }, 'Gemini text chat failed');
            throw new TextChatError(`AI 接口返回 ${res.status}`, detail);
        }

        const json = await res.json() as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (!text) throw new TextChatError('AI 返回内容为空');
        return text;
    } finally {
        clearTimeout(timer);
    }
}
