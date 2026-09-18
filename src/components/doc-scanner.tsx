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
  warpFromMat,
  imageToMat,
  enhanceMat,
  scaleCorners,
  MAX_OUTPUT_EDGE,
  type CornerConfidence,
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

/** 界面文案集中一处，将来接入 i18n 只需替换这一个对象 */
const TEXT = {
  aimHint: "对准练习册页面",
  reviewHint: "确认扫描效果",
  close: "关闭",
  shoot: "拍摄",
  album: "相册",
  starting: "正在启动相机…",
  loadingCv: "正在加载图像处理模块…",
  noPaper:
    "未自动识别到纸张四角。已放好一个默认框，可拖动四个青色圆点手动拉正；不动它就保持整张原图。",
  /**
   * 【custom-v21】低置信档文案。
   * 这一档**已经默认参与拉正**（不再等用户拖），所以必须明确告诉用户"这是系统估算、可能不准"，
   * 并把"看一眼预览"这个动作点出来 —— 预览就是这一档唯一的人工闸门。
   */
  estimated:
    "四角是系统估算的（可能不准），已按它拉正预览。看一眼右图，不对就拖动四个琥珀色圆点修正。",
  noPaperManual: "已按你拖出的四个角拉正。继续微调，或点「重拍」重新拍。",
  dragTip: "拖动图上的青色圆点可微调纸边",
  dragTipLow: "拖动图上的琥珀色圆点可微调纸边",
  retake: "重拍",
  useOriginal: "用原图",
  useOriginalAgain: "再点一次用原图",
  useOriginalTip: "「用原图」将放弃自动拉正与美化，直接使用原始照片",
  confirm: "确认",
  previewing: "正在生成预览…",
  finalizing: "正在生成图片…",
};

const ENHANCE_LABEL: Record<EnhanceMode, string> = {
  original: "原色",
  white: "漂白",
  bw: "黑白",
};

/**
 * 预览用的最大边长。
 * 【custom-v19 性能核心】custom-v18 的预览直接跑全尺寸（2500px），单帧 4~7.5 秒。
 * 预览 canvas 实际显示宽度只有几百 CSS px（高 DPI 屏按 2 倍算约 1400 物理像素），
 * 因此 1200px 足以肉眼无差别，而像素量只有全尺寸的约 1/4 → 预览快 4 倍以上。
 * 出图走 MAX_OUTPUT_EDGE（custom-v19 起为 1920，与下游落库上限对齐），清晰度不受影响。
 */
const PREVIEW_EDGE = 1200;

/**
 * 出图 JPEG 质量。
 * 【custom-v19】0.95 → 0.80：与下游 compressImage 的默认质量（0.8）对齐，
 * 出图即最终成品——此前只有超过 1MB 的档位会被下游二次重编码，同批图质量不一致。
 * 0.80 是扫描件常规区间，配合前置的漂白/二值化，1920 长边下纸面足够干净。
 */
const OUTPUT_QUALITY = 0.8;

/**
 * 抓帧转 dataURL 的质量——拍摄路径的**中间产物**，与 OUTPUT_QUALITY 是两回事。
 * 这里编出来的图是喂给 OpenCV 的原图，**不落库**；最终成品的尺寸与质量
 * 由 MAX_OUTPUT_EDGE / OUTPUT_QUALITY 决定。保持高质量，避免进算法前就丢细节。
 */
const CAPTURE_QUALITY = 0.95;

/** 「用原图」的二次确认时限（毫秒），超时自动取消 */
const CONFIRM_WINDOW_MS = 3000;

/** 拖动四角的判定半径（CSS px），兼顾手指触摸精度 */
const HIT_RADIUS = 44;

/**
 * 【custom-v21】把手配色与线型 —— 这是让"错得像对的"变得**可察觉**的唯一手段。
 * 青色实线 = 系统确定（直接确定即可）；琥珀虚线 = 系统在估算（值得扫一眼预览）。
 * 只用形状/颜色区分、不加文字弹窗，是因为这一档不需要打断用户操作。
 */
const HANDLE_COLOR_HIGH = "#00D4FF";
const HANDLE_COLOR_LOW = "#F59E0B";
const LOW_CONFIDENCE_DASH = [10, 6];

