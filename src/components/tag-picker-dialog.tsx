"use client";

/**
 * 【2026-11-01 建，2026-11-02 加多选】「从标准标签库选知识点」—— 树形选择对话框。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 空空的原话（2026-11-01）：
 *   "我检索知识点的时候，这些知识点都是散装的，没有逻辑性，找起来会很繁琐。
 *    我事实上需要的是像标准标签库一样的呈现，这样我能够找对科目，找对年级，
 *    找对学期，找到单元最终找准我想要的那个标签。"
 *
 * 他 2026-11-02 又补了两条（都在这一版里）：
 *   · "上一版那个树形选择对话框中，知识点是不是可以多选呢？选中的知识点也在上面显示，
 *      后面给一个叉，这样选中了什么一目了然。"
 *   · "在所有的章、节、知识点前面都增加一个小选择框，如果点击这个框，
 *      则这个树枝下面所有的章节知识点都选中……如果我选中一个节下一些知识点（不是全部），
 *      则这个节一级上面的章前面的方框显示为选中但不是都选中状态（半选）。"
 *
 * ── 两种模式 ────────────────────────────────────────────────────────
 * | 模式 | 谁在用 | 行为 |
 * |---|---|---|
 * | `multiple=false`（默认） | 错题详情页「从标签库选」 | 点一个叶子就选中，**替换**上一个 |
 * | `multiple=true` | 错题本页「知识点检索」 | 点叶子**切换**，可多选，父节点带三态复选框 |
 *
 * ── 三态怎么算 ──────────────────────────────────────────────────────
 * 只对**叶子**计数（题只挂在最末级知识点上）：
 *   · 子树里的叶子全选中 ⇒ 父节点 `checked`
 *   · 选中一部分        ⇒ 父节点 `indeterminate`（黑色小方块）
 *   · 一个都没有        ⇒ 不选
 * 点父节点那个框 = 把整棵子树**全选 / 全不选**（这就是他要的"简化勾下一层"）。
 *
 * ⚠️ `onPick` 回的是 `{id, name}[]`，不是纯名字：
 *    详情页的 `TagInput` 要**名字**，错题本页的筛选要 **id**（按 id 不按名字，
 *    "计算""阅读理解"这种词在不同册下都有，按名字会串）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Loader2, Search, X } from "lucide-react";
import { leavesOf, searchTagTree, tagSelectionState } from "@/lib/tag-tree";

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

/** 选中的一项：**id 给筛选用，name 给输入框用** */
export interface PickedTag {
    id: string;
    name: string;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** 确定时回调。单选模式给 1 个，多选给 0..n 个 */
    onPick: (tags: PickedTag[]) => void;
    /** 当前这道题的学科 —— 有的话默认展开它，省一次点击 */
    defaultSubject?: string;
    /** 【2026-11-02】多选（父节点带三态复选框、已选区带叉） */
    multiple?: boolean;
    /** 打开时预填的已选项（多选时回显上次选的） */
    initialPicked?: PickedTag[];
}

