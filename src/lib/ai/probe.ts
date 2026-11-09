/**
 * 【2026-11-09 空空】**模型能力探查：不维护"能力表"，直接问厂商。**
 *
 * ── 为什么要这个 ──────────────────────────────────────────────
 * 这一晚踩的坑全都是"以为所有 OpenAI 兼容模型都一样"：
 *   · 小米/智谱会先思考，`content` 空、答案全在 `reasoning_content` 里
 *   · GLM-5 关不掉思考，只能限档（`reasoning_effort`）
 *   · `glm-4v-flash` 的 `max_tokens` 上限只有 1024
 *   · 商汤按分钟限流，连着跑必 429
 *
 * 抄一份"模型能力表"能解决当下，但**表会过时**——厂商上新、改档位、改限制，
 * 我们就又得跟着改代码。所以改成**配好 key 之后现场问一遍**：
 * 能拿到什么就记什么，拿不到就按"未知"处理（保守策略）。
 *
 * ── 探什么、怎么探（每个模型 4~5 次微型请求）──────────────────
 * | 项 | 探法 | 判据 |
 * |---|---|---|
 * | 模型清单 | `GET /models` | 200 且返回 data[] |
 * | 会不会思考 | 发一句 "1+1"，max_tokens 64 | 返回里有没有 `reasoning_content` |
 * | 能不能看图 | 发一张 1×1 的 png | 不报错 ⇒ 支持 |
 * | 能不能关思考 | 带 `thinking:{type:'disabled'}` | 不报错 ⇒ 能关 |
 * | 能限哪些档 | 依次试 `low` / `high` / `max` | 哪个不报错就记哪个 |
 *
 * 成本：每个模型约 200 token（全是几十字的问答），**可以忽略**。
 */

export interface ModelCapabilities {
    /** 能不能读图 */
    image: boolean;
    /** 会不会先思考（返回里带 reasoning_content） */
    reasoning: boolean;
    /** 能不能彻底关掉思考（`thinking.type = disabled`） */
    thinkingOff: boolean;
    /** 能限制的思考档位；空数组 = 不支持 reasoning_effort */
    effortLevels: string[];
    /**
     * 试出来的**最大可接受 `max_tokens`**。
     *
     * 为什么必须探：超过模型硬上限时厂商返回的是 **400 报错**（不是静默截断），
     * 设置页把这个值填进"最大输出"，用户就没法填出一个必然失败的数。
     * 探测只发几个 token 的请求，**不会因为这些上限值真的生成那么多字**。
     */
    maxOutput: number;
    probedAt: string;
    /** 探测过程中的关键错误，留给设置页显示 */
    notes: string[];
}

export interface ProbeInput {
    apiKey: string;
    baseUrl: string;
    model: string;
    /** 单个探测请求的超时，默认 20 秒 —— 探测不该拖住设置页 */
    timeoutMs?: number;
}

