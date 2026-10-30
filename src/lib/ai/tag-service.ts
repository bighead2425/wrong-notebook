/**
 * 从数据库获取 AI 分析所需的标签
 * 替代原有的 getMathTagsByGrade 函数
 */

import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';

const logger = createLogger('ai:tag-service');

interface TagTreeNode {
    id: string;
    name: string;
    parentId: string | null;
    children?: TagTreeNode[];
}

/**
 * 给 AI 的标签清单分支：一个单元 + 它下面的知识点。
 *
 * 2026-10-30 新增。有了它，提示词才能按单元分组呈现，
 * 而不是把几百个名字平铺成一长串（那样 AI 只能按字面猜）。
 */
export interface TagBranch {
    unit: string;
    points: string[];
}

/**
 * 年级 → 数据库顶层节点名
 *
 * 【2026-10-30 重写】原来只映射 7–12，且用 if/else 分流：
 * `grade = 5` 会落进 `else` 分支执行 `for (g = 10; g <= 5)` —— **一次都不循环**，
 * 于是返回空数组，AI 拿不到任何小学标签。
 * 现在小学（1–6）与中学（7–9 / 10–12）各自累进，互不掺和。
 */
const GRADE_TO_TOPNODE: Record<number, string[]> = {
    1: ['一年级'],
    2: ['二年级'],
    3: ['三年级'],
    4: ['四年级'],
    5: ['五年级'],
    6: ['六年级'],
    7: ['七年级上', '七年级下'],
    8: ['八年级上', '八年级下'],
    9: ['九年级上', '九年级下'],
    10: ['高一上', '高一下'],
    11: ['高二上', '高二下'],
    12: ['高三上', '高三下'],
};

/**
 * 取「当前年级及以前」的顶层节点名（累进）。
 * - 小学 1–6：一年级 → 六年级
 * - 初中 7–9：七上 → 当前（不含小学，保持原行为）
 * - 高中 10–12：高一上 → 当前
 */
function topNodeNamesUpTo(grade: number | null): string[] {
    if (!grade) {
        return Object.values(GRADE_TO_TOPNODE).flat();
    }
    const start = grade <= 6 ? 1 : grade <= 9 ? 7 : 10;
    const names: string[] = [];
    for (let g = start; g <= grade; g++) {
        names.push(...(GRADE_TO_TOPNODE[g] || []));
    }
    return names;
}

/**
 * 从数据库获取指定年级的数学标签
 * @param grade - 年级 (1-12) 或 null
 * @returns 标签名称数组（平铺，供旧调用方使用）
 */
export async function getMathTagsFromDB(grade: number | null): Promise<string[]> {
    const semesterNames = topNodeNamesUpTo(grade);

    try {
        // 获取所有顶层节点（年级学期）
        const topLevelTags = await prisma.knowledgeTag.findMany({
            where: {
                subject: 'math',
                parentId: null,
                name: { in: semesterNames },
            },
            select: { id: true },
        });

        const topLevelIds = topLevelTags.map(t => t.id);

        // 递归获取所有叶子节点标签
        const allTags = await prisma.knowledgeTag.findMany({
            where: {
                subject: 'math',
                isSystem: true,
            },
            select: {
                id: true,
                name: true,
                parentId: true,
            },
        });

        // 构建父子关系映射
        const childMap = new Map<string, string[]>();
        allTags.forEach(tag => {
            if (tag.parentId) {
                const children = childMap.get(tag.parentId) || [];
                children.push(tag.id);
                childMap.set(tag.parentId, children);
            }
        });

        // 递归收集所有后代ID
        const collectDescendants = (nodeId: string): string[] => {
            const children = childMap.get(nodeId) || [];
            if (children.length === 0) return [nodeId]; // 叶子节点
            return children.flatMap(cid => collectDescendants(cid));
        };

        // 收集所有目标年级的叶子节点
        const leafIds = new Set<string>();
        topLevelIds.forEach(id => {
            collectDescendants(id).forEach(leafId => leafIds.add(leafId));
        });

        // 获取叶子节点名称
        const tagNameMap = new Map(allTags.map(t => [t.id, t.name]));
        const result = Array.from(leafIds)
            .map(id => tagNameMap.get(id))
            .filter((name): name is string => !!name);

        return result;
    } catch (error) {
        logger.error({ error }, 'getMathTagsFromDB error');
        return [];
    }
}

