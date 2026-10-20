"use client";

/**
 * 【2026-10-20 真真】「建议深挖」（`/deep-suggestions`）—— 空空第 6 条要的新页面。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 他的原话（摘）：
 *   "将『去该题所在的本』按钮，改为『查看相关习题』，点击后打开一个页面……命名为『建议深挖』，
 *    里面将所有不管来自哪个错题本的建议升级的错题卡，都放入这个页面，
 *    用户可以点击错题卡进入这道错题的详情页……每个错题卡下方设置两个按钮，
 *    第一个按钮是『升级』……这个按钮显示为『已升级』，再点击一次这道题的状态从深挖变回复练……
 *    另一个按钮为『留级』……同时在左上角放一个『全部升级』按钮。"
 *
 * ── 他当天下午改了「留级」的行为（这一版按新的来）──────────────────────
 *   "如果我在『建议深挖』页，对某一道题进行了留级，则这道题不会从页面消失，
 *    而是在下面增加一个分隔线，分隔线上写『留级题』，下面是所有被留级的题目，
 *    留级题目如果被升级了，再从这个页面消失……留级是一个记号，
 *    记录这道题用户目前不想升级，不用再提醒了，但如果用户想升级的时候，
 *    还是可以进入『建议深挖』页面对其进行升级的。"
 *
 * ⇒ 页面分两段：**上面 = 建议中的**、**下面 = 留级题**。
 *   留级**不删卡**，只是挪到下面；从下面升级 ⇒ 它才真正离开。
 *
 * ── 我按他的设计做的两处收窄 ────────────────────────────────────────
 * **① 去掉"卡片右下角点击升级"**：他同时要求"点击错题卡进入详情页"，
 *    同一张卡两个点击目标，手指点下去只能靠猜。⇒ 卡片主体只负责去看详情。
 * **② "已升级"再点 = 撤回（降回复练）**：这是他写的，但按钮写"已升级"却做降级，
 *    容易误触 ⇒ 加 `title` 明说"点一下撤回"。
 *
 * ── "留级"为什么不是永久 ──────────────────────────────────────────────
 * 判据是"计划复习里错 ≥2 次"。她留级之后又错到第 3、4 次，情况已经变了，
 * 还压着 = 替她做了一个过时的决定。⇒ 落库时记下"当时错了几次"，
 * **只有错得不比当时多**才继续留在下面那一栏（判据在 `lib/cabinet.ts`）。
 *
 * ── "已升级"的题为什么还留在上面那栏 ──────────────────────────────────
 * 判据只看 `manageType`，一升为 deep 就会被排除。但那样她刚点完卡片就消失，
 * 根本没机会点回来 ⇒ 升级/撤回都在**本地**翻转（`isDeep`），刷新后才真正离开。
 * ══════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { subjectLabel } from "@/lib/notebook-fields";
import { ArrowUp, ArrowUpCircle, Loader2, Printer, SkipForward, TrendingUp, X } from "lucide-react";

interface SuggestionItem {
    id: string;
    source: string | null;
    manageType: string | null;
    isDeep: boolean;
    wrongCount: number;
    notebookId: string | null;
    notebookName: string | null;
    subject: string | null;
    gradeSemester: string | null;
    content: string | null;
}

interface ListResponse {
    items: SuggestionItem[];
    keptItems: SuggestionItem[];
    suggestUpgradeMinWrong: number;
}

export default function DeepSuggestionsPage() {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [items, setItems] = useState<SuggestionItem[]>([]);
    /** 【他改主意后】留级题单独一栏 —— 不删卡，只是挪下来 */
    const [keptItems, setKeptItems] = useState<SuggestionItem[]>([]);
    const [threshold, setThreshold] = useState(2);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    /** 哪个动作正在跑（防止连点；"全部升级"用 `all`） */
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const res = await apiClient.get<ListResponse>("/api/deep-suggestions");
            setItems(res.items || []);
            setKeptItems(res.keptItems || []);
            setThreshold(res.suggestUpgradeMinWrong ?? 2);
        } catch (e) {
            console.error(e);
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    /** 单条：升级 / 撤回（就地翻转，不重新拉列表 —— 刚点完就消失会让人以为点坏了） */
    const toggleOne = async (it: SuggestionItem, from: "suggested" | "kept") => {
        if (busy) return;
        const toDeep = !it.isDeep;
        setBusy(it.id);
        try {
            await apiClient.post("/api/deep-suggestions", {
                action: toDeep ? "upgrade" : "downgrade",
                ids: [it.id],
            });
            if (from === "kept") {
                /**
                 * 【他改主意后】从「留级题」里升级 ⇒ **这张卡离开页面**
                 * （他原话："留级题目如果被升级了，再从这个页面消失"）。
                 * 服务端同时把留级记号删了，所以刷新也不会回来。
                 */
                if (toDeep) setKeptItems((prev) => prev.filter((x) => x.id !== it.id));
                else setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, isDeep: false } : x)));
            } else {
                setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, isDeep: toDeep } : x)));
            }
        } catch (e) {
            console.error(e);
            alert(L("没改成功，再试一次。", "Could not update. Try again."));
        } finally {
            setBusy(null);
        }
    };

    /** 留级：确认暂不升 ⇒ 落库 + **挪到下面那一栏**（不再消失） */
    const keepOne = async (it: SuggestionItem) => {
        if (busy) return;
        setBusy(it.id);
        try {
            await apiClient.post("/api/deep-suggestions", { action: "keep", ids: [it.id] });
            setItems((prev) => prev.filter((x) => x.id !== it.id));
            setKeptItems((prev) => [...prev, { ...it, isDeep: false }]);
        } catch (e) {
            console.error(e);
            alert(L("没记上，再试一次。", "Could not save. Try again."));
        } finally {
            setBusy(null);
        }
    };

    /**
     * 【2026-10-20 空空第 1 条】**把留级题放回上面那一栏**（撤销留级）。
     *
     * 他的理由很实在："留级了就只能升级，不利于测试软件，也不利于管理。"
     * ⇒ 留级题上多一个"返回"按钮，点它只删掉留级记号（等级一个字不动），
     *   卡立刻回到"建议中的"那一栏，还能再留级。
     */
    const unkeepOne = async (it: SuggestionItem) => {
        if (busy) return;
        setBusy(it.id);
        try {
            await apiClient.post("/api/deep-suggestions", { action: "unkeep", ids: [it.id] });
            setKeptItems((prev) => prev.filter((x) => x.id !== it.id));
            setItems((prev) => [{ ...it, isDeep: false }, ...prev]);
        } catch (e) {
            console.error(e);
            alert(L("没改成功，再试一次。", "Could not update. Try again."));
        } finally {
            setBusy(null);
        }
    };

    /** 全部升级：只处理**还没升的**（幂等，点两次不会出错） */
    const upgradeAll = async () => {
        const todo = items.filter((x) => !x.isDeep).map((x) => x.id);
        if (todo.length === 0 || busy) return;
        setBusy("all");
        try {
            await apiClient.post("/api/deep-suggestions", { action: "upgrade", ids: todo });
            const set = new Set(todo);
            setItems((prev) => prev.map((x) => (set.has(x.id) ? { ...x, isDeep: true } : x)));
        } catch (e) {
            console.error(e);
            alert(L("批量升级没成功，再试一次。", "Bulk upgrade failed. Try again."));
        } finally {
            setBusy(null);
        }
    };

    const pendingCount = items.filter((x) => !x.isDeep).length;
    /** 【第 2 条】已升级的单独一栏：它们现在的正事是"印出来" */
    const suggestedItems = items.filter((x) => !x.isDeep);
    const upgradedItems = items.filter((x) => x.isDeep);

    /** 一张卡 —— 三栏共用（建议中 / 留级 / 已升级，按钮各不同） */
    const renderCard = (it: SuggestionItem, from: "suggested" | "kept" | "upgraded") => (
        <Card key={it.id} className={it.isDeep ? "border-emerald-300 dark:border-emerald-900" : ""}>
            {/**
             * 卡片主体 = 去详情页（他要求的"点击错题卡进入这道错题的详情页"）。
             * ⚠️ 按钮必须放在这个 `<Link>` **外面** —— 链接里套按钮，
             *    点按钮会先触发跳转（这个项目在别处踩过）。
             */}
            <Link href={`/error-items/${it.id}`} className="block">
                <CardHeader className="gap-1 pb-2">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                        <span className="font-mono text-sm">{it.source || it.id}</span>
                        {it.subject && (
                            <span className="text-xs font-normal text-muted-foreground">
                                {subjectLabel(it.subject)}
                            </span>
                        )}
                        {it.gradeSemester && (
                            <span className="text-xs font-normal text-muted-foreground">· {it.gradeSemester}</span>
                        )}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                        {it.notebookName || L("（未归本）", "(no notebook)")}
                    </p>
                </CardHeader>
                <CardContent className="space-y-2 pb-2">
                    <p className="line-clamp-2 text-sm">
                        {(it.content || "").replace(/\s+/g, " ").trim() || L("（没有题干）", "(no text)")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {L(`计划复习里错了 ${it.wrongCount} 次`, `Wrong ${it.wrongCount}× in planned reviews`)}
                    </p>
                </CardContent>
            </Link>
            <CardContent className="flex gap-2 pt-0">
                {/* 【第 2 条】已升级那一栏不放"升级/撤回" —— 那里只有打印/清除两个去向 */}
                {from !== "upgraded" && (
                <Button
                    size="sm"
                    variant={it.isDeep ? "outline" : "default"}
                    className={it.isDeep ? "border-emerald-500 text-emerald-700 dark:text-emerald-300" : ""}
                    disabled={!!busy}
                    title={
                        it.isDeep
                            ? L("点一下撤回，这道题会变回复练", "Click to undo — it goes back to review")
                            : L("把这道题从复练升级为深挖", "Upgrade from review to deep")
                    }
                    onClick={() => void toggleOne(it, from)}
                >
                    {busy === it.id ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                        <ArrowUpCircle className="mr-1.5 h-4 w-4" />
                    )}
                    {it.isDeep ? L("已升级", "Upgraded") : L("升级", "Upgrade")}
                </Button>
                )}
                {/* 下面那栏已经是"留级"状态了，不再给这个按钮（给了也没意义） */}
                {from === "suggested" && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={!!busy}
                        title={L(
                            "暂不升级，挪到下面的「留级题」（错得更多时会重新回到上面）",
                            "Keep as is; moves to “Kept” below (comes back if it gets worse)",
                        )}
                        onClick={() => void keepOne(it)}
                    >
                        <SkipForward className="mr-1.5 h-4 w-4" />
                        {L("留级", "Keep")}
                    </Button>
                )}
                {/* 【第 1 条】留级题多一个"回到上面" —— 撤销留级记号，卡回到上面那栏 */}
                {from === "kept" && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={!!busy}
                        title={L(
                            "撤销留级，这张卡回到上面「建议中的」那一栏（等级不变）",
                            "Undo keep — the card goes back up (level unchanged)",
                        )}
                        onClick={() => void unkeepOne(it)}
                    >
                        <ArrowUp className="mr-1.5 h-4 w-4" />
                        {L("回到上面", "Move up")}
                    </Button>
                )}
                {/**
                 * 【第 2 条】**已升级的题要给"下一步"**：这时候真正要做的是
                 * "把它用深挖纸印出来"，不是标记完就算了。
                 *
                 * · 打印 → `/print-preview?mode=deep&ids=` **新标签**打开。
                 *   用新标签而不是跳转，是因为 `print-preview` 的返回键写死回 `/notebooks`，
                 *   从这一页进去会被带到别处；新标签关掉就回到这里，正好符合"返回还回建议深挖"。
                 * · 清除 → 只从**本地**移走（它的 `manageType` 已经是 deep，
                 *   服务端下次不会再把它列进来，所以不需要额外落库）。
                 */}
                {from === "upgraded" && (
                    <>
                        <Button size="sm" variant="default" asChild>
                            <a
                                href={`/print-preview?mode=deep&ids=${encodeURIComponent(it.id)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={L("打开这道题的深挖页，调好版面就印", "Open its deep sheet to print")}
                            >
                                <Printer className="mr-1.5 h-4 w-4" />
                                {L("打印", "Print")}
                            </a>
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground"
                            disabled={!!busy}
                            title={L("这次不印了，把它从这一页清出去", "Dismiss without printing")}
                            onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}
                        >
                            <X className="mr-1.5 h-4 w-4" />
                            {L("清除", "Dismiss")}
                        </Button>
                    </>
                )}
            </CardContent>
        </Card>
    );

    return (
        <main className="min-h-screen bg-background">
            <div className="container mx-auto max-w-7xl space-y-4 p-4 pb-20 md:p-8">
                <div className="flex flex-wrap items-center gap-2">
                    <BackButton fallbackUrl="/" className="shrink-0" />
                    <h1 className="flex items-center gap-2 text-base font-semibold sm:text-lg">
                        <TrendingUp className="h-5 w-5" />
                        {L("建议深挖", "Suggested upgrades")}
                    </h1>
                    <span className="flex-1" />
                    <Button size="sm" disabled={pendingCount === 0 || !!busy} onClick={() => void upgradeAll()}>
                        {busy === "all" ? (
                            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                            <ArrowUpCircle className="mr-1.5 h-4 w-4" />
                        )}
                        {L(
                            `全部升级${pendingCount > 0 ? `（${pendingCount}）` : ""}`,
                            `Upgrade all${pendingCount > 0 ? ` (${pendingCount})` : ""}`,
                        )}
                    </Button>
                </div>

                <p className="text-sm text-muted-foreground">
                    {L(
                        `计划复习里错了 ${threshold} 次以上、还不是深挖的题（只建议，不会自动改）。点卡片看详情。`,
                        `Wrong ${threshold}+ times in planned reviews and not deep yet (suggestion only). Tap a card for details.`,
                    )}
                </p>

                {loading ? (
                    <div className="flex items-center gap-2 p-10 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        {L("正在算…", "Loading…")}
                    </div>
                ) : error ? (
                    <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
                        {L("数据没取到，稍后再试。", "Failed to load. Try again later.")}
                    </div>
                ) : items.length === 0 && keptItems.length === 0 ? (
                    /**
                     * 【2026-10-20 美化】空状态加一个**很淡的大图标**（`opacity-15`）。
                     * 原来只有一行字，空页面看起来像"没加载出来"；
                     * 有了图标，它读起来是"这里本来就该空着"。
                     * 和主页按钮右下角的水印是同一套语言（淡、大、不抢字）。
                     */
                    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center text-muted-foreground">
                        <TrendingUp aria-hidden className="h-10 w-10 opacity-15" />
                        <span className="text-sm">{L("没有需要升级的题。", "Nothing to upgrade right now.")}</span>
                    </div>
                ) : (
                    <>
                        {/* ===== 上半：建议中的 ===== */}
                        {suggestedItems.length > 0 && (
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                {suggestedItems.map((it) => renderCard(it, "suggested"))}
                            </div>
                        )}

                        {/* ===== 已升级（【第 2 条】新加的那一栏）===== */}
                        {upgradedItems.length > 0 && (
                            <div className="space-y-3 pt-2">
                                <div className="flex items-center gap-3">
                                    <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                                        {L(`已升级（${upgradedItems.length}）`, `Upgraded (${upgradedItems.length})`)}
                                    </span>
                                    <span className="h-px flex-1 bg-border" />
                                    <span className="text-xs text-muted-foreground">
                                        {L("下一步是把它们印出来", "Next: print them")}
                                    </span>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                    {upgradedItems.map((it) => renderCard(it, "upgraded"))}
                                </div>
                            </div>
                        )}

                        {/* ===== 分隔线 + 留级题（他改主意后加的那一栏）===== */}
                        {keptItems.length > 0 && (
                            <div className="space-y-3 pt-2">
                                <div className="flex items-center gap-3">
                                    <span className="text-sm font-medium text-muted-foreground">
                                        {L(`留级题（${keptItems.length}）`, `Kept (${keptItems.length})`)}
                                    </span>
                                    <span className="h-px flex-1 bg-border" />
                                    <span className="text-xs text-muted-foreground">
                                        {L("先不升，不再提醒；想升随时可以升", "Not now — no more reminders; upgrade anytime")}
                                    </span>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                    {keptItems.map((it) => renderCard(it, "kept"))}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </main>
    );
}
