"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { loadOpenCV } from "@/lib/cv-loader";
import {
  findPaperCorners,
  warpPerspective,
  enhanceMat,
  type Corners,
  type EnhanceMode,
} from "@/lib/doc-scan";
import { Button } from "@/components/ui/button";
import { Camera, Image as ImageIcon, RotateCcw, Check, Loader2 } from "lucide-react";

export interface DocScannerHandle {
  openCamera: () => void;
  openWithFile: (file: File) => void;
}

interface DocScannerProps {
  onScanComplete: (blob: Blob) => void;
  onClose: () => void;
}

const ENHANCE_LABEL: Record<EnhanceMode, string> = {
  original: "原色",
  white: "漂白",
  bw: "黑白",
};

export const DocScanner = forwardRef<DocScannerHandle, DocScannerProps>(
  function DocScanner({ onScanComplete, onClose }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const srcCanvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const previewRef = useRef<HTMLCanvasElement>(null);
    const cvRef = useRef<any>(null);
    const dragRef = useRef<keyof Corners | null>(null);

    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<"camera" | "review">("camera");
    const [camError, setCamError] = useState<string | null>(null);
    const [cvError, setCvError] = useState<string | null>(null);
    const [cvLoading, setCvLoading] = useState(false);
    // 默认「漂白」：底色干净最省墨，AI 识别率也最高
    const [enhance, setEnhance] = useState<EnhanceMode>("white");
    const [corners, setCorners] = useState<Corners | null>(null);
    const [detectFail, setDetectFail] = useState(false);
    const [busy, setBusy] = useState(false);
    const [videoReady, setVideoReady] = useState(false);
    // 实际拍到的像素——custom-v8 曾因没要分辨率只拍出 461×562，这里显示出来便于当场验证
    const [shotSize, setShotSize] = useState<string>("");

    const stopCamera = useCallback(() => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }, []);

    /**
     * 打开相机。
     * 【custom-v8 的第一个病根就在这里】v8 只写 { facingMode: "environment" } 没要分辨率，
     * 浏览器默认给 ~480p，12MP 的主摄只拍出 461×562。这里显式要 1920+ 并开连续对焦。
     */
    const startCamera = useCallback(async () => {
      setCamError(null);
      setVideoReady(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
            // 连续对焦：拍照前镜头会一直合焦，避免拍虚
            ...({ advanced: [{ focusMode: "continuous" }] } as any),
          },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          const t = stream.getVideoTracks()[0];
          const s = t?.getSettings?.();
          setVideoReady(true);
          if (s?.width && s?.height) {
            setShotSize(`相机流 ${s.width}×${s.height}`);
          }
        }
      } catch (e: any) {
        // 部分浏览器不接受 advanced 约束，降级为只要 facingMode
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          });
          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play();
            setVideoReady(true);
          }
        } catch (e2: any) {
          setVideoReady(false);
          setCamError(
            "无法打开相机：" +
              (e2?.message || "需通过 HTTPS 访问并授予相机权限，或改用相册。")
          );
        }
      }
    }, []);

    /** 把图片载入审核态，并自动找纸张四角 */
    const loadImgAndReview = useCallback(async (dataUrl: string, sizeNote?: string) => {
      setBusy(true);
      setDetectFail(false);
      setCorners(null);
      setCvError(null);
      const img = new Image();
      img.onload = async () => {
        imgRef.current = img;
        if (sizeNote) setShotSize(sizeNote);
        try {
          setCvLoading(true);
          const cv = await loadOpenCV();
          cvRef.current = cv;
          setCvLoading(false);
          const found = findPaperCorners(cv, img);
          if (found) {
            setCorners(found);
            setDetectFail(false);
          } else {
            setDetectFail(true);
          }
        } catch (err: any) {
          setCvError(err?.message || "图像处理模块加载失败");
        }
        setMode("review");
        setBusy(false);
      };
      img.onerror = () => {
        setCvError("图片加载失败");
        setBusy(false);
      };
      img.src = dataUrl;
    }, []);

    const openCamera = useCallback(() => {
      setOpen(true);
      setMode("camera");
      setVideoReady(false);
      setShotSize("");
      setEnhance("white");
      startCamera();
    }, [startCamera]);

    const openWithFile = useCallback(
      (file: File) => {
        setOpen(true);
        setShotSize("");
        setEnhance("white");
        const r = new FileReader();
        r.onload = () => loadImgAndReview(r.result as string);
        r.readAsDataURL(file);
      },
      [loadImgAndReview]
    );

    useImperativeHandle(ref, () => ({ openCamera, openWithFile }), [
      openCamera,
      openWithFile,
    ]);

    useEffect(() => {
      if (!open) stopCamera();
      return () => stopCamera();
    }, [open, stopCamera]);

    /**
     * 抓帧。优先用 ImageCapture.takePhoto() 拿相机全分辨率静帧（比 video 流清晰），
     * 不支持时回退到 canvas 抓 video 当前帧。
     */
    const captureFrame = useCallback(async () => {
      const v = videoRef.current;
      if (!v || !v.videoWidth || !videoReady) return;
      const track = streamRef.current?.getVideoTracks()[0];

      let dataUrl = "";
      let w = v.videoWidth;
      let h = v.videoHeight;

      // @ts-ignore ImageCapture 尚未进入所有 TS DOM 类型
      if (track && typeof window !== "undefined" && (window as any).ImageCapture) {
        try {
          // @ts-ignore
          const cap = new (window as any).ImageCapture(track);
          const blob = await cap.takePhoto();
          const bmp = await createImageBitmap(blob);
          w = bmp.width;
          h = bmp.height;
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          c.getContext("2d")!.drawImage(bmp, 0, 0);
          dataUrl = c.toDataURL("image/jpeg", 0.95);
          bmp.close?.();
        } catch {
          dataUrl = ""; // 回退到抓帧
        }
      }

      if (!dataUrl) {
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        canvas.getContext("2d")!.drawImage(v, 0, 0);
        dataUrl = canvas.toDataURL("image/jpeg", 0.95);
        w = v.videoWidth;
        h = v.videoHeight;
      }

      stopCamera();
      setShotSize(`实拍 ${w}×${h}（${((w * h) / 1e6).toFixed(1)}MP）`);
      loadImgAndReview(dataUrl);
    }, [loadImgAndReview, stopCamera, videoReady]);

    /** 画原图 + 四角把手（青色，沿用用户偏好的高对比配色） */
    const drawSrc = useCallback(() => {
      const img = imgRef.current;
      const srcC = srcCanvasRef.current;
      const ov = overlayRef.current;
      if (!img || !srcC || !ov) return;
      const maxW = Math.min(srcC.clientWidth || 360, 720);
      const scale = maxW / img.width;
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      [srcC, ov].forEach((c) => {
        c.width = w;
        c.height = h;
        c.style.width = w + "px";
        c.style.height = h + "px";
      });
      const ctx = srcC.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      const octx = ov.getContext("2d")!;
      octx.clearRect(0, 0, w, h);
      if (corners) {
        const pts = [
          corners.topLeftCorner,
          corners.topRightCorner,
          corners.bottomRightCorner,
          corners.bottomLeftCorner,
        ].map((p) => ({ x: p.x * scale, y: p.y * scale }));
        octx.strokeStyle = "#00D4FF";
        octx.lineWidth = 2;
        octx.beginPath();
        octx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < 4; i++) octx.lineTo(pts[i].x, pts[i].y);
        octx.closePath();
        octx.stroke();
        octx.fillStyle = "#00D4FF";
        pts.forEach((p) => {
          octx.beginPath();
          octx.arc(p.x, p.y, 12, 0, Math.PI * 2);
          octx.fill();
        });
      }
    }, [corners]);

    /** 拉正 + 增强，渲染预览 */
    const renderPreview = useCallback(() => {
      const img = imgRef.current;
      const prev = previewRef.current;
      const cv = cvRef.current;
      if (!img || !prev || !cv) return;
      try {
        let base: any;
        if (corners) {
          const { mat } = warpPerspective(cv, img, corners);
          base = mat;
        } else {
          // 没找到纸边：直接用原图
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          c.getContext("2d")!.drawImage(img, 0, 0);
          base = cv.imread(c);
        }
        const out = enhanceMat(cv, base, enhance);
        cv.imshow(prev, out);
        out.delete();
        base.delete();
      } catch (e) {
        console.warn("[doc-scanner] 预览渲染失败:", e);
      }
    }, [corners, enhance]);

    useEffect(() => {
      if (mode === "review") {
        drawSrc();
        renderPreview();
      }
    }, [mode, drawSrc, renderPreview, enhance]);

    // 四角拖拽微调
    const onPointerDown = (e: React.PointerEvent) => {
      if (!corners || !overlayRef.current) return;
      const rect = overlayRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const img = imgRef.current;
      if (!img) return;
      const scale = rect.width / img.width;
      let nearest: keyof Corners | null = null;
      let best = Infinity;
      (Object.keys(corners) as (keyof Corners)[]).forEach((k) => {
        const p = corners[k];
        const d = Math.hypot(p.x * scale - x, p.y * scale - y);
        if (d < best) {
          best = d;
          nearest = k;
        }
      });
      if (best < 40) dragRef.current = nearest;
    };

    const onPointerMove = (e: React.PointerEvent) => {
      if (!dragRef.current || !corners || !overlayRef.current || !imgRef.current) return;
      const rect = overlayRef.current.getBoundingClientRect();
      const scale = rect.width / imgRef.current.width;
      const x = (e.clientX - rect.left) / scale;
      const y = (e.clientY - rect.top) / scale;
      setCorners({ ...corners, [dragRef.current]: { x, y } });
    };

    const onPointerUp = () => {
      dragRef.current = null;
    };

    /** 确认：拉正+增强后回传 Blob */
    const finalize = useCallback(
      (useOriginal: boolean) => {
        const img = imgRef.current;
        const cv = cvRef.current;
        if (!img) return;
        setBusy(true);
        try {
          let out: any;
          if (!useOriginal && cv && corners) {
            const { mat } = warpPerspective(cv, img, corners);
            out = enhanceMat(cv, mat, enhance);
            mat.delete();
          } else if (cv) {
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            c.getContext("2d")!.drawImage(img, 0, 0);
            const base = cv.imread(c);
            out = enhanceMat(cv, base, enhance);
            base.delete();
          }
          const canvas = document.createElement("canvas");
          if (out) {
            cv.imshow(canvas, out);
            out.delete();
          } else {
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext("2d")!.drawImage(img, 0, 0);
          }
          canvas.toBlob(
            (blob) => {
              if (blob) onScanComplete(blob);
              setBusy(false);
              setOpen(false);
            },
            "image/jpeg",
            0.95
          );
        } catch (e) {
          console.warn("[doc-scanner] 出图失败:", e);
          setBusy(false);
        }
      },
      [corners, enhance, onScanComplete]
    );

    if (!open) return null;

    return (
      <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col">
        {/* 顶部条 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="text-white text-sm">
            {mode === "camera" ? "对准练习册页面" : "确认扫描效果"}
            {shotSize && (
              <span className="ml-2 text-xs text-[#00D4FF]">{shotSize}</span>
            )}
          </div>
          <Button
            variant="ghost"
            className="text-white"
            onClick={() => {
              setOpen(false);
              stopCamera();
              onClose();
            }}
          >
            关闭
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {mode === "camera" ? (
            <div className="space-y-4">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                onLoadedMetadata={() => setVideoReady(true)}
                onCanPlay={() => setVideoReady(true)}
                className="w-full rounded-lg bg-black"
                style={{ maxHeight: "60vh", objectFit: "contain" }}
              />
              {camError && (
                <p className="text-red-400 text-sm text-center">{camError}</p>
              )}
              <div className="flex flex-col gap-3 items-center">
                <div className="flex gap-3">
                  <Button
                    onClick={captureFrame}
                    disabled={!videoReady || busy}
                    className="bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90"
                  >
                    <Camera className="mr-2 h-5 w-5" /> 拍摄
                  </Button>
                  <Button
                    variant="outline"
                    className="text-[#00D4FF] border-[#00D4FF]/60"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImageIcon className="mr-2 h-5 w-5" /> 相册
                  </Button>
                </div>
                {!videoReady && !camError && (
                  <p className="text-xs text-slate-400">正在启动相机…</p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {cvLoading && (
                <p className="text-xs text-[#00D4FF] text-center">
                  <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                  正在加载图像处理模块…
                </p>
              )}
              {cvError && (
                <p className="text-red-400 text-sm text-center">{cvError}</p>
              )}
              {detectFail && (
                <p className="text-amber-400 text-sm text-center">
                  未自动识别到纸张四角，已用整张原图。可拖动四角微调，或点「重拍」。
                </p>
              )}
              <div className="grid md:grid-cols-2 gap-4">
                {/* 左：原图 + 四角 */}
                <div className="relative inline-block">
                  <canvas ref={srcCanvasRef} className="rounded" />
                  <canvas
                    ref={overlayRef}
                    className="absolute inset-0 touch-none"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerLeave={onPointerUp}
                  />
                </div>
                {/* 右：增强预览 */}
                <div>
                  <canvas ref={previewRef} className="rounded w-full h-auto" />
                </div>
              </div>

              {/* 三档增强：原色 / 漂白 / 黑白（v8 的"灰度"只是去色没意义，换成"漂白"） */}
              <div className="flex gap-2 justify-center flex-wrap">
                {(["original", "white", "bw"] as EnhanceMode[]).map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={enhance === m ? "default" : "outline"}
                    className={
                      enhance === m
                        ? "bg-[#00D4FF] text-slate-900 border-0"
                        : "text-[#00D4FF] border-[#00D4FF]/60"
                    }
                    onClick={() => setEnhance(m)}
                  >
                    {ENHANCE_LABEL[m]}
                  </Button>
                ))}
              </div>

              <div className="flex gap-3 justify-center flex-wrap">
                <Button
                  variant="outline"
                  className="text-[#00D4FF] border-[#00D4FF]/60"
                  onClick={() => {
                    setMode("camera");
                    startCamera();
                  }}
                >
                  <RotateCcw className="mr-1 h-4 w-4" /> 重拍
                </Button>
                <Button
                  variant="outline"
                  className="text-[#00D4FF] border-[#00D4FF]/60"
                  onClick={() => finalize(true)}
                  disabled={busy}
                >
                  用原图
                </Button>
                <Button
                  onClick={() => finalize(false)}
                  disabled={busy || !!cvError}
                  className="bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90"
                >
                  <Check className="mr-1 h-4 w-4" /> 确认
                </Button>
              </div>
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openWithFile(f);
            e.target.value = "";
          }}
        />
      </div>
    );
  }
);
