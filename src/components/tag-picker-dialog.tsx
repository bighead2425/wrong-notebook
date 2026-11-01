"use client";

/**
 * 【2026-11-01 真真】「从标准标签库选知识点」—— 树形选择对话框。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 空空的原话：
 *   "我检索知识点的时候，这些知识点都是散装的，没有逻辑性，找起来会很繁琐。
 *    我事实上需要的是像标准标签库一样的呈现，这样我能够找对科目，找对年级，
 *    找对学期，找到单元最终找准我想要的那个标签 ⇒ 所以在点击编辑后，
 *    下面的保存和取消按钮的右边增加一个按钮，点击这个按钮给一个对话框，
 *    这个框里面就是标准标签库那个子页的内容。"
 *
 * ── 为什么不用 `TagInput` 那个下拉 ────────────────────────────────────
 * 那个下拉是**扁平**的：聚焦就拉 300 个叶子名字（"数一数""比长短高矮"…），
 * 一眼看不出"这是哪本书哪一章的"。挑一个词像大海捞针。
 * 这里给的是**树**：学科 → 册（含年级学期）→ 章 → 节 → 知识点，逐级点开，
 * 最后点到叶子才算选中 —— 与 `/tags` 页「标准标签」那一栏**同一套数据**。
 *
 * ── 数据 ────────────────────────────────────────────────────────────
 * `GET /api/tags?subject=xxx` 返回该学科的整棵树（`TagTreeNode`）。
 * **点开某个学科才拉**，不一次性拉九个学科（那是九次查询 + 几 MB）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

/** 与 `/tags` 页同一份学科表（顺序也一致，别各写一套） */
const SUBJECTS = [
    { key: "math", name: "数学" },
    { key: "english", name: "英语" },
    { key: "physics", name: "物理" },
    { key: "chemistry", name: "化学" },
    { key: "biology", name: "生物" },
    { key: "chinese", name: "语文" },
    { key: "history", name: "历史" },
    { key: "geography", name: "地理" },
    { key: "politics", name: "政治" },
] as const;

interface TagTreeNode {
    id: string;
    name: string;
    code: string | null;
    isSystem: boolean;
    children: TagTreeNode[];
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** 选中一个**叶子**标签后回调（名字就是 `TagInput` 要的那个字符串） */
    onPick: (name: string) => void;
    /** 当前这道题的学科 —— 有的话默认展开它，省一次点击 */
    defaultSubject?: string;
}