/**
 * 【custom-v21】非高置信档允许把手拖出画面外的比例。
 *
 * 历史：custom-v19 把角点硬夹在图片范围内，理由是"拖出边界会导致拉正结果异常"
 * —— 这没错，但夹得太死会留下一个死角：当**纸张本身被取景框切掉**时，
 * 真实纸角落在画面之外，用户根本标不出来。
 * 低置信 / 无候选档本来就是"手动修正"场景，放开 6% 余量；高置信档维持严格夹取，
 * 不改变已被验收过的行为。副作用上限也只是边缘一条 6% 的黑边，且只有用户主动拖出去才有。
 */
const OVERSHOOT_PAD = 0.06;

/**
 * 【问题①】未识别到纸张四角时，默认角点相对图片的内缩比例。
 *
 * 原实现检测失败只弹一句提示、`corners` 保持 null，而画把手（overlay effect）与拖动提示
 * 都以 `corners` 有值为前提 → 提示成了空头支票，用户"想拖也无从下手"。
 * 现在给一组内缩 6% 的默认角点，四个把手就出现了。
 *
 * ⚠️ 只给角点是不够的：只要 `corners` 有值，出图就会按它做 warpPerspective 裁剪。
 * 若一上来就按"内缩框"裁，用户看到的是**被裁掉一圈的图** —— 比不改还差。
 * 因此另设 manualWarp 闸门：默认角点**只用于显示把手**，必须等用户真的拖过任一把手，
 * 才启用按角点裁剪；拖动之前始终保持整张原图。
 */
const MANUAL_CORNER_INSET = 0.06;

