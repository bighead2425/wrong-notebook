"use client";

import { useState, useEffect, useCallback } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";
import { TrendingUp, Plus, Trash2, ChevronDown, ChevronRight, House, Loader2, BookOpen, Search, ChevronsUpDown, ChevronsDownUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";
import { searchTagTree } from "@/lib/tag-tree";
import { TagStats, TagStatsResponse } from "@/types/api";

// 标签树节点类型
interface TagTreeNode {
    id: string;
    name: string;
    code: string | null;
    isSystem: boolean;
    children: TagTreeNode[];
}

// 学科配置
const SUBJECTS = [    { key: 'math', name: '数学' },
    { key: 'english', name: '英语' },
    { key: 'physics', name: '物理' },
    { key: 'chemistry', name: '化学' },
    { key: 'biology', name: '生物' },
    { key: 'chinese', name: '语文' },
    { key: 'history', name: '历史' },
    { key: 'geography', name: '地理' },
    { key: 'politics', name: '政治' },
] as const;

type SubjectKey = typeof SUBJECTS[number]['key'];

/**
 * 【2026-10-31】「待归类」：AI 选了名字、但词表里定位不到位置的题。
 * 以前这些标签会被静默丢掉，界面看着一切正常 —— 这个 tab 就是让它们现形。
 */
interface PendingCandidate {
    id: string;
    name: string;
    path: string;
}
interface PendingItem {
    id: string;
    source: string | null;
    questionText: string;
    notebook: string;
    subject: string;
    deviation: string;
    pending: Array<{ name: string; book: string; section: string; candidates: PendingCandidate[] }>;
}

export default function TagsPage() {
    const { t } = useLanguage();
    const [stats, setStats] = useState<TagStats[]>([]);
    const [loading, setLoading] = useState(true);

    // 标签数据 (按学科) - null 表示未加载，[] 表示已加载但无数据
    const [tagsBySubject, setTagsBySubject] = useState<Record<SubjectKey, TagTreeNode[] | null>>({
        math: null,
        english: null,
        physics: null,
        chemistry: null,
        biology: null,
        chinese: null,
        history: null,
        geography: null,
        politics: null,
    });

    // 自定义标签 (扁平列表，仅用于显示)
    const [customTags, setCustomTags] = useState<Array<{ id: string; name: string; subject: string; parentName?: string }>>([]);

    /* ===== 【2026-10-31】待归类 ===== */
    const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
    const [pendingLoading, setPendingLoading] = useState(false);
    /** 每条的备注草稿（键 = `${itemId}:${name}`）；可选，不填也能确认 */
    const [pendingNotes, setPendingNotes] = useState<Record<string, string>>({});

    const loadPending = useCallback(async () => {
        setPendingLoading(true);
        try {
            const data = await apiClient.get<{ items: PendingItem[] }>('/api/tags/pending');
            setPendingItems(data.items || []);
        } catch (e) {
            console.error('Failed to load pending tags', e);
        } finally {
            setPendingLoading(false);
        }
    }, []);

    const confirmPending = async (itemId: string, name: string, tagId: string) => {
        const key = `${itemId}:${name}`;
        try {
            await apiClient.post('/api/tags/pending/resolve', {
                itemId,
                name,
                tagId,
                ...(pendingNotes[key]?.trim() ? { note: pendingNotes[key].trim() } : {}),
            });
            /* 本地摘掉这一条，不必整页重刷 */
            setPendingItems((prev) =>
                prev
                    .map((it) =>
                        it.id === itemId
                            ? { ...it, pending: it.pending.filter((p) => p.name !== name) }
                            : it,
                    )
                    .filter((it) => it.pending.length > 0),
            );
        } catch (e) {
            console.error('Failed to resolve pending tag', e);
        }
    };

    // 新建标签表单
    const [newTagSubject, setNewTagSubject] = useState<SubjectKey>("math");
    const [newTagGrade, setNewTagGrade] = useState<string>(""); // 年级ID
    const [gradeOptions, setGradeOptions] = useState<Array<{ id: string; name: string }>>([]);
    const [newTagName, setNewTagName] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // 展开状态
    const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});

    /**
     * 【2026-11-02 真真】标准标签库的**检索**（空空第 2 条）。
     *
     * `searchInput` 是框里正在敲的字，`searchTerm` 是**点了搜索之后**才生效的词 ——
     * 他明确要求"点击搜索才开始搜索"，边打边筛会把树筛得七零八落、还看不清结构。
     */
    const [searchInput, setSearchInput] = useState("");
    const [searchTerm, setSearchTerm] = useState("");
    /** 命中个数（0 命中要说一句"没找到"，否则人会以为按钮没反应） */
    const [hitCount, setHitCount] = useState<number | null>(null);
    /**
     * 检索中 / 全展中。
     *
     * 为什么需要：这两个动作都要**先把 9 个学科的词表拉齐**（树是点开才懒加载的），
     * 老 NAS 上是一两秒的事。不给反馈的话按钮看起来像没反应，人会连点。
     */
    const [busy, setBusy] = useState(false);

    /**
     * 【2026-11-02 真真】**展开状态跨页保存** —— 空空第 2 条要"回到标准标签库并保持相应状态"。
     *
     * 从这一页点进 `/by-tag/[id]` 再点返回，`/tags` 是重新挂载的，
     * 组件里的 state 会归零 ⇒ 展开的册/章全收起来，她得重新点一遍。
     * ⇒ 用 `sessionStorage` 记住展开集合（关标签页就清，不污染长期存储）。
     *
     * ⚠️ 为什么用 effect 恢复而不是 `useState` 惰性初始化：
     *    服务端渲染时没有 `window`，惰性初始化会让服务端拿到 `{}`、客户端拿到有值
     *    ⇒ hydration 不一致（比多一次渲染糟得多）。
     */
    useEffect(() => {
        try {
            const saved = sessionStorage.getItem("tags-expanded-nodes");
            if (saved) {
                // eslint-disable-next-line react-hooks/set-state-in-effect -- 见上：挂载后读一次，避免 hydration 不一致
                setExpandedNodes(JSON.parse(saved) as Record<string, boolean>);
            }
        } catch {
            /* 存坏了就当没有 */
        }
    }, []);

    /** 展开集合一变就存 —— 返回时照原样恢复 */
    useEffect(() => {
        try {
            sessionStorage.setItem("tags-expanded-nodes", JSON.stringify(expandedNodes));
        } catch {
            /* 存不下（隐私模式）就算了，不影响主流程 */
        }
    }, [expandedNodes]);
    /**
     * 【2026-11-01】「换教材怎么改」说明书（skill）。
     *
     * 他要的是"把说明书放进产品里"：升年级 / 换教材时要重新校准词表，
     * 但那件事不一定由同一个 AI 来做 —— 所以把作业流程写成一份能带走的文档，
     * 点这里就能看、能下载。
     * 文件本体在 `public/skills/curriculum-calibration.md`（会打进镜像）。
     */
    const [skillOpen, setSkillOpen] = useState(false);
    const [skillText, setSkillText] = useState<string>('');

    // 获取标签树
    /**
     * 【2026-11-02 真真】改成**回传**数据。
     *
     * 检索 / 全展 需要"这一学科的所有节点 id"才能一次把展开集合算出来，
     * 而 `setTagsBySubject` 是异步的 —— 拉完立刻读 state 还是旧值。
     * 回传一份，调用方就不必等下一次渲染。
     */
    const fetchTags = useCallback(async (subject: SubjectKey) => {
        try {
            const data = await apiClient.get<{ tags: TagTreeNode[] }>(`/api/tags?subject=${subject}`);
            setTagsBySubject(prev => ({ ...prev, [subject]: data.tags }));
            return data.tags;
        } catch (error) {
            console.error(`Failed to fetch ${subject} tags:`, error);
            return null;
        }
    }, []);

    // 获取自定义标签
    const fetchCustomTags = useCallback(async () => {
        try {
            // 获取所有学科的扁平标签，过滤非系统标签
            const allCustom: Array<{ id: string; name: string; subject: string; parentName?: string }> = [];
            for (const { key } of SUBJECTS) {
                const data = await apiClient.get<{ tags: Array<{ id: string; name: string; isSystem: boolean; parentName?: string }> }>(
                    `/api/tags?subject=${key}&flat=true`
                );
                const custom = data.tags.filter(t => !t.isSystem).map(t => ({ ...t, subject: key }));
                allCustom.push(...custom);
            }
            setCustomTags(allCustom);
        } catch (error) {
            console.error("Failed to fetch custom tags:", error);
        }
    }, []);

    // 获取统计
    const fetchStats = async () => {
        try {
            const data = await apiClient.get<TagStatsResponse>("/api/tags/stats");
            setStats(data.stats);
        } catch (error) {
            console.error("Failed to fetch tag stats:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // 初始加载
        fetchStats();
        fetchCustomTags();
        // 默认加载数学标签
        fetchTags('math');
        // 【2026-10-31】顺便数一下有没有"标签没归类"的题（数量要能一眼看见）
        loadPending();
    }, [fetchTags, fetchCustomTags, loadPending]);

    // 当学科变化时，获取对应的年级列表
    useEffect(() => {
        const fetchGrades = async () => {
            try {
                const data = await apiClient.get<{ tags: TagTreeNode[] }>(`/api/tags?subject=${newTagSubject}`);
                // 顶级节点就是年级，只取系统标签
                const grades = data.tags
                    .filter(t => t.isSystem)
                    .map(t => ({ id: t.id, name: t.name }));
                setGradeOptions(grades);
                setNewTagGrade(""); // 重置选择
            } catch (error) {
                console.error("Failed to fetch grades:", error);
                setGradeOptions([]);
            }
        };
        fetchGrades();
    }, [newTagSubject]);

    // 添加自定义标签
    const handleAddCustomTag = async () => {
        if (!newTagName.trim()) {
            alert(t.tags?.custom?.enterName || "Please enter tag name");
            return;
        }

        setSubmitting(true);
        try {
            await apiClient.post('/api/tags', {
                name: newTagName.trim(),
                subject: newTagSubject,
                parentId: (newTagGrade && newTagGrade !== 'none') ? newTagGrade : undefined,
            });
            setNewTagName("");
            // 刷新
            await fetchCustomTags();
            await fetchTags(newTagSubject);
            alert(t.tags?.custom?.success || "Tag added successfully!");
        } catch (error: any) {
            if (error?.message?.includes('409')) {
                alert(t.tags?.custom?.exists || "Tag already exists");
            } else {
                alert("Failed to add tag");
            }
        } finally {
            setSubmitting(false);
        }
    };

    // 删除自定义标签
    const handleRemoveCustomTag = async (tagId: string, tagName: string, subject: SubjectKey) => {
        /**
         * 【2026-11-04 审计 A5】**删之前先看有多少道题在用。**
         *
         * 原来一句 confirm 就删：题上这个标签直接消失，没有任何痕迹；
         * 自定义标签底下要是挂着子节点，还会被抬成根节点。
         * 用列表接口拿 `total`（`scope=all` 连已掌握/归档的也算上），
         * 把"几道题会失去它"摆在他面前再让他决定。
         */
        let usedBy = 0;
        try {
            const probe = await apiClient.get<{ total: number }>(
                `/api/error-items/list?tagId=${encodeURIComponent(tagId)}&pageSize=1&scope=all`,
            );
            usedBy = probe.total ?? 0;
        } catch {
            /* 查不到就当 0 —— 不能因为查引用失败就卡住删除 */
        }

        const question = usedBy > 0
            ? `有 ${usedBy} 道题在用「${tagName}」。\n\n删了之后这些题会失去这个标签，且无法恢复。确定删除？`
            : (t.tags?.custom?.deleteConfirm || "Are you sure you want to delete tag \"{tag}\"?").replace("{tag}", tagName);

        if (!confirm(question)) return;

        try {
            /* force=1 = "人已经看见了数量，确认要删"（后端拿它区分"没传"） */
            await apiClient.delete(`/api/tags?id=${tagId}${usedBy > 0 ? "&force=1" : ""}`);
            await fetchCustomTags();
            await fetchTags(subject);
        } catch (error) {
            console.error("Failed to delete tag:", error);
            alert("Failed to delete tag");
        }
    };

    // 切换节点展开
    const toggleNode = (nodeId: string) => {
        setExpandedNodes(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));
    };

    // 渲染标签树节点
    const renderTreeNode = (node: TagTreeNode, depth: number = 0, isLeafContext: boolean = false): React.ReactNode => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expandedNodes[node.id];
        const paddingLeft = depth * 16;

        if (!hasChildren) {
            /**
             * 【2026-11-01】叶子（知识点）**可点** —— 点进去看"这个知识点她错了哪些题"。
             * 以前只是个死标签，管理页只能增删，看不到题。
             */
            return (
                <Link
                    key={node.id}
                    href={`/by-tag/${node.id}?back=${encodeURIComponent("/tags")}`}
                    className="inline-block"
                    style={{ marginLeft: isLeafContext ? 0 : paddingLeft }}
                    title="看这个知识点的所有题"
                >
                    <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                        {highlight(node.name)}
                        {(() => {
                            const stat = stats.find(s => s.tag === node.name);
                            return stat ? <span className="ml-1 text-xs text-muted-foreground">({stat.count})</span> : null;
                        })()}
                    </Badge>
                </Link>
            );
        }



        // 过滤出系统标签子节点
        const visibleChildren = node.children.filter(child => child.isSystem);

        if (visibleChildren.length === 0) {
            // 如果没有可见子节点，且当前节点非叶子（但所有子节点都被过滤了），也显示为 Badge？
            // 原逻辑: !hasChildren -> Badge. 
            // 这里我们保持原样，如果不显示子节点，它仍然是一个展开的Folder但内容为空。
            // 或者我们可以返回 null? 不，父节点是系统节点，应该显示。
            return (
                <div key={node.id} className="space-y-2" style={{ paddingLeft }}>
                    <div
                        className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded px-2 py-1 -mx-2"
                        onClick={() => toggleNode(node.id)}
                    >
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        <span className="font-medium text-sm">{highlight(node.name)}</span>
                        <span className="text-xs text-muted-foreground">({visibleChildren.length})</span>
                        {/* 【2026-11-01】这一层（册/章/节）也能点进去看题 —— 题挂在下面的知识点上，按子树查 */}
                        <Link
                            href={`/by-tag/${node.id}?back=${encodeURIComponent("/tags")}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-primary hover:underline ml-1"
                        >
                            看题
                        </Link>
                    </div>
                </div>
            );
        }

        // 判断可见子节点是否都是叶子节点
        const allChildrenAreLeaves = visibleChildren.every(child => child.children.filter(c => c.isSystem).length === 0);

        // 有子节点 - 可展开
        return (
            <div key={node.id} className="space-y-2" style={{ paddingLeft }}>
                <div
                    className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded px-2 py-1 -mx-2"
                    onClick={() => toggleNode(node.id)}
                >
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span className="font-medium text-sm">{highlight(node.name)}</span>
                    <span className="text-xs text-muted-foreground">({visibleChildren.length})</span>
                        {/* 【2026-11-01】这一层（册/章/节）也能点进去看题 —— 题挂在下面的知识点上，按子树查 */}
                        <Link
                            href={`/by-tag/${node.id}?back=${encodeURIComponent("/tags")}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-primary hover:underline ml-1"
                        >
                            看题
                        </Link>
                </div>
                {isExpanded && (
                    allChildrenAreLeaves ? (
                        // 如果所有子节点都是叶子，使用 flex-wrap 布局
                        <div className="flex flex-wrap gap-2 pl-6">
                            {visibleChildren.map(child => renderTreeNode(child, 0, true))}
                        </div>
                    ) : (
                        // 如果有非叶子子节点，使用垂直堆叠布局
                        <div className="space-y-2 pl-6">
                            {visibleChildren.map(child => renderTreeNode(child, 0, false))}
                        </div>
                    )
                )}
            </div>
        );
    };

    /* ==================== 【2026-11-02 真真】检索 / 全展 / 全收 ==================== */

    /**
     * 把还没拉过的学科补齐，回一张完整的「学科 → 树」。
     *
     * 为什么要这样：检索和全展都要**全学科的节点 id**才能一次算好展开集合，
     * 而树是点开学科才懒加载的 —— 不先补齐，搜"小数乘法"只会搜到已经点开的那一科。
     * 并行拉，9 个学科不至于串成一条长龙。
     */
    const ensureAllTrees = async (): Promise<Record<string, TagTreeNode[]>> => {
        const trees: Record<string, TagTreeNode[]> = {};
        const missing: SubjectKey[] = [];
        for (const { key } of SUBJECTS) {
            const cached = tagsBySubject[key];
            if (cached) trees[key] = cached;
            else missing.push(key);
        }
        const fetched = await Promise.all(
            missing.map(async (key) => [key, await fetchTags(key)] as const),
        );
        for (const [key, nodes] of fetched) trees[key] = nodes ?? [];
        return trees;
    };

    /**
     * 关键字高亮。
     *
     * 只高亮**第一处** —— 词表里最长也就十来个字，命中两处的极少见；
     * 拆多段反而把 JSX 写复杂。用 `mark` 而不是加粗：浏览器原生语义就是"标记"，
     * 打印/读屏也认得。
     */
    const highlight = (text: string): React.ReactNode => {
        if (!searchTerm) return text;
        const idx = text.toLowerCase().indexOf(searchTerm.toLowerCase());
        if (idx < 0) return text;
        return (
            <>
                {text.slice(0, idx)}
                <mark className="bg-amber-200 text-foreground rounded px-0.5">
                    {text.slice(idx, idx + searchTerm.length)}
                </mark>
                {text.slice(idx + searchTerm.length)}
            </>
        );
    };

    const handleSearch = async () => {
        const kw = searchInput.trim();

        /**
         * 【他明确要求】框里没内容就点搜索 = **不搜**，回到"全部收起"的原状。
         * 不是"清空搜索"，是回到初始态 —— 连展开的册/章也一起收掉。
         */
        if (!kw) {
            setSearchTerm("");
            setHitCount(null);
            setExpandedNodes({});
            return;
        }

        setBusy(true);
        let trees: Record<string, TagTreeNode[]>;
        try {
            trees = await ensureAllTrees();
        } finally {
            setBusy(false);
        }
        const next: Record<string, boolean> = {};
        let hits = 0;

        for (const { key } of SUBJECTS) {
            /**
             * 【2026-11-02】"展开到哪一层"的规则在 `lib/tag-tree.ts#searchTagTree` ——
             * 它是纯函数、有单测。这里只负责把结果铺成 `expandedNodes` 的形状。
             *
             * 学科自己也算一层：某一科里有命中，那张 Card 就得打开，否则里面展开得再好也看不见。
             */
            const result = searchTagTree(trees[key] ?? [], kw);
            hits += result.hits;
            if (result.hits > 0) next[`subject-${key}`] = true;
            for (const id of result.expandIds) next[id] = true;
        }

        setSearchTerm(kw);
        setHitCount(hits);
        setExpandedNodes(next);
    };

    /** 全展：学科 → 学段 → 年级 → 学期 → 单元 → 章 → 节 → 知识点，一层不留 */
    const expandAll = async () => {
        setBusy(true);
        let trees: Record<string, TagTreeNode[]>;
        try {
            trees = await ensureAllTrees();
        } finally {
            setBusy(false);
        }
        const next: Record<string, boolean> = {};
        const walk = (list: TagTreeNode[]) => {
            for (const node of list) {
                if ((node.children?.length ?? 0) > 0) {
                    next[node.id] = true;
                    walk(node.children);
                }
            }
        };
        for (const { key } of SUBJECTS) {
            next[`subject-${key}`] = true;
            walk(trees[key] ?? []);
        }
        setExpandedNodes(next);
    };

    /**
     * 全收：一律折叠。
     *
     * 不动 `searchTerm` —— 收起是收起，搜索词还在框里，再点一次搜索还能回来。
     * 清掉它等于顺手抹了人的输入，不礼貌。
     */
    const collapseAll = () => {
        setExpandedNodes({});
    };

    // 渲染标准标签库
    const renderStandardTags = () => {
        return (
            <>
                {/**
                  * 【2026-11-02 真真】检索框 + 搜索 + 全展 + 全收（空空第 2 条）。
                  *
                  * 为什么"点了才搜"：词表是 8 层深的树，边打边筛会让树一直抖，
                  * 人还没打完就已经找不到自己在哪了。他自己也是这么要求的。
                  *
                  * 空着点搜索 = 回到全部收起的初始态（见 `handleSearch`）。
                  */}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                    <div className="relative flex-1 min-w-[200px] max-w-md">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") handleSearch();
                                if (e.key === "Escape") {
                                    setSearchInput("");
                                    setSearchTerm("");
                                    setHitCount(null);
                                }
                            }}
                            placeholder="检索单元 / 章节 / 知识点…"
                            className="h-9 pl-8 pr-8"
                        />
                        {searchInput && (
                            <button
                                type="button"
                                onClick={() => {
                                    setSearchInput("");
                                    setSearchTerm("");
                                    setHitCount(null);
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                title="清空"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                    <Button size="sm" onClick={handleSearch} disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Search className="h-4 w-4 mr-1" />}
                        {busy ? "搜索中…" : "搜索"}
                    </Button>
                    <div className="flex-1" />
                    <Button size="sm" variant="outline" onClick={expandAll} disabled={busy} title="展开所有层级，方便通读词表">
                        <ChevronsUpDown className="h-4 w-4 mr-1" />
                        全展
                    </Button>
                    <Button size="sm" variant="outline" onClick={collapseAll} title="全部折叠回学科层">
                        <ChevronsDownUp className="h-4 w-4 mr-1" />
                        全收
                    </Button>
                </div>

                {/* 搜完给个交代：命中几处 / 一处都没命中 */}
                {searchTerm && (
                    <div className="mb-3 text-sm">
                        {hitCount && hitCount > 0 ? (
                            <span className="text-muted-foreground">
                                找到 <span className="font-medium text-foreground">{hitCount}</span> 处「
                                <span className="font-medium text-foreground">{searchTerm}</span>」，已展开到对应层级
                            </span>
                        ) : (
                            <span className="text-amber-600">
                                没找到含「{searchTerm}」的单元 / 章节 / 知识点
                            </span>
                        )}
                    </div>
                )}

                {SUBJECTS.map(({ key, name }) => {
                    const subjectName = (t.tags?.subjects as any)?.[key] || name;
                    const isExpanded = expandedNodes[`subject-${key}`];
                    const tags = tagsBySubject[key];

                    return (
                        <Card key={key} className="mb-4">
                            <CardHeader
                                className="cursor-pointer hover:bg-muted/50 transition-colors flex flex-row items-center justify-between py-4"
                                onClick={() => {
                                    toggleNode(`subject-${key}`);
                                    if (tags === null) fetchTags(key);
                                }}
                            >
                                <CardTitle className="text-lg flex items-center gap-2">
                                    {isExpanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                                    {highlight(subjectName)}
                                </CardTitle>
                                <span className="text-sm text-muted-foreground">
                                    {isExpanded ? (t.common?.collapse || "Collapse") : (t.common?.expand || "Expand")}
                                </span>
                            </CardHeader>
                            {isExpanded && (
                                <CardContent className="space-y-4 pt-0">
                                    {tags === null ? (
                                        <div className="text-center py-4 text-muted-foreground">
                                            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                                            Loading...
                                        </div>
                                    ) : tags.filter(t => t.isSystem).length === 0 ? (
                                        <div className="text-center py-4 text-muted-foreground">
                                            {t.tags?.stats?.empty || "暂无系统标签"}
                                        </div>
                                    ) : (
                                        tags.filter(t => t.isSystem).map(node => renderTreeNode(node))
                                    )}
                                </CardContent>
                            )}
                        </Card>
                    );
                })}
            </>
        );
    };

    // 渲染自定义标签
    const renderCustomTags = () => {
        const groupedBySubject = customTags.reduce((acc, tag) => {
            if (!acc[tag.subject]) acc[tag.subject] = [];
            acc[tag.subject].push(tag);
            return acc;
        }, {} as Record<string, typeof customTags>);

        return (
            <div className="space-y-6">
                <Card>
                    <CardHeader><CardTitle>{t.tags?.custom?.addTitle || "Add Custom Tag"}</CardTitle></CardHeader>
                    <CardContent>
                        <div className="flex gap-3 flex-wrap">
                            <Select value={newTagSubject} onValueChange={(v) => setNewTagSubject(v as SubjectKey)}>
                                <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {SUBJECTS.map(({ key, name }) => (
                                        <SelectItem key={key} value={key}>{(t.tags?.subjects as any)?.[key] || name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            <Select value={newTagGrade} onValueChange={setNewTagGrade}>
                                <SelectTrigger className="w-[140px]">
                                    <SelectValue placeholder={t.tags?.custom?.selectGrade || "选择年级"} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">{t.tags?.custom?.noGrade || "不选择年级"}</SelectItem>
                                    {gradeOptions.map((grade) => (
                                        <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            <Input
                                placeholder={t.tags?.custom?.placeholder || "Enter tag name..."}
                                value={newTagName}
                                onChange={(e) => setNewTagName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddCustomTag()}
                                className="flex-1 min-w-[200px]"
                            />
                            <Button onClick={handleAddCustomTag} disabled={submitting}>
                                {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                                {t.tags?.custom?.add || "Add"}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                            {t.tags?.custom?.hint || "💡 Custom tags will automatically appear in tag suggestions"}
                        </p>
                    </CardContent>
                </Card>

                {customTags.length === 0 ? (
                    <Card><CardContent className="py-12 text-center text-muted-foreground">
                        {t.tags?.custom?.empty || "No custom tags yet, click above to add!"}
                    </CardContent></Card>
                ) : (
                    SUBJECTS.map(({ key, name }) => {
                        const tags = groupedBySubject[key];
                        if (!tags?.length) return null;

                        // Group by parentName (or "General")
                        const groupedByParent = tags.reduce((acc, tag) => {
                            const groupName = tag.parentName || "通用";
                            if (!acc[groupName]) acc[groupName] = [];
                            acc[groupName].push(tag);
                            return acc;
                        }, {} as Record<string, typeof customTags>);

                        // Sort groups keys to put "General" last or first? Let's put regular names first.
                        const groupKeys = Object.keys(groupedByParent).sort((a, b) => {
                            if (a === "通用") return 1;
                            if (b === "通用") return -1;
                            return a.localeCompare(b, "zh");
                        });

                        return (
                            <Card key={key}>
                                <CardHeader><CardTitle className="text-lg">{(t.tags?.subjects as any)?.[key] || name} ({tags.length})</CardTitle></CardHeader>
                                <CardContent className="space-y-4">
                                    {groupKeys.map(groupName => (
                                        <div key={groupName} className="space-y-2">
                                            {groupName !== "通用" && (
                                                <h4 className="text-sm font-semibold text-muted-foreground border-b pb-1 mb-2">{groupName}</h4>
                                            )}
                                            {groupName === "通用" && groupKeys.length > 1 && (
                                                <h4 className="text-sm font-semibold text-muted-foreground border-b pb-1 mb-2">其他</h4>
                                            )}
                                            <div className="flex flex-wrap gap-2">
                                                {groupedByParent[groupName].map((tag) => (
                                                    <Badge key={tag.id} variant="secondary" className="px-3 py-1.5 text-sm">
                                                        {tag.name}
                                                        <button
                                                            onClick={() => handleRemoveCustomTag(tag.id, tag.name, key)}
                                                            className="ml-2 hover:text-destructive transition-colors"
                                                            title={t.common?.delete || "Delete"}
                                                        >
                                                            <Trash2 className="h-3 w-3" />
                                                        </button>
                                                    </Badge>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                        );
                    })
                )}
            </div>
        );
    };

    /**
     * 【2026-10-31】渲染「待归类」。
     *
     * 一屏解决一件事：AI 当时写的是什么、词表里最像的是哪几个、确认时能不能顺手留一句原因。
     * 候选只给"同科 + 名字相近"，不给人看整棵树 —— 那等于把猜谜又推回给人。
     */
    const renderPending = () => {
        if (pendingLoading) return <div className="text-center py-8 text-muted-foreground">加载中…</div>;
        if (pendingItems.length === 0) {
            return (
                <div className="text-center py-12 text-muted-foreground space-y-1">
                    <p>没有待归类的标签。</p>
                    <p className="text-xs">AI 选的每个知识点都找到了位置。</p>
                </div>
            );
        }
        return (
            <div className="space-y-4">
                {pendingItems.map((item) => (
                    <Card key={item.id}>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base flex items-center gap-2">
                                <span className="font-mono text-sm">{item.source || item.id.slice(0, 8)}</span>
                                {item.notebook && <Badge variant="outline">{item.notebook}</Badge>}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground line-clamp-2">{item.questionText}</p>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {item.pending.map((p) => {
                                const key = `${item.id}:${p.name}`;
                                return (
                                    <div key={p.name} className="space-y-2 border-t pt-3 first:border-0 first:pt-0">
                                        <div className="text-sm">
                                            {/**
                                              * 【2026-11-02 真真】原来写死"AI 写的是"。
                                              * 但人在详情页手打一个库里没有的词，也会落到这里 ——
                                              * 那时它说"AI 写的"是**冤枉 AI**，还会让人以为是 AI 的锅。
                                              * 改成中性的说法，两种来源都成立。
                                              */}
                                            没归类上 <span className="font-medium">「{p.name}」</span>
                                            {(p.book || p.section) && (
                                                <span className="text-muted-foreground">
                                                    （{p.book}{p.section ? ` › ${p.section}` : ''}）
                                                </span>
                                            )}
                                        </div>
                                        {p.candidates.length > 0 ? (
                                            <div className="flex flex-wrap gap-2">
                                                {p.candidates.map((c) => (
                                                    <Button
                                                        key={c.id}
                                                        size="sm"
                                                        variant="secondary"
                                                        onClick={() => confirmPending(item.id, p.name, c.id)}
                                                    >
                                                        {c.name}
                                                        {c.path && (
                                                            <span className="ml-1 text-xs text-muted-foreground">{c.path}</span>
                                                        )}
                                                    </Button>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-xs text-amber-600">
                                                词表里没有相近的。可能要在「标准标签」里手工建一个，再回来确认。
                                            </p>
                                        )}
                                        <Input
                                            value={pendingNotes[key] || ''}
                                            onChange={(e) =>
                                                setPendingNotes((prev) => ({ ...prev, [key]: e.target.value }))
                                            }
                                            placeholder="可选：一句话说明，例如「这题其实是三下的」"
                                            className="h-8 text-sm"
                                        />
                                    </div>
                                );
                            })}
                        </CardContent>
                    </Card>
                ))}
            </div>
        );
    };

    // 渲染统计
    const renderStats = () => {
        if (loading) return <div className="text-center py-8">{t.tags?.stats?.loading || "Loading..."}</div>;
        if (stats.length === 0) return <div className="text-center py-8 text-muted-foreground">{t.tags?.stats?.empty || "No tag usage records yet"}</div>;
        const maxCount = stats[0]?.count || 1;
        return (
            <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" />{t.tags?.stats?.frequency || "Tag Usage Frequency (Top 20)"}</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                    {stats.slice(0, 20).map((stat) => {
                        const percentage = (stat.count / maxCount) * 100;
                        return (
                            <div key={stat.tag} className="space-y-1">
                                <div className="flex justify-between items-center text-sm">
                                    <span className="font-medium">{stat.tag}</span>
                                    <span className="text-muted-foreground">{stat.count} {t.tags?.stats?.count || "times"}</span>
                                </div>
                                <div className="h-2 bg-muted rounded-full overflow-hidden">
                                    <div className="h-full bg-primary transition-all" style={{ width: `${percentage}%` }} />
                                </div>
                            </div>
                        );
                    })}
                </CardContent>
            </Card>
        );
    };

    /** 打开说明书：第一次点才去取文件（几 KB，取过就留着） */
    const openSkill = async () => {
        setSkillOpen(true);
        if (skillText) return;
        try {
            const res = await fetch('/skills/curriculum-calibration.md');
            setSkillText(res.ok ? await res.text() : '说明书读取失败，可以点「下载」直接拿文件。');
        } catch {
            setSkillText('说明书读取失败，可以点「下载」直接拿文件。');
        }
    };

    return (
        <div className="container mx-auto px-4 py-8 max-w-6xl">
            <div className="flex items-center gap-4 mb-6">
                <BackButton fallbackUrl="/" />
                <div>
                    <h1 className="text-3xl font-bold">{t.tags?.title || "Tag Management"}</h1>
                    <p className="text-muted-foreground mt-1">
                        {t.tags?.subtitle || "View and manage knowledge point tags"}
                    </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {/* 【2026-11-01】升年级/换教材时怎么改词表 —— 说明书放进产品里，能看能带走 */}
                    <Button variant="outline" size="sm" onClick={() => void openSkill()}>
                        <BookOpen className="h-4 w-4 mr-1" />
                        换教材怎么改
                    </Button>
                    <Link href="/">
                        <Button variant="ghost" size="icon">
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>
            </div>

            <Tabs defaultValue="standard" className="w-full">
                <TabsList className="grid w-full grid-cols-4 mb-6">
                    <TabsTrigger value="standard">{t.tags?.tabs?.standard || "Standard Tags"}</TabsTrigger>
                    <TabsTrigger value="custom">{t.tags?.tabs?.custom || "Custom Tags"}</TabsTrigger>
                    <TabsTrigger value="pending">
                        {`待归类${pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}`}
                    </TabsTrigger>
                    <TabsTrigger value="stats">{t.tags?.tabs?.stats || "Usage Statistics"}</TabsTrigger>
                </TabsList>

                <TabsContent value="standard" className="space-y-4">{renderStandardTags()}</TabsContent>
                <TabsContent value="custom">{renderCustomTags()}</TabsContent>
                <TabsContent value="pending">{renderPending()}</TabsContent>
                <TabsContent value="stats">{renderStats()}</TabsContent>
            </Tabs>

            {/* 【2026-11-01】说明书弹层：能看、能下载带走 */}
            {skillOpen && (
                <div
                    className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
                    onClick={() => setSkillOpen(false)}
                >
                    <div
                        className="bg-background rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-3 p-4 border-b">
                            <div>
                                <h3 className="font-semibold">换教材 / 升年级时，怎么校准知识点词表</h3>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    给接手的人（或 AI）看的作业流程；也可以下载下来带走
                                </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <a href="/skills/curriculum-calibration.md" download="教材目录校准.md">
                                    <Button size="sm" variant="outline">下载</Button>
                                </a>
                                <Button size="sm" variant="ghost" onClick={() => setSkillOpen(false)}>
                                    关闭
                                </Button>
                            </div>
                        </div>
                        <div className="p-4 overflow-auto">
                            {skillText ? (
                                <pre className="text-xs whitespace-pre-wrap break-words font-mono leading-relaxed">
                                    {skillText}
                                </pre>
                            ) : (
                                <p className="text-sm text-muted-foreground">正在读取…</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