/** 1×1 透明 PNG，用来试"能不能读图"，几乎不花 token */
const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function postChat(
    input: ProbeInput,
    body: Record<string, unknown>,
    timeoutMs: number,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${input.apiKey}`,
            },
            body: JSON.stringify({ model: input.model, ...body }),
        });
        const text = await res.text();
        if (!res.ok) {
            /* 把厂商的原始报错截下来 —— 这是判断"不支持这个参数"的唯一依据 */
            return { ok: false, error: `${res.status} ${text.slice(0, 200)}` };
        }
        try {
            return { ok: true, json: JSON.parse(text) };
        } catch {
            return { ok: false, error: '返回不是 JSON' };
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg.slice(0, 160) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 探测一个模型。
 *
 * ⚠️ 顺序是有讲究的：**先文本、后视觉、最后试参数**。
 * 文本都失败说明 key/baseUrl/model 三样里有一个不对，再探下去只是浪费请求。
 */
export async function probeModel(input: ProbeInput): Promise<ModelCapabilities> {
    const timeoutMs = input.timeoutMs ?? 20000;
    const notes: string[] = [];

    const caps: ModelCapabilities = {
        image: false,
        reasoning: false,
        thinkingOff: false,
        effortLevels: [],
        maxOutput: 8192,
        probedAt: new Date().toISOString(),
        notes,
    };

    /* ① 文本 + 会不会思考 */
    const textProbe = await postChat(
        input,
        { messages: [{ role: 'user', content: '1+1=?' }], max_tokens: 64 },
        timeoutMs,
    );
    if (!textProbe.ok) {
        notes.push(`文本请求失败：${textProbe.error}`);
        return caps;
    }
    const msg = (textProbe.json as {
        choices?: { message?: { reasoning_content?: string; content?: string } }[];
    }).choices?.[0]?.message;
    caps.reasoning = Boolean(msg?.reasoning_content);

    /* ② 能不能看图（1×1 图几乎不花 token，只看报不报错） */
    const visionProbe = await postChat(
        input,
        {
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '这是什么颜色？' },
                        { type: 'image_url', image_url: { url: TINY_PNG } },
                    ],
                },
            ],
            max_tokens: 32,
        },
        timeoutMs,
    );
    if (visionProbe.ok) {
        caps.image = true;
    } else {
        notes.push(`视觉探测失败：${visionProbe.error}`);
    }

    /* ③ 能不能关思考（只对"会思考"的模型有意义） */
    if (caps.reasoning) {
        const offProbe = await postChat(
            input,
            {
                messages: [{ role: 'user', content: '1+1=?' }],
                max_tokens: 64,
                thinking: { type: 'disabled' },
            },
            timeoutMs,
        );
        caps.thinkingOff = offProbe.ok;
        if (!offProbe.ok) {
            notes.push(`关不掉思考：${offProbe.error.slice(0, 80)}`);
        } else {
            /* 有的厂商"接受参数但照样思考"，所以要再看一次返回里有没有 reasoning */
            const offMsg = (offProbe.json as {
                choices?: { message?: { reasoning_content?: string } }[];
            }).choices?.[0]?.message;
            if (offMsg?.reasoning_content) {
                caps.thinkingOff = false;
                notes.push('参数被接受，但依然返回了 reasoning_content（假关闭）');
            }
        }

        /* ④ 能限哪些档 —— 一次一次试，报错的就不记 */
        for (const level of ['low', 'high', 'max']) {
            const effProbe = await postChat(
                input,
                {
                    messages: [{ role: 'user', content: '1+1=?' }],
                    max_tokens: 64,
                    reasoning_effort: level,
                },
                timeoutMs,
            );
            if (effProbe.ok) caps.effortLevels.push(level);
        }
        if (caps.effortLevels.length === 0 && !caps.thinkingOff) {
            notes.push('既关不掉、也限不了 —— 这个模型"想多久"完全不受控');
        }
    }

    /* ⑤ 最大输出上限 —— 从大到小试，第一个不报错的就是它能接的 */
    /**
     * 【2026-11-09 空空】**从 131072 起试。**
     *
     * 设置页现在最大给到 131072，探测却从 65536 起 —— 那样选了大值会显示
     * "上限约 65536"，看起来像是填错了。两边必须对齐。
     *
     * 每档只发一个 2 token 的请求，**不会真的生成那么多字**，成本可忽略。
     */
    for (const v of [131072, 65536, 32768, 16384, 8192]) {
        const probe = await postChat(
            input,
            { messages: [{ role: 'user', content: '1' }], max_tokens: v },
            timeoutMs,
        );
        if (probe.ok) {
            caps.maxOutput = v;
            break;
        }
        /* 只认"参数非法/超限"这类报错；网络问题不改变结论，直接留默认值 */
        if (!/max_tokens|maximum|too large|invalid|1024|4096/i.test(probe.error)) {
            notes.push(`上限探测中断：${probe.error.slice(0, 80)}`);
            break;
        }
    }

    return caps;
}

/**
 * 拉模型清单。
 *
 * 不是所有厂商都实现 `/models`（有的返回 404），拿不到不是错误，
 * 只是"这次没法列清单"，调用方应该允许用户手填模型名。
 */
export async function listModels(input: Omit<ProbeInput, 'model'>): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15000);
    try {
        const res = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/models`, {
            signal: controller.signal,
            headers: { Authorization: `Bearer ${input.apiKey}` },
        });
        if (!res.ok) return [];
        const json = (await res.json()) as { data?: { id?: string }[] };
        return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
}
