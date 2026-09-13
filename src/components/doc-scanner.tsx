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
import { Button } from "@/components/ui/button";
import { Camera, Image as ImageIcon, RotateCcw, Check } from "lucide-react";

type Corner = { x: number; y: number };
type Corners = {
  topLeftCorner: Corner;
  topRightCorner: Corner;
  bottomRightCorner: Corner;
  bottomLeftCorner: Corner;
};
type EnhanceMode = "original" | "gray" | "bw";

export interface DocScannerHandle {
  openCamera: () => void;
  openWithFile: (file: File) => void;
}

interface DocScannerProps {
  onScanComplete: (blob: Blob) => void;
  onClose: () => void;
}

function quadSize(pts: Corners) {
  const d = (a: Corner, b: Corner) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = Math.max(
    d(pts.topLeftCorner, pts.topRightCorner),
    d(pts.bottomLeftCorner, pts.bottomRightCorner)
  );
  const h = Math.max(
    d(pts.topLeftCorner, pts.bottomLeftCorner),
    d(pts.topRightCorner, pts.bottomRightCorner)
  );
  return { w: Math.round(w), h: Math.round(h) };
}

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
    const scannerRef = useRef<any>(null);

    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<"camera" | "review">("camera");
    const [camError, setCamError] = useState<string | null>(null);
    const [cvError, setCvError] = useState<string | null>(null);
    const [cvLoading, setCvLoading] = useState(false);
    const [enhance, setEnhance] = useState<EnhanceMode>("original");
    const [corners, setCorners] = useState<Corners | null>(null);
    const [detectFail, setDetectFail] = useState(false);
    const [busy, setBusy] = useState(false);
    const [videoReady, setVideoReady] = useState(false);
    const dragRef = useRef<keyof Corners | null>(null);

    const stopCamera = useCallback(() => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }, []);

    const startCamera = useCallback(async () => {
      setCamError(null);
      setVideoReady(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setVideoReady(true);
        }
      } catch (e: any) {
        setVideoReady(false);
        setCamError(
          "无法打开相机：" +
            (e?.message || "需通过 HTTPS 访问并授予相机权限，或改用相册。")
        );
      }
    }, []);

    const loadImgAndReview = useCallback(async (dataUrl: string) => {
      setBusy(true);
      setDetectFail(false);
      setCorners(null);
      setCvError(null);
      const img = new Image();
      img.onload = async () => {
        imgRef.current = img;
        try {
          const cv = await loadOpenCV();
          cvRef.current = cv;
          setCvLoading(true);
          const mod = await import("jscanify/client");
          scannerRef.current = new (mod as any).default();
          setCvLoading(false);
          const src = cv.imread(img);
          const contour = scannerRef.current.findPaperContour(src);
          if (!contour) {
            src.delete();
            setDetectFail(true);
          } else {
            const pts = scannerRef.current.getCornerPoints(contour) as Corners;
            contour.delete();
            src.delete();
            setCorners(pts);
            setDetectFail(false);
          }
        } catch (err: any) {
          setCvError(err?.message || "OpenCV 加载失败");
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
      startCamera();
    }, [startCamera]);

    const openWithFile = useCallback(
      (file: File) => {
        setOpen(true);
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

    const captureFrame = useCallback(() => {
      const v = videoRef.current;
      if (!v || !v.videoWidth || !videoReady) return;
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext("2d")!.drawImage(v, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      stopCamera();
      loadImgAndReview(dataUrl);
    }, [loadImgAndReview, stopCamera, videoReady]);

    // 画原图 + 四角把手
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

    // warp + 增强预览
    const renderPreview = useCallback(() => {
      const img = imgRef.current;
      const prev = previewRef.current;
      const cv = cvRef.current;
      const scanner = scannerRef.current;
      if (!img || !prev || !cv || !scanner) return;
      let srcMat: any = null;
      let outCanvas = prev;
      try {
        if (corners) {
          const { w, h } = quadSize(corners);
          const scale = Math.min(1, 2000 / Math.max(w, h));
          const rw = Math.max(1, Math.round(w * scale));
          const rh = Math.max(1, Math.round(h * scale));
          srcMat = cv.imread(img);
          const canvas = scanner.extractPaper(img, rw, rh, corners) as HTMLCanvasElement;
          if (!canvas) {
            throw new Error("extract failed");
          }
          // 增强
          let mat = cv.imread(canvas);
          if (enhance === "gray") {
            const g = new cv.Mat();
            cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY);
            cv.cvtColor(g, mat, cv.COLOR_GRAY2RGBA);
            g.delete();
          } else if (enhance === "bw") {
            const g = new cv.Mat();
            cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY);
            const bw = new cv.Mat();
            cv.adaptiveThreshold(
              g,
              bw,
              255,
              cv.ADAPTIVE_THRESH_GAUSSIAN_C,
              cv.THRESH_BINARY,
              11,
              2
            );
            cv.cvtColor(bw, mat, cv.COLOR_GRAY2RGBA);
            g.delete();
            bw.delete();
          }
          cv.imshow(outCanvas, mat);
          mat.delete();
        } else {
          // 无四角：用原图
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          c.getContext("2d")!.drawImage(img, 0, 0);
          const mat = cv.imread(c);
          cv.imshow(outCanvas, mat);
          mat.delete();
        }
      } catch (e) {
        // 失败则直接画原图
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        c.getContext("2d")!.drawImage(img, 0, 0);
        const ctx = outCanvas.getContext("2d")!;
        outCanvas.width = img.width;
        outCanvas.height = img.height;
        ctx.drawImage(c, 0, 0);
      } finally {
        if (srcMat) srcMat.delete();
      }
    }, [corners, enhance]);

    useEffect(() => {
      if (mode === "review") {
        drawSrc();
        renderPreview();
      }
    }, [mode, drawSrc, renderPreview, enhance]);

    // 四角拖拽
    const onPointerDown = (e: React.PointerEvent) => {
      if (!corners || !overlayRef.current) return;
      const rect = overlayRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const pts = corners;
      const entries: [keyof Corners, Corner][] = [
        ["topLeftCorner", pts.topLeftCorner],
        ["topRightCorner", pts.topRightCorner],
        ["bottomRightCorner", pts.bottomRightCorner],
        ["bottomLeftCorner", pts.bottomLeftCorner],
      ];
      let best: keyof Corners | null = null;
      let bestD = 24;
      for (const [k, p] of entries) {
        const scale = overlayRef.current.width / imgRef.current!.width;
        const d = Math.hypot(p.x * scale - x, p.y * scale - y);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      if (best) {
        dragRef.current = best;
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
    };

    const onPointerMove = (e: React.PointerEvent) => {
      if (!dragRef.current || !corners || !overlayRef.current || !imgRef.current) return;
      const rect = overlayRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const scale = overlayRef.current.width / imgRef.current.width;
      const nx = Math.max(0, Math.min(imgRef.current.width, x / scale));
      const ny = Math.max(0, Math.min(imgRef.current.height, y / scale));
      setCorners((prev) =>
        prev ? { ...prev, [dragRef.current!]: { x: nx, y: ny } } : prev
      );
    };

    const onPointerUp = () => {
      dragRef.current = null;
    };

    const finalize = (useOriginal: boolean) => {
      const cv = cvRef.current;
      const img = imgRef.current;
      if (!cv || !img) return;
      setBusy(true);
      try {
        let canvas: HTMLCanvasElement;
        if (useOriginal || !corners) {
          canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          canvas.getContext("2d")!.drawImage(img, 0, 0);
        } else {
          const { w, h } = quadSize(corners);
          const scale = Math.min(1, 2000 / Math.max(w, h));
          const rw = Math.max(1, Math.round(w * scale));
          const rh = Math.max(1, Math.round(h * scale));
          const c = scannerRef.current.extractPaper(img, rw, rh, corners) as HTMLCanvasElement;
          if (!c) {
            canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext("2d")!.drawImage(img, 0, 0);
          } else {
            canvas = c;
            if (enhance !== "original") {
              let mat = cv.imread(canvas);
              if (enhance === "gray") {
                const g = new cv.Mat();
                cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY);
                cv.cvtColor(g, mat, cv.COLOR_GRAY2RGBA);
                g.delete();
              } else {
                const g = new cv.Mat();
                cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY);
                const bw = new cv.Mat();
                cv.adaptiveThreshold(g, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);
                cv.cvtColor(bw, mat, cv.COLOR_GRAY2RGBA);
                g.delete();
                bw.delete();
              }
              cv.imshow(canvas, mat);
              mat.delete();
            }
          }
        }
        canvas.toBlob(
          (blob) => {
            if (blob) onScanComplete(blob);
            setBusy(false);
            setOpen(false);
          },
          "image/jpeg",
          0.92
        );
      } catch (e) {
        setBusy(false);
      }
    };

    if (!open) return null;

    return (
      <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
        {/* 顶部栏 */}
        <div className="flex items-center justify-between p-3 text-white">
          <Button variant="ghost" className="text-white" onClick={() => { setOpen(false); onClose(); }}>
            取消
          </Button>
          <span className="text-sm font-medium">文档扫描</span>
          <div className="w-10" />
        </div>

        {mode === "camera" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="w-full max-w-md rounded-lg bg-black"
              style={{ maxHeight: "60vh" }}
              onLoadedMetadata={() => setVideoReady(true)}
              onCanPlay={() => setVideoReady(true)}
            />
            {camError && (
              <p className="text-red-300 text-sm text-center px-4">{camError}</p>
            )}
            <div className="flex gap-3">
              <Button
                size="lg"
                onClick={captureFrame}
                disabled={!!camError || !videoReady || busy}
                className="bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90"
              >
                <Camera className="mr-2 h-5 w-5" /> 拍摄
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="text-[#00D4FF] border-[#00D4FF]/60"
                onClick={() => fileInputRef.current?.click()}
              >
                <ImageIcon className="mr-2 h-5 w-5" /> 相册
              </Button>
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
        )}

        {mode === "review" && (
          <div className="flex-1 overflow-auto p-3 flex flex-col gap-3">
            {cvError && (
              <p className="text-red-300 text-sm text-center">{cvError}</p>
            )}
            {cvLoading && (
              <p className="text-white/70 text-center text-sm">正在加载扫描引擎…</p>
            )}
            {detectFail && !cvError && (
              <p className="text-amber-300 text-sm text-center">
                未自动识别到纸张四角，已用原图。可点“重拍”或仍可使用原图。
              </p>
            )}

            {/* 原图 + 四角把手 */}
            <div className="relative mx-auto" style={{ touchAction: "none" }}>
              <canvas ref={srcCanvasRef} className="rounded-md max-w-full" />
              <canvas
                ref={overlayRef}
                className="absolute left-0 top-0"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                style={{ touchAction: "none" }}
              />
            </div>

            {/* 校正预览 */}
            <div className="mx-auto">
              <p className="text-white/60 text-xs mb-1 text-center">校正预览</p>
              <canvas ref={previewRef} className="rounded-md max-w-full bg-white" />
            </div>

            {/* 增强模式 */}
            <div className="flex gap-2 justify-center">
              {(["original", "gray", "bw"] as EnhanceMode[]).map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={enhance === m ? "default" : "outline"}
                  className={
                    enhance === m
                      ? "bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90"
                      : "text-white border-white/40"
                  }
                  onClick={() => setEnhance(m)}
                >
                  {m === "original" ? "原色" : m === "gray" ? "灰度" : "黑白"}
                </Button>
              ))}
            </div>

            {/* 操作 */}
            <div className="flex gap-2 justify-center pb-4">
              <Button variant="outline" className="text-[#00D4FF] border-[#00D4FF]/60" onClick={() => { setMode("camera"); startCamera(); }}>
                <RotateCcw className="mr-1 h-4 w-4" /> 重拍
              </Button>
              <Button variant="outline" className="text-[#00D4FF] border-[#00D4FF]/60" onClick={() => finalize(true)} disabled={busy}>
                用原图
              </Button>
              <Button onClick={() => finalize(false)} disabled={busy || !!cvError} className="bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90">
                <Check className="mr-1 h-4 w-4" /> 确认
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }
);
