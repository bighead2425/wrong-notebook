/**
 * 知识点「坐标」的解析与归一。
 *
 * 【2026-10-31 新增】为什么需要坐标：
 *
 * 原来 AI 只交回三个**名字**（`<knowledge_points>平行四边形的面积, 底和高的对应</…>`），
 * 服务端拿名字去反查。而词表里 38 个知识点跨册重名（「轴对称图形」在二上/三下/五上/八上
 * 各有一条），`findFirst` 取第一条 ⇒ **五年级那道题会挂到二年级**。
 *
 * 而且提示词里明明白白要求它"先判断属于哪个单元，再在该行下列里选" ——
 * 它做了定位，我们却**没要求它把定位结果交出来**。这是整条链路最贵的一次信息丢失。
 *
 * 所以协议改成四段：
 *
 *   <knowledge_points>
 *   <kp book="五年级上" chapter="第五单元 多边形的面积" section="平行四边形的面积" name="底和高的对应"/>
 *   </knowledge_points>
 *
 * 落库时按 册+节+名字 → 册+名字 → 放弃 三级降级。**绝不退回全局按名字查**。
 *
 * 纯函数、不碰数据库 —— 这条规则必须能单独测（38 组重名全靠它）。
 */

export interface TagRef {
    /** 册 / 学段（如「五年级上」「高三」「小学」），模型可能不填 */
    book?: string;
    /** 章（如「第五单元 多边形的面积」），可空 */
    chapter?: string;
    /** 节（如「平行四边形的面积」），可空 */
    section?: string;
    /** 知识点名（唯一必填项） */
    name: string;
    /**
     * true = 这条是从旧的逗号分隔格式推出来的，**没有位置**。
     * 落库时最多只能做到"按名字查"，必须进待确认队列。
     */
    legacy?: boolean;
}

/** 属性取值的三种引号写法都收（模型偶尔用中文引号或单引号） */
function readAttr(attrs: string, key: string): string | undefined {
    const patterns = [
        new RegExp(`${key}\\s*=\\s*"([^"]*)"`),
        new RegExp(`${key}\\s*=\\s*'([^']*)'`),
        new RegExp(`${key}\\s*=\\s*“([^”]*)”`),
    ];
    for (const re of patterns) {
        const m = attrs.match(re);
        if (m && m[1].trim()) return m[1].trim();
    }
    return undefined;
}

/**
 * 解析 `<kp .../>` 或 `<kp ...>名字</kp>`。
 *
 * 解析不出任何一条时返回 `[]` —— 由调用方降级到旧的逗号切分（见 `splitKnowledgePoints`）。
 * **不要在这里猜**：拿不准就交给上层决定，测起来才分得清是哪一步的问题。
 */
export function parseTagRefs(raw: string | null | undefined): TagRef[] {
    if (!raw) return [];

    const out: TagRef[] = [];
    // 自闭合 或 成对标签，两种都收
    const re = /<kp\b([^>]*?)(?:\/>|>([\s\S]*?)<\/kp>)/gi;

    for (const m of raw.matchAll(re)) {
        const attrs = m[1] || '';
        const inner = (m[2] || '').trim();
        const name = readAttr(attrs, 'name') || inner;
        if (!name) continue;
        if (name.toUpperCase() === 'UNMATCHED') continue;

        out.push({
            book: readAttr(attrs, 'book'),
            chapter: readAttr(attrs, 'chapter'),
            section: readAttr(attrs, 'section'),
            name,
        });
    }

    return out;
}

/**
 * 名字归一：去掉括号补充、空白、全半角差异。
 *
 * 为什么要它：AI 常把提示词里的名字改写成
 * 「等式的性质（等式两边同乘或同除以一个非零数，等式仍成立）」——
 * 库里那条叫「等式的性质」，逐字比永远不中，于是每次都造一个新节点。
 * 归一之后至少能认出是同一个东西（识别不了位置，但能识别身份）。
 */
export function normalizeTagName(name: string): string {
    return name
        .replace(/[（(][^）)]*[）)]/g, '') // 括号补充整段去掉
        .replace(/\s+/g, '')
        .replace(/[·・]/g, '')
        .replace(/[，,。．.]/g, '')
        .trim();
}
