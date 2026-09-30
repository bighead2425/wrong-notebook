"use client";

import { useEffect, useState, useRef } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Filter, CheckCircle, Clock, ChevronDown, Printer, ListChecks, Trash2, X, Combine, Flame, Layers } from "lucide-react";
import Link from "next/link";
import { format } from "date-fns";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRouter } from "next/navigation";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KnowledgeFilter } from "@/components/knowledge-filter";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { apiClient } from "@/lib/api-client";
import {
    MANAGE_TYPE_LABEL,
    MANAGE_TYPE_UNDECIDED,
    cycleManageType,
    getManageTypeLabel,
    manageTypeScreenColor,
} from "@/lib/manage-type";
import { cleanMarkdown } from "@/lib/markdown-utils";
import { Pagination } from "@/components/ui/pagination";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants/pagination";
import {
    getMistakeCategoryLabel,
    normalizeMistakeCategory,
} from "@/lib/mistake-category";
import { attentionLevelOf, ATTENTION_LEVELS, cycleAttentionLevel, isAttentionUnfiltered } from "@/lib/attention-level";
import { AttentionMultiSelect } from "@/components/attention-multi-select";
import { ReviewDots } from "@/components/review-dots";
import { PrintCounts } from "@/components/print-counts";
import { DatePickerCalendar } from "@/components/date-picker-calendar";
import { countByDay, dayBoundsISO, rangeBoundsISO } from "@/lib/calendar-grid";

/**
 * 【2026-09-30】时间筛选扩到 7 档 + 「其他日期」。
 * `other` 不在下拉里直接生效 —— 点它**打开日历**，选完（若干天 / 一段）才落到筛选上。
 */
type TimeFilter = "all" | "week" | "2weeks" | "3weeks" | "month" | "2months" | "3months" | "other";

/** 时间范围下拉的档位（`all` 单列在最上面，"其他日期…" 在最后开日历） */
const TIME_RANGE_OPTIONS: readonly [Exclude<TimeFilter, "all" | "other">, string, string][] = [
    ["week", "近一周", "Last week"],
    ["2weeks", "近两周", "Last 2 weeks"],
    ["3weeks", "近三周", "Last 3 weeks"],
    ["month", "近一个月", "Last month"],
    ["2months", "近两个月", "Last 2 months"],
    ["3months", "近三个月", "Last 3 months"],
];

interface ErrorListProps {
    notebookId?: string;
    subjectName?: string;
    /**
     * 【2026-09-30】本子的"年级学期 + 学科"，只为**跳复练卷页时带上筛选**用
     * （复练卷页的筛选就是这两项）。不给也不影响本页任何功能。
     */
    notebookInfo?: { gradeTerm?: string; subject?: string };
    /**
     * 【2026-09-30】把两个数报上去，给页面头部那句
     * 「共 XX 道错题，当前选中 YY 道题」用（那句在错题本页的页头，不在这里）。
     *   total         = 当前筛选后剩多少道
     *   notebookTotal = 这本一共多少道（不带筛选；全局列表页没有"这本"⇒ null）
     */
    onCountChange?: (counts: { total: number; notebookTotal: number | null }) => void;
}

type KnowledgeFilterChange = {
    gradeSemester?: string;
    chapter?: string;
    tag?: string | null;
};

