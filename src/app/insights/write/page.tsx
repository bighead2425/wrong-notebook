"use client";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-10-13 他第 3 / 4 条的落地】**日积月累 · 录入页**（`/insights/write`）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 他为什么要单独一页（原话拆解）：
 *   "一方面打开日积月累页，需要从数据库拉来内容，这个时间现在是越来越慢了；
 *    另一方面那个界面还不够纯粹，我想如果我要记录一个东西，那么我就排除干扰，
 *    这一页主要就为这个功能而生就可以了。所以我需要一进入日积月累页，就是建立日积月累条目的界面。"
 *
 * ⇒ **进门就是写**：这一页**不读列表、不加筛选、不放标题**，打开就能打字。
 *   另两页各留一个按钮通道：管理 → `/insights`（老页面，名字改成"日积月累·管理"），
 *   打印 → `/insights/print`。**老路由一个都没改**（`/insights` 被扫码流程、内阁、
 *   错题详情页一串深链用着，改名字等于把这些入口全弄断）。
 *
 * ── 两个按钮的语义（他第 4 条定的）────────────────────────────────
 *   · **暂存**（`Inbox` 图标）= 存进库里当**草稿**（`status='draft'`），
 *     等他后续在管理页整理或删除；**列表 / 打印 / 内阁默认都不收草稿**。
 *   · **保存**（`✓`）= 正式内容（`status='final'`）。
 *   两个按钮都**只在"页面上已经有东西"时可点**（他："不是全新页面状态"）。
 *   ⚠️ 暂存之后再改再按保存 ⇒ 走 PATCH 把那条**转正**（不新建第二条，
 *      否则同一次记录会在库里留两份）。
 *
 * ── 这一版**故意没做**的部分（下一步接，别当忘了）─────────────────
 *   图片（拍照 / 本地 / 收件箱）、扫码绑定错题、OCR / 总结 / 聊一聊。
 *   零件全是现成的（`DocScanner` + `ImageCropper` + `insight-photo` + `/api/insights/ai`），
 *   但都要接线 + 真机试，晚上这一版先把"进门就能写字"跑通 ——
 *   **先立靶子**（他的原话）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Inbox, Loader2, Printer, Settings2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MdEditor, type MdEditorInstance } from "@/components/md-editor";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { dayKey } from "@/lib/calendar-grid";
import { GRADE_SEMESTER_OPTIONS } from "@/lib/grade-semester-options";
import { SUBJECT_OPTIONS } from "@/lib/notebook-fields";

/** 上次选的年级学期 / 学科记在这儿 —— 他一天要记好几条，"每次重选"是纯粹的浪费 */
const LS_GRADE = "insight.write.gradeSemester";
const LS_SUBJECT = "insight.write.subject";

