"use client";

import { useState, useEffect, useCallback } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";
import { TrendingUp, Plus, Trash2, ChevronDown, ChevronRight, House, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";
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

    // 获取标签树
    const fetchTags = useCallback(async (subject: SubjectKey) => {
        try {
            const data = await apiClient.get<{ tags: TagTreeNode[] }>(`/api/tags?subject=${subject}`);
            setTagsBySubject(prev => ({ ...prev, [subject]: data.tags }));
        } catch (error) {
            console.error(`Failed to fetch ${subject} tags:`, error);
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
        if (!confirm((t.tags?.custom?.deleteConfirm || "Are you sure you want to delete tag \"{tag}\"?").replace("{tag}", tagName))) {
            return;
        }

        try {
            await apiClient.delete(`/api/tags?id=${tagId}`);
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
            // 叶子节点 - 显示为 Badge
            return (
                <Badge key={node.id} variant="outline" className="cursor-default hover:bg-accent" style={{ marginLeft: isLeafContext ? 0 : paddingLeft }}>
                    {node.name}
                    {(() => {
                        const stat = stats.find(s => s.tag === node.name);
                        return stat ? <span className="ml-1 text-xs text-muted-foreground">({stat.count})</span> : null;
                    })()}
                </Badge>
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
                        <span className="font-medium text-sm">{node.name}</span>
                        <span className="text-xs text-muted-foreground">({visibleChildren.length})</span>
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
                    <span className="font-medium text-sm">{node.name}</span>
                    <span className="text-xs text-muted-foreground">({visibleChildren.length})</span>
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

    // 渲染标准标签库
    const renderStandardTags = () => {
        return (
            <>
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
                                    {subjectName}
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
                                            AI 写的是 <span className="font-medium">「{p.name}」</span>
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
                <div className="ml-auto flex items-center">
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
        </div>
    );
}