export function ErrorList({ notebookId, subjectName, notebookInfo, onCountChange }: ErrorListProps = {}) {
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [masteryFilter, setMasteryFilter] = useState<"all" | "mastered" | "unmastered">("all");
    const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
    /** 日历选的结果：绿点（若干天）或蓝色区间（一段）—— 二者不会同时存在 */
    const [datePoints, setDatePoints] = useState<string[]>([]);
    const [dateRange, setDateRange] = useState<{ from: string; to: string } | null>(null);
    const [calendarOpen, setCalendarOpen] = useState(false);
    /** 日历上要标"浅粉"的日子 → 当天录了几道（打开日历时现拉） */
    const [dateCounts, setDateCounts] = useState<Record<string, number>>({});
    const [dateSpan, setDateSpan] = useState<{ min: string; max: string }>({ min: "", max: "" });
    const [gradeFilter, setGradeFilter] = useState("");
    const [chapterFilter, setChapterFilter] = useState("");
    /** 【2026-09-28】原「所属卷等级」(A/B/其他) 改为**错题等级**：全部 / 深挖 / 复练 / 未定 */
    const [manageTypeFilter, setManageTypeFilter] = useState<"all" | "deep" | "review" | "undecided">("all");
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
    /**
     * 【2026-09-30】等级筛选**改成多选**：默认 5 档全选（= 没筛）。
     * 只勾了几档 ⇒ `attention=1,3,5`。
     */
    const [attentionSelection, setAttentionSelection] = useState<number[]>(
        ATTENTION_LEVELS.map((l) => l.value),
    );
    // 分页状态
    const [page, setPage] = useState(1);
    const [pageSize] = useState(DEFAULT_PAGE_SIZE);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    // 多选模式状态
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isDeleting, setIsDeleting] = useState(false);
    const [isMerging, setIsMerging] = useState(false);
    const { t, language } = useLanguage();
    const router = useRouter();
    /** 本页新文案的双语助手（跟复练卷页一个写法，不再往 translations 里塞碎键） */
    const L = (zh: string, en: string) => (language === "zh" ? zh : en);

    /**
     * 【2026-09-30】**卡片上的行内小操作**统一走这里：等级升级 / 复习类型轮转 / 待复习↔已掌握。
     *
     * 做法：**先改本地、再发请求**（乐观更新）——卡片的字马上变，不用等一个来回；
     * 失败就弹提示 + 拉一次真实列表回正（**失败提示一律保留**：静默失败比啰嗦更糟）。
     * ⚠️ 全部走 `PUT /api/error-items/[id]`（改属性接口**不替调用方做主**，传什么改什么）。
     */
    const patchItemFields = async (
        id: string,
        patch: Record<string, unknown>,
        optimistic: Partial<ErrorItem>,
    ) => {
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...optimistic } : it)));
        try {
            await apiClient.put(`/api/error-items/${id}`, patch);
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.updateFailed || 'Update failed');
            fetchItems();
        }
    };

    /**
     * 右上角那枚等级奖牌：**点一下升一级，👑 之后回到 🥉**（循环）。
     * 出处：他 2026-09-30 的原话 ——
     *   *"点击错题卡上的等级图标，则图标自动升级并保存，顺序从🥉…👑升级，已经是👑的跳回🥉。"*
     */
    const cycleAttention = (item: ErrorItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // 循环规则写在 lib 里（唯一实现；扫码页加等级也走同一个函数）
        const next = cycleAttentionLevel(item.attention);
        patchItemFields(item.id, { attention: next }, { attention: next });
    };

    /**
     * 右下角的「深挖 / 复练 / 未定」：点一下轮转**深挖 → 复练 → 未定 → 深挖**（循环）。
     * 顺序写在 `lib/manage-type.ts` 的 `cycleManageType` 里（唯一实现）。
     * 文字与颜色一起变（颜色仍取自 `MANAGE_TYPE_SCREEN_COLOR`，一处取色）。
     */
    const cycleManageTypeOnCard = (item: ErrorItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const next = cycleManageType(item.manageType);
        patchItemFields(item.id, { manageType: next }, { manageType: next });
    };

    /**
     * 左上角的「待复习 / 已掌握」：点一下互转。
     *
     * ⚠️ 一个必须说清的后果：**点到"已掌握"（masteryLevel=2）后，这道题就不在主库里了**
     *    （四分法：主库 = masteryLevel < 2，见 api/error-items/list 的 scope=main）。
     *    所以当前会话里卡片还留在原地（乐观更新），下次刷新/换筛选它就"进已掌握分区"了。
     *    再点回去（变回 0）它就会回来 —— 这正是四分法要的效果，不是 bug。
     */
    const toggleMastery = (item: ErrorItem, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const next = item.masteryLevel > 0 ? 0 : 2;
        patchItemFields(item.id, { masteryLevel: next }, { masteryLevel: next });
    };

    const handleExportPrint = () => {
        // 【2026-09-30】筛选参数**只在一处生成**（`buildFilterParams`）——
        // 列表 / 导出打印 / 跨页全选三处共用，免得某个条件在一处改了、另一处没改。
        const params = buildFilterParams();

        /**
         * 【2026-09-28】多选模式下**只导出勾中的那几道**。
         * 顺序 = `Set` 的插入顺序 = 她勾选的先后（`/api/error-items/list?ids=` 已支持，
         * 扫码跳单题打印也走同一个参数）。
         * ⚠️ **一道都没勾 ⇒ 一个参数都不加**，保持"按当前筛选整页导出"的老行为。
         *    这是他要的："如果不选题的情况下，就不执行，按照原计划执行。"
         */
        if (isSelectMode && selectedIds.size > 0) {
            params.set("ids", [...selectedIds].join(","));
        }

        router.push(`/print-preview?${params.toString()}`);
    };

    const handleTagClick = (tag: string) => {
        setSelectedTag(selectedTag === tag ? null : tag);
    };

    const handleFilterChange = ({ gradeSemester, chapter, tag }: KnowledgeFilterChange) => {
        if (gradeSemester !== undefined) setGradeFilter(gradeSemester);
        if (chapter !== undefined) setChapterFilter(chapter);
        // 注意：tag 可能是 undefined（表示清除），需要用 'tag' in obj 来判断是否传入了该参数
        // 但由于我们的结构是直接解构，这里改用 null 作为清除标识
        // 实际上 KnowledgeFilter 传入的是 { tag: undefined }，所以 tag 参数确实会被设置
        // 问题在于 !== undefined 不能区分"未传入"和"传入undefined"
        // 正确的做法是检查参数对象中是否有该 key
        setSelectedTag(tag === undefined ? null : tag);

        // Clear dependent filters and reset page
        if (!gradeSemester) {
            setGradeFilter("");
            setChapterFilter("");
            setSelectedTag(null);
        } else if (!chapter) {
            setChapterFilter("");
        }
        setPage(1); // 筛选变化时重置页码
    };

    // 使用服务端 items 直接渲染，章节过滤已在 KnowledgeFilter 中通过 tag 实现
    const filteredItems = items;

    const toggleTagsExpanded = (itemId: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setExpandedTags(prev => {
            const newSet = new Set(prev);
            if (newSet.has(itemId)) {
                newSet.delete(itemId);
            } else {
                newSet.add(itemId);
            }
            return newSet;
        });
    };

    // 多选模式相关函数
    /**
     * 【2026-09-29】他要求：点「多选」时**当前页筛选出的题全部默认选中**（"眼前的题都是选中状态"），
     * 而不是像以前那样空着一道道勾。进多选时用当前列表（`filteredItems`）的 id 铺满选中集。
     */
    const toggleSelectMode = async () => {
        if (isSelectMode) {
            setIsSelectMode(false);
            setSelectedIds(new Set());
            return;
        }
        setIsSelectMode(true);
        // 先铺上"本页可见"的（立刻有反馈），再把**当前筛选下的全部 id** 合进来（跨页全选）
        setSelectedIds(new Set(items.map((i) => i.id)));
        const ids = await fetchAllFilteredIds();
        setSelectedIds(new Set(ids));
    };

    /** 清除：一键把所有选中状态抹掉（他要求在「取消」左边，蓝色字） */
    const clearSelection = () => setSelectedIds(new Set());

    /**
     * 【2026-09-29】列表页**单题删除**（他要求：不进详情页也能删某一道）。
     * 与详情页右上角「删除」走同一条路：`DELETE /api/error-items/[id]` 默认**软删进回收箱**
     * （可还原，只有回收箱里的"彻底删除"才 hard=1），确认文案也用同一条 ⇒ "效果一样"。
     * ⚠️ 卡片整体套在 `<Link>` 里，必须 preventDefault + stopPropagation，否则会跳去详情页。
     */
    const trashItem = async (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const confirmMessage = t.common?.messages?.confirmMoveToTrash
            || 'Move this question to the trash? You can restore it from the trash later.';
        if (!confirm(confirmMessage)) return;
        try {
            await apiClient.delete(`/api/error-items/${id}`);
            // 单题删除成功不弹窗：题从列表里消失本身就是反馈（他嫌"每次保存都跳确认"）
            fetchItems();
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.deleteFailed || 'Delete failed');
        }
    };

    const toggleSelectItem = (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(id)) {
                newSet.delete(id);
            } else {
                newSet.add(id);
            }
            return newSet;
        });
    };

    const handleBatchDelete = async () => {
        if (selectedIds.size === 0) return;

        const confirmMsg = (t.notebook?.confirmBatchTrash || "Move {count} items to trash?")
            .replace("{count}", selectedIds.size.toString());
        if (!confirm(confirmMsg)) return;

        setIsDeleting(true);
        try {
            // H2/T2：默认软删进回收箱，可还原
            await apiClient.post("/api/error-items/batch-delete", {
                ids: Array.from(selectedIds),
            });
            // 成功不弹窗（同上：他嫌啰嗦）—— 已经确认过一次，题从列表里消失就是反馈
            setIsSelectMode(false);
            setSelectedIds(new Set());
            fetchItems();
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.deleteFailed || "Delete failed");
        } finally {
            setIsDeleting(false);
        }
    };

    /**
     * #14 / T6：多选后合并错题
     * 把几道同源错题打包重送 AI，生成一道新题（新题号），原来几道进回收箱。
     */
    const handleBatchMerge = async () => {
        if (selectedIds.size < 2) {
            alert(t.notebook?.mergeNeedTwo || "请至少选择 2 道题合并");
            return;
        }

        const confirmMsg = (t.notebook?.confirmMerge || "Merge {count} items into one new question? The originals go to trash.")
            .replace("{count}", selectedIds.size.toString());
        if (!confirm(confirmMsg)) return;

        setIsMerging(true);
        try {
            const res = await apiClient.post<{ item: { id: string; source?: string | null } }>(
                "/api/error-items/merge",
                { ids: Array.from(selectedIds) },
                { timeout: 180000 },
            );
            alert((t.notebook?.mergeSuccess || "Merged. New question no: {no}")
                .replace("{no}", res.item.source || res.item.id));
            setIsSelectMode(false);
            setSelectedIds(new Set());
            fetchItems();
        } catch (error: any) {
            console.error(error);
            alert(error?.data?.message || t.notebook?.mergeFailed || "Merge failed");
        } finally {
            setIsMerging(false);
        }
    };

    // 追踪筛选条件是否变化（用于判断是否需要重置页码）
    const prevFiltersRef = useRef({ search, masteryFilter, timeFilter, selectedTag, notebookId, gradeFilter, chapterFilter, manageTypeFilter, attentionSelection, datePoints, dateRange });

    useEffect(() => {
        const prevFilters = prevFiltersRef.current;
        const filtersChanged =
            prevFilters.search !== search ||
            prevFilters.masteryFilter !== masteryFilter ||
            prevFilters.timeFilter !== timeFilter ||
            prevFilters.selectedTag !== selectedTag ||
            prevFilters.notebookId !== notebookId ||
            prevFilters.gradeFilter !== gradeFilter ||
            prevFilters.chapterFilter !== chapterFilter ||
            prevFilters.manageTypeFilter !== manageTypeFilter ||
            prevFilters.attentionSelection !== attentionSelection ||
            // 日历里改选的日子/区段也算"筛选变了"
            JSON.stringify(prevFilters.datePoints) !== JSON.stringify(datePoints) ||
            JSON.stringify(prevFilters.dateRange) !== JSON.stringify(dateRange);

        // 更新 ref
        prevFiltersRef.current = { search, masteryFilter, timeFilter, selectedTag, notebookId, gradeFilter, chapterFilter, manageTypeFilter, attentionSelection, datePoints, dateRange };

        if (filtersChanged && page !== 1) {
            // 筛选条件变化且不在第一页，重置到第一页（会再次触发此 effect）
            setPage(1);
            return;
        }

        // 正常请求数据
        fetchItems();
    }, [page, search, masteryFilter, timeFilter, selectedTag, notebookId, gradeFilter, chapterFilter, manageTypeFilter, attentionSelection, datePoints, dateRange]);

    /**
     * 当前筛选条件 → 查询参数（**一处实现**：列表 / 导出打印 / 跨页全选 / 日历共用）。
     * 各写一份的话，迟早在某个条件上分叉 —— 那就会出现
     * "列表里筛出 20 道、全选却只选中 18 道"这种最难查的不一致。
     *
     * @param opts.withoutDates 【2026-09-30 修 bug 用】**不要把"日期筛选"带上**。
     *   日历里"哪些天录过错题"（浅粉底）必须问的是"**这本里所有录过的日子**"，
     *   不能带着"我当前选了哪几天"去问 —— 带着问就是**自己筛自己**，
     *   结果只剩已选的那几天还有粉色，其余的日子全变白且点不动。
     *   （他实测报的就是这个：确认后重新打开日历，只剩 19/26 是绿的、别的粉色没了；
     *    切到"近一周"再回来粉色又回来了 —— 因为那时参数里没有日期条件了。）
     */
    function buildFilterParams(opts: { withoutDates?: boolean } = {}): URLSearchParams {
        const params = new URLSearchParams();
        if (notebookId) params.append("notebookId", notebookId);
        if (search) params.append("query", search);
        if (masteryFilter !== "all") {
            params.append("mastery", masteryFilter === "mastered" ? "1" : "0");
        }
        if (timeFilter !== "all" && !opts.withoutDates) {
            params.append("timeRange", timeFilter);
            /**
             * 【2026-09-30】「其他日期」：**传绝对时刻，不传"日子"**。
             * 容器跑在 UTC，服务端自己算"这一天"会偏 8 小时；
             * 客户端用本地时区把日界换算成 ISO 再传，服务端只做 gte/lt 比较。
             */
            if (timeFilter === "other") {
                if (datePoints.length > 0) {
                    params.append("points", datePoints.map((k) => dayBoundsISO(k).start).join(","));
                } else if (dateRange) {
                    const b = rangeBoundsISO(dateRange.from, dateRange.to);
                    params.append("from", b.start);
                    params.append("to", b.end);
                }
            }
        }
        if (selectedTag) params.append("tag", selectedTag);
        if (gradeFilter) params.append("gradeSemester", gradeFilter);
        if (chapterFilter) params.append("chapter", chapterFilter); // 章节筛选
        if (manageTypeFilter !== "all") params.append("manageType", manageTypeFilter);
        /**
         * 等级（**多选**）：5 档全选 = 没筛，一个参数都不传；
         * 只勾了几档 ⇒ `attention=1,3,5`（服务端按 `in` 过滤）。
         */
        if (attentionSelection.length > 0 && !isAttentionUnfiltered(attentionSelection)) {
            params.append("attention", attentionSelection.join(","));
        }
        return params;
    }

    const fetchItems = async () => {
        setLoading(true);
        try {
            const params = buildFilterParams();
            // 分页参数
            params.append("page", page.toString());
            params.append("pageSize", pageSize.toString());

            const response = await apiClient.get<PaginatedResponse<ErrorItem> & { notebookTotal?: number | null }>(`/api/error-items/list?${params.toString()}`);
            setItems(response.items);
            setTotal(response.total);
            setTotalPages(response.totalPages);
            const nbTotal = response.notebookTotal ?? null;
            // 报给页头那句「共 XX 道错题，当前选中 YY 道题」
            onCountChange?.({ total: response.total, notebookTotal: nbTotal });
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    /**
     * 【2026-09-30】**跨页全选**：拉"当前筛选下的全部 id"（`mode=ids`，不走分页）。
     *
     * 他实测报的：筛出 20 道、第一页 18 道，点「多选」只勾中了 18 道 —— 剩下 2 道漏了。
     * 全选当然要按**筛选结果**算，不是按"这一页看得见的"。
     */
    const fetchAllFilteredIds = async (): Promise<string[]> => {
        try {
            const params = buildFilterParams();
            params.set("mode", "ids");
            const res = await apiClient.get<{ ids: string[] }>(`/api/error-items/list?${params.toString()}`);
            return res.ids || [];
        } catch (error) {
            console.error("Failed to load all filtered ids:", error);
            // 拿不到就退回"本页可见"，至少不把用户晾在原地
            return items.map((i) => i.id);
        }
    };

    /** 打开日历：现拉"哪些天录过错题"（按当前筛选口径）+ 数据跨度（决定画几个月） */
    const openCalendar = async () => {
        setCalendarOpen(true);
        try {
            // ⚠️ **不带日期条件**去问"哪些天有记录" —— 否则等于自己筛自己（见 buildFilterParams 注释）
            const params = buildFilterParams({ withoutDates: true });
            params.set("mode", "dates");
            const res = await apiClient.get<{ stamps: string[] }>(`/api/error-items/list?${params.toString()}`);
            const stamps = res.stamps || [];
            const counts = countByDay(stamps);
            setDateCounts(counts);
            const keys = Object.keys(counts).sort();
            setDateSpan({ min: keys[0] ?? "", max: keys[keys.length - 1] ?? "" });
        } catch (error) {
            console.error("Failed to load record dates:", error);
            setDateCounts({});
            setDateSpan({ min: "", max: "" });
        }
    };

    /**
     * 【2026-09-30 改多选】有没有"正在生效的筛选" —— 决定筛选按钮是不是「已筛」+银灰底。
     * 只算**筛选下拉里的那些条件**（掌握度/时间/标签/年级/章节/分类/等级）；
     * 搜索框不算（它就在旁边、看得见，而且不属于"下拉里设过的条件"）。
     * ⚠️ 等级：**5 档全选 = 没筛**（跟选"全部"一个意思），所以只在"没全选"时才算已筛。
     */
    const hasActiveFilter =
        masteryFilter !== "all" ||
        timeFilter !== "all" ||
        !!selectedTag ||
        !!gradeFilter ||
        !!chapterFilter ||
        manageTypeFilter !== "all" ||
        !isAttentionUnfiltered(attentionSelection);

    return (
        <div className="space-y-6">            <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative w-full sm:flex-1">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder={t.notebook.search}
                        className="pl-9"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                {/* 【2026-09-30 他要求换位】「复练卷」从第二行挪到第一行右上（原来"筛选"待的地方），
                    「筛选」则挪到第二行、紧挨着「分类」。 */}
                <Button
                    variant="outline"
                    onClick={() => {
                        const qs = new URLSearchParams();
                        if (notebookInfo?.gradeTerm) qs.set("grade", notebookInfo.gradeTerm);
                        if (notebookInfo?.subject) qs.set("subject", notebookInfo.subject);
                        router.push(`/review-volumes${qs.toString() ? `?${qs.toString()}` : ""}`);
                    }}
                    title={L("看这本的复练卷", "Review volumes of this notebook")}
                >
                    <Layers className="mr-2 h-4 w-4" />
                    {L("复练卷", "Volumes")}
                </Button>
                <Button variant="outline" onClick={handleExportPrint}>
                    <Printer className="mr-2 h-4 w-4" />
                    {t.notebook?.exportPrint || "导出打印"}
                </Button>
                <Button
                    variant={isSelectMode ? "secondary" : "outline"}
                    onClick={toggleSelectMode}
                >
                    <ListChecks className="mr-2 h-4 w-4" />
                    {isSelectMode ? (t.notebook?.cancelSelect || "取消") : (t.notebook?.selectMode || "多选")}
                </Button>
            </div>

            {/* Advanced Filters Row */}
            <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
                <div className="w-full sm:w-auto">
                    <KnowledgeFilter
                        gradeSemester={gradeFilter}
                        tag={selectedTag}
                        onFilterChange={handleFilterChange}
                        subjectName={subjectName}
                        // 本内（notebookId 存在）已锁定年级学期，不再重复筛年级
                        hideGrade={!!notebookId}
                    />
                </div>
                {/* 【2026-09-30 他要求重排】原来「全部 / 深挖 / 复练 / 未定」四个按钮占一行，
                    现在收成【分类】一个下拉（单选、选中打勾、选完按钮变灰），
                    右边接【筛选】，再右边是新加的【等级】多选。 */}
                <div className="flex flex-wrap gap-2">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant={manageTypeFilter === "all" ? "outline" : "secondary"}
                                size="sm"
                                className={manageTypeFilter === "all" ? "" : "bg-zinc-300 text-zinc-900 hover:bg-zinc-300/90"}
                            >
                                {L("分类", "Category")}
                                {manageTypeFilter !== "all" &&
                                    ` · ${
                                        manageTypeFilter === "deep"
                                            ? MANAGE_TYPE_LABEL.deep
                                            : manageTypeFilter === "review"
                                              ? MANAGE_TYPE_LABEL.review
                                              : MANAGE_TYPE_UNDECIDED
                                    }`}
                                <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-40">
                            {([
                                ["all", t.filter.all || "All"],
                                ["deep", MANAGE_TYPE_LABEL.deep],
                                ["review", MANAGE_TYPE_LABEL.review],
                                ["undecided", MANAGE_TYPE_UNDECIDED],
                            ] as const).map(([key, label]) => (
                                <DropdownMenuItem key={key} onClick={() => setManageTypeFilter(key)}>
                                    <span className="w-4 shrink-0">{manageTypeFilter === key ? "✓" : ""}</span>
                                    <span>{label}</span>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* 筛选（从第一行换到这儿，内容没动） */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            {/* 有任何筛选条件 ⇒ 按钮变「已筛」+ **银灰底**。
                                他实测的原话："有的时候我会忘了我已经进行了筛选"。
                                ⚠️ 搜索框**不算**在里头（它自己就看得见，且就在旁边）。 */}
                            <Button
                                variant={hasActiveFilter ? "secondary" : "outline"}
                                size="sm"
                                className={hasActiveFilter ? "bg-zinc-300 text-zinc-900 hover:bg-zinc-300/90" : ""}
                            >
                                <Filter className="mr-1.5 h-3.5 w-3.5" />
                                {hasActiveFilter ? L("已筛", "Filtered") : t.notebook.filter}
                                <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-48">
                            <DropdownMenuLabel>{t.filter.masteryStatus || "Mastery Status"}</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => setMasteryFilter("all")}>
                                {masteryFilter === "all" && "✓ "}{t.filter.all || "All"}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setMasteryFilter("unmastered")}>
                                {masteryFilter === "unmastered" && "✓ "}{t.filter.review || "To Review"}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setMasteryFilter("mastered")}>
                                {masteryFilter === "mastered" && "✓ "}{t.filter.mastered || "Mastered"}
                            </DropdownMenuItem>

                            <DropdownMenuSeparator />

                            {/* 时间范围 7 档 + 「其他日期」（点它开日历） */}
                            <DropdownMenuLabel>{t.filter.timeRange || "Time Range"}</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => setTimeFilter("all")}>
                                {timeFilter === "all" && "✓ "}{t.filter.allTime || "All Time"}
                            </DropdownMenuItem>
                            {TIME_RANGE_OPTIONS.map(([key, zh, en]) => (
                                <DropdownMenuItem key={key} onClick={() => setTimeFilter(key)}>
                                    {timeFilter === key && "✓ "}
                                    {L(zh, en)}
                                </DropdownMenuItem>
                            ))}
                            <DropdownMenuItem onClick={openCalendar}>
                                {timeFilter === "other" && "✓ "}
                                {L("其他日期…", "Custom dates…")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* 等级（多选：🥉青铜 … 👑王者，至少留一个，底部 全选/取消/确认） */}
                    <AttentionMultiSelect
                        value={attentionSelection}
                        onConfirm={setAttentionSelection}
                        language={language}
                    />
                </div>
            </div>

            {selectedTag && (
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                    <span className="text-sm text-muted-foreground">
                        {t.filter.filteringByTag || "Filtering by tag"}:
                    </span>
                    <Badge variant="secondary" className="cursor-pointer" onClick={() => setSelectedTag(null)}>
                        {selectedTag}
                        <span className="ml-1 text-xs">×</span>
                    </Badge>
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredItems.map((item) => {
                    // 优先使用 tags 关联，回退到 knowledgePoints
                    let tags: string[] = [];
                    if (item.tags && item.tags.length > 0) {
                        tags = item.tags.map((tag) => tag.name);
                    } else {
                        try {
                            tags = JSON.parse(item.knowledgePoints || "[]");
                        } catch {
                            tags = [];
                        }
                    }
                    return (
                        <div key={item.id} className="relative">
                            {/* 选择模式下的复选框 */}
                            {isSelectMode && (
                                <div
                                    className="absolute top-2 left-2 z-10"
                                    onClick={(e) => toggleSelectItem(item.id, e)}
                                >
                                    <Checkbox
                                        checked={selectedIds.has(item.id)}
                                        className="h-5 w-5 border-2 bg-background shadow-sm"
                                    />
                                </div>
                            )}
                            {/* 【2026-09-29】多选模式下**点卡片任意空白处**即可切换选中（他要求），
                                不再只在点左上角勾选框时才生效。 */}
                            <Link
                                href={isSelectMode ? "#" : `/error-items/${item.id}`}
                                onClick={(e) => {
                                    if (!isSelectMode) return;
                                    e.preventDefault();
                                    toggleSelectItem(item.id, e);
                                }}
                            >
                                <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer gap-2 pt-4">
                                    <CardHeader className="pb-0">
                                        <div className="flex justify-between items-start">
                                            {/* 【2026-09-30 他要求】左上角的「待复习 / 已掌握」**点一下互转**并保存。
                                                ⚠️ 点到"已掌握"后，这道题就不在主库了（四分法：主库 = masteryLevel<2），
                                                   刷新/换筛选后它会进"已掌握分区"；再点回来就回来。 */}
                                            <Badge
                                                variant={item.masteryLevel > 0 ? "default" : "secondary"}
                                                className={`${item.masteryLevel > 0 ? "bg-green-600 hover:bg-green-700" : ""} ${isSelectMode ? "" : "cursor-pointer"}`}
                                                title={item.masteryLevel > 0
                                                    ? L("点一下改回「待复习」", "Click to mark as to-review")
                                                    : L("点一下标成「已掌握」", "Click to mark as mastered")}
                                                onClick={isSelectMode ? undefined : (e) => toggleMastery(item, e)}
                                            >
                                                {item.masteryLevel > 0 ? (
                                                    <span className="flex items-center gap-1">
                                                        <CheckCircle className="h-3 w-3" /> {t.notebook.mastered}
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1">
                                                        <Clock className="h-3 w-3" /> {t.notebook.review}
                                                    </span>
                                                )}
                                            </Badge>
                                            {/* 右上角：**等级奖牌** + 录入时间 + 垃圾桶。
                                                奖牌点一下升一级（👑 之后回 🥉）—— 他 2026-09-30 的要求。 */}
                                            <div className="flex items-center gap-0.5 shrink-0">
                                                <button
                                                    type="button"
                                                    className={`mr-0.5 rounded px-0.5 text-sm leading-none ${isSelectMode ? "cursor-default" : "cursor-pointer hover:bg-muted"}`}
                                                    title={L(
                                                        `等级：${attentionLevelOf(item.attention).zh}（点一下升一级）`,
                                                        `Level: ${attentionLevelOf(item.attention).en} (click to upgrade)`,
                                                    )}
                                                    onClick={isSelectMode ? undefined : (e) => cycleAttention(item, e)}
                                                >
                                                    {attentionLevelOf(item.attention).medal}
                                                </button>
                                                <span className="text-xs text-muted-foreground">
                                                    {format(new Date(item.createdAt), "MM/dd")}
                                                </span>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    className="text-muted-foreground hover:text-destructive"
                                                    title={t.common?.delete || "Move to trash"}
                                                    onClick={(e) => trashItem(item.id, e)}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </Button>
                                            </div>
                                        </div>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="text-sm line-clamp-3">
                                            {(() => {
                                                // 提取文本并清理 LaTeX/Markdown 格式
                                                const rawText = (item.questionText || "").split('\n\n')[0]; // 取第一段
                                                const cleanText = cleanMarkdown(rawText);

                                                return cleanText.length > 80
                                                    ? cleanText.substring(0, 80) + "..."
                                                    : cleanText;
                                            })()}
                                        </div>
                                        {/* 【2026-09-30 他要求】这里原来显示**作答状态**（不会做/做错了/未判断），
                                            现在换成**错因**（8 种里的一种）。没打错因就不占位。 */}
                                        <div className="flex flex-wrap gap-2 mt-3">
                                            {normalizeMistakeCategory(item.mistakeCategory) && (
                                                <Badge variant="secondary" className="text-xs">
                                                    {getMistakeCategoryLabel(item.mistakeCategory, language)}
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap gap-2 mt-3">
                                            {(expandedTags.has(item.id) ? tags : tags.slice(0, 3)).map((tag: string) => (
                                                <Badge
                                                    key={tag}
                                                    variant={selectedTag === tag ? "default" : "outline"}
                                                    className={`text-xs transition-colors ${isSelectMode ? "" : "cursor-pointer hover:bg-primary/10"}`}
                                                    /* 多选模式下标签不再响应点击：此时点卡片任意处＝切换选中，
                                                       标签要是还能筛选题，就会出现"点一下同时干了两件事"的歧义 */
                                                    onClick={isSelectMode ? undefined : (e) => {
                                                        e.preventDefault();
                                                        handleTagClick(tag);
                                                    }}
                                                >
                                                    {tag}
                                                </Badge>
                                            ))}
                                            {tags.length > 3 && (
                                                <Badge
                                                    variant="secondary"
                                                    className={`text-xs transition-colors ${isSelectMode ? "" : "cursor-pointer hover:bg-secondary/80"}`}
                                                    title={expandedTags.has(item.id)
                                                        ? (t.notebooks?.collapseTagsTooltip || "Click to collapse")
                                                        : (t.notebooks?.expandTagsTooltip || "Click to expand {count} tags").replace("{count}", (tags.length - 3).toString())}
                                                    onClick={isSelectMode ? undefined : (e) => toggleTagsExpanded(item.id, e)}
                                                >
                                                    {expandedTags.has(item.id) ? (
                                                        <>{t.notebooks?.collapseTags || "Collapse"}</>
                                                    ) : (
                                                        <>{(t.notebooks?.expandTags || "+{count} more").replace("{count}", (tags.length - 3).toString())}</>
                                                    )}
                                                </Badge>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            </Link>
                            {/* 右下角：这道题的**复习类型**（深挖 / 复练 / 未定）。
                                【2026-09-30 他要求】点一下轮转 深挖→复练→未定→深挖，文字与颜色一起变、即点即存。
                                ⚠️ 仍然用绝对定位而不是塞进标签流：标签会换行，
                                   `ml-auto` 在 flex-wrap 里靠不住（他会看到它乱跑）。 */}
                            <button
                                type="button"
                                className={`absolute bottom-2 right-3 text-[11px] font-semibold ${isSelectMode ? "cursor-default" : "cursor-pointer hover:underline"}`}
                                style={{ color: manageTypeScreenColor(item.manageType) }}
                                title={L("点一下换类型：深挖 → 复练 → 未定", "Click to cycle: deep → review → undecided")}
                                onClick={isSelectMode ? undefined : (e) => cycleManageTypeOnCard(item, e)}
                            >
                                {getManageTypeLabel(item.manageType)}
                            </button>
                            {/* 【2026-09-30】左下角：两个打印次数（暗红 | 深绿） */}
                            <span
                                className="absolute bottom-2 left-3 text-[11px] pointer-events-none"
                                title={`深挖纸打印次数 ${item.printCount ?? 0} ｜ 复练纸印刷次数 ${item.reviewPrintCount ?? 0}`}
                            >
                                <PrintCounts deep={item.printCount} review={item.reviewPrintCount} compact />
                            </span>
                            {/* 【2026-09-30】底端**中间**：四个复习结果圆圈
                                （前三个 = 第 1/7/21 天计划复习，第四个 = 最近一次），与左右两边同一行。 */}
                            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-none">
                                <ReviewDots outcomes={item.reviewOutcomes} language={language} />
                            </span>
                        </div>
                    );
                })}
            </div>

            {/* 分页器 */}
            <Pagination
                page={page}
                totalPages={totalPages}
                total={total}
                pageSize={pageSize}
                onPageChange={setPage}
            />

            {/* 多选模式底部操作栏 */}
            {isSelectMode && (
                <div className="fixed bottom-0 left-0 right-0 bg-background border-t shadow-lg p-4 z-50">
                    <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
                        <span className="text-sm text-muted-foreground">
                            {(t.notebook?.selectedCount || "{count} selected").replace("{count}", selectedIds.size.toString())}
                        </span>
                        <div className="flex items-center gap-3">
                            {/* 【2026-09-29】他要的「清除」：蓝色文字，摆在「取消」左边，一点全不选 */}
                            <button
                                type="button"
                                className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline disabled:text-muted-foreground disabled:no-underline disabled:cursor-default"
                                onClick={clearSelection}
                                disabled={selectedIds.size === 0}
                            >
                                {t.notebook?.clearSelection || "清除"}
                            </button>
                            <Button
                                variant="outline"
                                onClick={toggleSelectMode}
                            >
                                <X className="mr-2 h-4 w-4" />
                                {t.notebook?.cancelSelect || "取消"}
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={handleBatchDelete}
                                disabled={selectedIds.size === 0 || isDeleting}
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t.notebook?.deleteSelected || "删除选中"}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* 【2026-09-30】录入日期日历（「其他日期」）。
                确认后：**日历消失但记住选择**（绿点/蓝区间留在 state 里），
                下拉里的「其他日期」前面会出现 ✓，筛选按钮也变成「已筛」银灰底。
                取消后：本次选择作废（`initialPoints`/`initialRange` 用的还是确认过的旧值）。 */}
            {calendarOpen && (
                <DatePickerCalendar
                    counts={dateCounts}
                    initialPoints={datePoints}
                    initialRange={dateRange}
                    minKey={dateSpan.min}
                    maxKey={dateSpan.max}
                    L={(zh, en) => (language === "zh" ? zh : en)}
                    onCancel={() => setCalendarOpen(false)}
                    onConfirm={(sel) => {
                        setDatePoints(sel.points);
                        setDateRange(sel.range);
                        // 绿点或蓝区间任一有货 ⇒ 这个筛选生效；都空 ⇒ 等于没筛（按钮也退回原样）
                        setTimeFilter(sel.points.length > 0 || sel.range ? "other" : "all");
                        setCalendarOpen(false);
                    }}
                />
            )}
        </div>
    );
}
