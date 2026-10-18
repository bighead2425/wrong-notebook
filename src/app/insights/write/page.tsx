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
 * ── 【2026-10-18】接上三件"进门就写"要用到的东西 ─────────────────
 *   ① **图片**：DocScanner（拍/相册/去底/漂白）→ ImageCropper（剪/擦/转）→ 缩在编辑框上方，
 *      保存时随条目一起进 `InsightPhoto`（一条最多一张，老规矩）。
 *   ② **拍字识文（OCR）**：拍一张 → `/api/insights/ocr` → **抄下来的文字追加进正文**。
 *      ⚠️ **图不留底**（他 2026-10-18 定的）：OCR 完图就没了，只留字 ——
 *         "文字内容留底比较简单也比较容易查"。
 *   ③ **整理**：`/api/insights/ai` → 直接把**整理好的卡片填进正文**（他的原话：
 *      "AI整理的内容，直接填写入正文"）。整理前的原文**留一份**，提示条上给「撤回原样」，
 *      因为这是覆盖式写入 —— 覆盖别人的话，必须留一条退路。
 *
 * ── 这一版**故意没做**的 ────────────────────────────────────────────
 *   **扫码绑定错题**：他 2026-10-13 已经把这本东西定位成"**不绑定题**的笔记"，
 *   扫码绑题会把它拽回"错题附件"。真要关联，`/insights`（管理页）右栏本来就能关联，
 *   那是"事后整理"的活，不该压在"进门就写"这一步上。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
    ArrowLeft,
    Check,
    ImagePlus,
    Inbox,
    Loader2,
    Printer,
    ScanText,
    Settings2,
    Sparkles,
    Undo2,
    X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MdEditor, type MdEditorInstance } from "@/components/md-editor";
