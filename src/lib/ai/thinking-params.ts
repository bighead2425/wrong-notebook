/**
 * 【2026-11-09 空空】**"要不要带思考参数、带哪个"——这个判断只能有一处。**
 *
 * ── 为什么必须抽出来 ─────────────────────────────────────────────
 * 项目里有两条调 AI 的路：
 *   ① `OpenAIProvider`（非两段式、第二段归位等）
 *   ② `two-stage-runner` 里的 `chatCompletions`（第一段看图转录，**当前默认走这条**）
 *
 * 11-09 之前，`thinkingParams()` 只写在 ① 里，② 的请求体只有
 * `{ model, messages, max_tokens }` —— 于是：
 *
 *   · 设置页选「思考强度 = 低」→ ① 会带 `reasoning_effort`，② 一个都不带
 *   · 能力探测出"能关思考"     → ① 会带 `thinking: disabled`，② 还是不带
 *
 * 结果就是：**mimo 一道小学题烧掉一万多 token 在 reasoning 上**，
 * 而用户明明在设置里选了"低"。不是模型不听话，是我们没告诉它。
 *
 * ── 三套机制（实测，不是推测）──────────────────────────────────────
 *   · DeepSeek 系：`thinking: { type: 'disabled' }` 能彻底关
 *   · GLM-5 系：**关不掉**，只能 `reasoning_effort: 'low'` 让它少想
 *   · 小米 / 商汤：两个参数都不认，乱发会直接 400
 *
 * ── 原则 ─────────────────────────────────────────────────────────
 * **没探测过就一个都不带。** 宁可让它多想，也不能把不认参数的老厂商搞崩。
 */

export type ThinkingCapability = {
    image: boolean;
    reasoning: boolean;
    thinkingOff: boolean;
    effortLevels: string[];
} | undefined;

export type ThinkingWanted = 'off' | 'low' | 'high' | 'max' | undefined;

/**
 * 算出这次请求该附加的思考参数。返回空对象表示"什么都不带"。
 *
 * @param cap     能力探测结果（没探测过传 undefined）
 * @param wanted  用户在设置里手选的强度（留空 = 自动取最省的）
 */
export function buildThinkingParams(
    cap: ThinkingCapability,
    wanted: ThinkingWanted,
): Record<string, unknown> {
    /**
     * 【2026-11-09】**没探测过时，只有用户明确选了才发。**
     *
     * 否则"设置里选了低、却一点没生效"会重演 —— 他不可能每次都先点一遍测试连接。
     * 至于厂商认不认，由调用方的 400 兜底负责（见 `chatCompletions` 里那段）。
     */
    if (!cap) {
        if (!wanted) return {};
        if (wanted === 'off') return { thinking: { type: 'disabled' } };
        return { reasoning_effort: wanted };
    }
    if (!cap.reasoning) return {};
    const levels = cap.effortLevels ?? [];

    /* ① 用户手选的优先 —— 但只发模型认的，否则请求直接 400 */
    if (wanted === 'off' && cap.thinkingOff) {
        return { thinking: { type: 'disabled' } };
    }
    if (wanted && wanted !== 'off' && levels.includes(wanted)) {
        return { reasoning_effort: wanted };
    }

    /* ② 没手选、或手选的档它不认 ⇒ 按能力取最省的 */
    if (cap.thinkingOff) return { thinking: { type: 'disabled' } };
    if (levels.includes('low')) return { reasoning_effort: 'low' };
    if (levels.length > 0) return { reasoning_effort: levels[0] };
    return {};
}