export function TagPickerDialog({
    open,
    onOpenChange,
    onPick,
    defaultSubject,
    multiple = false,
    initialPicked,
}: Props) {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    /** 每个学科的树：`undefined` = 还没拉，`null` = 正在拉 */
    const [trees, setTrees] = useState<Record<string, TagTreeNode[] | null>>({});
    /** 展开的节点（学科键 + 节点 id） */
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    /** 选中的叶子：id → {id, name}（顺序即点击顺序，chips 按这个排） */
    const [picked, setPicked] = useState<PickedTag[]>([]);

    /**
     * 【2026-11-03 真真】**检索 / 全展 / 全收**（空空要的，与标签管理页同一套手感）。
     *
     * 他原话："在进入错题本页，点击知识点检索，打开按知识点筛这个页面中，我也想要这几个功能。
     *         在错题详情页，点开知识点的编辑，再点击从标签库选……我也想要这三个功能。"
     *
     * 两处用的是**同一个组件**，所以只改这一处，两边同时有。
     *
     * `searchInput` 是框里正在敲的字，`searchTerm` 是**点了搜索之后**才生效的词 ——
     * 跟他上次的要求一致：边打边筛会让树一直抖，人还没打完就找不到自己在哪了。
     */
    const [searchInput, setSearchInput] = useState("");
    const [searchTerm, setSearchTerm] = useState("");
    /** 命中个数（0 命中要说一句"没找到"，否则人会以为按钮没反应） */
    const [hitCount, setHitCount] = useState<number | null>(null);
    /** 搜索 / 全展时正在拉 9 个学科的词表，按钮上给个转圈 */
    const [busy, setBusy] = useState(false);

    /**
     * 拉一个学科的词表。
     *
     * 【2026-11-03】改成**回传节点**：检索 / 全展要一次性算出整棵树的展开集合，
     * 而 `setTrees` 是异步的 —— 拉完立刻读 state 还是旧值。
     */
    const loadSubject = useCallback(async (key: string): Promise<TagTreeNode[]> => {
        setTrees((prev) => (prev[key] === undefined ? { ...prev, [key]: null } : prev));
        try {
            const data = await apiClient.get<{ tags: TagTreeNode[] }>(`/api/tags?subject=${key}`);
            const nodes = data.tags || [];
            setTrees((prev) => ({ ...prev, [key]: nodes }));
            return nodes;
        } catch (e) {
            console.error(`Failed to load ${key} tags:`, e);
            setTrees((prev) => ({ ...prev, [key]: [] }));
            return [];
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
     * **别把它"优化"回去。**
     */
    useEffect(() => {
        if (!open) return;
        setPicked(initialPicked ?? []);
        setTrees({});
        // 【2026-11-03】检索状态也跟着清 —— 上次搜的词不该带到这一次
        setSearchInput("");
        setSearchTerm("");
        setHitCount(null);
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

    const pickedIds = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);

    /** 点一个叶子：单选=替换，多选=切换 */
    const clickLeaf = (node: TagTreeNode) => {
        if (!multiple) {
            setPicked([{ id: node.id, name: node.name }]);
            return;
        }
        setPicked((prev) =>
            prev.some((p) => p.id === node.id)
                ? prev.filter((p) => p.id !== node.id)
                : [...prev, { id: node.id, name: node.name }],
        );
    };

    /** 点父节点那个框：整棵子树全选 / 全不选 */
    const toggleSubtree = (node: TagTreeNode) => {
        const leaves = leavesOf(node);
        const allIn = leaves.every((l) => pickedIds.has(l.id));
        if (allIn) {
            const drop = new Set(leaves.map((l) => l.id));
            setPicked((prev) => prev.filter((p) => !drop.has(p.id)));
        } else {
            setPicked((prev) => {
                const have = new Set(prev.map((p) => p.id));
                const add = leaves.filter((l) => !have.has(l.id)).map((l) => ({ id: l.id, name: l.name }));
                return [...prev, ...add];
            });
        }
    };

    /** 父节点的三态：全选 / 部分 / 无 */
    /**
     * 三态判定 —— **实现在 `lib/tag-tree.ts`**，这里只是转调。
     * 抽出去的原因：它是"勾父节点"的唯一判据，算错了界面上看不出来、只会让题数不对；
     * 放在组件里既测不了也没法复用。`__tests__/unit/tag-tree.test.ts` 钉住了它。
     */
    const stateOf = (node: TagTreeNode) => tagSelectionState(node, pickedIds);

    /* ============ 【2026-11-03 真真】检索 / 全展 / 全收 ============ */

    /**
     * 把还没拉过的学科补齐，回一张完整的「学科 → 树」。
     *
     * 为什么要这样：树是"点开学段才加载"的，不补齐就只会搜到已经点开的那一科 ——
     * 人在数学里搜"阅读理解"永远搜不到语文那一条。
     * 并行拉，9 个学科不至于串成一条长龙。
     */
    async function ensureAllTrees(): Promise<Record<string, TagTreeNode[]>> {
        const out: Record<string, TagTreeNode[]> = {};
        const missing: string[] = [];
        for (const sub of SUBJECTS) {
            const cached = trees[sub.key];
            if (Array.isArray(cached)) out[sub.key] = cached;
            else missing.push(sub.key);
        }
        const loaded = await Promise.all(
            missing.map(async (key) => [key, await loadSubject(key)] as const),
        );
        for (const [key, nodes] of loaded) out[key] = nodes;
        return out;
    }

    /**
     * 关键字高亮。
     *
     * 只高亮**第一处** —— 词表里最长也就十来个字，命中两处的极少见；用 `mark`
     * 而不是加粗：浏览器原生语义就是"标记"，读屏也认得。
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
         * 在对话框里这一点更重要：全展开的话 8 层树会把 50vh 的框撑爆。
         */
        if (!kw) {
            setSearchTerm("");
            setHitCount(null);
            setExpanded(new Set());
            return;
        }

        setBusy(true);
        let all: Record<string, TagTreeNode[]>;
        try {
            all = await ensureAllTrees();
        } finally {
            setBusy(false);
        }

        const next = new Set<string>();
        let hits = 0;

        for (const sub of SUBJECTS) {
            /**
             * "展开到哪一层"的规则在 `lib/tag-tree.ts#searchTagTree` —— 纯函数、有单测。
             * 这里只负责把结果铺成 `expanded`（Set）的形状。
             *
             * 学科自己也算一层：某一科里有命中，那个学科的折叠块就得打开，
             * 否则里面展开得再好也看不见。
             */
            const result = searchTagTree(all[sub.key] ?? [], kw);
            hits += result.hits;
            if (result.hits > 0) next.add(`subject-${sub.key}`);
            for (const id of result.expandIds) next.add(id);
        }

        setSearchTerm(kw);
        setHitCount(hits);
        setExpanded(next);
    };

    /** 全展：学科 → 学段 → 年级 → 学期 → 单元 → 章 → 节 → 知识点，一层不留 */
    const expandAll = async () => {
        setBusy(true);
        let all: Record<string, TagTreeNode[]>;
        try {
            all = await ensureAllTrees();
        } finally {
            setBusy(false);
        }
        const next = new Set<string>();
        const walk = (list: TagTreeNode[]) => {
            for (const node of list) {
                if (node.children.length > 0) {
                    next.add(node.id);
                    walk(node.children);
                }
            }
        };
        for (const sub of SUBJECTS) {
            next.add(`subject-${sub.key}`);
            walk(all[sub.key] ?? []);
        }
        setExpanded(next);
    };

    /**
     * 全收：一律折叠。
     *
     * 不动 `searchTerm` —— 收起是收起，搜索词还在框里，再点一次搜索还能回来。
     * 清掉它等于顺手抹了人的输入。
     */
    const collapseAll = () => {
        setExpanded(new Set());
    };

    /**
     * 递归画树。
     * 中间层：左边是**三态复选框**（点了全选子树），右边箭头+名字（点了展开/收起）。
     * 叶子：整行可点（多选时前面也有个框，与父节点视觉一致）。
     */
    function renderNode(node: TagTreeNode, depth: number): React.ReactNode {
        const hasChildren = node.children.length > 0;
        const key = node.id;
        const isOpen = expanded.has(key);
        const pad = { paddingLeft: 8 + depth * 14 };

        if (!hasChildren) {
            const active = pickedIds.has(node.id);
            return (
                <div
                    key={key}
                    className={`flex items-center gap-1.5 rounded text-sm transition-colors ${
                        active && !multiple ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                    }`}
                    style={pad}
                >
                    {multiple && (
                        <input
                            type="checkbox"
                            checked={active}
                            onChange={() => clickLeaf(node)}
                            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
                            aria-label={node.name}
                        />
                    )}
                    <button
                        type="button"
                        onClick={() => clickLeaf(node)}
                        className={`flex-1 py-1 text-left ${active && multiple ? "font-medium text-primary" : ""}`}
                    >
                        {highlight(node.name)}
                    </button>
                </div>
            );
        }

        const st = stateOf(node);
        return (
            <div key={key}>
                <div className="flex items-center gap-1.5 rounded text-sm hover:bg-accent" style={pad}>
                    {multiple && (
                        <input
                            type="checkbox"
                            checked={st === "all"}
                            ref={(el) => {
                                /** 半选状态只能这样设（HTML 属性没有 `indeterminate` 的 JSX 版） */
                                if (el) el.indeterminate = st === "some";
                            }}
                            onChange={() => toggleSubtree(node)}
                            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
                            aria-label={node.name}
                        />
                    )}
                    <button
                        type="button"
                        onClick={() => toggle(key)}
                        className="flex flex-1 items-center gap-1 py-1 text-left"
                    >
                        {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className={depth === 0 ? "font-medium" : ""}>{highlight(node.name)}</span>
                    </button>
                </div>
                {isOpen && <div>{node.children.map((c) => renderNode(c, depth + 1))}</div>}
            </div>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/**
              * 【2026-11-03】加 `max-h` / `overflow-y-auto`。
              *
              * 加了检索工具栏以后内容变高（标题 + 说明 + 工具栏 + 命中提示 + 已选区
              * + 50vh 树 + 底部按钮），小屏或缩放 125% 时会撑出可视区 ——
              * 而 `DialogContent` 原本没有高度上限，超出部分**滚不到**。
              */}
            <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="text-base">
                        {multiple
                            ? L("按知识点筛（可多选）", "Filter by knowledge points (multi-select)")
                            : L("从标准标签库选知识点", "Pick from the standard tag library")}
                    </DialogTitle>
                </DialogHeader>

                <p className="text-xs text-muted-foreground">
                    {multiple
                        ? L(
                              "点章节前面的方框 = 整段全选；只勾一部分时，上级显示为半选。",
                              "Tick a chapter box to select the whole branch; partial picks show as half-checked.",
                          )
                        : L(
                              "按 科目 → 册 → 章 → 节 → 知识点 逐级点开，选中后点「确定」填进去。",
                              "Drill down: subject → book → chapter → section → point. Then press OK.",
                          )}
                </p>

                {/**
                  * 【2026-11-03 真真】检索框 + 搜索 + 全展 + 全收。
                  *
                  * 与标签管理页**同一套手感**（他说"我觉得功能非常实用，我也想要这几个功能"）：
                  * 点了才搜、空着点搜索 = 全部收起、关键字黄底高亮。
                  *
                  * 这里比管理页更需要它 —— 对话框只有 50vh 高，靠手点 8 层树找
                  * "小数减法"要翻半天，还容易点错册。
                  */}
                <div className="flex flex-wrap items-center gap-1.5">
                    <div className="relative min-w-[150px] flex-1">
                        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
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
                            placeholder={L("检索单元 / 章节 / 知识点…", "Search unit / chapter / point…")}
                            className="h-8 pl-7 pr-7 text-sm"
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
                                title={L("清空", "Clear")}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                    <Button size="sm" onClick={handleSearch} disabled={busy}>
                        {busy ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Search className="mr-1 h-3.5 w-3.5" />
                        )}
                        {busy ? L("搜索中…", "Searching…") : L("搜索", "Search")}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={expandAll}
                        disabled={busy}
                        title={L("展开所有层级，方便通读词表", "Expand every level")}
                    >
                        <ChevronsUpDown className="mr-1 h-3.5 w-3.5" />
                        {L("全展", "Expand all")}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={collapseAll}
                        title={L("全部折叠回学科层", "Collapse to subjects")}
                    >
                        <ChevronsDownUp className="mr-1 h-3.5 w-3.5" />
                        {L("全收", "Collapse all")}
                    </Button>
                </div>

                {/* 搜完给个交代：命中几处 / 一处都没命中 */}
                {searchTerm && (
                    <div className="text-xs">
                        {hitCount && hitCount > 0 ? (
                            <span className="text-muted-foreground">
                                {L("找到 ", "Found ")}
                                <span className="font-medium text-foreground">{hitCount}</span>
                                {L(" 处「", " match(es) for \"")}
                                <span className="font-medium text-foreground">{searchTerm}</span>
                                {L("」，已展开到对应层级", "\", expanded to that level")}
                            </span>
                        ) : (
                            <span className="text-amber-600">
                                {L(
                                    `没找到含「${searchTerm}」的单元 / 章节 / 知识点`,
                                    `No unit / chapter / point contains "${searchTerm}"`,
                                )}
                            </span>
                        )}
                    </div>
                )}

                {/* 【第 5 条】已选区：每个带一个叉，点叉等于取消这一项 */}
                {multiple && picked.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 rounded-md border bg-muted/40 p-2">
                        <span className="text-xs text-muted-foreground">
                            {L(`已选 ${picked.length} 个：`, `${picked.length} selected: `)}
                        </span>
                        {picked.map((p) => (
                            <span
                                key={p.id}
                                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                            >
                                {p.name}
                                <button
                                    type="button"
                                    onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                                    className="rounded-full hover:bg-primary/20"
                                    aria-label={L("取消这个", "Remove")}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        ))}
                    </div>
                )}

                <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded-md border p-2">
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
                                    {highlight(s.name)}
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
                    <span className="min-w-0 flex-1 truncate text-sm">
                        {picked.length === 0 ? (
                            <span className="text-muted-foreground">
                                {multiple ? L("还没选（不选 = 不筛）", "Nothing selected (no filter)") : L("还没选", "Nothing selected")}
                            </span>
                        ) : (
                            <span className="text-muted-foreground">
                                {L(`已选 ${picked.length} 个`, `${picked.length} selected`)}
                            </span>
                        )}
                    </span>
                    {/* 【他要求】清除放最左、样式弱化 —— 与「取消」拉开距离，防误点 */}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        disabled={picked.length === 0}
                        onClick={() => setPicked([])}
                    >
                        {L("清除", "Clear")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                        {L("取消", "Cancel")}
                    </Button>
                    <Button
                        size="sm"
                        onClick={() => {
                            onPick(picked);
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