import { DocScanner, type DocScannerHandle } from "@/components/doc-scanner";
import { ImageCropper } from "@/components/image-cropper";
import { ImageZoomViewer } from "@/components/image-zoom-viewer";
import { apiClient } from "@/lib/api-client";
import { processImageFile } from "@/lib/image-utils";
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

    /** 配图（data URL）。一条最多一张 —— 与 `InsightPhoto` 的唯一索引同一条规矩 */
    const [photo, setPhoto] = useState<string | null>(null);
    /**
     * 图**有没有变过**。
     * ⚠️ 必须单独记：PATCH 每次都带 `photo` 的话，几百 KB 的 data URL 会**每条都重写一遍**
     *    （服务端 `writePhoto` 是 upsert，写一次就多一次 IO）。只在真改过时才带。
     */
    const [photoDirty, setPhotoDirty] = useState(false);

    /** DocScanner 这次是"给这条配一张图"还是"把图上的字抄下来" */
    const scanModeRef = useRef<"photo" | "ocr">("photo");
    const scannerRef = useRef<DocScannerHandle | null>(null);
    /** DocScanner 交出的成品（object URL），交给剪裁页继续加工 */
    const [croppingImage, setCroppingImage] = useState<string | null>(null);
    const [isCropperOpen, setIsCropperOpen] = useState(false);
    const [isViewerOpen, setIsViewerOpen] = useState(false);

    const [aiBusy, setAiBusy] = useState(false);
    const [ocrBusy, setOcrBusy] = useState(false);
    /**
     * 「整理」覆盖正文之前的原文。
     * 整理是**覆盖式写入**（把她的原料换成整理好的卡片），所以必须留一条退路 ——
     * 模型整理跑偏的时候，她要能一键退回自己写的样子，而不是靠 Ctrl+Z 碰运气。
     */
    const [undoRaw, setUndoRaw] = useState<string | null>(null);

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
                    // 只在图真变过时才带（否则每存一次都重写一遍几百 KB）
                    ...(photoDirty ? { photo } : {}),
                });
                setPhotoDirty(false);
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
                        // 有图就一起落库；没有就不传（服务端 `photo` 缺省 = 不动）
                        ...(photo ? { photo } : {}),
                        source: "page",
                        status,
                        // 日期由**客户端**算（容器跑 UTC，服务端算日子会差一天 —— 项目老规矩）
                        dateKey: dayKey(new Date()),
                    },
                );
                setPhotoDirty(false);
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
        setPhoto(null);
        setPhotoDirty(false);
        setUndoRaw(null);
        editorRef.current?.setMarkdown("");
    };

    // ── 图片：拍照/相册 → 去底漂白 → 剪裁 → 缩在正文上方 ────────────
    /** 剪裁页「确认」⇒ 压缩成 data URL，暂存在这一页，保存时才进库 */
    const handleCropComplete = async (blob: Blob) => {
        try {
            const dataUrl = await processImageFile(new File([blob], "insight.jpg", { type: "image/jpeg" }));
            setPhoto(dataUrl);
            setPhotoDirty(true);
            setCroppingImage(null);
            setIsCropperOpen(false);
        } catch (e) {
            console.error(e);
            // 失败**不关剪裁页**：她修了半天的图不能因为一次读不出来就丢了
            setError(L("这张图读不出来，换一张试试。", "Could not read that image."));
        }
    };

    const removePhoto = () => {
        if (croppingImage) URL.revokeObjectURL(croppingImage);
        setCroppingImage(null);
        setPhoto(null);
        setPhotoDirty(true); // 「原本有图 → 现在没图」也是一次改动，保存时要让服务端删掉
    };

    // ── 拍字识文（OCR）────────────────────────────────────────────
    /**
     * 拍一张 ⇒ 抄进正文。
     *
     * 三个刻意的做法：
     *  ① **追加**而不是覆盖（她可能已经写了一半，抄下来的接在后面）；
     *  ② **图不留底**（他 2026-10-18 定的）—— 这一步的图**不存**，只留字；
     *  ③ 结果落到正文之后**不再自动整理**：抄错了她自己能改，
     *     而"顺手帮我整理"会让她失去"我记的就是我写的"这件事。
     */
    const runOcr = async (blob: Blob) => {
        if (ocrBusy) return;
        setOcrBusy(true);
        setError("");
        setNotice("");
        try {
            const dataUrl = await processImageFile(new File([blob], "ocr.jpg", { type: "image/jpeg" }));
            const res = await apiClient.post<{ text?: string }>("/api/insights/ocr", { image: dataUrl });
            const text = (res?.text ?? "").trim();
            if (!text) throw new Error("empty");
            const next = content.trim() ? `${content.trim()}\n\n${text}` : text;
            setContent(next);
            editorRef.current?.setMarkdown(next);
            setNotice(L("照片上的字已经抄进正文，可以自己改。", "Text pulled into the note — edit as you like."));
        } catch (e) {
            console.error(e);
            setError(L("没读出字来，换一张清楚点的、正着拍的试试。", "Could not read that photo. Try a clearer, straight-on shot."));
        } finally {
            setOcrBusy(false);
        }
    };

    /**
     * DocScanner 交回成品 —— 这里是"配图"和"读字"的**分岔口**：
     *   · `photo` ⇒ 进剪裁页（图要她自己修：剪掉多余边、擦掉不想留的）；
     *   · `ocr`   ⇒ 直接送读字（读字不需要人剪，多一道剪裁只是多一道坎）。
     *
     * ⚠️ 定义位置在 `runOcr` 之后：这里要调它，往里放会踩"先声明后使用"。
     */
    const handleScanComplete = (blob: Blob) => {
        if (scanModeRef.current === "ocr") {
            void runOcr(blob);
            return;
        }
        const url = URL.createObjectURL(blob);
        setCroppingImage(url);
        setIsCropperOpen(true);
    };

    // ── 整理：把原料整理成一张卡片，**直接填进正文** ────────────────
    /**
     * 他 2026-10-18 的原话："AI整理的内容，直接填写入正文。"
     * ⇒ 这里**不再另起批注**（老做法是追加一段斜体），而是整段替换。
     *
     * ⚠️ 覆盖式写入 ⇒ 必须留退路：原文存进 `undoRaw`，提示条上给「撤回原样」。
     * ⚠️ 正文正确性：他把这条定死了 —— **正文必须是正确的**（错的内容反复记，
     *    记一遍多错一遍），她的错由 AI 段点出来。提示词第 5 条按这个改过。
     */
    const runAi = async () => {
        if (!hasContent || aiBusy) return;
        setAiBusy(true);
        setError("");
        setNotice("");
        try {
            const res = await apiClient.post<{ note?: string }>("/api/insights/ai", {
                content,
                subject: subject || null,
            });
            const note = (res?.note ?? "").trim();
            if (!note) throw new Error("empty");
            setUndoRaw(content);
            setContent(note);
            editorRef.current?.setMarkdown(note);
            setNotice(L("整理好了，已经填进正文 —— 可以直接改，也可以撤回原样。", "Tidied into the note. Edit it, or restore your original."));
        } catch (e) {
            console.error(e);
            setError(L("整理没成功，再试一次。", "Could not tidy it. Try again."));
        } finally {
            setAiBusy(false);
        }
    };

    const restoreRaw = () => {
        if (undoRaw === null) return;
        setContent(undoRaw);
        editorRef.current?.setMarkdown(undoRaw);
        setUndoRaw(null);
        setNotice(L("已撤回你原来写的样子。", "Restored your original."));
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
                    {/* 三个动作：配图 / 拍字识文 / 整理。都排在标签同一行右侧，
                        手机上文字收起只留图标（标签本来就没几个字，别把编辑框挤下去）。 */}
                    <span className="flex-1" />
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!!busy || aiBusy}
                        title={L("给这条配一张图（拍照 / 相册）", "Attach a photo")}
                        onClick={() => {
                            scanModeRef.current = "photo";
                            scannerRef.current?.openCamera();
                        }}
                    >
                        <ImagePlus className="h-4 w-4 sm:mr-1.5" />
                        <span className="hidden sm:inline">{L("图片", "Photo")}</span>
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={ocrBusy || !!busy || aiBusy}
                        title={L("拍一张，把上面的字抄进正文（图不留底）", "Read a photo into the note")}
                        onClick={() => {
                            scanModeRef.current = "ocr";
                            scannerRef.current?.openCamera();
                        }}
                    >
                        {ocrBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanText className="h-4 w-4 sm:mr-1.5" />}
                        <span className="hidden sm:inline">{ocrBusy ? L("读图中", "Reading") : L("拍字", "Read")}</span>
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!hasContent || aiBusy || ocrBusy}
                        title={L("把这段原料整理成一张卡片，直接填进正文", "Tidy into a card")}
                        onClick={() => void runAi()}
                    >
                        {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 sm:mr-1.5" />}
                        <span className="hidden sm:inline">{aiBusy ? L("整理中", "Tidying") : L("整理", "Tidy")}</span>
                    </Button>
                </div>

                {/* ===== 配图缩略图：有图才出现（没图时不占版面）===== */}
                {photo && (
                    <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2">
                        <button
                            type="button"
                            onClick={() => setIsViewerOpen(true)}
                            className="shrink-0 cursor-zoom-in"
                            title={L("点开放大看", "Click to enlarge")}
                            aria-label={L("放大阅览这张图", "Enlarge this photo")}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={photo} alt="" className="h-16 w-16 rounded object-cover" />
                        </button>
                        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                            {L(
                                "这张图会跟着这条一起存（一条最多一张）。点图能放大看。",
                                "This photo is saved with the note (one per note). Click to enlarge.",
                            )}
                        </p>
                        <Button variant="ghost" size="icon" onClick={removePhoto} title={L("去掉这张图", "Remove photo")}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                )}

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
                        <span className="min-w-0 flex-1">{error || notice}</span>
                        {/**
                         * 【2026-10-18】「撤回原样」—— 「整理」是覆盖式写入，得有退路。
                         *
                         * 整理会把她写的那段换成卡片（他定的："AI整理的内容，直接填写入正文"）。
                         * 但模型总会有整理跑偏的时候 —— 那时她要的是"你把我原来写的还我"，
                         * 而不是去猜 Ctrl+Z 能不能撤。⇒ 原文留着，一键换回。
                         *
                         * ⚠️ 只在**刚整理完**这一小段时间有意义，所以一撤回就清掉；
                         *    再整理一次会重新记一份（覆盖上一份，不堆历史 —— 这里不是版本库）。
                         */}
                        {undoRaw !== null && !error && (
                            <button
                                type="button"
                                className="shrink-0 rounded border px-2 py-0.5 text-xs hover:bg-accent"
                                onClick={restoreRaw}
                            >
                                {L("撤回原样", "Restore")}
                            </button>
                        )}
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
                        "提示：暂存 = 先扔进库里等整理（打印与内阁都看不见它）；保存 = 正式内容。Ctrl/⌘ + S 也能保存。「拍字」只留文字，照片本身不留底。",
                        "Draft = parked in the library (hidden from printing and the cabinet). Save = final. Ctrl/⌘+S works too. “Read” keeps only the text, not the photo.",
                    )}
                </p>
            </div>

            {/**
             * 拍照/相册这一整条链路（与主页、日积月累管理页**同一套组件**，不另写一份）。
             * `onClose` 不做别的事：这一页没有"撤到上一步"的概念，
             * 关掉扫描器就等于放弃这张 —— 正文里已经写的东西一个字不动。
             */}
            <DocScanner ref={scannerRef} onScanComplete={handleScanComplete} onClose={() => {}} />
            {croppingImage && (
                <ImageCropper
                    imageSrc={croppingImage}
                    open={isCropperOpen}
                    onClose={() => {
                        setIsCropperOpen(false);
                        setCroppingImage(null);
                    }}
                    onCropComplete={handleCropComplete}
                />
            )}
            <ImageZoomViewer open={isViewerOpen} src={photo} onClose={() => setIsViewerOpen(false)} />
        </main>
    );
}
