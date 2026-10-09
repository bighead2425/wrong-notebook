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
import { CORNER_KEYS, guideBox, presetFromLive, settleCorners, toNormCorners } from "@/lib/doc-live-corners";
import { Camera, Image as ImageIcon, RotateCcw, Check, Loader2 } from "lucide-react";

export interface DocScannerHandle {
  openCamera: () => void;
  openWithFile: (file: File) => void;
}

interface DocScannerProps {
  onScanComplete: (blob: Blob) => void;
  onClose: () => void;
  /**
   * 【custom-v26 连拍模式】批量上传的「连续拍摄」用。
   *
   * 开启后发生两件事：
   *  ① 「确认扫描效果」那一步的「确认」按钮换成 **「再拍一张」/「完成」**；
   *  ② 每张图连同用户意图一起回传给 `onBurstShot`，而不再走 `onScanComplete`。
   *     点「再拍一张」时扫描器**不关闭** —— 直接回到取景框继续拍，
   *     拍多少张就往批量队列里堆多少张，直到点「完成」才关闭。
   *
   * 不传就是原本的单张模式，行为一字不变。
   */
  burstMode?: boolean;
  onBurstShot?: (blob: Blob, action: "again" | "done") => void;
  /** 连拍已拍张数（显示在顶部条）——连着拍十几张时没这个数会心里没底 */
  burstCount?: number;
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
  /** 【custom-v26 连拍】「确认」拆成两个：出这张 + 继续拍 / 出这张 + 收工 */
  burstAgain: "再拍一张",
  burstDone: "完成",
  /** 连拍模式下「用原图」变成开关，选中后由上面两个按钮决定何时出图 */
  useOriginalOn: "已选原图",
  previewing: "正在生成预览…",
  finalizing: "正在生成图片…",
  /** 【2026-10-08】取景页的"预览实时提示四角"开关（实验，默认关） */
  liveToggle: "预览时实时提示四角（实验）",
  livePreparing: "正在准备图像处理模块…",
  liveSearching: "对准纸的四个角，正在识别…",
  liveFound: "已认到纸边，四角对齐即可拍",
  /** 【2026-10-09】估算档（琥珀）也显示 —— 文案要让它"敢拍"，而不是让它犹豫 */
  liveFoundLow: "已认到纸边（估算，可直接拍，拍完还能微调）",
  /* 【2026-10-08】拍完的一句诊断 —— 把已有的置信档说人话，省掉"拍完才发现歪了" */
  diagHigh: "四角自动识别：准（可直接确认或微调）",
  diagLow: "四角是估算的，请看一眼并修正",
  diagNone: "没自动认出四角，请手动拖四个角",
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
 * 【2026-10-08 他第 1 条】拖动把手时的"放大镜"。
 *
 * 他的原话：拖把手时"只能凭感觉挪位置，我需要一点精确的指示"。
 *
 * 【2026-10-09 他第 1 条 · 位置改了】第一版是"放在**对角**"（左上的把手 ⇒ 右上…不，
 * 是**右下**）。他实机用下来不满意，给了新规则，理由也说清了：
 *
 *   "特别是右手操作左上角的时候，放大在右下角十分不便捷……图片左侧的把手都在右上角放大，
 *    图片右侧的把手都在左上角放大。"
 *
 *   ⇒ **只看左右**：把手在图片左半边 ⇒ 放大镜在**右上角**；在右半边 ⇒ **左上角**；
 *      **纵向一律贴顶**（不再看上下）。
 *   真正要避开的只是"手指压住把手"，而那是**左右方向**的遮挡；
 *   纵向固定贴顶之后，放大镜永远出现在可预期的那一处，看一眼不用找。
 *
 * 下面那张表是这件事的"数据"部分：角的中文名（给放大镜里的角标文字用）。
 */
const CORNER_LABEL: Record<keyof Corners, string> = {
  topLeftCorner: "左上角",
  topRightCorner: "右上角",
  bottomRightCorner: "右下角",
  bottomLeftCorner: "左下角",
};
/** 放大镜的放大倍数与边长占比（相对叠加层短边） */
const LOUPE_ZOOM = 2.6;
const LOUPE_RATIO = 0.32;

/**
 * 【2026-10-08】取景页"预览实时提示四角"的三个参数。为什么要一个个定：
 *
 * · `LIVE_DETECT_WIDTH = 800` —— **与找角算法内部的 `DETECT_WIDTH` 对齐**。
 *   `findPaperCorners` 内部是 `scale = min(1, 800 / cols)`（只缩不放）⇒
 *   我们这边直接喂 800 宽，它就**一次 resize 都不用做**（不多不少正好），
 *   而且**检测分辨率与"拍完那条路"完全一致**：拍完那条路喂的是 4K 原图，
 *   到了算法里同样被缩到 800 宽。⇒ 预览里给出的提示，与拍完得到的结果**同源**，
 *   不会出现"预览说行、拍完却认歪了"。
 * · `LIVE_INTERVAL_MS = 280` —— 约 3~4 帧/秒。实时描边没必要 30fps：
 *   人要看清"对没对齐" 3 帧/秒足够，而耗电与发热差一个量级。
 * · `LIVE_FRAMES = 3` —— 判稳要看最近 3 帧（见 settleCorners）。
 */
const LIVE_DETECT_WIDTH = 800;
const LIVE_INTERVAL_MS = 280;
const LIVE_FRAMES = 3;

/** 开关记忆的 localStorage key（不勾就永远不加载这一层，老路径一字不变） */
const LIVE_CORNERS_KEY = "wn_doc_live_corners";

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

/**
 * 【2026-10-08】取景页的叠加层 —— **1.414 参考框（四角小直角）+ 一条水平参考线 + 认到的纸边**。
 *
 * ⚠️ 写成模块级组件是**有意**的：它只吃 props 与模块常量（不碰主组件的闭包）
 *    —— 这个项目吃过"模块级组件引用了主组件里的变量 ⇒ 构建报 Cannot find name"的亏。
 * ⚠️ 全部用**百分比**定位：叠加层与画面天然同步，不必知道预览显示成多少像素。
 *    这正是"框和纸错位"最常见的成因（拿容器尺寸当画面尺寸），这里从根上避开。
 */
function LiveGuideOverlay({
  frameW,
  frameH,
  corners,
  confidence,
}: {
  frameW: number;
  frameH: number;
  corners: Corners | null;
  confidence?: CornerConfidence | null;
}) {
  const g = guideBox(frameW, frameH);
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const guideColor = "rgba(255,255,255,0.55)";
  /**
   * 【2026-10-09】颜色 = 可信度（与审核页同一套语义）：
   * 青色实线 = 严格档确定；琥珀虚线 = 降级链估算（**现在也显示**，他反馈"藏起来用户不敢按快门"）。
   */
  const low = confidence === "low";
  const quadColor = low ? HANDLE_COLOR_LOW : HANDLE_COLOR_HIGH;
  const quadGlow = low ? "rgba(245,158,11,0.7)" : "rgba(0,212,255,0.7)";
  const quadFill = low ? "rgba(245,158,11,0.10)" : "rgba(0,212,255,0.08)";
  // 四角的"∟"：每个角两条边（用 border 拼），刻意**不画整框** —— 免得被当成裁剪框
  const brackets = [
    { left: g.x0, top: g.y0, tx: "0", ty: "0", borders: { borderTop: true, borderLeft: true } },
    { left: g.x1, top: g.y0, tx: "-100%", ty: "0", borders: { borderTop: true, borderRight: true } },
    { left: g.x1, top: g.y1, tx: "-100%", ty: "-100%", borders: { borderBottom: true, borderRight: true } },
    { left: g.x0, top: g.y1, tx: "0", ty: "-100%", borders: { borderBottom: true, borderLeft: true } },
  ];
  const quad = corners
    ? CORNER_KEYS.map((k) => `${corners[k].x * 100},${corners[k].y * 100}`).join(" ")
    : "";

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* 水平参考线：帮她把纸放平（歪没歪一眼能看出来） */}
      <div
        className="absolute left-0 right-0 top-1/2 border-t border-dashed"
        style={{ borderColor: "rgba(255,255,255,0.25)" }}
      />
      {/* 1.414 参考框的四角小直角 */}
      {brackets.map((b, i) => (
        <div
          key={i}
          className="absolute h-6 w-6"
          style={{
            left: pct(b.left),
            top: pct(b.top),
            transform: `translate(${b.tx}, ${b.ty})`,
            borderColor: guideColor,
            borderStyle: "solid",
            borderWidth: 0,
            borderTopWidth: b.borders.borderTop ? 2 : 0,
            borderBottomWidth: b.borders.borderBottom ? 2 : 0,
            borderLeftWidth: b.borders.borderLeft ? 2 : 0,
            borderRightWidth: b.borders.borderRight ? 2 : 0,
          }}
        />
      ))}
      {/* 认到的纸边（青色；与审核页"高置信=青色"同一套语义） */}
      {corners && (
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <polygon
            points={quad}
            fill={quadFill}
            stroke={quadColor}
            strokeWidth={2}
            strokeDasharray={low ? "8 5" : undefined}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {/* 四个角点用 div 画（不用 SVG circle）：viewBox 被非等比拉伸，
          circle 会变成椭圆 —— div + translate(-50%,-50%) 才是正圆。 */}
      {corners &&
        CORNER_KEYS.map((k) => (
          <div
            key={k}
            className="absolute h-3 w-3 rounded-full"
            style={{
              left: pct(corners[k].x),
              top: pct(corners[k].y),
              transform: "translate(-50%,-50%)",
              background: quadColor,
              boxShadow: `0 0 6px ${quadGlow}`,
            }}
          />
        ))}
    </div>
  );
}

export const DocScanner = forwardRef<DocScannerHandle, DocScannerProps>(
  function DocScanner({ onScanComplete, onClose, burstMode = false, onBurstShot, burstCount = 0 }, ref) {
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

    /* ==================== 【2026-10-08】预览实时提示四角（实验开关）====================
     * 他提的想法：现在拍照是"先拍、后校对四角"，他想在按快门之前就看到软件认出的纸边。
     * 现状盘点：找角算法（findPaperCorners）、OpenCV 按需加载、坐标换算**都已经有了**，
     * 拍完也已经在自动找角；这一层只是把同一个算法**每 280ms 拿到取景帧上跑一次**，
     * 稳了才画出来（判稳见 lib/doc-live-corners）。
     *
     * ⚠️ 三条刻意的边界：
     *   ① **默认关**、记住上次选择 ⇒ 不勾就与老版本一字不差（他说这版只当测验，不合适就关掉）；
     *   ② 只有 `high` 档才参与显示 —— low/none 时宁可什么都不画，也不让框乱晃误导人；
     *   ③ 显示用**归一化坐标**，叠加层用百分比定位 ⇒ 不必知道预览显示成多少像素
     *      （"框和纸错位"最常见的成因就是拿容器尺寸当画面尺寸，这里从根上避开）。
     */
    const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
    /** 最近几帧的结果（null = 这一帧没得出可用结果） */
    const liveFramesRef = useRef<(Corners | null)[]>([]);
    /** 与上面对齐的置信档（用来判断这一窗结果整体算"确定"还是"估算"） */
    const liveConfRef = useRef<(CornerConfidence | null)[]>([]);
    /** 判稳后、已平滑的显示角点（归一化 0..1）；null = 现在不该画 */
    const [liveCorners, setLiveCorners] = useState<Corners | null>(null);
    /**
     * 【2026-10-09 他的反馈】预览里**琥珀色（估算档）也要显示**。
     *
     * 他的原话："只有将纸张框为青色框的时候才会显示出来，琥珀色框是不会显示的，
     * 事实上很多时候琥珀色框也是对的，但在预览不到的情况下，用户迟迟不敢下定决心拍摄
     * ……只要有识别出来的框就显示出来然后动态调整，这样用户才比较有信心和比较。"
     *
     * 判断：这条要求是对的。审核页里 low 档**本来就默认参与拉正**（只把把手画成琥珀虚线
     * 提示"这是估算"），所以预览里把它藏起来，等于让用户在最需要参照的时刻失去参照。
     * 现在改成"认到就画"，用**颜色**表达可信度：青色=确定，琥珀=估算（与审核页同一套语义）。
     * ⚠️ 判稳那一关不放松（仍然要连续 3 帧对得上），否则会变成"框乱晃"，比不画更糟。
     */
    const [liveConfidence, setLiveConfidence] = useState<CornerConfidence | null>(null);
    /** 这一层是否可用（OpenCV 就绪）。就绪前勾上会显示"正在准备…" */
    const [liveCvReady, setLiveCvReady] = useState(false);
    /** 取景画面的宽高比（用于算参考框的比例；流尺寸还没拿到时为 null） */
    const [liveFrameSize, setLiveFrameSize] = useState<{ w: number; h: number } | null>(null);
    /**
     * 开关本身。惰性初值：读 localStorage（他只在本机浏览器上用，不涉隐私）。
     * 【2026-10-08 他第 2 条】**缺省改成选中** —— 他试过之后觉得好用，
     * 所以只有**明确关过**（存了 "0"）才不勾；没存过就默认开。
     */
    const [liveOn, setLiveOn] = useState<boolean>(() => {
      if (typeof window === "undefined") return true;
      try {
        return window.localStorage.getItem(LIVE_CORNERS_KEY) !== "0";
      } catch {
        return true;
      }
    });

    const setLiveOnPersist = useCallback((v: boolean) => {
      setLiveOn(v);
      try {
        window.localStorage.setItem(LIVE_CORNERS_KEY, v ? "1" : "0");
      } catch {
        /* 隐私模式下写不进去，不影响本次使用 */
      }
    }, []);


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
    /**
     * 【custom-v26 连拍】「用原图」在连拍模式下不是"立刻出图"，而是一个**开关**：
     * 出图动作交给「再拍一张」/「完成」，所以必须先记住"这张要不要放弃拉正美化"。
     * 单张模式不走这个状态（那边点「用原图」就直接出图，保持原行为）。
     */
    const [useOrig, setUseOrig] = useState(false);
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
      /**
       * 【custom-v26】开新流之前先停掉旧流。
       *
       * 拍完照那条流是**故意留着**的（「重拍」要能立刻回到取景，不必重新授权），
       * 但以前 startCamera 是直接覆盖 streamRef —— 旧流没人 stop，就一直挂着：
       * 单张模式点一次「重拍」泄漏一条；连拍模式拍 10 张就是 10 条流同时活着
       * （摄像头指示灯不灭、手机发热耗电，部分浏览器还会直接拒绝再开新流）。
       */
      stopCamera();
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
            // 参考框要按**画面本身**的比例画（见 guideBox 的注释）
            setLiveFrameSize({ w: s.width, h: s.height });
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
    }, [stopCamera]);

