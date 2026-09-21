import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AppConfig, getAppConfig, updateAppConfig } from "@/lib/config";
import { internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { OpenAIInstance } from "@/types/api";

const logger = createLogger('api:settings');

export const dynamic = 'force-dynamic';

/**
 * 密钥掩码。前端认得这个值：POST 回来时遇到它就表示"没改，保留原来的"。
 * （这不是加密 —— 只是让非管理员看不到真实密钥，见下面的 maskSecrets）
 */
const MASK = '********';

/**
 * 【安全修复】原先这里没有任何鉴权，注释却写着 "since this is an authenticated
 * endpoint" —— 它**并不是**：src/middleware.ts 的 matcher 明确把 /api 排除在外，
 * 所有接口都得自己检查会话。结果是任何人（连登录都不用）GET /api/settings
 * 就能拿到明文 AI 密钥；POST 还能把 baseUrl 改到别人的服务器上，把你的请求劫持走。
 *
 * 现在：
 *   · GET/POST 都要求已登录；
 *   · 非管理员拿不到真实密钥（一律掩码）；
 *   · 非管理员只能改"分析超时"，其它字段（AI 配置、转存路径、开放注册）一律丢弃。
 */
async function currentUserRole(): Promise<{ signedIn: boolean; isAdmin: boolean }> {
    const session = await getServerSession(authOptions);
    const role = (session?.user as { role?: string } | undefined)?.role;
    return { signedIn: Boolean(session?.user), isAdmin: role === 'admin' };
}

/** 给非管理员看的配置：所有密钥换成掩码，其余字段照旧 */
function maskSecrets(config: AppConfig): AppConfig {
    return {
        ...config,
        openai: config.openai
            ? {
                ...config.openai,
                instances: (config.openai.instances || []).map((i) => ({
                    ...i,
                    apiKey: i.apiKey ? MASK : '',
                })),
            }
            : config.openai,
        gemini: config.gemini
            ? { ...config.gemini, apiKey: config.gemini.apiKey ? MASK : '' }
            : config.gemini,
        azure: config.azure
            ? { ...config.azure, apiKey: config.azure.apiKey ? MASK : '' }
            : config.azure,
    };
}

export async function GET() {
    const { signedIn, isAdmin } = await currentUserRole();
    if (!signedIn) return unauthorized("Authentication required");

    const config = getAppConfig();
    // 管理员拿完整配置（设置页要能编辑密钥）；其它人只看得到掩码
    return NextResponse.json(isAdmin ? config : maskSecrets(config));
}

export async function POST(req: Request) {
    try {
        const { signedIn, isAdmin } = await currentUserRole();
        if (!signedIn) return unauthorized("Authentication required");

        const rawBody = await req.json();
        const currentConfig = getAppConfig();

        /**
         * 非管理员只放行 timeouts（界面上的"分析超时"）。
         *
         * 为什么不是直接 403：普通用户在设置对话框点保存时，前端是把整份配置
         * POST 回来的。若直接拒绝，"改超时"这种正常操作也会报错。
         * 所以改成**白名单式丢弃** —— 能改的留下，改不了的当没传。
         */
        const body = isAdmin ? rawBody : { timeouts: rawBody?.timeouts };

        // Don't save masked keys if they somehow get sent back (for Gemini)
        if (body.gemini?.apiKey === MASK) {
            // 保留原有的 API Key
            body.gemini.apiKey = currentConfig.gemini?.apiKey;
        }

        // For OpenAI instances, preserve original keys for masked entries
        if (body.openai?.instances) {
            const currentInstances = currentConfig.openai?.instances || [];
            body.openai.instances = body.openai.instances.map((instance: OpenAIInstance) => {
                if (instance.apiKey === MASK) {
                    // 查找原有实例并保留其 API Key
                    const originalInstance = currentInstances.find((i: OpenAIInstance) => i.id === instance.id);
                    return {
                        ...instance,
                        apiKey: originalInstance?.apiKey || '',
                    };
                }
                return instance;
            });
        }

        // For Azure, preserve original key if masked
        if (body.azure?.apiKey === MASK) {
            body.azure.apiKey = currentConfig.azure?.apiKey;
        }

        const updatedConfig = updateAppConfig(body);
        return NextResponse.json(isAdmin ? updatedConfig : maskSecrets(updatedConfig));
    } catch (error) {
        logger.error({ error }, 'Failed to update settings');
        return internalError("Failed to update settings");
    }
}


