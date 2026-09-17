"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import jsQR from "jsqr";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { SubjectChip } from "@/components/subject-chip";
import { apiClient } from "@/lib/api-client";
import { ErrorItem } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    Printer,
    ExternalLink,
    Check,
    Trash2,
    Combine,
    X,
    Loader2,
    Camera,
    CameraOff,
    ScanLine,
    Minus,
    Plus,
    RotateCcw,
} from "lucide-react";

interface ScanResponse {
    found: boolean;
    source: "main" | "trash" | null;
    item: ErrorItem | null;
}

/**
 * 扫码交互（#11 / T8）—— 纸面二维码回流系统
 *
 * 链路：主页左上「扫一扫」→ 本页调摄像头 → 扫到题号 → **停扫** → 弹界面 → 6 功能。
 *
 * 6 功能（#11 定稿）：
 *   ① 打印（跳打印页，计数由打印页在真正点打印时 +1）
 *   ② 关注管理 1-5 档（G8：语义=难度档，+/- 调整，存后台供筛选）
 *   ③ 跳转原题详情
 *   ④ 已会（等同标已掌握，masteryLevel = 2）
 *   ⑤ 删题（确认后进回收箱，非彻底删）
 *   ⑥ 合并（#14 新增）
 *
 * 交互细节（蓝图明确要求）：
 *   - 「点关闭关；点其他处不消失，除非点跳转」→ 弹层不加遮罩点击关闭。
 *   - 「扫码先主库检索，无则启回收箱库检索，界面底色不同」→ 按 source 换底色。
 *
 * 实现说明：解码用 jsQR（纯 JS，任何浏览器可跑）；BarcodeDetector 依赖
 * Google Play Services，安卓设备不一定可用，故不采用。
 * 另加「手动输入题号」兜底：摄像头不可用、二维码磨损、光线差时不至于卡死。
 */
