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
 *   ⚠️【2026-10-19 改】暂存**存完就清空页面、直接另起一条**（他的原话："暂存就是把内容
 *      赶快记下来……不需要再问是不是想另起一条了"）。原来那条"暂存后接着写 = 改那条暂存条"
 *      的路已删 —— 要改草稿去管理页改。
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
    Link2,
    Loader2,
    Printer,
    QrCode,
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
import { QrScanDialog } from "@/components/qr-scan-dialog";
import { ScanVolumeView } from "@/components/scan-volume-view";
import { InsightScanView } from "@/components/insight-scan-view";
import { apiClient } from "@/lib/api-client";
import { processImageFile } from "@/lib/image-utils";
import { planInsightSource } from "@/lib/insight-source";
import { cutInsightCrops, toQuoteBlock } from "@/lib/insight-image";
import { nextSubjectByAi } from "@/lib/insight-subject";
import { parsePageCode } from "@/lib/volume-code";
import type { CropRegions } from "@/lib/crop-regions";
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
    const [busy, setBusy] = useState<"draft" | "save" | null>(null);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");

    /** 配图（data URL）。一条最多一张 —— 与 `InsightPhoto` 的唯一索引同一条规矩 */
    const [photo, setPhoto] = useState<string | null>(null);
    /**
     * 这张图**要不要印进积累纸**（"入版"）。
     *
     * 【2026-10-19 空空第 3 条】录入的时候就要能定：他原话是"在编辑过程中就可以
     * 指定日积月累的图片到底需不需要入版了，缺省设置为『入版』，点击后变为『不入版』"。
     * 以前只有管理页能改（事后整理时才想起来），而"这张图只是我自己看的、别印出去"
     * 这个判断，往往在拍完照那一刻就已经有了。
     * ⚠️ 关掉**不等于删图**（图还在、编辑区还看得见），只是**这一版纸不排它**。
     */
    const [photoIncluded, setPhotoIncluded] = useState(true);
    /**
     * ⚠️【2026-10-19】原来的 `photoDirty`（"图有没有变过"）已删：
     *    它是给"暂存后接着改那条"的 PATCH 分支用的（怕每次重写几百 KB 的 data URL）。
     *    暂存即另起之后，这一页只剩 POST 一条路，每次都是新的一条 ⇒ 无所谓"变没变"。
     */

    /** DocScanner 这次是"给这条配一张图"还是"把图上的字抄下来" */
    const scanModeRef = useRef<"photo" | "ocr">("photo");
    const scannerRef = useRef<DocScannerHandle | null>(null);
    /** DocScanner 交出的成品（object URL），交给剪裁页继续加工 */
    const [croppingImage, setCroppingImage] = useState<string | null>(null);
    const [isCropperOpen, setIsCropperOpen] = useState(false);
    const [isViewerOpen, setIsViewerOpen] = useState(false);

    const [aiBusy, setAiBusy] = useState(false);
    const [ocrBusy, setOcrBusy] = useState(false);
    /** 剪裁页「确认」之后那一段（拆图 + 读字）—— 有一两秒，锁住按钮防重复提交 */
    const [cropBusy, setCropBusy] = useState(false);
    /**
     * 剪裁页回传的框坐标。
     *
     * ⚠️ 必须用 **ref** 而不是 state：`onCropRegions` 与 `onCropComplete` 是
     *    同一次点击里先后同步调用的，setState 那一刻还没生效 ⇒ 在 `onCropComplete`
     *    里读 state 会读到**上一张图**的框（"这张图的框套在上一张上"，不报错只裁歪）。
     */
    const regionsRef = useRef<CropRegions | null>(null);
    /**
     * 「整理」覆盖正文之前的原文。
     * 整理是**覆盖式写入**（把她的原料换成整理好的卡片），所以必须留一条退路 ——
     * 模型整理跑偏的时候，她要能一键退回自己写的样子，而不是靠 Ctrl+Z 碰运气。
     */
    const [undoRaw, setUndoRaw] = useState<string | null>(null);

    /* ── 【2026-10-19 第 4 条】扫码链接 ──────────────────────────────────
     *
     * 她要的：在暂存按钮左边点一下扫码 ——
     *   · 扫**深挖纸**（裸题号）⇒ 直接把这道题链到这条积累上；
     *   · 扫**复练纸 / 模仿纸**（页二维码）⇒ 摊开那一卷，点某道题 ⇒ 链上；
     *   · 扫**积累纸**（页二维码）⇒ 摊开那一张，点某条积累 ⇒ 链上（可以链多条）。
     *
     * ⚠️ 链接**先挂在前端**，保存时才落库：这一页是"进门就写"，扫码那一刻
     *    这条积累还没有 id（没点保存）。顺带解决"扫了但最后没保存"的孤儿问题。
     */
    const [scanOpen, setScanOpen] = useState(false);
    /** 扫到卷/积累纸的页二维码 ⇒ 弹层里摊开那一张，等她点 */
    const [pickedVolume, setPickedVolume] = useState<{ code: string; kind: string } | null>(null);
    /** 链到的那道题（题号 + 题干开头，只用于界面显示；落库时只存题号） */
    const [linkedItem, setLinkedItem] = useState<{ no: string; text: string } | null>(null);
    /** 链到的别的积累（`JL…` 编号 + 开头一段）—— 一条积累可以链多条 */
    const [linkedInsights, setLinkedInsights] = useState<{ code: string; content: string }[]>([]);

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
     * 【2026-10-18】"能不能存"的判据要**把图算进来**。
     *
     * 一条积累可以**只有一张图、一个字都没有**（拍下来就是这张图本身）。
     * 只看 `content` 的话，保存按钮是灰的 —— 她拍完图发现存不了，
     * 会以为软件坏了（这正是"没人用往往是入口的问题"那一类）。
     * ⚠️ 但「整理」仍然只认文字：没有原料，AI 无从下手。
     */
    const hasSomething = hasContent || !!photo;

    /**
     * 【2026-10-19 第 4 条】扫到一个码。
     *
     * 判断顺序与 `/scan` 页一致（两条路互不干扰）：**先试卷/积累纸的页号，再当题号查**。
     *   · 页号 ⇒ **不跳转**，在本页弹层里摊开那一张（录入页上还有没保存的正文，跳走就没了）；
     *   · 题号 ⇒ 查一下这道题，直接链上（他："如果扫到了深挖纸，就直接将这道题链接到这个积累上"）。
     */
    const handleQrCode = async (code: string) => {
        setScanOpen(false);
        setError("");
        const page = parsePageCode(code);
        if (page) {
            setPickedVolume({ code: page.pageCode, kind: page.kind });
            return;
        }
        try {
            const res = await apiClient.get<{
                found: boolean;
                item?: { id: string; source?: string | null; questionText?: string | null };
            }>(`/api/scan?no=${encodeURIComponent(code)}`);
            if (!res.found || !res.item) {
                setError(L(`没找到这个码对应的题：${code}`, `No question found for ${code}`));
                return;
            }
            const text = (res.item.questionText || "").replace(/\s+/g, " ").trim();
            setLinkedItem({
                no: res.item.source || code,
                text: text.length > 50 ? `${text.slice(0, 50)}…` : text,
            });
            setNotice(L(`已链接到这道题：${res.item.source || code}`, `Linked to ${res.item.source || code}`));
        } catch (e) {
            console.error(e);
            setError(L("查询失败，再扫一次试试。", "Lookup failed. Try scanning again."));
        }
    };

    /** 卷页里点了某道题的加号 ⇒ 链上（卷页弹层随即关掉） */
    const linkVolumeItem = (item: { source?: string | null; questionText?: string | null }) => {
        const text = (item.questionText || "").replace(/\s+/g, " ").trim();
        setLinkedItem({
            no: item.source || "",
            text: text.length > 50 ? `${text.slice(0, 50)}…` : text,
        });
        setPickedVolume(null);
        setNotice(L(`已链接到这道题：${item.source || ""}`, `Linked to ${item.source || ""}`));
    };

    /**
     * 积累纸里点了某一条 ⇒ 链上（**可以链多条**，他："链接的积累可以形成多个"）。
     * ⚠️ 点到的可能就是"她正在写的这一条"（同一条积累又扫到自己那张纸）—— 拦掉，
     *    自己链自己没有意义，还会在库里留一条自环。
     */
    const linkInsight = async (insightCode: string) => {
        setPickedVolume(null);
        if (linkedInsights.some((l) => l.code === insightCode)) return;
        try {
            const res = await apiClient.get<{ insights?: { code: string; content?: string | null }[] }>(
                `/api/insights?codes=${encodeURIComponent(insightCode)}`,
            );
            const hit = res.insights?.[0];
            if (!hit) {
                setError(L(`没找到这条积累：${insightCode}`, `No entry found: ${insightCode}`));
                return;
            }
            const text = (hit.content || "").replace(/\s+/g, " ").trim();
            setLinkedInsights((prev) => [
                ...prev,
                { code: hit.code, content: text.length > 40 ? `${text.slice(0, 40)}…` : text },
            ]);
            setNotice(L(`已链接到这条积累：${hit.code}`, `Linked to ${hit.code}`));
        } catch (e) {
            console.error(e);
            setError(L("查询失败，再扫一次试试。", "Lookup failed. Try scanning again."));
        }
    };

    /**
     * 写进去。
     * @param status `draft` = 暂存 / `final` = 保存（正式）
     */
    const put = async (status: "draft" | "final") => {
        if (!hasSomething || busy) return;
        setBusy(status === "draft" ? "draft" : "save");
        setNotice("");
        setError("");
        try {
            /**
             * ⚠️【2026-10-19 空空第 1 条】这一页**只有"新建一条"这一条路**了。
             *
             * 原来是"暂存后记住 id，接着写 = 改那条暂存条"（为了不攒重复条）。
             * 他 2026-10-19 推翻了：
             *   "暂存就是把内容赶快记下来，但又怕回头忘了要整理什么，这才有了这个功能，
             *    因此不需要再问是不是想另起一条了。"
             * ⇒ **暂存 = 存进库里 + 立刻清空页面 + 直接开始下一条**。
             *
             * 顺带把"暂存后接着改"那条 PATCH 分支一起删了：那条路现在根本走不到，
             * 留着只会让下一个人以为"暂存条还能在录入页里接着改"（它其实在管理页改）。
             */
            const created = await apiClient.post<{ id?: string; code?: string; replaced?: boolean }>(
                "/api/insights",
                {
                    gradeSemester: gradeSemester || null,
                    subject: subject || null,
                    content,
                    // 有图就一起落库；没有就不传（服务端 `photo` 缺省 = 不动）
                    ...(photo ? { photo } : {}),
                    /** 【2026-10-19 第 3 条】"入版"跟着这条一起存 */
                    ...(photo ? { photoIncludedInPrint: photoIncluded } : {}),
                    /**
                     * 【2026-10-19 第 4 条】扫深挖纸/卷页链到的那道题。
                     * ⚠️ 必须带 `linkQuestion: true` —— 否则服务端会走"一题一条 ⇒ 覆盖"
                     *    那条老路，把这道题原来那条积累的正文**静默抹掉**。
                     */
                    ...(linkedItem ? { errorItemNo: linkedItem.no, linkQuestion: true } : {}),
                    /** 扫积累纸链到的那几条（一条可以多条） */
                    ...(linkedInsights.length > 0 ? { linkCodes: linkedInsights.map((l) => l.code) } : {}),
                    source: "page",
                    status,
                    // 日期由**客户端**算（容器跑 UTC，服务端算日子会差一天 —— 项目老规矩）
                    dateKey: dayKey(new Date()),
                },
            );
            if (status === "draft") {
                setNotice(L("已暂存（在管理页里标着「待整理」），可以直接记下一条。", "Saved as draft (marked in the manage page). Ready for the next one."));
                resetForNext();
            } else {
                setNotice(
                    L(
                        `已保存${created?.code ? `（${created.code}）` : ""}。可以接着写下一条了。`,
                        `Saved${created?.code ? ` (${created.code})` : ""}. Ready for the next one.`,
                    ),
                );
                resetForNext();
            }
            rememberPicks(gradeSemester, subject);
        } catch (e) {
            console.error(e);
            /**
             * 【2026-10-19 第 4 条】链的那道题**已经有积累了** ⇒ 服务端回 409。
             * 这句必须说清楚"为什么没存上"—— 否则她会以为软件坏了（内容明明在页面上）。
             */
            const status = (e as { status?: number })?.status;
            const detail = (e as { data?: { error?: string; message?: string } })?.data;
            if (status === 409) {
                setError(
                    detail?.error ||
                        detail?.message ||
                        L("这道题已经有积累了，一条积累只能链一道题。", "That question already has an entry."),
                );
            } else {
                setError(L("没存上，再试一次。", "Could not save. Try again."));
            }
        } finally {
            setBusy(null);
        }
    };

    /** 存完一条就清空，**接着写第二条**（这一页存在的意义就是"进门就记"） */
    const resetForNext = () => {
        setContent("");
        setPhoto(null);
        /** 下一条默认回到「入版」—— 不重置的话，上一条关了入版，新的一条也跟着关（界面与库不一致） */
        setPhotoIncluded(true);
        setUndoRaw(null);
        /** 【2026-10-19 第 4 条】链接是**这一条**的，下一条不能继承 */
        setLinkedItem(null);
        setLinkedInsights([]);
        editorRef.current?.setMarkdown("");
    };

    // ── 图片：拍照/相册 → 去底漂白 → 剪裁 → 缩在正文上方 ────────────
    /**
     * 剪裁页「确认」⇒ 按框把这一张拆成三块（2026-10-18 他定的那套）：
     *
     *   红框（印刷体）→ OCR → 正文里的**引文块**（别人说的话）
     *   蓝框（她手写）→ OCR → 正文里的**普通段落**（她自己的话）
     *   橙框（图）    → 直接当这条的**附图**，不进 OCR
     *
     * 一个框都没画 ⇒ 老行为：整张图当附图（他的原话："录入了图片，
     * 那个图片当然就是这条积累的附图"）。
     *
     * ⚠️ 画了橙框就**不留整图**：正文里已经有字了，再存一张同样的图只是重复。
     *    这正是他说的"其他打印和手写的内容就可以剔除掉了"。
     */
    const handleCropComplete = async (blob: Blob) => {
        setCropBusy(true);
        setError("");
        try {
            const dataUrl = await processImageFile(new File([blob], "insight.jpg", { type: "image/jpeg" }));
            const regions = regionsRef.current;

            /**
             * ⚠️ 这里**不能** `setCroppingImage(null)`：它是 `<ImageCropper>` 的开关条件，
             *    一清就把整块卸了 —— 下面读字那一两秒里界面会闪一下，
             *    而且"读失败留在原地重试"也就无从谈起。
             *    只关 `open`（下面 `setIsCropperOpen(false)`）；图等在下次打开时被覆盖。
             */

            // 没画框（或只有一张空白图）：整图当附图，不折腾
            if (!regions || regions.boxes.length === 0) {
                setPhoto(dataUrl);
                setIsCropperOpen(false);
                return;
            }

            const plan = planInsightSource(regions);
            const crops = await cutInsightCrops(dataUrl, plan);

            /**
             * 读字。**失败只提示、不中断** —— 图已经拍好了，
             * 不能因为一次读不出来就把整张图也丢了（她还能自己照着打）。
             */
            if (crops.printed || crops.handwritten) {
                try {
                    const res = await apiClient.post<{ printed?: string; handwritten?: string; subject?: string | null }>(
                        "/api/insights/ocr",
                        {
                            ...(crops.printed ? { printed: crops.printed } : {}),
                            ...(crops.handwritten ? { handwritten: crops.handwritten } : {}),
                        },
                    );
                    const parts: string[] = [];
                    // 书上的话进引文块，她的话进正文 —— 这个区分就是"红框/蓝框"的全部意义
                    if (res?.printed) parts.push(toQuoteBlock(res.printed));
                    if (res?.handwritten) parts.push(res.handwritten.trim());
                    if (parts.length > 0) {
                        const next = [content.trim(), ...parts].filter(Boolean).join("\n\n");
                        setContent(next);
                        editorRef.current?.setMarkdown(next);
                    }
                    /** 【2026-10-19 第 2 条】画框读字这一步也判了学科 —— 只在空着时填（理由同 `runOcr`） */
                    applyAiSubject(res?.subject, false);
                } catch (e) {
                    console.error(e);
                    setError(L("字没读出来（图已经存下了），可以照着打。", "Could not read the text (photo saved). You can type it."));
                }
            }

            // 附图：有橙框就只要橙框那块；没橙框就整图
            const figure = crops.figure ?? (plan.photoCrop ? null : dataUrl);
            if (figure) {
                setPhoto(figure);
            }

            setIsCropperOpen(false);
        } catch (e) {
            console.error(e);
            // 失败**不关剪裁页**：她修了半天的图不能因为一次读不出来就丢了
            setError(L("这张图读不出来，换一张试试。", "Could not read that image."));
        } finally {
            setCropBusy(false);
        }
    };

    const removePhoto = () => {
        if (croppingImage) URL.revokeObjectURL(croppingImage);
        setCroppingImage(null);
        setPhoto(null);
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
    /** 学科 key → 中文标签（提示语里要用） */
    const subjectLabel = (key: string) => SUBJECT_OPTIONS.find((s) => s.key === key)?.label ?? key;

    /**
     * 【2026-10-19 空空第 2 条】把 AI 判出的学科落到界面上。
     *
     * @param aiSubject AI 给的 key（认不出就是 null）
     * @param mayOverwrite `true` = 与已选不一致就**改掉**（整理那一步）；
     *                     `false` = **只在空着时填**（读字那一步，见 `runOcr` 的说明）
     *
     * ⚠️ 定义在 `runOcr` **之前**：`runOcr` 要调它（先声明后使用）。
     */
    const applyAiSubject = (aiSubject: string | null | undefined, mayOverwrite: boolean) => {
        const target = mayOverwrite ? nextSubjectByAi(subject, aiSubject) : (!subject && aiSubject ? nextSubjectByAi("", aiSubject) : null);
        if (!target) return;
        setSubject(target);
        setNotice((prev) =>
            prev
                ? L(`${prev}（学科按内容改成了「${subjectLabel(target)}」）`, `${prev} (subject set to ${subjectLabel(target)})`)
                : L(`学科按内容改成了「${subjectLabel(target)}」`, `Subject set to ${subjectLabel(target)}`),
        );
    };

    const runOcr = async (blob: Blob) => {
        if (ocrBusy) return;
        setOcrBusy(true);
        setError("");
        setNotice("");
        try {
            const dataUrl = await processImageFile(new File([blob], "ocr.jpg", { type: "image/jpeg" }));
            const res = await apiClient.post<{ text?: string; subject?: string | null }>("/api/insights/ocr", { image: dataUrl });
            const text = (res?.text ?? "").trim();
            if (!text) throw new Error("empty");
            const next = content.trim() ? `${content.trim()}\n\n${text}` : text;
            setContent(next);
            editorRef.current?.setMarkdown(next);
            /**
             * 【2026-10-19 第 2 条】**只在学科还空着时填**。
             *
             * 为什么读字这一步不覆盖已有学科：它只看到**半张图**（印刷体那一块），
             * 不足以说"明显不一致"—— 用半张图去改她已经选好的学科，是拿弱证据推翻强证据。
             * 覆盖留给「整理」那一步（它看到完整正文）。
             *
             * ⚠️ 顺序：先写主提示再追加（`applyAiSubject` 用函数式更新读 prev）。
             */
            setNotice(L("照片上的字已经抄进正文，可以自己改。", "Text pulled into the note — edit as you like."));
            applyAiSubject(res?.subject, false);
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
        // 上一张图的框绝不能留到这一张（坐标换了，框还在 = 不报错只裁歪）
        regionsRef.current = null;
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
            const res = await apiClient.post<{ note?: string; subject?: string | null }>("/api/insights/ai", {
                content,
                subject: subject || null,
            });
            const note = (res?.note ?? "").trim();
            if (!note) throw new Error("empty");
            setUndoRaw(content);
            setContent(note);
            editorRef.current?.setMarkdown(note);
            /**
             * ⚠️ 顺序：先写主提示，再让 `applyAiSubject` 追加 —— 它用的是**函数式更新**
             *    （`setNotice(prev => …)`），会读到刚写进去的那句；反过来会被覆盖掉。
             */
            setNotice(L("整理好了，已经填进正文 —— 可以直接改，也可以撤回原样。", "Tidied into the note. Edit it, or restore your original."));
            /**
             * 【2026-10-19 第 2 条】**整理这一步可以覆盖已选学科** ——
             * 它看到的是完整正文（不是半张图），才谈得上"明显不一致"。
             */
            applyAiSubject(res?.subject, true);
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
    }, [content, busy, gradeSemester, subject, photo, photoIncluded]);

    /** 正在写、又直接关页面 ⇒ 拦一下（写下来的东西不能无声丢掉） */
    useEffect(() => {
        if (!hasSomething) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [hasSomething]);

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
                    {/**
                     * 【2026-10-19 第 4 条】扫一扫 —— 摆在暂存左边（他指定的位置）。
                     * 扫深挖纸 ⇒ 直接链那道题；扫卷/积累纸 ⇒ 本页摊开那张纸，点哪条链哪条。
                     */}
                    <Button
                        variant="outline"
                        size="icon"
                        disabled={!!busy}
                        title={L(
                            "扫码链接：扫深挖纸的题号，或复练/模仿卷、积累纸的页码",
                            "Scan to link a question or another entry",
                        )}
                        onClick={() => setScanOpen(true)}
                    >
                        <QrCode className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="outline"
                        size="icon"
                        disabled={!hasSomething || !!busy}
                        title={L("暂存（先存进库里，等你在管理页整理）", "Save as draft")}
                        onClick={() => void put("draft")}
                    >
                        {busy === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Inbox className="h-4 w-4" />}
                    </Button>
                    <Button
                        size="icon"
                        disabled={!hasSomething || !!busy}
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
                    {/**
                     * 【2026-10-19 手机版面第 2 批】**手机上一行放标签、一行放动作**。
                     *
                     * 三个动作用图标就够（`hidden sm:inline` 藏文字），但挤在两个下拉标签旁边时，
                     * 手机上一行会贴得很紧、还容易被挤到第三行去。
                     * ⇒ 整组在 `sm` 以下 `w-full`（强制换行）+ 贴右 + 上面一条细线，
                     *    与日积月累·管理页顶栏是同一套写法（同一批规则，别两处不一样）。
                     */}
                    <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end max-sm:border-t max-sm:pt-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!!busy || aiBusy}
                        title={L(
                            "拍照/相册。拍完能画框：红=书上的字，蓝=你写的，橙=图，绿=只要这一块",
                            "Photo. Then draw boxes: red = printed, blue = your writing, orange = picture, green = only this part",
                        )}
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
                                "这条的附图（一条最多一张）。点图能放大看。画了橙框就只留橙框里那块。",
                                "Attached picture (one per note). Click to enlarge. With an orange box, only that part is kept.",
                            )}
                        </p>
                        {/**
                         * 【2026-10-19 第 3 条】「入版」开关 —— 录入的时候就能定这张图印不印。
                         * 缺省「入版」；点一下变「不入版」（图还在，只是这一版纸不排它）。
                         * 与"去掉这张图"是两件事：那个是**删图**，这个是**不印**。
                         */}
                        <button
                            type="button"
                            onClick={() => setPhotoIncluded((v) => !v)}
                            title={
                                photoIncluded
                                    ? L("入版中：组积累纸时会带上这张图（点一下改成不带）", "In print — click to exclude it")
                                    : L("未入版：组积累纸时不带这张图，图仍在库里（点一下恢复）", "Not printed — the photo is still kept")
                            }
                            className={`shrink-0 rounded border px-2 py-1 text-xs hover:bg-accent ${photoIncluded ? "text-emerald-600" : "text-muted-foreground"}`}
                        >
                            {photoIncluded ? L("入版 ✓", "In print ✓") : L("不入版", "Not printed")}
                        </button>
                        <Button variant="ghost" size="icon" onClick={removePhoto} title={L("去掉这张图", "Remove photo")}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                )}

                {/* ===== 【2026-10-19 第 4 条】已链接的东西（有才出现）===== */}
                {(linkedItem || linkedInsights.length > 0) && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs">
                        <span className="flex items-center gap-1 text-muted-foreground">
                            <Link2 className="h-3.5 w-3.5" />
                            {L("这条链到了", "Linked to")}
                        </span>
                        {linkedItem && (
                            <span className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-2 py-0.5">
                                <span className="font-medium">{linkedItem.no}</span>
                                {linkedItem.text && <span className="truncate text-muted-foreground">{linkedItem.text}</span>}
                                <button
                                    type="button"
                                    className="shrink-0 text-muted-foreground hover:text-destructive"
                                    title={L("取消这个链接", "Unlink")}
                                    onClick={() => setLinkedItem(null)}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        )}
                        {linkedInsights.map((l) => (
                            <span key={l.code} className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-2 py-0.5">
                                <span className="font-medium">{l.code}</span>
                                {l.content && <span className="truncate text-muted-foreground">{l.content}</span>}
                                <button
                                    type="button"
                                    className="shrink-0 text-muted-foreground hover:text-destructive"
                                    title={L("取消这个链接", "Unlink")}
                                    onClick={() => setLinkedInsights((prev) => prev.filter((x) => x.code !== l.code))}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        ))}
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
                         * 【2026-10-13】「另起一条」—— **2026-10-19 起这个按钮不需要了**。
                         *
                         * 原来暂存会记住这条的 id（接着写 = 改它），所以得给一个明确的脱身按钮。
                         * 空空 2026-10-19 定了："暂存就是把内容赶快记下来……不需要再问是不是想另起一条了。"
                         * ⇒ 暂存**本身就是**另起一条（存完立刻清空），这条死结从根上没有了。
                         */}
                    </div>
                )}

                <p className="text-xs text-muted-foreground">
                    {L(
                        "提示：暂存 = 先扔进库里等整理（打印与内阁都看不见它），存完立刻空出这一页、直接记下一条；保存 = 正式内容。Ctrl/⌘ + S 也能保存。「拍字」只留文字，照片本身不留底。",
                        "Draft = parked in the library (hidden from printing and the cabinet) and the page clears itself for the next note. Save = final. Ctrl/⌘+S works too. “Read” keeps only the text, not the photo.",
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
                    analyzing={cropBusy}
                    onClose={() => {
                        setIsCropperOpen(false);
                        setCroppingImage(null);
                        regionsRef.current = null;
                    }}
                    onCropComplete={handleCropComplete}
                    /**
                     * 框坐标：**ref 收**（见 regionsRef 的说明）。
                     * `scopeUnion`：日积月累里画几个绿框 = 一条积累的几段，
                     * 要**合并**，不能像错题那样切成好几条。
                     */
                    onCropRegions={(p) => {
                        regionsRef.current = p;
                    }}
                    scopeUnion
                />
            )}
            <ImageZoomViewer open={isViewerOpen} src={photo} onClose={() => setIsViewerOpen(false)} />

            {/* ===== 【2026-10-19 第 4 条】扫码链接 ===== */}
            <QrScanDialog open={scanOpen} onClose={() => setScanOpen(false)} onScanned={(code) => void handleQrCode(code)} />

            {/**
             * 扫到卷 / 积累纸的页二维码 ⇒ **在本页摊开那一张**（不跳走）。
             *
             * 为什么不跳 `/scan`：这一页上还有**没保存的正文**，一跳就没了。
             * 摊开的这两个组件就是 `/scan` 页用的同一个（`ScanVolumeView` / `InsightScanView`），
             * 点加号/圆圈的回调改成"链上并关掉"，其余一模一样 —— 不另写一套渲染。
             */}
            {pickedVolume && (
                <div className="fixed inset-0 z-50 overflow-auto bg-background">
                    <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
                        {pickedVolume.kind === "build" ? (
                            <InsightScanView
                                code={pickedVolume.code}
                                onPickItem={(insightCode) => void linkInsight(insightCode)}
                                onBack={() => setPickedVolume(null)}
                                backLabel={L("返回录入", "Back")}
                            />
                        ) : (
                            <ScanVolumeView
                                code={pickedVolume.code}
                                onPickItem={(item) => linkVolumeItem(item)}
                                onBack={() => setPickedVolume(null)}
                                backLabel={L("返回录入", "Back")}
                            />
                        )}
                    </div>
                </div>
            )}
        </main>
    );
}
