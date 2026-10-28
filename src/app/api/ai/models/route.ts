import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { unauthorized } from '@/lib/api-errors';

const logger = createLogger('api:ai:models');

interface ModelInfo {
    id: string;
    name: string;
    owned_by?: string;
}

// 从模型 ID 中提取短名称
function extractModelName(modelId: string): string {
    // models/gemini-2.0-flash -> gemini-2.0-flash
    return modelId.replace(/^models\//, '');
}

async function fetchGeminiModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const url = `${baseUrl}/v1beta/models?key=${apiKey}`;

    const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, errorText }, 'Gemini models API error');
        throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.models || [])
        .map((m: any) => {
            const id = extractModelName(m.name);
            return {
                id,
                name: id,
                owned_by: 'Google',
            };
        });
}

async function fetchOpenAIModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const url = `${baseUrl}/models`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        logger.error({ statusText: response.statusText }, 'OpenAI models API error');
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    return (data.data || [])
        .map((model: any) => ({
            id: model.id,
            name: model.id,
            owned_by: model.owned_by,
        }));
}

/**
 * 【2026-10-29 审计修复】这个接口原来**没有鉴权**，而 `baseUrl` 来自查询参数 ——
 * 等于任何人都能让服务器去 fetch 任意地址（探内网、探云元数据），并把 apiKey 拼进去。
 *
 * 两道闸：
 *  ① 必须登录（它只在"设置 → AI 服务"里用，本来就在登录态下）；
 *  ② 拒绝**环回 / 云元数据**地址 —— 但**保留局域网地址**：
 *     他将来若在 NAS 上跑个 Ollama / vLLM（192.168.x.x），那是正当用法，
 *     一刀切封私网会把这条路堵死。
 */
async function assertSafeBaseUrl(raw: string | null): Promise<string | null> {
    if (!raw) return null;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return 'baseUrl 不是合法地址';
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'baseUrl 只支持 http/https';

    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback =
        host === 'localhost' ||
        host === '::1' ||
        host === '169.254.169.254' ||          // 云元数据（AWS/GCP/Azure 同一地址）
        /^127\./.test(host);
    if (loopback) return 'baseUrl 不允许指向本机 / 云元数据地址';
    return null;
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) return unauthorized("Authentication required");

        const { searchParams } = new URL(req.url);
        const provider = searchParams.get('provider');
        const apiKey = searchParams.get('apiKey');
        const baseUrl = searchParams.get('baseUrl');

        const unsafe = await assertSafeBaseUrl(baseUrl);
        if (unsafe) {
            return NextResponse.json({ error: unsafe, models: [] }, { status: 400 });
        }

        if (!apiKey) {
            return NextResponse.json(
                { error: 'API key is required' },
                { status: 400 }
            );
        }

        let models: ModelInfo[] = [];

        if (provider === 'gemini') {
            const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com';
            models = await fetchGeminiModels(apiKey, effectiveBaseUrl);
        } else {
            // OpenAI-compatible
            const effectiveBaseUrl = baseUrl || 'https://api.openai.com/v1';
            models = await fetchOpenAIModels(apiKey, effectiveBaseUrl);
        }

        return NextResponse.json({ models });

    } catch (error: any) {
        logger.error({ error }, 'Error fetching models');
        return NextResponse.json(
            { error: error.message || 'Internal server error', models: [] },
            { status: 200 } // Return 200 with empty models to allow manual input
        );
    }
}