    /* ==================== 【2026-10-08】逐帧找角（只在取景页 + 开关打开时跑）====================
     * 节奏：约每 280ms 抓一帧 → 缩到 800 宽（与算法内部 DETECT_WIDTH 对齐，互不 resize）
     *      → findPaperCorners → 归一化 → 进判稳缓冲 → 稳了才 setLiveCorners。
     *
     * ⚠️ 三件事必须做对，否则会变成"框乱晃"或"手机发烫"：
     *   ① **只在 `mode === "camera" && videoReady && liveOn` 时跑**，其余情况（进了审核页、
     *      拍完 stopCamera、用户关开关、组件卸载）一律停 —— 所以依赖数组就是这三样；
     *   ② **单帧失败不许中断循环**（弱光/反光下随时可能认不出）：try/catch 包住，
     *      这一帧记 null，等下一帧；
     *   ③ **Mat 立刻释放**：这个项目为 Mat 泄漏吃过亏（4K 图一帧就几十 MB）。
     */
    useEffect(() => {
      if (!open || mode !== "camera" || !videoReady || !liveOn) {
        // 关掉/离开时把显示清干净，别让上一帧的框留在画面上
        liveFramesRef.current = [];
        liveConfRef.current = [];
        setLiveCorners(null);
        setLiveConfidence(null);
        return;
      }
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const tick = async () => {
        if (stopped) return;
        try {
          const cv = cvRef.current ?? (await loadOpenCV());
          if (stopped) return;
          cvRef.current = cv;
          setLiveCvReady(true);

          const v = videoRef.current;
          if (!v || !v.videoWidth || !v.videoHeight) {
            timer = setTimeout(tick, LIVE_INTERVAL_MS);
            return;
          }
          // ⚠️ 只在真的变了才 setState：这个 effect 每秒跑 3~4 次，
          //    每次都塞一个**新对象**会让整个组件白白重渲染（手机上就是白耗电）。
          setLiveFrameSize((prev) =>
            prev && prev.w === v.videoWidth && prev.h === v.videoHeight
              ? prev
              : { w: v.videoWidth, h: v.videoHeight },
          );

          // 抓帧：只画到 800 宽的小画布（4K 直接进算法没必要，见 LIVE_DETECT_WIDTH 注释）
          const cw = LIVE_DETECT_WIDTH;
          const ch = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * cw));
          let canvas = liveCanvasRef.current;
          if (!canvas) {
            canvas = document.createElement("canvas");
            liveCanvasRef.current = canvas;
          }
          if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
          }
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(v, 0, 0, cw, ch);
            // ⚠️ 类型写成 `ReturnType<typeof imageToMat>` 而不是裸 `any`：
            //    本项目有"lint 基线门禁（error 只许降不许涨）"，多加一个显式 any 就会顶掉门禁；
            //    而 imageToMat 的返回本来就是 OpenCV 的 Mat，借用它的返回类型既准确又不违规。
            let mat: ReturnType<typeof imageToMat> | null = null;
            try {
              mat = imageToMat(cv, canvas);
              const found = findPaperCorners(cv, mat);
              /**
               * 【2026-10-09】high / low **都参与显示**（只排除 none）。
               * 颜色区分可信度，语义与审核页一致：青色=严格档确定，琥珀=降级链估算。
               * 他要的就是这个 —— "只要有识别出来的框就显示出来"，才敢下决心按快门。
               */
              const usable = !!found.corners && found.confidence !== "none";
              liveFramesRef.current = [
                ...liveFramesRef.current,
                usable ? toNormCorners(found.corners as Corners, cw, ch) : null,
              ].slice(-LIVE_FRAMES);
              liveConfRef.current = [
                ...liveConfRef.current,
                usable ? found.confidence : null,
              ].slice(-LIVE_FRAMES);

              const settled = settleCorners(liveFramesRef.current);
              setLiveCorners(settled);
              // 这一窗里**只要有一帧是估算**，整体就按估算显示（保守：不把"估算"说成"确定"）
              setLiveConfidence(
                settled ? (liveConfRef.current.includes("low") ? "low" : "high") : null,
              );
            } finally {
              mat?.delete?.();
            }
          }
        } catch {
          // 单帧出问题（OpenCV 没就绪 / 抓帧失败）→ 丢掉这一帧，下一轮再试
          liveFramesRef.current = [...liveFramesRef.current, null].slice(-LIVE_FRAMES);
          liveConfRef.current = [...liveConfRef.current, null].slice(-LIVE_FRAMES);
          setLiveCorners(null);
          setLiveConfidence(null);
        }
        if (!stopped) timer = setTimeout(tick, LIVE_INTERVAL_MS);
      };

      // 首帧稍微推迟一点，避免和"相机刚起来"抢主线程
      timer = setTimeout(tick, 60);
      return () => {
        stopped = true;
        if (timer != null) clearTimeout(timer);
        liveFramesRef.current = [];
        setLiveCorners(null);
      };
    }, [open, mode, videoReady, liveOn]);

    /** 把图片载入审核态，并自动找纸张四角 */
    const loadImgAndReview = useCallback(
      async (dataUrl: string, sizeNote?: string, preset?: Corners | null) => {
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
            //
            // 【2026-10-08 他第 1 条】有 `preset` 就**直接用、不再重找**：
            // 那是他按快门时预览里已经认准的四个角（他自己的话说："本来框准了拍摄的，
            // 结果拍出来又重找一遍，反而找不对了"）。只在"照片与预览同一画幅"时才会传进来
            //（判据在 presetFromLive 里，画幅一变就不敢照搬）。
            const found = preset
              ? { corners: preset, confidence: "high" as CornerConfidence, stage: "live-preset" }
              : findPaperCorners(cv, full);
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
      setUseOrig(false);
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

      /**
       * 【2026-10-08 他第 1 条】把"按快门时预览里已经认准的四个角"一并带进审核态。
       *
       * 只在**照片与预览同一画幅**时才会真的带上（判据在 presetFromLive 里）——
       * 因为 `takePhoto()` 可能换成 4:3 之类的另一种传感器模式，画幅一变，
       * 纸在照片里的位置整体都不同，照搬预览的角会错得更离谱。
       */
      const preset = presetFromLive({
        live: liveOn ? liveCorners : null,
        stillW: w,
        stillH: h,
        frameW: liveFrameSize?.w ?? v.videoWidth,
        frameH: liveFrameSize?.h ?? v.videoHeight,
      });

      stopCamera();
      setShotSize(`实拍 ${w}×${h}（${((w * h) / 1e6).toFixed(1)}MP）`);
      loadImgAndReview(dataUrl, undefined, preset);
    }, [loadImgAndReview, stopCamera, videoReady, liveOn, liveCorners, liveFrameSize]);

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

      /**
       * 【2026-10-08 他第 3 条】把手改成三处画法，目的只有一个：
       * 让他一眼看清"**圆心到底压在纸角上没有**"。
       *   ① 圆**不再实心** —— 只留一圈细边 + 很淡的填充，底下的纸角能透出来；
       *   ② 四边形折线**画在圆的上面**，于是四条边一直连到圆心（就是他要的"边与圆心的连线"）；
       *   ③ 圆心补一个实心小点（外描一圈白边，深色纸上也看得见）—— 判"准不准"最终看这个点。
       */
      const HANDLE_R = 12;
      pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = low ? "rgba(245,158,11,0.14)" : "rgba(0,212,255,0.14)";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.stroke();
      });

      // 折线压在圆上面：四条边一直画到圆心
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(low ? LOW_CONFIDENCE_DASH : []);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // 圆心：实心小点（最后画，永远在最上层）
      pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      /* ===== 【2026-10-08 他第 1 条】拖动时的放大镜 =====
         他的需求：拖把手时"只能凭感觉挪位置，我需要一点精确的指示"，
         并自己指定了位置 —— 显示在**对面那个角**（手指挡住的地方看不见，
         对面正好空着）。这是成熟做法（iOS 选字、Excalidraw 等都用），照做。
         我额外加了一行百分比：判断"左右两个角是否对称"时比肉眼靠谱。
         ⚠️ 只在拖动中画，松手立刻消失 —— 不挡他看整张纸。 */
      const dk = dragRef.current;
      if (dk) {
        const hx = corners[dk].x * s;
        const hy = corners[dk].y * s;
        const lw = Math.round(Math.min(ov.width, ov.height) * LOUPE_RATIO);
        const M = 12;
        const rr = 10;
        /**
         * 【2026-10-09 他第 1 条】放大镜放在**哪一角**（他给的规则，照做）：
         *   · 把手在图片**左半边** ⇒ 放大镜在**右上角**；
         *   · 把手在图片**右半边** ⇒ 放大镜在**左上角**；
         *   · 纵向**一律贴顶**（不再看上下）。
         *
         * 为什么改：原先放的是"**对角**"（左上↔右下）。他右手拖**左上角**那个把手时，
         * 放大镜飞到屏幕右下 —— 手和眼睛要分头跑，很不便。
         * 他的判断是：真正要避开的只是"手指压住把手"这件事，那是**左右**方向的遮挡，
         * 所以只在**水平方向**镜像就够了；纵向固定在顶部，位置永远是可预期的那一处。
         */
        const leftHalf = corners[dk].x < img.width / 2;
        const lx = leftHalf ? ov.width - M - lw : M;
        const ly = M;
        const roundRect = () => {
          ctx.beginPath();
          ctx.moveTo(lx + rr, ly);
          ctx.arcTo(lx + lw, ly, lx + lw, ly + lw, rr);
          ctx.arcTo(lx + lw, ly + lw, lx, ly + lw, rr);
          ctx.arcTo(lx, ly + lw, lx, ly, rr);
          ctx.arcTo(lx, ly, lx + lw, ly, rr);
          ctx.closePath();
        };

        ctx.save();
        // ① 放大镜内容：圆角矩形裁剪 → 把坐标系挪成"以被拖的点为中心、放大 LOUPE_ZOOM 倍"
        roundRect();
        ctx.clip();
        ctx.fillStyle = "#0b1220";
        ctx.fillRect(lx, ly, lw, lw);
        ctx.translate(lx + lw / 2, ly + lw / 2);
        ctx.scale(LOUPE_ZOOM, LOUPE_ZOOM);
        ctx.translate(-hx, -hy);
        // 画面本身（与叠加层同一套显示坐标，所以下面画的纸边天然对得上）
        ctx.drawImage(img, 0, 0, display.w, display.h);
        // 纸的四条边（线宽除以倍数 ⇒ 屏幕上看起来仍是原来的粗细）
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 / LOUPE_ZOOM;
        ctx.setLineDash(low ? LOW_CONFIDENCE_DASH.map((v) => v / LOUPE_ZOOM) : []);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(hx, hy, HANDLE_R / LOUPE_ZOOM, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 / LOUPE_ZOOM;
        ctx.stroke();
        ctx.restore();

        // ② 镜框
        roundRect();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // ③ 十字准心（正中留缺口 —— 那一点就是"圆心"，别被线盖住）+ 圆心小点
        const cxp = lx + lw / 2;
        const cyp = ly + lw / 2;
        const gap = 7;
        const arm = 14;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cxp - gap - arm, cyp);
        ctx.lineTo(cxp - gap, cyp);
        ctx.moveTo(cxp + gap, cyp);
        ctx.lineTo(cxp + gap + arm, cyp);
        ctx.moveTo(cxp, cyp - gap - arm);
        ctx.lineTo(cxp, cyp - gap);
        ctx.moveTo(cxp, cyp + gap);
        ctx.lineTo(cxp, cyp + gap + arm);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cxp, cyp, 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // ④ 角标 + 数字（"距左 12.0% · 距下 8.0%"这种，用来判断对称）
        const pctX = (corners[dk].x / img.width) * 100;
        const pctY = (corners[dk].y / img.height) * 100;
        const info = `${CORNER_LABEL[dk]}　x ${pctX.toFixed(1)}% · y ${pctY.toFixed(1)}%`;
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.textBaseline = "middle";
        const tw = ctx.measureText(info).width;
        const bx = Math.max(M, Math.min(ov.width - M - tw - 12, lx));
        // 放大镜在下半屏 → 文字放它上面；在上半屏 → 放下面（永远不越出画布）
        const by = ly > ov.height / 2 ? ly - 26 : Math.min(ly + lw + 8, ov.height - 22);
        ctx.fillStyle = "rgba(15,23,42,0.85)";
        ctx.fillRect(bx, by, tw + 12, 20);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(info, bx + 6, by + 10);
      }
    }, [corners, display, cornerConfidence, dragging]);

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
      (useOriginal: boolean, action?: "again" | "done") => {
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
              if (blob) {
                // 【custom-v26 连拍】连拍模式下每张图连同「还要不要继续拍」一起回传，
                // 由调用方决定往队列里堆；单张模式维持原样。
                if (burstMode && onBurstShot && action) onBurstShot(blob, action);
                else onScanComplete(blob);
              }
              setBusy(false);
              if (burstMode && action === "again") {
                // 连拍：留在扫描器里，回到取景继续拍。
                // 与「重拍」走同一条复位路径（下一张 loadImgAndReview 会释放上一张的 Mat）。
                setUseOrig(false);
                setConfirmUseOriginal(false);
                setMode("camera");
                startCamera();
              } else {
                closeAll();
              }
            },
            "image/jpeg",
            OUTPUT_QUALITY
          );
        } catch (e) {
          console.warn("[doc-scanner] 出图失败:", e);
          setBusy(false);
        }
      },
      [corners, cornersActive, enhance, onScanComplete, closeAll, burstMode, onBurstShot, startCamera]
    );

    /** 「用原图」二次确认：避免误触丢掉自动拉正与美化（蓝图 #5 要求） */
    const handleUseOriginal = () => {
      // 【custom-v26 连拍】连拍模式下这是个**开关**而不是"立刻出图"：
      // 出图由「再拍一张 / 完成」触发，这里只决定这张要不要放弃拉正美化。
      if (burstMode) {
        setUseOrig((v) => !v);
        return;
      }
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
            {/* 【2026-10-08】拍完的一句诊断：把**已有的**置信档说成人话。
                以前只有"青色/琥珀色把手"这一个隐晦信号，用户得自己知道颜色的含义；
                现在直接写出来，省的正是他说的那种"拍完才发现歪了、要重拍"。
                ⚠️ 只在他还没动过把手时显示（`!manualWarp`）—— 一旦他开始拖，
                   这句诊断就没意义了，页面上另有一句拖动提示。 */}
            {mode === "review" && !manualWarp && (
              <span
                className="ml-2 text-xs"
                style={{
                  color: cornerConfidence === "high" ? HANDLE_COLOR_HIGH : HANDLE_COLOR_LOW,
                }}
              >
                {cornerConfidence === "high"
                  ? TEXT.diagHigh
                  : cornerConfidence === "low"
                    ? TEXT.diagLow
                    : TEXT.diagNone}
              </span>
            )}
            {burstMode && burstCount > 0 && (
              <span className="ml-2 text-xs text-[#00D4FF]">
                已拍 {burstCount} 张
              </span>
            )}
          </div>
          <Button variant="ghost" className="text-white" onClick={closeAll}>
            {TEXT.close}
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {mode === "camera" ? (
            <div className="space-y-4">
              {/* 【2026-10-08】画面 + 叠加层。
                  容器**贴着画面**（video 用 w-auto/h-auto 由浏览器按比例撑出内容尺寸），
                  叠加层再 `absolute inset-0` ⇒ 与画面严格重合。
                  ⚠️ 不能直接把叠加层放在"占满宽度的容器"上：那时容器尺寸 ≠ 画面尺寸
                     （有黑边/留白），框就会跟纸错位。 */}
              <div className="relative mx-auto w-fit max-w-full">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  onLoadedMetadata={(e) => {
                    setVideoReady(true);
                    const v = e.currentTarget;
                    // 真实画面尺寸以元素为准（降级路径拿不到 track settings）
                    if (v.videoWidth) {
                      setLiveFrameSize((prev) =>
                        prev && prev.w === v.videoWidth && prev.h === v.videoHeight
                          ? prev
                          : { w: v.videoWidth, h: v.videoHeight },
                      );
                    }
                  }}
                  onCanPlay={() => setVideoReady(true)}
                  className="block h-auto max-h-[60vh] w-auto max-w-full rounded-lg bg-black"
                />
                {liveOn && liveFrameSize && (
                  <LiveGuideOverlay
                    frameW={liveFrameSize.w}
                    frameH={liveFrameSize.h}
                    corners={liveCorners}
                    confidence={liveConfidence}
                  />
                )}
              </div>

              {/* 开关：只在取景页、默认关、记住上次选择。关掉 = 与老版本一字不差。 */}
              <label className="flex flex-wrap items-center justify-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={liveOn}
                  onChange={(e) => setLiveOnPersist(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[#00D4FF]"
                />
                {TEXT.liveToggle}
                {liveOn && (
                  <span className="text-slate-500">
                    ·{" "}
                    {!liveCvReady
                      ? TEXT.livePreparing
                      : liveCorners
                        ? liveConfidence === "low"
                          ? TEXT.liveFoundLow
                          : TEXT.liveFound
                        : TEXT.liveSearching}
                  </span>
                )}
              </label>

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
                    setUseOrig(false); // 重拍是换一张，上一张的「用原图」选择不该继承
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
                    (burstMode ? useOrig : confirmUseOriginal)
                      ? "border-amber-400 text-amber-400 hover:bg-amber-400/10 hover:text-amber-400"
                      : "text-[#00D4FF] border-[#00D4FF]/60 hover:bg-[#00D4FF]/10 hover:text-[#00D4FF]"
                  }
                  onClick={handleUseOriginal}
                  disabled={busy}
                >
                  {burstMode
                    ? (useOrig ? TEXT.useOriginalOn : TEXT.useOriginal)
                    : (confirmUseOriginal ? TEXT.useOriginalAgain : TEXT.useOriginal)}
                </Button>
                {burstMode ? (
                  <>
                    {/* 连拍：出这张 → 留在扫描器继续拍（扫描器不关闭，见 finalize） */}
                    <Button
                      onClick={() => finalize(useOrig, "again")}
                      disabled={busy || !!cvError}
                      className="text-[#00D4FF] border-[#00D4FF]/60 hover:bg-[#00D4FF]/10 hover:text-[#00D4FF]"
                      variant="outline"
                    >
                      <Camera className="mr-1 h-4 w-4" /> {TEXT.burstAgain}
                    </Button>
                    {/* 连拍：出这张 → 关闭扫描器，回到批量页 */}
                    <Button
                      onClick={() => finalize(useOrig, "done")}
                      disabled={busy || !!cvError}
                      className="bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90"
                    >
                      <Check className="mr-1 h-4 w-4" /> {TEXT.burstDone}
                    </Button>
                  </>
                ) : (
                  <Button
                    onClick={() => finalize(false)}
                    disabled={busy || !!cvError}
                    className="bg-[#00D4FF] text-slate-900 border-0 hover:bg-[#00D4FF]/90"
                  >
                    <Check className="mr-1 h-4 w-4" /> {TEXT.confirm}
                  </Button>
                )}
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
