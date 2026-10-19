"use client";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-10-19 空空第 4 条】**扫一扫**（只负责"扫出一个字符串"）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用在 `/insights/write`（进门就写那一页）顶栏：扫深挖纸的题号、复练/模仿卷的页码、
 * 积累纸的页码，把这条积累和那道题（或那条积累）**链起来**。
 *
 * ── 与 `/scan` 页的关系（为什么这里又有一份解码循环）──────────────────
 * `/scan` 是一个 **724 行的业务页**（扫到卷 → 打开卷页；扫到题 → 打开错题卡；
 * 还有"给某道题找关联题"那一整套）。它把"解码"和"业务"焊在一个组件里。
 *
 * 录入页要的只是**第一步**（解码），后面的业务完全不同（链接到一条还没保存的积累）。
 * 直接把 `/scan` 搬过来会带来两个问题：
 *   ① 它会 `router.push` 跳走 —— 而录入页上**还有没保存的正文**，跳走就没了；
 *   ② 改 `/scan` 去支持"链接模式"要动那条已经在用的核心链路（扫码回录），
 *      风险远大于收益。
 * ⇒ 所以这里只抽**解码**这一小段（约 60 行），业务判断全部留给调用方。
 * ⚠️ 两份解码循环的行为必须一致（250ms 一帧、`dontInvert`）—— 改一处要想到另一处。
 *
 * ── 三个必须做对的细节 ────────────────────────────────────────────────
 *  ① **打开就起摄像头**（他 2026-10-12 定过："跳出扫一扫页面时，调用摄像头总要点击一下
 *     按钮，这是不必要的"）；关掉就停，不能留一个后台亮着的摄像头。
 *  ② **同一个码不重复触发**：解码是每 250ms 一帧，同一个二维码会连着命中十几次。
 *     不拦的话上层会被弹十几次。
 *  ③ **手动输入兜底**：摄像头不可用、码磨损、光线差时不至于卡死（`/scan` 页也有）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { CameraOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";

export function QrScanDialog({
    open,
    onClose,
    onScanned,
}: {
    open: boolean;
    onClose: () => void;
    /** 扫到一个码（已经 `trim().toUpperCase()`）。上层负责判断它是题号还是卷页码 */
    onScanned: (code: string) => void;
}) {
    const { language } = useLanguage();
    /**
     * ⚠️ 这里用 `useCallback` 包住 `L`（项目里别处多是普通箭头函数）：
     *    它被 `startScan` 的依赖数组引用 ⇒ 不稳定的 `L` 会让 `startScan` 每次渲染重建
     *    ⇒ 那个"打开就起摄像头"的 effect 会跟着重跑（摄像头被反复关/开）。
     */
    const L = useCallback((a: string, b: string) => (language === "zh" ? a : b), [language]);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    /** 已经交出去的那个码 —— 同一帧里会反复命中，拦住它 */
    const lastCodeRef = useRef<string>("");

    const [camError, setCamError] = useState<string | null>(null);
    const [manualNo, setManualNo] = useState("");

    const stopScan = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
    }, []);

    const handleCode = useCallback(
        (raw: string) => {
            const code = (raw || "").trim().toUpperCase();
            if (!code || code === lastCodeRef.current) return;
            lastCodeRef.current = code;
            stopScan();
            onScanned(code);
        },
        [onScanned, stopScan],
    );

    const startScan = useCallback(async () => {
        lastCodeRef.current = "";
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" },
                audio: false,
            });
            /** ⚠️ 放在 `await` **之后**：这样打开弹层那一下不会同步 setState（见下面 effect 的说明） */
            setCamError(null);
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
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
                const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
                if (code?.data) handleCode(code.data);
            }, 250);
        } catch (error) {
            console.error(error);
            setCamError(
                L(
                    "打不开摄像头。可以检查浏览器授权，或用下面的「手动输入」。",
                    "Cannot open camera. Check permission, or type the code below.",
                ),
            );
        }
    }, [L, handleCode]);

    /** 打开就起摄像头、关掉就停（别留一个后台亮着的摄像头） */
    useEffect(() => {
        if (open) {
            /**
             * ⚠️ 这里**必须**在 effect 里起摄像头 —— 他 2026-10-12 明确要求过
             *    "跳出扫一扫页面时，调用摄像头总要点击一下按钮，这是不必要的"。
             *    规则（`react-hooks/set-state-in-effect`）担心的是同步 setState 引发级联渲染：
             *    这条路径上**唯一**的同步写是 else 分支那两个"清空"，只在关闭时发生一次；
             *    起摄像头那一支已经挪到 `await` 之后（见 `startScan`）。
             */
            // eslint-disable-next-line react-hooks/set-state-in-effect
            void startScan();
        } else {
            stopScan();
            setManualNo("");
            setCamError(null);
        }
        return () => stopScan();
    }, [open, startScan, stopScan]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4">
            <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3">
                <div className="flex items-center justify-between text-white">
                    <h2 className="text-base font-medium">{L("扫一扫", "Scan")}</h2>
                    <Button variant="ghost" size="icon" onClick={onClose} title={L("关闭", "Close")} className="text-white">
                        <X className="h-5 w-5" />
                    </Button>
                </div>

                <div className="relative flex-1 overflow-hidden rounded-lg bg-black">
                    <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                    <canvas ref={canvasRef} className="hidden" />
                    {camError && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-sm text-white">
                            <CameraOff className="h-10 w-10" />
                            <p>{camError}</p>
                        </div>
                    )}
                </div>

                {/* 手动输入兜底：摄像头不可用、码磨损、光线差时不至于卡死 */}
                <div className="rounded-lg bg-white/95 p-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                        {L(
                            "也可以手动输入纸上的编码（题号，或卷/积累纸那一页的页码）。",
                            "Or type the code printed on the paper.",
                        )}
                    </p>
                    <div className="flex gap-2">
                        <Input
                            className="font-mono"
                            placeholder={L("如 SX20260930001 或 RE20260930001-02", "e.g. SX20260930001 / RE20260930001-02")}
                            value={manualNo}
                            onChange={(e) => setManualNo(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") handleCode(manualNo);
                            }}
                        />
                        <Button onClick={() => handleCode(manualNo)} disabled={!manualNo.trim()}>
                            {L("确定", "Go")}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