export default function InsightWritePage() {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [gradeSemester, setGradeSemester] = useState("");
    const [subject, setSubject] = useState("");
    const [content, setContent] = useState("");

    /** 编辑器实例（撤销按钮要用；MdEditor 不是 forwardRef，走 `onReady` 回调） */
    const editorRef = useRef<MdEditorInstance | null>(null);
    /** 这条已经以草稿存过库的 id —— 保存时把它转正，而不是再新建一条 */
    const [draftId, setDraftId] = useState<string | null>(null);
    const [busy, setBusy] = useState<"draft" | "save" | null>(null);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");

    /** 打开就用上次的年级/学科（本地存，不上云） */
    useEffect(() => {
        try {
            setGradeSemester(localStorage.getItem(LS_GRADE) ?? "");
            setSubject(localStorage.getItem(LS_SUBJECT) ?? "");
        } catch {
            /* 隐私模式下取不到就算了 */
        }
    }, []);

    const rememberPicks = useCallback((g: string, s: string) => {
        try {
            localStorage.setItem(LS_GRADE, g);
            localStorage.setItem(LS_SUBJECT, s);
        } catch {
            /* 同上 */
        }
    }, []);

    /** 页面上有没有东西（决定暂存/保存能不能点 —— 他的原话："不是全新页面状态"） */
    const hasContent = content.trim().length > 0;

    /**
     * 写进去。
     * @param status `draft` = 暂存 / `final` = 保存（正式）
     */
    const put = async (status: "draft" | "final") => {
        if (!hasContent || busy) return;
        setBusy(status === "draft" ? "draft" : "save");
        setNotice("");
        setError("");
        try {
            if (draftId) {
                // 已经在库里（先前暂存过）⇒ 就地改，不新建
                await apiClient.patch(`/api/insights/${draftId}`, {
                    content,
                    status,
                    gradeSemester: gradeSemester || null,
                    subject: subject || null,
                });
                if (status === "final") {
                    setNotice(L("已保存。可以接着写下一条了。", "Saved. Ready for the next one."));
                    resetForNext();
                } else {
                    setNotice(L("已暂存（在管理页里标着「待整理」）。", "Saved as draft (marked in the manage page)."));
                }
            } else {
                const created = await apiClient.post<{ id?: string; code?: string; replaced?: boolean }>(
                    "/api/insights",
                    {
                        gradeSemester: gradeSemester || null,
                        subject: subject || null,
                        content,
                        source: "page",
                        status,
                        // 日期由**客户端**算（容器跑 UTC，服务端算日子会差一天 —— 项目老规矩）
                        dateKey: dayKey(new Date()),
                    },
                );
                if (status === "draft") {
                    setDraftId(created?.id ?? null);
                    setNotice(L("已暂存（在管理页里标着「待整理」）。", "Saved as draft."));
                } else {
                    setNotice(
                        L(
                            `已保存${created?.code ? `（${created.code}）` : ""}。可以接着写下一条了。`,
                            `Saved${created?.code ? ` (${created.code})` : ""}. Ready for the next one.`,
                        ),
                    );
                    resetForNext();
                }
            }
            rememberPicks(gradeSemester, subject);
        } catch (e) {
            console.error(e);
            setError(L("没存上，再试一次。", "Could not save. Try again."));
        } finally {
            setBusy(null);
        }
    };

    /** 存完一条就清空，**接着写第二条**（这一页存在的意义就是"进门就记"） */
    const resetForNext = () => {
        setContent("");
        setDraftId(null);
        editorRef.current?.setMarkdown("");
    };

    /** Ctrl/⌘ + S 也存（手不离键盘） */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void put("final");
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [content, busy, draftId, gradeSemester, subject]);

    /** 正在写、又直接关页面 ⇒ 拦一下（写下来的东西不能无声丢掉） */
    useEffect(() => {
        if (!hasContent) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [hasContent]);

    /**
     * 标签外观。
     * ⚠️ `relative` + `overflow-hidden` 是**给里面那层透明 select 定位用的**，别删：
     *    他明确要求"标签**不显示下拉三角**，只要点击标签就下拉" ⇒ 做法是让 `<select>`
     *    铺满整个标签（`absolute inset-0 opacity-0`），点标签任意位置都命中它本身，
     *    原生的下拉就会展开。
     *    ⚠️ 不能用 `sr-only`：那会把 select 缩成 1px，点标签**大概率点不到**它，
     *       表现就是"点了一下没反应"—— 比留个三角更糟。
     */
    const tagClass =
        "relative inline-flex items-center gap-1 overflow-hidden rounded-md border px-2.5 py-1 text-xs hover:bg-accent transition-colors";

    return (
        <main className="min-h-screen bg-background">
            {/* ===== 顶栏：返回 / 撤销 / 管理 / 打印 ……… 暂存 / 保存 =====
                他明说"此页不放标题"—— 这一页唯一的主角是那个编辑框。 */}
            <div className="border-b bg-background">
                <div className="mx-auto flex w-full max-w-[1100px] items-center gap-1 px-3 py-2 md:px-6">
                    <Link href="/">
                        <Button variant="ghost" size="icon" title={L("返回主页", "Home")}>
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                    </Link>
                    <Button
                        variant="ghost"
                        size="icon"
                        title={L("撤销上一步（与 Ctrl+Z 同一条路）", "Undo")}
                        onClick={() => editorRef.current?.undo()}
                    >
                        <Undo2 className="h-5 w-5" />
                    </Button>
                    <Link href="/insights">
                        <Button variant="outline" size="sm" title={L("去日积月累·管理页", "Manage entries")}>
                            <Settings2 className="h-4 w-4 sm:mr-1.5" />
                            <span className="hidden sm:inline">{L("管理", "Manage")}</span>
                        </Button>
                    </Link>
                    <Link href="/insights/print">
                        <Button variant="outline" size="sm" title={L("去日积月累·打印页", "Takeaway sheets")}>
                            <Printer className="h-4 w-4 sm:mr-1.5" />
                            <span className="hidden sm:inline">{L("打印", "Print")}</span>
                        </Button>
                    </Link>
                    <span className="flex-1" />
                    <Button
                        variant="outline"
                        size="icon"
                        disabled={!hasContent || !!busy}
                        title={L("暂存（先存进库里，等你在管理页整理）", "Save as draft")}
                        onClick={() => void put("draft")}
                    >
                        {busy === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Inbox className="h-4 w-4" />}
                    </Button>
                    <Button
                        size="icon"
                        disabled={!hasContent || !!busy}
                        title={L("保存（正式记入日积月累）", "Save")}
                        onClick={() => void put("final")}
                    >
                        {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </Button>
                </div>
            </div>

            <div className="mx-auto w-full max-w-[1100px] space-y-3 px-3 py-3 md:px-6">
                {/* ===== 工具栏：年级学期 / 学科 / （图片 · 扫码 · OCR · 总结 下一步） =====
                    他要求这两个标签**不带下拉三角**（"有点占地方"），点标签本身就下拉 ⇒ 用原生 select
                    套一层标签外观（手机上也是原生选择器，比自绘下拉更省事、更稳）。 */}
                <div className="flex flex-wrap items-center gap-2">
                    <label className={tagClass}>
                        <span className="truncate max-w-[7rem]">
                            {gradeSemester || L("年级学期", "Grade/term")}
                        </span>                        <select
                            className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                            value={gradeSemester}
                            onChange={(e) => setGradeSemester(e.target.value)}
                            aria-label={L("年级学期", "Grade and term")}
                        >
                            <option value="">{L("（不指定）", "(none)")}</option>
                            {GRADE_SEMESTER_OPTIONS.map((g) => (
                                <option key={g} value={g}>
                                    {g}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className={tagClass}>
                        <span className="truncate max-w-[6rem]">
                            {subject
                                ? SUBJECT_OPTIONS.find((s) => s.key === subject)?.label ?? subject
                                : L("学科", "Subject")}
                        </span>                        <select
                            className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                            aria-label={L("学科", "Subject")}
                        >
                            <option value="">{L("（不指定）", "(none)")}</option>
                            {SUBJECT_OPTIONS.map((s) => (
                                <option key={s.key} value={s.key}>
                                    {s.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <span className="text-xs text-muted-foreground">
                        {L(
                            "图片 / 扫码绑定错题 / OCR / 总结 —— 下一步接（零件都现成，接线还没做）",
                            "Image / scan-to-bind / OCR / summarize — next step",
                        )}
                    </span>
                </div>

                {/* ===== 编辑框：这一页的主角 ===== */}
                <MdEditor
                    value={content}
                    onChange={setContent}
                    placeholder={L(
                        "记下来就行：一句话、一个词、书上划的一段、老师说的、自己想到的……",
                        "Just write it down: a line, a word, something from a book or class…",
                    )}
                    minHeightPx={320}
                    dirty={hasContent}
                    onReady={(inst) => {
                        editorRef.current = inst;
                    }}
                />

                {(notice || error) && (
                    <div
                        className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm ${error
                            ? "border-destructive/50 text-destructive"
                            : "border-emerald-500/40 bg-emerald-500/10"
                            }`}
                    >
                        <span>{error || notice}</span>
                        {/**
                         * 【2026-10-13】「另起一条」—— 暂存之后那个**死结**的出口。
                         *
                         * 暂存会把这一条的 id 记下来（接着写 = 改它，这是对的：不会攒出一堆重复条）。
                         * 但他要是想"再记一条新的"，原来只有一条路 —— 手动把内容删光；
                         * 而删光之后按钮变灰、重新写的内容一按保存又会**盖回那条暂存条**，
                         * 他会以为"写了半天没存上"。⇒ 给一个明确的脱身按钮。
                         */}
                        {draftId && !error && (
                            <button
                                type="button"
                                className="shrink-0 rounded border px-2 py-0.5 text-xs hover:bg-accent"
                                onClick={() => {
                                    resetForNext();
                                    setNotice(
                                        L(
                                            "已另起一条（刚暂存的那条在「管理」里等着整理）。",
                                            "Started a new one — the draft is waiting in Manage.",
                                        ),
                                    );
                                }}
                            >
                                {L("另起一条", "New one")}
                            </button>
                        )}
                    </div>
                )}

                <p className="text-xs text-muted-foreground">
                    {L(
                        "提示：暂存 = 先扔进库里等整理（打印与内阁都看不见它）；保存 = 正式内容。Ctrl/⌘ + S 也能保存。",
                        "Draft = parked in the library (hidden from printing and the cabinet). Save = final. Ctrl/⌘+S works too.",
                    )}
                </p>
            </div>
        </main>
    );
}