/** 按图片尺寸推一组内缩矩形角点（仅用于展示把手；是否真的据其裁剪由 manualWarp 决定） */
function defaultCornersFor(img: {
  width: number;
  height: number;
}): Corners {
  const dx = Math.round(img.width * MANUAL_CORNER_INSET);
  const dy = Math.round(img.height * MANUAL_CORNER_INSET);
  return {
    topLeftCorner: { x: dx, y: dy },
    topRightCorner: { x: img.width - dx, y: dy },
    bottomRightCorner: { x: img.width - dx, y: img.height - dy },
    bottomLeftCorner: { x: dx, y: img.height - dy },
  };
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
    const leftColRef = useRef<HTMLDivElement>(null);
    const cvRef = useRef<any>(null);
    const dragRef = useRef<keyof Corners | null>(null);

    // —— custom-v19：Mat 只读一次并缓存，全链路复用 ——
    /** 全分辨率源图 Mat（出图用） */
    const fullMatRef = useRef<any>(null);
    /** 预览尺寸源图 Mat（预览用，像素量约为全图 1/4） */
    const previewMatRef = useRef<any>(null);
    /** 预览 Mat 相对全图的缩放比，用于把角点坐标映射到预览坐标系 */
    const previewScaleRef = useRef(1);
    /** 竞态闸门：换图/关窗后，迟到的 onload 回调不再写入状态 */
    const tokenRef = useRef(0);
    /** pointermove 的 rAF 合并 */
    const rafRef = useRef<number | null>(null);
    const pendingRef = useRef<{ x: number; y: number } | null>(null);
    /** 「用原图」二次确认的定时器 */
    const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<"camera" | "review">("camera");
    const [camError, setCamError] = useState<string | null>(null);
    const [cvError, setCvError] = useState<string | null>(null);
    const [cvLoading, setCvLoading] = useState(false);
    // 默认「漂白」：底色干净最省墨，AI 识别率也最高
    const [enhance, setEnhance] = useState<EnhanceMode>("white");
    const [corners, setCorners] = useState<Corners | null>(null);
    /**
     * 【custom-v21】四角检测的置信档，取代原来的 detectFail 布尔量。
     * - `high`：严格档认出来的，青色实线，直接拉正；
     * - `low` ：降级链兜住的（放宽阈值 / 点数补救 / 旋转矩形），琥珀虚线，**过校验即默认拉正**；
     * - `none`：彻底没候选，corners 只是内缩默认框，不动就保持整张原图（沿用旧行为）。
     */
    const [cornerConfidence, setCornerConfidence] =
      useState<CornerConfidence>("none");
    /**
     * 用户是否**真的拖过**任一把手。
     * none 档时 corners 只是"展示用"的默认框，必须等这个开关打开才拿它去裁剪
     * （否则会立刻裁掉一圈，比不改更差）—— 详见 MANUAL_CORNER_INSET 注释。
     */
    const [manualWarp, setManualWarp] = useState(false);
    const [busy, setBusy] = useState(false);
    const [videoReady, setVideoReady] = useState(false);
    // 实际拍到的像素——custom-v8 曾因没要分辨率只拍出 461×562，这里显示出来便于当场验证
    const [shotSize, setShotSize] = useState<string>("");
    /** 拖动中：此时**不重算预览**，只移动把手（custom-v18 卡死的根因就在这里） */
    const [dragging, setDragging] = useState(false);
    /** 预览正在后台计算，给用户一个提示，避免以为卡死 */
    const [previewBusy, setPreviewBusy] = useState(false);
    const [confirmUseOriginal, setConfirmUseOriginal] = useState(false);
    /** 左栏显示尺寸（CSS px），随容器宽度自适应 */
    const [display, setDisplay] = useState<{ w: number; h: number } | null>(null);
    /** 换图时 +1，用于触发底图重绘 */
    const [imgEpoch, setImgEpoch] = useState(0);

    /**
     * 角点是否**参与**拉正与裁剪。
     * - high / low：corners 是识别（或降级兜住）的结果 → 直接生效；
     * - none：corners 只是默认展示框 → 必须等用户拖过（manualWarp）才生效。
     * 预览与出图都必须用这个开关判断，否则会出现"提示说保留原图、实际却裁掉一圈"。
     */
    const cornersActive =
      !!corners && (manualWarp || cornerConfidence !== "none");

    /** 释放缓存的 Mat，避免 wasm 堆内存泄漏 */
    const releaseMats = useCallback(() => {
      try {
        fullMatRef.current?.delete?.();
        previewMatRef.current?.delete?.();
      } catch {
        /* 忽略：Mat 可能已被销毁 */
      }
      fullMatRef.current = null;
      previewMatRef.current = null;
    }, []);

    const stopCamera = useCallback(() => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }, []);

    /**
     * 打开相机。
     * 【custom-v8 的第一个病根就在这里】v8 只写 { facingMode: "environment" } 没要分辨率，
     * 浏览器默认给 ~480p，12MP 的主摄只拍出 461×562。这里显式要 4K 并开连续对焦。
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
      } catch {
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
    const loadImgAndReview = useCallback(
      async (dataUrl: string, sizeNote?: string) => {
        const token = ++tokenRef.current;
        setBusy(true);
        setCornerConfidence("none");
        setCorners(null);
        setManualWarp(false);
        setCvError(null);
        setDragging(false);
        dragRef.current = null;
        releaseMats();

        const img = new Image();
        img.onload = async () => {
          // 已被更新的请求取代（用户连续选了另一张图 / 已关闭）→ 丢弃本次结果
          if (token !== tokenRef.current) return;
          imgRef.current = img;
          if (sizeNote) setShotSize(sizeNote);
          try {
            setCvLoading(true);
            const cv = await loadOpenCV();
            if (token !== tokenRef.current) return;
            cvRef.current = cv;

            // 全尺寸与预览尺寸各读一次，之后所有重算都复用（custom-v19）
            const full = imageToMat(cv, img);
            if (token !== tokenRef.current) {
              full.delete();
              return;
            }
            fullMatRef.current = full;

            const scale = Math.min(
              1,
              PREVIEW_EDGE / Math.max(img.width, img.height)
            );
            previewScaleRef.current = scale;
            const pm = new cv.Mat();
            cv.resize(full, pm, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
            previewMatRef.current = pm;

            setCvLoading(false);

            // 【custom-v21】分档处理：
            // high → 严格档认出来的，直接拉正（同旧版成功路径）；
            // low  → 降级链兜住的，过合理性校验即默认拉正，把手画成琥珀虚线提示"这是估算"；
            // none → 旧版失败路径：给默认内缩框当把手，不动就保持整张原图。
            const found = findPaperCorners(cv, full);
            if (found.corners) {
              setCorners(found.corners);
              setCornerConfidence(found.confidence);
            } else {
              // 【问题①】检测失败也必须给出一组角点：否则 overlay 不画把手、用户无从下手。
              // 注意这只是"展示用"的默认框，是否据其裁剪由 manualWarp 决定。
              setCorners(defaultCornersFor(img));
              setCornerConfidence("none");
            }
          } catch (err: any) {
            setCvLoading(false);
            setCvError(err?.message || "图像处理模块加载失败");
          }
          if (token !== tokenRef.current) return;
          setImgEpoch((e) => e + 1);
          setMode("review");
          setBusy(false);
        };
        img.onerror = () => {
          if (token !== tokenRef.current) return;
          setCvError("图片加载失败");
          setBusy(false);
        };
        img.src = dataUrl;
      },
      [releaseMats]
    );

    const openCamera = useCallback(() => {
      setOpen(true);
      setMode("camera");
      setVideoReady(false);
      setShotSize("");
      setEnhance("white");
      setConfirmUseOriginal(false);
      startCamera();
    }, [startCamera]);

    const openWithFile = useCallback(
      (file: File) => {
        // 【custom-v19 修复】相册路径原先不关摄像头，相机会一直亮着
        stopCamera();
        setOpen(true);
        setShotSize("");
        setEnhance("white");
        setConfirmUseOriginal(false);
        const r = new FileReader();
        r.onload = () => loadImgAndReview(r.result as string);
        r.readAsDataURL(file);
      },
      [loadImgAndReview, stopCamera]
    );

    useImperativeHandle(ref, () => ({ openCamera, openWithFile }), [
      openCamera,
      openWithFile,
    ]);

    const closeAll = useCallback(() => {
      tokenRef.current++; // 作废在途的加载请求
      stopCamera();
      releaseMats();
      setOpen(false);
      setConfirmUseOriginal(false);
      onClose();
    }, [onClose, releaseMats, stopCamera]);

    useEffect(() => {
      if (!open) stopCamera();
      return () => stopCamera();
    }, [open, stopCamera]);

    // 卸载时彻底释放 wasm 内存与定时器
    useEffect(() => {
      return () => {
        tokenRef.current++;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        try {
          fullMatRef.current?.delete?.();
          previewMatRef.current?.delete?.();
        } catch {
          /* 忽略 */
        }
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      };
    }, []);

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
          dataUrl = c.toDataURL("image/jpeg", CAPTURE_QUALITY);
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
        dataUrl = canvas.toDataURL("image/jpeg", CAPTURE_QUALITY);
        w = v.videoWidth;
        h = v.videoHeight;
      }

      stopCamera();
      setShotSize(`实拍 ${w}×${h}（${((w * h) / 1e6).toFixed(1)}MP）`);
      loadImgAndReview(dataUrl);
    }, [loadImgAndReview, stopCamera, videoReady]);

    /** 渲染增强预览。用**预览尺寸**的 Mat，比全尺寸快 4 倍以上。 */
    const renderPreview = useCallback(
      (modeNow: EnhanceMode, cs: Corners | null) => {
        const cv = cvRef.current;
        const pm = previewMatRef.current;
        const prev = previewRef.current;
        if (!cv || !pm || !prev) return;
        try {
          let base: any;
          let ownBase = false;
          if (cs) {
            // 角点是原图坐标，用前先换算到预览 Mat 的坐标系
            base = warpFromMat(
              cv,
              pm,
              scaleCorners(cs, previewScaleRef.current),
              PREVIEW_EDGE
            ).mat;
            ownBase = true;
          } else {
            // 没找到纸边：直接用（预览尺寸的）原图
            base = pm;
          }
          const out = enhanceMat(cv, base, modeNow);
          cv.imshow(prev, out);
          out.delete();
          if (ownBase) base.delete();
        } catch (e) {
          console.warn("[doc-scanner] 预览渲染失败:", e);
        }
      },
      []
    );

    /**
     * 预览重算。
     * 【custom-v19 关键】拖动中直接 return —— 只移动把手，不重算。
     * custom-v18 是「每动一像素就重算全尺寸一次」，一次拖拽等于连续几十次 7 秒计算，界面必然冻死。
     * 现在改为：拖动只画圆点（毫秒级），松手后才算一次。
     */
    useEffect(() => {
      if (mode !== "review" || !open) return;
      if (dragging) {
        setPreviewBusy(false);
        return;
      }
      if (!previewMatRef.current) return;
      let cancelled = false;
      setPreviewBusy(true);
      // 先让浏览器把「计算中」画出来，再干同步的 wasm 重活，否则提示根本来不及显示
      const t = setTimeout(() => {
        if (cancelled) return;
        renderPreview(enhance, cornersActive ? corners : null);
        setPreviewBusy(false);
      }, 30);
      return () => {
        cancelled = true;
        clearTimeout(t);
      };
    }, [mode, open, enhance, corners, cornersActive, dragging, renderPreview, imgEpoch]);

    /** 画左侧底图，并把显示尺寸设为容器宽度（custom-v18 锁死 300px 的修复） */
    useEffect(() => {
      if (mode !== "review" || !open) return;
      const redraw = () => {
        const img = imgRef.current;
        const srcC = srcCanvasRef.current;
        const ov = overlayRef.current;
        const col = leftColRef.current;
        if (!img || !srcC || !ov || !col) return;
        // 关键：量**容器**宽度，而不是 canvas 自身的 clientWidth。
        // canvas 未设尺寸时默认 300px，custom-v18 正是被这个默认值锁死的。
        const avail = col.clientWidth || 360;
        const maxW = Math.max(220, Math.min(avail, 720));
        const scale = maxW / img.width;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        [srcC, ov].forEach((c) => {
          c.width = w;
          c.height = h;
          c.style.width = w + "px";
          c.style.height = h + "px";
        });
        srcC.getContext("2d")!.drawImage(img, 0, 0, w, h);
        setDisplay({ w, h });
      };
      redraw();
      const ro = new ResizeObserver(redraw);
      if (leftColRef.current) ro.observe(leftColRef.current);
      return () => ro.disconnect();
    }, [mode, open, imgEpoch]);

    /** 单独重绘把手层：拖动时只跑这一个 effect，成本近似为零 */
    useEffect(() => {
      const ov = overlayRef.current;
      const img = imgRef.current;
      if (!ov || !display) return;
      const ctx = ov.getContext("2d")!;
      ctx.clearRect(0, 0, ov.width, ov.height);
      if (!corners || !img) return;
      const s = display.w / img.width;
      const pts = [
        corners.topLeftCorner,
        corners.topRightCorner,
        corners.bottomRightCorner,
        corners.bottomLeftCorner,
      ].map((p) => ({ x: p.x * s, y: p.y * s }));
      // 【custom-v21】低置信档用琥珀虚线：颜色本身就是"这是系统估算、可能不准"的信号
      const low = cornerConfidence === "low";
      const color = low ? HANDLE_COLOR_LOW : HANDLE_COLOR_HIGH;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(low ? LOW_CONFIDENCE_DASH : []);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.fill();
      });
    }, [corners, display, cornerConfidence]);

    // —— 四角拖拽微调 ——
    const onPointerDown = (e: React.PointerEvent) => {
      const ov = overlayRef.current;
      const img = imgRef.current;
      if (!corners || !ov || !img) return;
      const rect = ov.getBoundingClientRect();
      const s = rect.width / img.width;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let nearest: keyof Corners | null = null;
      let best = Infinity;
      (Object.keys(corners) as (keyof Corners)[]).forEach((k) => {
        const p = corners[k];
        const d = Math.hypot(p.x * s - x, p.y * s - y);
        if (d < best) {
          best = d;
          nearest = k;
        }
      });
      if (best < HIT_RADIUS) {
        dragRef.current = nearest;
        setDragging(true);
        // 手指移出画布也能继续拖（手机上很关键）
        try {
          ov.setPointerCapture(e.pointerId);
        } catch {
          /* 部分浏览器不支持，忽略 */
        }
      }
    };

    const onPointerMove = (e: React.PointerEvent) => {
      const key = dragRef.current;
      const ov = overlayRef.current;
      const img = imgRef.current;
      if (!key || !ov || !img) return;
      const rect = ov.getBoundingClientRect();
      const s = rect.width / img.width;
      // 【custom-v19→v21】把角点夹在图片范围内，避免拖出边界导致拉正结果异常。
      // v21 调整：只在**高置信档**严格夹取；低置信 / 无候选档本来就处于"手动修正"场景，
      // 放开 OVERSHOOT_PAD 余量 —— 否则当纸张被取景框切掉时，真实纸角落在画面外、
      // 用户根本标不出来（详见 OVERSHOOT_PAD 注释）。
      const pad = cornerConfidence === "high" ? 0 : OVERSHOOT_PAD;
      const padX = img.width * pad;
      const padY = img.height * pad;
      const x = Math.max(-padX, Math.min(img.width + padX, (e.clientX - rect.left) / s));
      const y = Math.max(-padY, Math.min(img.height + padY, (e.clientY - rect.top) / s));
      pendingRef.current = { x, y };
      if (rafRef.current != null) return;
      // 用 rAF 把同一帧内的多次 pointermove 合并成一次 state 更新
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const p = pendingRef.current;
        const k = dragRef.current;
        if (!p || !k) return;
        // 函数式更新：不依赖闭包里的 corners，避免连续移动时丢失中间状态
        setCorners((prev) => (prev ? { ...prev, [k]: p } : prev));
      });
    };

    const onPointerUp = () => {
      if (!dragRef.current) return;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const p = pendingRef.current;
      const k = dragRef.current;
      pendingRef.current = null;
      dragRef.current = null;
      if (p && k) setCorners((prev) => (prev ? { ...prev, [k]: p } : prev));
      // 用户真的动过把手了 → 打开"按角点裁剪"闸门。
      // 检测失败时这是唯一的启用途径：默认框在你亲手拖过之后才生效。
      setManualWarp(true);
      setDragging(false); // 松手 → 触发一次预览重算
    };

    /**
     * 确认出图。
     * 【custom-v19 修复 P0】useOriginal 时**完全不经 OpenCV**：不拉正、不增强、不改一个像素。
     * custom-v18 在这里仍调用了 enhanceMat，所以在「黑白」档点「用原图」拿到的是黑白二值图，
     * 与「用原图」四个字的意思完全相反。
     */
    const finalize = useCallback(
      (useOriginal: boolean) => {
        const img = imgRef.current;
        const cv = cvRef.current;
        if (!img) return;
        setBusy(true);
        try {
          const canvas = document.createElement("canvas");
          let out: any = null;

          if (useOriginal || !cv) {
            // 真正的原图
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext("2d")!.drawImage(img, 0, 0);
          } else {
            const fm = fullMatRef.current;
            if (fm && corners && cornersActive) {
              const warped = warpFromMat(cv, fm, corners, MAX_OUTPUT_EDGE).mat;
              out = enhanceMat(cv, warped, enhance);
              warped.delete();
            } else if (fm) {
              out = enhanceMat(cv, fm, enhance);
            }
            if (out) {
              cv.imshow(canvas, out);
              out.delete();
            } else {
              canvas.width = img.width;
              canvas.height = img.height;
              canvas.getContext("2d")!.drawImage(img, 0, 0);
            }
          }

          canvas.toBlob(
            (blob) => {
              if (blob) onScanComplete(blob);
              setBusy(false);
              closeAll();
            },
            "image/jpeg",
            OUTPUT_QUALITY
          );
        } catch (e) {
          console.warn("[doc-scanner] 出图失败:", e);
          setBusy(false);
        }
      },
      [corners, cornersActive, enhance, onScanComplete, closeAll]
    );

    /** 「用原图」二次确认：避免误触丢掉自动拉正与美化（蓝图 #5 要求） */
    const handleUseOriginal = () => {
      if (!confirmUseOriginal) {
        setConfirmUseOriginal(true);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = setTimeout(
          () => setConfirmUseOriginal(false),
          CONFIRM_WINDOW_MS
        );
        return;
      }
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      setConfirmUseOriginal(false);
      finalize(true);
    };

    if (!open) return null;

    /**
     * z-[100]：本组件现在有两个挂载点 —— ① UploadZone（页面级，z-50 就够）
     * ② 编辑器的「拉伸」入口（上面压着 Radix Dialog，其 Overlay 与 Content 都是 z-50）。
     * 统一抬到 100，保证无论从哪进来都盖在最上层。
     */
    return (
      <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col">
        {/* 顶部条 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="text-white text-sm">
            {mode === "camera" ? TEXT.aimHint : TEXT.reviewHint}
            {shotSize && (
              <span className="ml-2 text-xs text-[#00D4FF]">{shotSize}</span>
            )}
          </div>
          <Button variant="ghost" className="text-white" onClick={closeAll}>
            {TEXT.close}
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
                    <Camera className="mr-2 h-5 w-5" /> {TEXT.shoot}
                  </Button>
                  <Button
                    variant="outline"
                    className="text-[#00D4FF] border-[#00D4FF]/60"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImageIcon className="mr-2 h-5 w-5" /> {TEXT.album}
                  </Button>
                </div>
                {!videoReady && !camError && (
                  <p className="text-xs text-slate-400">{TEXT.starting}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {cvLoading && (
                <p className="text-xs text-[#00D4FF] text-center">
                  <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                  {TEXT.loadingCv}
                </p>
              )}
              {cvError && (
                <p className="text-red-400 text-sm text-center">{cvError}</p>
              )}
              {cornerConfidence === "low" && !manualWarp && (
                <p className="text-amber-400 text-sm text-center">
                  {TEXT.estimated}
                </p>
              )}
              {cornerConfidence === "none" && !manualWarp && (
                <p className="text-amber-400 text-sm text-center">
                  {TEXT.noPaper}
                </p>
              )}
              {manualWarp && (
                <p className="text-[#00D4FF] text-sm text-center">
                  {TEXT.noPaperManual}
                </p>
              )}
              <div className="grid md:grid-cols-2 gap-4 items-start">
                {/* 左：原图 + 四角（宽度跟随容器，不再锁死） */}
                <div ref={leftColRef} className="relative w-full">
                  <canvas ref={srcCanvasRef} className="rounded block" />
                  <canvas
                    ref={overlayRef}
                    className="absolute inset-0 touch-none cursor-crosshair"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  />
                </div>
                {/* 右：增强预览 */}
                <div className="relative">
                  <canvas ref={previewRef} className="rounded w-full h-auto block" />
                  {previewBusy && (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-950/40 rounded">
                      <span className="text-xs text-[#00D4FF] bg-slate-950/80 px-3 py-1.5 rounded-full">
                        <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                        {TEXT.previewing}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {corners && !dragging && (
                <p className="text-xs text-slate-500 text-center">
                  {cornerConfidence === "low" ? TEXT.dragTipLow : TEXT.dragTip}
                </p>
              )}

              {/* 三档增强：原色 / 漂白 / 黑白（v8 的"灰度"只是去色没意义，换成"漂白"） */}
              <div className="flex gap-2 justify-center flex-wrap">
                {(["original", "white", "bw"] as EnhanceMode[]).map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={enhance === m ? "default" : "outline"}
                    // custom-v19 修复：选中态必须显式覆盖 hover 样式。
                    // 原来只写 bg/text，Button 自带的 hover:bg-primary 会在鼠标悬停时把
                    // 亮青底压成深色，而文字仍是深色 → 对比度 1.01:1，文字直接看不见。
                    className={
                      enhance === m
                        ? "bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90 hover:text-slate-900"
                        : "text-[#00D4FF] border-[#00D4FF]/60 hover:bg-[#00D4FF]/10 hover:text-[#00D4FF]"
                    }
                    onClick={() => setEnhance(m)}
                  >
                    {ENHANCE_LABEL[m]}
                  </Button>
                ))}
              </div>

              {busy && (
                <p className="text-xs text-[#00D4FF] text-center">
                  <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                  {TEXT.finalizing}
                </p>
              )}

              {confirmUseOriginal && (
                <p className="text-xs text-amber-400 text-center">
                  {TEXT.useOriginalTip}
                </p>
              )}

              <div className="flex gap-3 justify-center flex-wrap">
                <Button
                  variant="outline"
                  className="text-[#00D4FF] border-[#00D4FF]/60"
                  onClick={() => {
                    setConfirmUseOriginal(false);
                    setMode("camera");
                    startCamera();
                  }}
                  disabled={busy}
                >
                  <RotateCcw className="mr-1 h-4 w-4" /> {TEXT.retake}
                </Button>
                <Button
                  variant="outline"
                  className={
                    confirmUseOriginal
                      ? "border-amber-400 text-amber-400 hover:bg-amber-400/10 hover:text-amber-400"
                      : "text-[#00D4FF] border-[#00D4FF]/60 hover:bg-[#00D4FF]/10 hover:text-[#00D4FF]"
                  }
                  onClick={handleUseOriginal}
                  disabled={busy}
                >
                  {confirmUseOriginal ? TEXT.useOriginalAgain : TEXT.useOriginal}
                </Button>
                <Button
                  onClick={() => finalize(false)}
                  disabled={busy || !!cvError}
                  className="bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90"
                >
                  <Check className="mr-1 h-4 w-4" /> {TEXT.confirm}
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
