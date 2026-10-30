/**
 * 把 AI 返回的 `<knowledge_points>` 文本切成知识点数组。
 *
 * 【2026-10-30】为什么不能直接用 `split(/[,，\n]/)`：
 * 知识点名里本来就可能带逗号，最典型的是括号内补充说明：
 *
 *   等式的性质（等式两边同乘或同除以一个非零数，等式仍成立）
 *
 * 简单按逗号切，会把它切成**两个标签**：
 *   「等式的性质（等式两边同乘或同除以一个非零数」
 *   「等式仍成立）」
 *
 * 库里真出现过这一对（2026-10-30 查证），两条都挂在根节点上、各连 0 道题。
 * 所以这里按**括号深度**切：只有深度为 0 的逗号才是分隔符。
 *
 * 另外顺手过滤 `UNMATCHED`：提示词允许 AI 说「这些标签都不合适」，
 * 那是合法输出，不该被当成一个知识点存进库。
 */
export function splitKnowledgePoints(raw: string | null | undefined): string[] {
    if (!raw) return [];

    const out: string[] = [];
    let depth = 0;
    let buf = '';

    const push = () => {
        const t = buf.trim();
        if (t && t.toUpperCase() !== 'UNMATCHED') out.push(t);
        buf = '';
    };

    for (const ch of raw) {
        if (ch === '（' || ch === '(') depth += 1;
        else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);

        if ((ch === ',' || ch === '，' || ch === '\n' || ch === '、') && depth === 0) {
            push();
            continue;
        }
        buf += ch;
    }
    push();

    return out;
}