export function TagPickerDialog({ open, onOpenChange, onPick, defaultSubject }: Props) {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    /** 每个学科的树：`undefined` = 还没拉，`null` = 正在拉 */
    const [trees, setTrees] = useState<Record<string, TagTreeNode[] | null>>({});
    /** 展开的节点（学科键 + 节点 id） */
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    /** 当前高亮的叶子 */
    const [picked, setPicked] = useState<string | null>(null);

    const loadSubject = useCallback(async (key: string) => {
        setTrees((prev) => (prev[key] === undefined ? { ...prev, [key]: null } : prev));
        try {
            const data = await apiClient.get<{ tags: TagTreeNode[] }>(`/api/tags?subject=${key}`);
            setTrees((prev) => ({ ...prev, [key]: data.tags || [] }));
        } catch (e) {
            console.error(`Failed to load ${key} tags:`, e);
            setTrees((prev) => ({ ...prev, [key]: [] }));
        }
    }, []);

    /**
     * 每次打开：**清掉上一次的缓存与选择**，并把当前学科自动展开。
     *
     * ⚠️⚠️【2026-11-01 空空特别交代】**不要缓存**。
     *   他原话："如果标准标签库的内容改变了，那么相应的这个树形结构也应该随之变化，
     *           也就是每次打开这个树形结构的时候，都是现去取值的，不是一成不变的。"
     *
     * 所以这里**必须 `setTrees({})`**：关掉再打开 = 重新拉一遍。
     * 上一版写的是 `if (trees[key] === undefined) load()` —— 那是"拉过一次就不再拉"，
     * 标签库在别处改过之后这里会一直是旧的。**别把它"优化"回去。**
     *
     * 代价：每次打开多一次请求（只有一个学科，几百 KB 量级），换来"永远是最新的"。
     */
    useEffect(() => {
        if (!open) return;
        setPicked(null);
        setTrees({});
        if (defaultSubject && SUBJECTS.some((s) => s.key === defaultSubject)) {
            setExpanded(new Set([`subject-${defaultSubject}`]));
            void loadSubject(defaultSubject);
        } else {
            setExpanded(new Set());
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在"打开"这一刻做一次
    }, [open]);

    const toggle = (key: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    /**
     * 递归画树。**只有叶子可点**（中间层点了只会展开/收起，不会被当成标签）。
     * ⚠️ 用 `function` 而不是 `const` —— 它要递归调自己，
     *    `const` 形式会被 `react-hooks` 规则判成"访问未初始化的变量"（TDZ）。
     */
    function renderNode(node: TagTreeNode, depth: number): React.ReactNode {
        const hasChildren = node.children.length > 0;
        const key = node.id;
        const isOpen = expanded.has(key);

        if (!hasChildren) {
            const active = picked === node.name;
            return (
                <button
                    key={key}
                    type="button"
                    onClick={() => setPicked(node.name)}
                    className={`block w-full rounded px-2 py-1 text-left text-sm transition-colors ${
                        active ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                    }`}
                    style={{ paddingLeft: 8 + depth * 14 }}
                >
                    {node.name}
                </button>
            );
        }

        return (
            <div key={key}>
                <button
                    type="button"
                    onClick={() => toggle(key)}
                    className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                    style={{ paddingLeft: 8 + depth * 14 }}
                >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                    <span className={depth === 0 ? "font-medium" : ""}>{node.name}</span>
                </button>
                {isOpen && <div>{node.children.map((c) => renderNode(c, depth + 1))}</div>}
            </div>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="text-base">
                        {L("从标准标签库选知识点", "Pick from the standard tag library")}
                    </DialogTitle>
                </DialogHeader>

                <p className="text-xs text-muted-foreground">
                    {L(
                        "按 科目 → 册 → 章 → 节 → 知识点 逐级点开，选中后点「确定」填进去。",
                        "Drill down: subject → book → chapter → section → point. Then press OK.",
                    )}
                </p>

                <div className="max-h-[55vh] space-y-2 overflow-y-auto rounded-md border p-2">
                    {SUBJECTS.map((s) => {
                        const key = `subject-${s.key}`;
                        const isOpen = expanded.has(key);
                        const tree = trees[s.key];
                        return (
                            <div key={s.key} className="rounded-md border">
                                <button
                                    type="button"
                                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-accent"
                                    onClick={() => {
                                        toggle(key);
                                        if (!isOpen && tree === undefined) void loadSubject(s.key);
                                    }}
                                >
                                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                    {s.name}
                                </button>
                                {isOpen && (
                                    <div className="pb-2">
                                        {tree === null || tree === undefined ? (
                                            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                {L("正在加载…", "Loading…")}
                                            </div>
                                        ) : tree.length === 0 ? (
                                            <p className="px-3 py-2 text-xs text-muted-foreground">
                                                {L("这个学科还没有标签", "No tags for this subject yet")}
                                            </p>
                                        ) : (
                                            tree.map((n) => renderNode(n, 0))
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm">
                        {picked ? (
                            <>
                                <span className="text-muted-foreground">{L("已选：", "Selected: ")}</span>
                                <span className="font-medium">{picked}</span>
                            </>
                        ) : (
                            <span className="text-muted-foreground">{L("还没选", "Nothing selected")}</span>
                        )}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                        {L("取消", "Cancel")}
                    </Button>
                    <Button
                        size="sm"
                        disabled={!picked}
                        onClick={() => {
                            if (picked) onPick(picked);
                            onOpenChange(false);
                        }}
                    >
                        {L("确定", "OK")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
