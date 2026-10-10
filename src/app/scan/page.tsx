"use client";

/**
 * 扫码页（#11 / T8）—— 纸面二维码回流系统。
 *
 * ── 2026-10-01 改版（他要的"扫码后的路径"）───────────────────────────
 * 以前：扫到题号 ⇒ 弹一个小框（题号/题目/难度 + 打印·看原题·已会·合并·删除）。
 * 现在按**扫到的是哪种二维码**分成两条路：
 *
 *   ① 扫到**深挖纸的题号码**（裸题号，如 `SX20260930001`）
 *      ⇒ 直接给出**这道题在错题本页里的错题卡**（同一份组件）+ 卡片下面
 *        **详情页复习结果那一栏的四行**；点卡片进详情页。
 *   ② 扫到**复练卷某一页的页码**（`RE20260930001-02`）
 *      ⇒ 打开这份卷的版面、**自动滚到扫到的那一页**，每道题罩天蓝框、中间蓝圆白加号；
 *        点加号 ⇒ 进 ① 那一屏（同一张错题卡 + 复习四行）。
 *   ③ 【2026-10-03 需求第 11 条】扫到**积累纸某一页的页码**（`BU20260930001-02`）
 *      ⇒ 打开这份积累纸的版面（`InsightScanView`，与 ② 同一套做法），每条积累罩一个框、
 *        中间一个"圆圈加号"（未关联错题 = 棕黄、关联了 = 紫；见 `lib/insight-plus.ts`）；
 *        点加号 ⇒ 去**日积月累页**选中这一条、并隐藏左栏。
 *      也就是说：扫深挖纸直达，扫复练卷/积累纸**中间多一步"从纸面上挑一条"**（他原话）。
 *
 * ── 三层返回是怎么做到的（这一条值得说清）─────────────────────────
 * 他要的是"从详情页退回错题卡、再从错题卡退回卷浏览"这种**层层后退**。
 * 实现上**不做内存里的栈**（刷新就没了），而是**把状态放进 URL**：
 *   `/scan?vol=RE…-02`            → 卷浏览
 *   `/scan?vol=RE…-02&item=<id>`  → 该题的错题卡（返回 = 去掉 item）
 *   点卡片进详情页时带上 `?back=<当前这串>`，详情页的返回键就回到这一屏。
 * 这样三层是三个真实的 URL，**刷新、浏览器后退、换设备都不会串**。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import jsQR from "jsqr";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api-client";
import type { ErrorItem } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { parsePageCode } from "@/lib/volume-code";
import { ScanItemPanel } from "@/components/scan-item-panel";
import { ScanVolumeView } from "@/components/scan-volume-view";
import { InsightScanView } from "@/components/insight-scan-view";
import { Camera, CameraOff, Loader2, Link2, ScanLine, Search } from "lucide-react";

interface ScanResponse {
    found: boolean;
    source: "main" | "trash" | null;
    item: ErrorItem | null;
}

type View = "scanner" | "volume" | "card";

export default function ScanPage() {
    const { language } = useLanguage();
    const zh = language === "zh";
    /**
     * 双语助手。⚠️ 用 `useCallback` 包一层：它是若干 `useCallback` 的依赖，
     *    每次渲染新建一个函数会让那些回调每轮都重建（eslint 会提醒，也确实没必要）。
     */
    const L = useCallback((a: string, b: string) => (zh ? a : b), [zh]);
    const router = useRouter();

    const [view, setView] = useState<View>("scanner");
    /** 卷浏览：纸上的页码码（卷号-页码） */
    const [volumeCode, setVolumeCode] = useState<string | null>(null);
    /** 错题卡：题 id + 这道题是从主库还是回收箱查出来的（H2/#12：界面底色不同） */
    const [itemId, setItemId] = useState<string | null>(null);
    const [itemSource, setItemSource] = useState<"main" | "trash">("main");

    const [scanning, setScanning] = useState(false);
    const [camError, setCamError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [manualNo, setManualNo] = useState("");
    const [missNo, setMissNo] = useState<string | null>(null);

    /**
     * 【2026-10-10】"给某道题找关联题"模式（他在"扫到的这道题"页点【关联别的题】→【打开扫码】）。
     *
     * 为什么放在这一页：**摄像头那套东西在这儿**（解码循环、video/canvas）。
     * 他明确要求"扫"必须用软件自己的扫码，而不是手机相机拍照 ——
     * 所以这一段就是"把扫码结果交给关联流程，而不是跳去看那张卡"。
     *   · `linkFromId` 非空 = 关联模式：扫到的题**不跳转**，而是问"挂到它下面？"
     *   · `linkFound`  = 扫到并查询成功的那道题（等他说"添加"）
     */
    const [linkFromId, setLinkFromId] = useState<string | null>(null);
    const [linkFromNo, setLinkFromNo] = useState<string>("");
    const [linkFound, setLinkFound] = useState<{
        id: string;
        no: string;
        text: string;
    } | null>(null);
    const [linkScanBusy, setLinkScanBusy] = useState(false);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    /** 停扫：释放摄像头与解码定时器 */
    const stopScan = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setScanning(false);
    }, []);

    /**
     * 地址栏跟着状态一起变。
     * ⚠️ 用 `replaceState` 而不是路由跳转：层与层之间用**页面上的返回键**走（他描述的就是这个手感），
     *    不用把浏览器历史塞满；而且这三屏本来就是同一个页面。
     */
    const syncUrl = useCallback(
        (next: { vol?: string | null; item?: string | null; src?: "main" | "trash" }) => {
            const qs = new URLSearchParams();
            const vol = next.vol === undefined ? volumeCode : next.vol;
            const item = next.item === undefined ? itemId : next.item;
            if (vol) qs.set("vol", vol);
            if (item) {
                qs.set("item", item);
                qs.set("src", next.src ?? itemSource);
            }
            window.history.replaceState(null, "", `/scan${qs.toString() ? `?${qs.toString()}` : ""}`);
        },
        [volumeCode, itemId, itemSource],
    );

    /** 打开"某道题的错题卡"这一屏 */
    const openCard = useCallback(
        (id: string, source: "main" | "trash", keepVolume = true) => {
            stopScan();
            setItemId(id);
            setItemSource(source);
            setView("card");
            syncUrl({ item: id, src: source, vol: keepVolume ? volumeCode : null });
        },
        [stopScan, syncUrl, volumeCode],
    );

    /** 打开"复练卷浏览"这一屏 */
    const openVolume = useCallback(
        (code: string) => {
            stopScan();
            setVolumeCode(code);
            setItemId(null);
            setView("volume");
            syncUrl({ vol: code, item: null });
        },
        [stopScan, syncUrl],
    );

    /** 回到扫码（把两层都清掉） */
    const backToScanner = useCallback(() => {
        setView("scanner");
        setVolumeCode(null);
        setItemId(null);
        syncUrl({ vol: null, item: null });
    }, [syncUrl]);

    /** 错题卡 → 上一层（有卷就回卷，没卷就回扫码） */
    const backFromCard = useCallback(() => {
        if (volumeCode) {
            setItemId(null);
            setView("volume");
            syncUrl({ item: null });
        } else {
            backToScanner();
        }
    }, [volumeCode, backToScanner, syncUrl]);

    /** 查库：先主库、后回收箱（顺序由 /api/scan 内部保证） */
    const lookupQuestion = useCallback(
        async (rawNo: string) => {
            const no = rawNo.trim().toUpperCase();
            if (!no) return;
            stopScan();
            setMissNo(null);
            setBusy("lookup");
            try {
                const res = await apiClient.get<ScanResponse>(`/api/scan?no=${encodeURIComponent(no)}`);
                if (!res.found || !res.item) {
                    setMissNo(no);
                    return;
                }
                openCard(res.item.id, res.source === "trash" ? "trash" : "main");
            } catch (error) {
                console.error(error);
                alert(L("查询失败", "Lookup failed"));
            } finally {
                setBusy(null);
            }
        },
        [L, openCard, stopScan],
    );

    /* ===== 【2026-10-10】"给某道题找关联题"：扫到的题**不跳转**，而是问要不要挂上去 ===== */

    /**
     * 关联模式下扫到一道题：**只查询、不跳转**，把结果交给"要不要挂上去"那个小窗。
     * ⚠️ 与 `lookupQuestion` 的区别就只有这一句"不跳转" —— 所以他扫完还能接着扫第二道。
     */
    const lookupForLink = useCallback(
        async (rawNo: string) => {
            const no = rawNo.trim().toUpperCase();
            if (!no) return;
            stopScan();
            setBusy("lookup");
            try {
                const res = await apiClient.get<ScanResponse>(`/api/scan?no=${encodeURIComponent(no)}`);
                if (!res.found || !res.item) {
                    alert(
                        L(
                            "错题本里没找到这道题（它可能还没录入，或者扫的不是题的码）。",
                            "Not found in the notebook.",
                        ),
                    );
                    return;
                }
                if (res.item.id === linkFromId) {
                    alert(L("这就是当前这道题，不用和自己关联。", "That is the same question."));
                    return;
                }
                const text = (res.item.questionText || "").replace(/\s+/g, " ").trim();
                setLinkFound({
                    id: res.item.id,
                    no: res.item.source || res.item.id,
                    text: text.length > 60 ? `${text.slice(0, 60)}…` : text,
                });
            } catch (error) {
                console.error(error);
                alert(L("查询失败", "Lookup failed"));
            } finally {
                setBusy(null);
            }
        },
        [L, linkFromId, stopScan],
    );

    /** 从"扫到的这道题"页进来：回到扫码屏，并记住"给哪道题找关联" */
    const startLinkScan = useCallback(
        (id: string, no: string) => {
            setLinkFromId(id);
            setLinkFromNo(no);
            setLinkFound(null);
            setView("scanner");
            syncUrl({ vol: null, item: null });
        },
        [syncUrl],
    );

    /** 不找了：退回刚才那道题的卡 */
    const cancelLinkScan = useCallback(() => {
        setLinkFromId(null);
        setLinkFound(null);
        if (itemId) setView("card");
    }, [itemId]);

    /**
     * 确认"把扫到的这道题挂上去"。
     * ⚠️ 两边各自都已经是一组题的主题时，规则返回 `choice` ⇒ 问一句并**推荐当前这道题当主题**，
     *    选"是"就带 `chooseRootId` 重发（对方整组接过来）。
     */
    const confirmLink = useCallback(
        async (chooseRootId?: string): Promise<void> => {
            if (!linkFound || !linkFromId) return;
            setLinkScanBusy(true);
            try {
                const res = await apiClient.post<{
                    ok: boolean;
                    message?: string;
                    choice?: { candidates: { id: string; no: string }[]; recommended: string };
                }>("/api/error-items/link", {
                    action: "link",
                    child: linkFound.id,
                    target: linkFromId,
                    ...(chooseRootId ? { chooseRootId } : {}),
                });

                if (res.choice) {
                    const ok = window.confirm(
                        L(
                            "这两道题各自都已经是一组题的主题了。\n让当前这道题当主题、把对方那一组一起接过来？（点取消 = 什么都不做）",
                            "Both are already main questions. Make the current one the main question and take over the other group?",
                        ),
                    );
                    if (ok) await confirmLink(linkFromId);
                    return;
                }
                if (!res.ok) {
                    alert(res.message || L("没有关联成功", "Could not link"));
                    return;
                }
                /** 挂上了：把那道卡放回来，让他看见角标已经变了 */
                alert(res.message || L("已关联", "Linked"));
                setLinkFound(null);
                setLinkFromId(null);
                setView("card");
            } catch (error) {
                console.error(error);
                alert(L("没有关联成功", "Could not link"));
            } finally {
                setLinkScanBusy(false);
            }
        },
        [L, linkFound, linkFromId],
    );

    /**
     * 扫到东西了：**先看是不是卷页码，再当题号查**。
     * 两条路互不干扰（卷页码形如 `RE…-02`、题号是 `SX…`）—— 先试 `parsePageCode`、
     * 不中再走题号（见 `lib/volume-code.ts` 里那段说明）。
     * 【2026-10-10】开头多一层"关联模式"判断：那是"给某道题找关联题"时，
     * 扫到的题**只查询、不跳转**（他要求："扫到题 B，点添加，就挂到题 A 下面"）。
     */
    const handleScanned = useCallback(
        (raw: string) => {
            const code = raw.trim().toUpperCase();
            if (!code) return;
            /**
             * 【2026-10-10】关联模式优先：扫到的题**不跳去看那张卡**，而是问"要不要挂上去"。
             * ⚠️ 扫到卷页码在这儿没用（卷不是题）⇒ 明确说一句，别让他以为扫坏了还在那儿反复扫。
             */
            if (linkFromId) {
                if (parsePageCode(code)) {
                    stopScan();
                    alert(
                        L(
                            "这是卷的二维码，不是题的。请扫那道题纸上的题号码。",
                            "That's a volume code — scan the question's own code instead.",
                        ),
                    );
                    return;
                }
                void lookupForLink(code);
                return;
            }
            if (parsePageCode(code)) {
                openVolume(code);
                return;
            }
            lookupQuestion(code);
        },
        [L, linkFromId, lookupForLink, lookupQuestion, openVolume, stopScan],
    );

    /** 解码：每 250ms 取一帧交给 jsQR（纯 JS，任何浏览器可跑；比 rAF 省电） */
    const startDecodeLoop = useCallback(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) return;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(image.data, image.width, image.height, {
                inversionAttempts: "dontInvert",
            });
            // 扫到即停（`handleScanned` 会 stopScan）
            if (code?.data) handleScanned(code.data);
        }, 250);
    }, [handleScanned]);

    const startScan = useCallback(async () => {
        setCamError(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" },
                audio: false,
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setScanning(true);
            startDecodeLoop();
        } catch (error) {
            console.error(error);
            setCamError(
                L(
                    "打不开摄像头。可以检查浏览器授权，或用下面的「手动输入」。",
                    "Cannot open camera. Check permission, or type the code below.",
                ),
            );
            setScanning(false);
        }
    }, [L, startDecodeLoop]);

    useEffect(() => () => stopScan(), [stopScan]);

    /**
     * 进来时**先看地址栏**有没有 vol / item：有就直接进那一屏。
     * 这一步就是三层返回能成立的关键（从详情页退回来时，URL 里带着 `item=`）。
     */
    useEffect(() => {
        const qs = new URLSearchParams(window.location.search);
        const vol = qs.get("vol");
        const item = qs.get("item");
        if (vol) setVolumeCode(vol);
        if (item) {
            setItemId(item);
            setItemSource(qs.get("src") === "trash" ? "trash" : "main");
            setView("card");
        } else if (vol) {
            setView("volume");
        }
    }, []);

    /** 当前这一屏的 URL（给详情页的 `?back=` 用） */
    const currentUrl = (() => {
        const qs = new URLSearchParams();
        if (volumeCode) qs.set("vol", volumeCode);
        if (itemId) {
            qs.set("item", itemId);
            qs.set("src", itemSource);
        }
        return `/scan${qs.toString() ? `?${qs.toString()}` : ""}`;
    })();

    // ===================== 层二 / 层三 =====================

    if (view === "card" && itemId) {
        return (
            <main className="min-h-screen p-4 md:p-8 bg-background">
                <div className="max-w-3xl mx-auto space-y-5">
                    <h1 className="flex items-center gap-2 text-xl font-bold">
                        <ScanLine className="h-5 w-5" />
                        {L("扫到的这道题", "Scanned question")}
                    </h1>
                    <ScanItemPanel
                        itemId={itemId}
                        source={itemSource}
                        onBack={backFromCard}
                        backLabel={volumeCode ? L("回到复练卷", "Back to volume") : L("回到扫码", "Back to scanner")}
                        backTo={currentUrl}
                        /** 【2026-10-10】他要的"扫"：**走软件自己的扫码**（不是手机相机拍照） */
                        onScanForLink={(currentNo) => startLinkScan(itemId, currentNo)}
                    />
                </div>
            </main>
        );
    }

    if (view === "volume" && volumeCode) {
        /**
         * 【2026-10-03 需求第 11 条】卷分两种：复练卷（`RE…`）与**积累纸**（`BU…`）。
         * `parsePageCode` 两种代号都认，所以扫到积累纸的页二维码本来就会走到这一屏 ——
         * 只是以前不管哪种卷都拿 `ReviewSheet`（题块）渲染，积累纸的条目就画错了。
         * 这里按**卷号里的代号**分流：积累纸走 `InsightScanView`（画框 + 圆圈加号那套）。
         */
        const isBuild = parsePageCode(volumeCode)?.kind === "build";
        return (
            <main className="min-h-screen bg-background p-4 md:p-6">
                <div className="mx-auto w-full max-w-6xl space-y-4">
                    <h1 className="flex items-center gap-2 text-xl font-bold">
                        <ScanLine className="h-5 w-5" />
                        {isBuild ? L("扫到的积累纸", "Scanned takeaway sheet") : L("扫到的复练卷", "Scanned volume")}
                    </h1>
                    {isBuild ? (
                        <InsightScanView
                            code={volumeCode}
                            /* 点圆圈 ⇒ 日积月累页、选中该条、隐藏左栏；返回键回到**这一屏**
                               （`back=` 带的是当前这条 URL，日积月累页照抄 error-items 的站内校验）。 */
                            onPickItem={(insightCode) =>
                                router.push(
                                    `/insights?pick=${encodeURIComponent(insightCode)}&noleft=1&back=${encodeURIComponent(currentUrl)}`,
                                )
                            }
                            onBack={backToScanner}
                        />
                    ) : (
                        <ScanVolumeView
                            code={volumeCode}
                            onPickItem={(item) => openCard(item.id, "main", true)}
                            onBack={backToScanner}
                        />
                    )}
                </div>
            </main>
        );
    }

    // ===================== 层一：扫码 =====================

    return (
        <main className="min-h-screen p-4 md:p-8 bg-background">
            <div className="max-w-3xl mx-auto space-y-5">
                <div className="flex items-start gap-4">
                    <BackButton fallbackUrl="/" />
                    <div className="flex-1 space-y-1">
                        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
                            <ScanLine className="h-6 w-6" />
                            {L("扫一扫", "Scan")}
                        </h1>
                        <p className="text-muted-foreground text-sm sm:text-base">
                            {L(
                                "扫深挖纸上的题号码 ⇒ 直接出这道题的卡；扫复练卷某一页的码 ⇒ 先看卷、再点题目中间的加号选一道题。",
                                "Scan a question code on a deep-dive sheet, or a page code on a review volume.",
                            )}
                        </p>
                    </div>
                </div>

                {/* 【2026-10-10】关联模式提示条：正在为某道题找关联题（他点的【关联别的题】→【打开扫码】） */}
                {linkFromId && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
                        <span className="flex items-center gap-2">
                            <Link2 className="h-4 w-4" />
                            {L(
                                `正在为「${linkFromNo || "当前这道题"}」找关联题：扫那道题纸上的题号码`,
                                `Finding a question to attach to ${linkFromNo || "the current one"} — scan its code`,
                            )}
                        </span>
                        <Button variant="outline" size="sm" onClick={cancelLinkScan}>
                            {L("取消", "Cancel")}
                        </Button>
                    </div>
                )}

                {/* ===== 摄像头区 ===== */}
                <div className="relative rounded-lg overflow-hidden border bg-black aspect-[4/3]">
                    <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
                    <canvas ref={canvasRef} className="hidden" />

                    {scanning && (
                        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                            <div className="w-56 h-56 border-2 border-white/80 rounded-lg" />
                        </div>
                    )}

                    {!scanning && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/90 p-6 text-center">
                            {camError ? (
                                <>
                                    <CameraOff className="h-10 w-10" />
                                    <p className="text-sm max-w-md">{camError}</p>
                                </>
                            ) : (
                                <>
                                    <Camera className="h-10 w-10" />
                                    <Button onClick={startScan} variant="secondary">
                                        {L("打开摄像头开始扫", "Open camera")}
                                    </Button>
                                </>
                            )}
                        </div>
                    )}

                    {busy === "lookup" && (
                        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-black/60 py-2 text-sm text-white">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {L("正在查…", "Looking up…")}
                        </div>
                    )}
                </div>

                <div className="flex flex-wrap gap-2">
                    {scanning ? (
                        <Button variant="outline" onClick={stopScan}>
                            <CameraOff className="mr-1.5 h-4 w-4" />
                            {L("停止扫描", "Stop")}
                        </Button>
                    ) : (
                        <Button onClick={startScan}>
                            <Camera className="mr-1.5 h-4 w-4" />
                            {L("开始扫描", "Start")}
                        </Button>
                    )}
                </div>

                {/* 手动输入兜底：摄像头不可用、码磨损、光线差时不至于卡死 */}
                <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-sm text-muted-foreground">
                        {L(
                            "摄像头用不了？手动输入纸上的编码（题号，或卷上那一页的页码）。",
                            "Camera not working? Type the code printed on the paper.",
                        )}
                    </p>
                    <div className="flex gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                className="pl-8 font-mono"
                                placeholder={L(
                                    "如 SX20260930001 或 RE20260930001-02",
                                    "e.g. SX20260930001 / RE20260930001-02",
                                )}
                                value={manualNo}
                                onChange={(e) => setManualNo(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") handleScanned(manualNo);
                                }}
                            />
                        </div>
                        <Button
                            onClick={() => handleScanned(manualNo)}
                            disabled={!manualNo.trim() || busy === "lookup"}
                        >
                            {L("查", "Go")}
                        </Button>
                    </div>
                    {missNo && (
                        <p className="text-sm text-rose-600">
                            {L(`没查到这个编码：${missNo}`, `Not found: ${missNo}`)}
                        </p>
                    )}
                </div>

                {/* 顺手留个口子：手机上没键盘，翻卷去那一页看更省事 */}
                <div className="text-center">
                    <Button variant="ghost" size="sm" onClick={() => router.push("/review-volumes")}>
                        {L("或者：去复练卷页翻一翻", "Or browse all volumes")}
                    </Button>
                </div>

                {/* 【2026-10-10】扫到题了：问一句要不要挂上去。
                    ⚠️ **不自动挂** —— 对方若本身就是一组题的主题，它整组都会被接过来，
                       这种事得他点头（规则层也会把这种情况回成 `choice`）。 */}
                {linkFound && (
                    <Dialog
                        open
                        onOpenChange={(open) => {
                            if (!open) setLinkFound(null);
                        }}
                    >
                        <DialogContent className="max-w-md">
                            <DialogHeader>
                                <DialogTitle>{L("把这道题挂上去？", "Attach this question?")}</DialogTitle>
                                <DialogDescription>
                                    {L(
                                        `将挂到「${linkFromNo || "当前这道题"}」下面（它当主题）。`,
                                        `It will attach to ${linkFromNo || "the current question"} as the main one.`,
                                    )}
                                </DialogDescription>
                            </DialogHeader>
                            <div className="rounded-md border p-3 text-sm">
                                <div className="font-medium">{linkFound.no}</div>
                                <p className="mt-1 text-xs text-muted-foreground">{linkFound.text}</p>
                            </div>
                            <DialogFooter>
                                <Button
                                    variant="outline"
                                    onClick={() => setLinkFound(null)}
                                    disabled={linkScanBusy}
                                >
                                    {L("取消", "Cancel")}
                                </Button>
                                <Button onClick={() => confirmLink()} disabled={linkScanBusy}>
                                    {linkScanBusy ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Link2 className="mr-2 h-4 w-4" />
                                    )}
                                    {L("添加到本题", "Attach")}
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                )}
            </div>
        </main>
    );
}
