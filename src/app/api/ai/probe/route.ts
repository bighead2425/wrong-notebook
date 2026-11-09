import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { internalError, unauthorized } from '@/lib/api-errors';
import { createLogger } from '@/lib/logger';
import { probeModel, listModels, type ModelCapabilities } from '@/lib/ai/probe';

const logger = createLogger('api:ai:probe');

export const dynamic = 'force-dynamic';

/**
 * POST /api/ai/probe —— **现场问厂商"这个模型能干什么"**。
 *
 * 与 `/api/ai/test` 的区别：
 *   · `test` 是"能不能用"（发一道真题跑完整分析，重、慢，但最真实）
 *   · `probe` 是"能怎么用"（4~5 次微型请求，几十 token，问清能力和限制）
 *
 * 两个都留着：配新 key 时先 probe 摸清性子，再用 test 确认真的能干活。
 *
 * body: { apiKey, baseUrl, model, listModels?: boolean }
 * resp: { capabilities, models }
 */
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return unauthorized('Authentication required');
    }

    try {
        const body = (await request.json()) as {
            apiKey?: string;
            baseUrl?: string;
            model?: string;
            listModels?: boolean;
        };

        if (!body.apiKey || !body.baseUrl || !body.model) {
            return NextResponse.json(
                { error: 'Missing apiKey / baseUrl / model' },
                { status: 400 },
            );
        }

        logger.info({ baseUrl: body.baseUrl, model: body.model }, 'AI 能力探测开始');

        /**
         * 清单与能力并行：两者互不依赖，串行做会让设置页多等一轮。
         * 清单失败不影响能力探测（有的厂商根本不实现 `/models`）。
         */
        const [capabilities, models] = await Promise.all([
            probeModel({
                apiKey: body.apiKey,
                baseUrl: body.baseUrl,
                model: body.model,
            }),
            body.listModels === false
                ? Promise.resolve([] as string[])
                : listModels({ apiKey: body.apiKey, baseUrl: body.baseUrl }),
        ]);

        logger.info(
            {
                model: body.model,
                image: capabilities.image,
                reasoning: capabilities.reasoning,
                thinkingOff: capabilities.thinkingOff,
                effortLevels: capabilities.effortLevels,
            },
            'AI 能力探测完成',
        );

        return NextResponse.json({
            capabilities: capabilities satisfies ModelCapabilities,
            models,
        });
    } catch (error) {
        logger.error({ error }, 'AI 能力探测失败');
        return internalError('Failed to probe model capabilities');
    }
}