/**
 * 从数据库获取指定学科的标签
 * @param subject - 学科 (math, physics, chemistry, english, etc.)
 * @returns 标签名称数组
 */
export async function getTagsFromDB(subject: string): Promise<string[]> {
    try {
        const tags = await prisma.knowledgeTag.findMany({
            where: {
                subject,
                isSystem: true,
                // 只获取叶子节点
                children: { none: {} },
            },
            select: { name: true },
            orderBy: { order: 'asc' },
        });

        return tags.map(t => t.name);
    } catch (error) {
        logger.error({ error }, 'getTagsFromDB error');
        return [];
    }
}

/**
 * 【2026-10-30】给 AI 的**结构化**标签清单：按单元分组，而不是一长串平铺的名字。
 *
 * 为什么必须带层级：平铺名字时，AI 看不出「平行四边形的面积」属于「多边形的面积」，
 * 只能按字面相似度猜；而带上单元后，它先在单元层面定位，再在单元内选点，准确率完全不同。
 *
 * 粒度取「叶子的父节点」作单元：`tag-data` 里 tags 是挂在 section 下的，
 * section 正好是「能单独出一张练习纸」的单位。
 *
 * @param subject 学科键（math / physics / ...）
 * @param grade   年级 1–12；仅数学按年级过滤，其他学科取全量
 */
export async function getTagTree(subject: string, grade: number | null): Promise<TagBranch[]> {
    try {
        const all = await prisma.knowledgeTag.findMany({
            where: { subject, isSystem: true },
            select: { id: true, name: true, parentId: true, order: true },
        });
        if (all.length === 0) return [];

        const byId = new Map(all.map((t) => [t.id, t]));
        const childCount = new Map<string, number>();
        for (const t of all) {
            if (t.parentId) childCount.set(t.parentId, (childCount.get(t.parentId) || 0) + 1);
        }

        /* 顶层（年级）过滤：数学按年级累进；其他学科不按年级（保持原行为） */
        const wantedTops = subject === 'math' ? new Set(topNodeNamesUpTo(grade)) : null;
        const roots = all.filter((t) => t.parentId === null && (!wantedTops || wantedTops.has(t.name)));
        if (roots.length === 0) return [];

        /* 收集这些根的全部后代 */
        const inScope = new Set(roots.map((r) => r.id));
        let grew = true;
        while (grew) {
            grew = false;
            for (const t of all) {
                if (t.parentId && inScope.has(t.parentId) && !inScope.has(t.id)) {
                    inScope.add(t.id);
                    grew = true;
                }
            }
        }

        /* 叶子挂到「它的父节点」这个单元下 */
        const branches = new Map<string, TagBranch>();
        const unitMeta = new Map<string, { order: number }>();
        for (const t of all) {
            if (!inScope.has(t.id)) continue;
            if ((childCount.get(t.id) || 0) > 0) continue;

            const parent = t.parentId ? byId.get(t.parentId) : null;
            const key = parent?.id ?? '__orphan__';
            const unit = parent?.name ?? '未分单元';

            if (!branches.has(key)) {
                branches.set(key, { unit, points: [] });
                unitMeta.set(key, { order: parent?.order ?? 9999 });
            }
            branches.get(key)!.points.push(t.name);
        }

        return [...branches.entries()]
            .sort((a, b) => (unitMeta.get(a[0])?.order ?? 9999) - (unitMeta.get(b[0])?.order ?? 9999))
            .map(([, v]) => v);
    } catch (error) {
        logger.error({ error }, 'getTagTree error');
        return [];
    }
}
