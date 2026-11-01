/**
 * 给标签补上**完整路径**（册 › 章 › 节 › 知识点）。
 *
 * 【2026-11-01】为什么需要它：
 *   详情页原来拿 `tagResolution` 拼路径，而那里的 `section` 字段存的是**章名**
 *   （两段式写库时 `section: e.chapter`），所以一道"长度单位换算"会显示成
 *   「五年级上 › 第一单元 小数的再认识和加减法」—— 少了真正的"节"，
 *   而且几道题看起来**长得一模一样**，像是全都挂到同一个地方了。
 *
 *   正确做法是**按标签节点自己的祖先链算**：落点是库里的事实，
 *   AI 的坐标只是过程记录，两者不该混用。
 */

import { prisma } from './prisma';
import { logger } from './logger';

export interface TagLike {
    id: string;
    name: string;
    parentId: string | null;
}

export interface WithPath {
    /**
     * 完整路径：册 › 章 › 节 › 知识点。
     *
     * **相邻重名会折叠**：词表里有"节名 = 知识点名"的情况
     * （如「小数的大小比较」既是节、下面又有一个同名知识点），
     * 不折叠的话会显示成「… › 小数的大小比较 › 小数的大小比较」。
     */
    path: string;
}

/**
 * 把一条祖先链（从册到点，**顺序已经是根在前**）折成路径串。
 *
 * 抽成纯函数是为了能测边界：只有一段时不能动，空链不能炸。
 */
export function chainToPaths(chain: string[]): { path: string } {
    const parts = [...chain];
    /* 只折叠**相邻**重名，不做全局去重（"第一单元"出现在两个册下是正常的） */
    while (parts.length > 1 && parts[parts.length - 1] === parts[parts.length - 2]) {
        parts.pop();
    }
    return { path: parts.join(' › ') };
}

/**
 * 批量补路径。一次把整棵树读进内存（词表约 1800 个节点，几十 KB），
 * 比逐级往上查（4 层 × N 次）快得多，也不会出现"查到一半父节点被删"的中间态。
 */
export async function decorateTagPaths<T extends TagLike>(
    tags: T[],
): Promise<(T & WithPath)[]> {
    if (tags.length === 0) return [];

    /**
     * 路径只是**显示用**的。查树失败（表被改、连接抖动、测试环境没 mock）
     * 绝不该让整个详情接口 500 —— 退化成"没有路径"，页面照常打开。
     */
    let all: { id: string; name: string; parentId: string | null }[];
    try {
        all = await prisma.knowledgeTag.findMany({
            select: { id: true, name: true, parentId: true },
        });
    } catch (e) {
        logger.warn({ err: String(e) }, '标签路径：读词表失败，本次不显示路径');
        return tags.map((t) => ({ ...t, path: '' }));
    }

    const byId = new Map(all.map((t) => [t.id, t]));

    const cache = new Map<string, string>();
    const pathOf = (id: string): string => {
        const hit = cache.get(id);
        if (hit !== undefined) return hit;

        const chain: string[] = [];
        const guard = new Set<string>();
        let cur: { id: string; name: string; parentId: string | null } | undefined = byId.get(id);
        while (cur && !guard.has(cur.id)) {
            guard.add(cur.id);
            chain.unshift(cur.name);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }

        const p = chainToPaths(chain).path;
        cache.set(id, p);
        return p;
    };

    return tags.map((t) => ({ ...t, path: pathOf(t.id) }));
}
