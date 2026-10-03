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

/**
 * 【2026-10-04】带图片的纯文本对话（回录分析用）—— `chatText` 的**多模态版**。
 *
 * 用途：深挖纸回录。把"她手写反思的照片" + 一段自定义输出格式的 system 提示词
 * 交给模型，要它退回**自由文本**（我们用 XML 标签约定的那种），而不是 AIService
 * 那套固定标签的结构化结果（`analyzeImage` 还会顺带做题、抽知识点，那是错题录入的活，
 * 这里只要"读她的手写"）。
 *
 * 与 `chatText` 一样支持三种 provider（openai / azure / gemini），并额外照顾
 * LongCat 那套 `input_image` 多模态格式（与 `openai-provider.ts` 的 analyzeImage 同口径）。
 */
export async function chatVision(options: {
    /** system 提示词（含输出格式要求） */
    system: string;
    /** 用户这一轮的补充说明（通常就是"请按上面格式读这张照片"） */
    user: string;
    /** 图片：原始 base64，或完整 data URL —— 两种都吃 */
    imageBase64: string;
    /** 图片 MIME，默认 image/jpeg（传 data URL 时以 data URL 里的为准） */
    mimeType?: string;
    timeoutMs?: number;
}): Promise<string> {
    const { system, user, imageBase64, timeoutMs = 120000 } = options;
    const { data: imageData, mimeType } = splitDataUrl(imageBase64, options.mimeType || 'image/jpeg');
    const dataUrl = `data:${mimeType};base64,${imageData}`;

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
            const base = inst.baseUrl || 'https://api.openai.com/v1';
            const url = buildUrl(base, '/chat/completions');
            const isLongCat = base.includes('longcat.chat');
            logger.info({ url, model: inst.model, isLongCat }, 'Vision chat via OpenAI-compatible endpoint');

            // LongCat 用 input_image 那套格式（与 openai-provider.ts 一致）
            const userContent = isLongCat
                ? [
                      { type: 'text', text: user },
                      { type: 'input_image', input_image: { data: [dataUrl], type: 'url' } },
                  ]
                : [
                      { type: 'text', text: user },
                      { type: 'image_url', image_url: { url: dataUrl } },
                  ];

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
                        { role: 'user', content: userContent },
                    ],
                    max_tokens: 2048,
                    temperature: 0.2,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                logger.error({ status: res.status, detail }, 'OpenAI vision chat failed');
                throw new TextChatError(`AI 接口返回 ${res.status}`, detail);
            }

            const json = await res.json() as { choices?: { message?: { content?: string } }[] };
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
            logger.info({ url }, 'Vision chat via Azure OpenAI');

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': az.apiKey,
                },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: system },
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: user },
                                { type: 'image_url', image_url: { url: dataUrl } },
                            ],
                        },
                    ],
                    max_tokens: 2048,
                    temperature: 0.2,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                logger.error({ status: res.status, detail }, 'Azure vision chat failed');
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
        logger.info({ model }, 'Vision chat via Gemini');

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: `${system}\n\n${user}` },
                            { inline_data: { mime_type: mimeType, data: imageData } },
                        ],
                    },
                ],
                generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            logger.error({ status: res.status, detail }, 'Gemini vision chat failed');
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

/** 把 data URL 拆成 `{ data, mimeType }`；不是 data URL 就按原样当 base64 用 */
function splitDataUrl(imageBase64: string, fallbackMime: string): { data: string; mimeType: string } {
    const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(imageBase64);
    if (m) return { data: m[2], mimeType: m[1] };
    return { data: imageBase64, mimeType: fallbackMime };
}