export default function ScanPage() {
    const { language } = useLanguage();
    const zh = language === "zh";
    const L = (a: string, b: string) => (zh ? a : b);
    const router = useRouter();

    const [scanning, setScanning] = useState(false);
    const [camError, setCamError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [manualNo, setManualNo] = useState("");
    const [missNo, setMissNo] = useState<string | null>(null);
    const [result, setResult] = useState<ScanResponse | null>(null);

    // #14 合并（手机端扫码）：攒够 2 道以上才能合并
    const [mergeMode, setMergeMode] = useState(false);
    const [mergeItems, setMergeItems] = useState<ErrorItem[]>([]);

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

    /** 查库：先主库、后回收箱（H2/#12 由 /api/scan 内部保证顺序） */
    const lookup = useCallback(
        async (rawNo: string, keepScanning = false) => {
            const no = rawNo.trim().toUpperCase();
            if (!no) return;
            if (!keepScanning) stopScan();
            setMissNo(null);
            setBusy("lookup");
            try {
                const res = await apiClient.get<ScanResponse>(
                    `/api/scan?no=${encodeURIComponent(no)}`,
                );
                if (!res.found || !res.item) {
                    setMissNo(no);
                    setResult(null);
                    return;
                }

                // 合并模式：把扫到的题攒起来（不可重复），继续扫下一道
                if (mergeMode) {
                    const item = res.item;
                    setMergeItems((prev) => {
                        if (prev.some((x) => x.id === item.id)) {
                            alert(L("这道题已经选过了", "Already selected"));
                            return prev;
                        }
                        return [...prev, item];
                    });
                    setResult(null);
                    if (keepScanning) return;
                    return;
                }

                setResult(res);
            } catch (error) {
                console.error(error);
                alert(L("查询失败", "Lookup failed"));
            } finally {
                setBusy(null);
            }
        },
        [L, mergeMode, stopScan],
    );

    /** 解码：每 250ms 取一帧交给 jsQR（比 requestAnimationFrame 省电、够灵敏） */
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
            if (code?.data) {
                // 扫到即停扫（蓝图：扫到题号特征 → 停扫）
                // 合并模式下不停，继续扫下一道
                lookup(code.data, mergeMode);
            }
        }, 250);
    }, [lookup, mergeMode]);

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
                    "打不开摄像头。可以检查浏览器授权，或用下面的「手动输入题号」。",
                    "Cannot open camera. Check permission, or type the question no. below.",
                ),
            );
            setScanning(false);
        }
    }, [L, startDecodeLoop]);

    useEffect(() => () => stopScan(), [stopScan]);

    /** ① 打印：跳打印页，计数在真正点「打印」时 +1（避免点了没打也计数） */
    const handlePrint = () => {
        const item = result?.item;
        if (!item) return;
        router.push(`/print-preview?ids=${item.id}&mode=card`);
    };

    /** ② 关注档 1-5（G8 难度档） */
    const handleAttention = async (next: number) => {
        const item = result?.item;
        if (!item) return;
        const clamped = Math.max(1, Math.min(5, next));
        setBusy("attention");
        try {
            await apiClient.put(`/api/error-items/${item.id}`, { attention: clamped });
            setResult((prev) =>
                prev?.item ? { ...prev, item: { ...prev.item, attention: clamped } } : prev,
            );
        } catch (error) {
            console.error(error);
            alert(L("调整失败", "Update failed"));
        } finally {
            setBusy(null);
        }
    };

    /** ③ 跳转原题详情（蓝图：点跳转时弹层可以消失） */
    const handleJump = () => {
        const item = result?.item;
        if (!item) return;
        setResult(null);
        router.push(`/error-items/${item.id}`);
    };

    /** ④ 已会 = 标已掌握（masteryLevel = 2） */
    const handleMastered = async () => {
        const item = result?.item;
        if (!item) return;
        if (!confirm(L(`${item.source || item.id} 标为「已会」？`, `Mark ${item.source || item.id} as mastered?`))) return;
        setBusy("mastered");
        try {
            await apiClient.patch(`/api/error-items/${item.id}/mastery`, { masteryLevel: 2 });
            setResult(null);
            alert(L("已标为已会", "Marked as mastered"));
        } catch (error) {
            console.error(error);
            alert(L("操作失败", "Failed"));
        } finally {
            setBusy(null);
        }
    };

    /** ⑤ 删题：进回收箱（软删，不是彻底删） */
    const handleDelete = async () => {
        const item = result?.item;
        if (!item) return;
        if (!confirm(L(`把 ${item.source || item.id} 删进回收箱？`, `Move ${item.source || item.id} to trash?`))) return;
        setBusy("delete");
        try {
            await apiClient.delete(`/api/error-items/${item.id}`);
            setResult(null);
            alert(L("已移入回收箱", "Moved to trash"));
        } catch (error) {
            console.error(error);
            alert(L("删除失败", "Delete failed"));
        } finally {
            setBusy(null);
        }
    };

    /** ⑥ 合并：进入合并模式，第 1 题先入库，然后继续扫下一道（#14） */
    const handleStartMerge = () => {
        const item = result?.item;
        if (!item) return;
        setMergeItems([item]);
        setMergeMode(true);
        setResult(null);
        // 合并模式下不停扫，继续扫下一道
        if (!scanning) startScan();
    };

    const handleConfirmMerge = async () => {
        if (mergeItems.length < 2) {
            alert(L("至少要有 2 道题才能合并", "Select at least 2 questions"));
            return;
        }
        setBusy("merge");
        try {
            const res = await apiClient.post<{ item: ErrorItem }>("/api/error-items/merge", {
                ids: mergeItems.map((x) => x.id),
            });
            alert(
                L(
                    `合并完成，新题号：${res.item.source || res.item.id}（原题已进回收箱）`,
                    `Merged. New no: ${res.item.source || res.item.id} (originals moved to trash)`,
                ),
            );
            setMergeMode(false);
            setMergeItems([]);
            stopScan();
        } catch (error) {
            console.error(error);
            alert(L("合并失败", "Merge failed"));
        } finally {
            setBusy(null);
        }
    };

    const cancelMerge = () => {
        setMergeMode(false);
        setMergeItems([]);
        setResult(null);
    };

    const item = result?.item;
    const isTrash = result?.source === "trash";
    // 回收箱里扫出来的题，界面底色不同（#12 明确要求）
    const tone = isTrash ? "rose" : "emerald";

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
                                "对准纸面左上角的二维码，扫到就停。扫到后可以打印、调难度、标已会、删题或合并。",
                                "Aim at the QR code on the paper. Once read, you can print, set difficulty, mark mastered, delete or merge.",
                            )}
                        </p>
                    </div>
                </div>

                {/* ===== 合并模式提示条 ===== */}
                {mergeMode && (
                    <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 space-y-2">
                        <div className="text-sm font-medium">
                            {L(
                                `合并中：已选 ${mergeItems.length} 道（继续扫下一道，或直接合并）`,
                                `Merging: ${mergeItems.length} selected (scan more, or merge now)`,
                            )}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {mergeItems.map((m) => (
                                <span
                                    key={m.id}
                                    className="inline-flex items-center gap-1.5 rounded border bg-background px-2 py-1 text-xs font-mono"
                                >
                                    <SubjectChip subjectKey={m.notebook?.subject} showLabel={false} />
                                    {m.source || m.id}
                                </span>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <Button size="sm" onClick={handleConfirmMerge} disabled={mergeItems.length < 2 || busy === "merge"}>
                                {busy === "merge" ? (
                                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                ) : (
                                    <Combine className="mr-1.5 h-4 w-4" />
                                )}
                                {L("合并这几道", "Merge")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={cancelMerge}>
                                {L("取消合并", "Cancel merge")}
                            </Button>
                        </div>
                    </div>
                )}

                {/* ===== 摄像头区 ===== */}
                <div className="relative rounded-lg overflow-hidden border bg-black aspect-[4/3]">
                    <video
                        ref={videoRef}
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                    />
                    <canvas ref={canvasRef} className="hidden" />

                    {/* 取景框 */}
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
                        <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-sm py-2 flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {L("正在查这道题…", "Looking up…")}
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
                            {L("重新扫描", "Scan again")}
                        </Button>
                    )}
                </div>

                {/* ===== 手动兜底：摄像头不可用 / 二维码磨损时用 ===== */}
                <div className="rounded-lg border p-3 space-y-2">
                    <div className="text-sm font-medium">
                        {L("手动输入题号（兜底）", "Type the question no. (fallback)")}
                    </div>
                    <div className="flex gap-2">
                        <input
                            value={manualNo}
                            onChange={(e) => setManualNo(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") lookup(manualNo, mergeMode);
                            }}
                            placeholder="SX20260916001"
                            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm font-mono uppercase"
                        />
                        <Button onClick={() => lookup(manualNo, mergeMode)} disabled={!manualNo.trim() || busy === "lookup"}>
                            {L("查询", "Look up")}
                        </Button>
                    </div>
                </div>

                {/* ===== 没找到 ===== */}
                {missNo && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                        {L(
                            `没找到题号 ${missNo}。可能是主库和回收箱里都没有，或题号扫错了。`,
                            `No match for ${missNo}. It may not exist in main or trash, or the no. is wrong.`,
                        )}
                    </div>
                )}

                {/* ===== 结果弹层（蓝图：点关闭关，点其他处不消失）===== */}
                {item && (
                    <div
                        className={`rounded-lg border-2 p-4 space-y-4 ${
                            isTrash
                                ? "border-rose-500/50 bg-rose-500/5"
                                : "border-emerald-500/50 bg-emerald-500/5"
                        }`}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <SubjectChip subjectKey={item.notebook?.subject} />
                                    <span className="font-mono font-semibold">{item.source || item.id}</span>
                                    {isTrash && (
                                        <span className="text-xs rounded bg-rose-500/20 text-rose-700 dark:text-rose-300 px-1.5 py-0.5">
                                            {L("在回收箱里", "in trash")}
                                        </span>
                                    )}
                                </div>
                                {item.notebook?.displayName && (
                                    <div className="text-sm text-muted-foreground">{item.notebook.displayName}</div>
                                )}
                            </div>
                            <Button size="icon" variant="ghost" onClick={() => setResult(null)} title={L("关闭", "Close")}>
                                <X className="h-5 w-5" />
                            </Button>
                        </div>

                        {item.questionText && (
                            <p className="text-sm text-muted-foreground line-clamp-3">{item.questionText}</p>
                        )}

                        {/* ② 关注档 1-5 */}
                        <div className="flex items-center gap-3 rounded-md border bg-background p-2.5">
                            <span className="text-sm">{L("关注档（难度）", "Attention (difficulty)")}</span>
                            <Button
                                size="icon"
                                variant="outline"
                                className="h-7 w-7"
                                disabled={busy === "attention" || (item.attention ?? 1) <= 1}
                                onClick={() => handleAttention((item.attention ?? 1) - 1)}
                            >
                                <Minus className="h-3.5 w-3.5" />
                            </Button>
                            <span className="font-semibold tabular-nums w-6 text-center">{item.attention ?? 1}</span>
                            <Button
                                size="icon"
                                variant="outline"
                                className="h-7 w-7"
                                disabled={busy === "attention" || (item.attention ?? 1) >= 5}
                                onClick={() => handleAttention((item.attention ?? 1) + 1)}
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </Button>
                            <span className="text-xs text-muted-foreground">
                                {L("1 容易 → 5 困难", "1 easy → 5 hard")}
                            </span>
                        </div>

                        {/* 6 功能 */}
                        <div className="grid grid-cols-2 gap-2">
                            <Button variant="outline" onClick={handlePrint}>
                                <Printer className="mr-1.5 h-4 w-4" />
                                {L("打印", "Print")}
                            </Button>
                            <Button variant="outline" onClick={handleJump}>
                                <ExternalLink className="mr-1.5 h-4 w-4" />
                                {L("看原题", "Open")}
                            </Button>
                            <Button variant="outline" onClick={handleMastered} disabled={busy === "mastered"}>
                                <Check className="mr-1.5 h-4 w-4" />
                                {L("已会", "Mastered")}
                            </Button>
                            <Button variant="outline" onClick={handleStartMerge}>
                                <Combine className="mr-1.5 h-4 w-4" />
                                {L("合并", "Merge")}
                            </Button>
                            <Button
                                variant="destructive"
                                className="col-span-2"
                                onClick={handleDelete}
                                disabled={busy === "delete"}
                            >
                                <Trash2 className="mr-1.5 h-4 w-4" />
                                {L("删题（进回收箱）", "Delete (to trash)")}
                            </Button>
                        </div>

                        {(item.printCount ?? 0) > 0 && (
                            <div className="text-xs text-muted-foreground">
                                {L(`已打印 ${item.printCount} 次`, `Printed ${item.printCount}×`)}
                            </div>
                        )}
                    </div>
                )}

                <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
                    <RotateCcw className="h-3.5 w-3.5" />
                    {L(
                        "扫到的题先查主库，主库没有才去回收箱找；回收箱里的题会用不同底色标出。",
                        "Lookup checks main first, then trash; items from trash use a different tone.",
                    )}
                </div>
            </div>
        </main>
    );
}
