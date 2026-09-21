"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { DocScanner, type DocScannerHandle } from "@/components/doc-scanner";
import { rotateCanvasSize, rotateRectCCW } from "@/lib/image-rotation";

interface ImageCropperProps {
    imageSrc: string;
    open: boolean;
    onClose: () => void;
    onCropComplete: (croppedImageBlob: Blob) => void;
    /**
     * 送 AI 进行中。
     * 【custom-v20 问题②】对话框此时**保持打开**（失败才不丢编辑成果），
     * 因而页面上那套进度提示被对话框盖住了，需要由编辑器自己给一个"正在分析"的反馈，
     * 并锁住「确定」避免重复提交。
     */
    analyzing?: boolean;
    /**
     * 【custom-v22 循环模式】本页**已经抠走并入库**的题目区域，坐标为**整页自然坐标**。
     * 仅作视觉标记（半透明遮罩 + 序号），用来避免同一道被重复抠。
     * 只在尚未做"裁剪即提取"时绘制——一旦裁过，工作画布已换成裁剪后的小图，
     * 坐标系随之改变，旧标记不再对应。
     */
    doneRects?: DoneRect[];
    /**
     * 【custom-v22 循环模式】确认时回传本次框选的区域（**整页自然坐标**）。
     * 调用方据此把它加进 doneRects。用户没拖裁剪框（整图直送）时为 null。
     */
    onCropRegion?: (rect: { x: number; y: number; w: number; h: number } | null) => void;
    /**
     * 【custom-v22 循环模式】"本页已录 N 道"的提示，显示在编辑器标题右侧。
     * 不传则不显示（非循环模式）。
     */
    loopCount?: number;
    /**
     * 【custom-v25 绿框】一张图上画了「区🟩」时，确认后是**一次交出多张**（一区一张），
     * 所以不能再走单张的 onCropComplete。
     *
     * 传了它 → 画了绿框就走批量；没画绿框仍走 onCropComplete（老路径完全不变）。
     * 没传它 → 绿框退化成"只按第一个区裁一张"，至少不会把整幅图连框外内容一起送出去。
     *
     * ⚠️ 调用方必须自己处理"多张"：批量上传把它并进队列，
     *    单题流（首页 / 错题本内添加）应切到批量流程，
     *    绝不能只取 blobs[0] 把其余几张默默丢掉。
     */
    onCropBatch?: (blobs: Blob[]) => void;
}

/** 循环模式下已抠走的区域（整页自然坐标） */
export interface DoneRect {
    x: number;
    y: number;
    w: number;
    h: number;
    /** 第几道（从 1 开始），画成圈号 */
    index: number;
}

// ============================================================
//  图片编辑模式：裁剪(原有) / 橡皮擦(涂白) / 区域标注(题干·手写答案)
// ============================================================
type Mode = "crop" | "erase" | "label";
/**
 * 【custom-v25】region = 绿框「区🟩」。
 * 语义与前两种**不同**：红/蓝框是"把这段内容告诉 AI 是什么"，绿框是"这一块就是一道题"，
 * 它同时承担了裁剪边界 —— 有绿框时 cropRect 不再参与导出。
 */
type LabelKind = "question" | "answer" | "region";
type EraseTool = "brush" | "rect";

/** 已提交的擦除图形（自然坐标）。白色填充可重叠且幂等，因此可按顺序重放来实现精确撤销。 */
type Shape =
    | { kind: "stroke"; pts: { x: number; y: number }[]; width: number }
    | { kind: "rect"; x: number; y: number; w: number; h: number };

/** 区域标注框（自然坐标，确认时烘焙进像素） */
interface Box {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    kind: LabelKind;
}

const QUESTION_COLOR = "#e50000"; // 红 = 题干
const ANSWER_COLOR = "#0055ff";   // 蓝 = 手写答案
/**
 * 绿 = 一道题的范围（区🟩）。
 * 刻意选偏深的绿：编辑器里「已录入」的标记是 #00c853 的虚线半透明遮罩，
 * 这里用实线 + 深一点的颜色，两者同框出现时也能一眼分开。
 */
const REGION_COLOR = "#009a4c";
const BRUSH_SIZES = [10, 20, 40, 80];
/**
 * 【custom-v24】笔头粗细四档的按钮文案。
 * 用户要求四档统一显示同一个圈，用**字号从小到大**表达由细到粗（不写「小/中/大/特大」四个字）。
 * 档位中文名挪进 title，鼠标悬停仍有提示，但不再占版面宽度。
 * 【custom-v25】实心圆 🔘 换成空心圆 ⚪（用户指定），四档仍靠字号递进。
 * ⚠️ BRUSH_LABELS / BRUSH_TITLES / BRUSH_FONT_PX 三个数组必须同长同序，改一处就得改三处。
 */
const BRUSH_LABELS = ["⚪", "⚪", "⚪", "⚪"];
const BRUSH_TITLES = ["小", "中", "大", "特大"];
const BRUSH_FONT_PX = [11, 14, 18, 23];

// ===== 缩放模型常量 =====
// zoom 语义：1 = 图片自然像素 1:1（不再靠 CSS 百分比偶然适配）
const MIN_ZOOM = 0.05;  // 下限：超大图也能整体看清
const MAX_ZOOM = 8;     // 上限：看手写字够用
const FIT_PAD = 16;     // 「适应窗口」时四周留白（px）
const FIT_MAX = 2;      // 「适应窗口」最多放大到 2 倍，避免小图被放大到糊

function normalizeRect(r: { x: number; y: number; w: number; h: number }) {
    return {
        x: Math.min(r.x, r.x + r.w),
        y: Math.min(r.y, r.y + r.h),
        w: Math.abs(r.w),
        h: Math.abs(r.h),
    };
}

/** 两矩形是否相交（边界接触也算） */
function rectsIntersect(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * 【custom-v25 绿框】把重叠（含互相包含）的绿框并成一组，每组取**并集包围盒**。
 *
 * 为什么用"连通分量"而不是"两两合并后重扫"：A∩B、B∩C 但 A∩C=∅ 时，
 * 三个框其实是同一片连续区域，必须并成一道题 —— 简单两两合并会漏掉这种传递关系，
 * 于是同一道题被切成两块分别送去分析。
 *
 * 异形排布也能覆盖：用户只要让绿框彼此搭上边，就会并成一个包得住两者的矩形。
 */
function mergeRegions(regions: { x: number; y: number; w: number; h: number }[]) {
    const n = regions.length;
    if (n === 0) return [];
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a: number, b: number) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (rectsIntersect(regions[i], regions[j])) union(i, j);
        }
    }
    const groups = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    regions.forEach((r, i) => {
        const root = find(i);
        const g = groups.get(root);
        const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
        if (!g) groups.set(root, { x0, y0, x1, y1 });
        else {
            g.x0 = Math.min(g.x0, x0); g.y0 = Math.min(g.y0, y0);
            g.x1 = Math.max(g.x1, x1); g.y1 = Math.max(g.y1, y1);
        }
    });
    // 按阅读顺序（上→下、左→右）输出，方便与"第 1 道 / 第 2 道"的直觉对上
    return [...groups.values()]
        .map((g) => ({ x: g.x0, y: g.y0, w: g.x1 - g.x0, h: g.y1 - g.y0 }))
        .filter((r) => r.w > 4 && r.h > 4)
        .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** 在 canvas 上画一个带圈数字（分图序号水印），中心 (cx,cy)，半径 r */
function drawCircledNumber(
    ctx: CanvasRenderingContext2D,
    n: number,
    cx: number,
    cy: number,
    r: number,
) {
    ctx.save();
    ctx.strokeStyle = "#00c853";
    ctx.fillStyle = "#00c853";
    ctx.lineWidth = Math.max(1.5, r * 0.18);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), cx, cy + r * 0.04);
    ctx.restore();
}

export function ImageCropper({
    imageSrc,
    open,
    onClose,
    onCropComplete,
    analyzing = false,
    doneRects,
    onCropRegion,
    loopCount,
    onCropBatch,
}: ImageCropperProps) {
    const { t } = useLanguage();

    /**
     * 【custom-v22 循环模式】本次框选区域的**整页自然坐标**。
     * 为什么要用 ref 而不是直接读 cropRect：
     * 「裁剪即提取」(bakeCropIntoBase) 会把整个基准画布换成裁剪后的小图、
     * 并把 cropRect 清空，坐标系从此改变 —— 那时再读 cropRect 已经拿不到整页坐标了。
     * 所以必须在烘焙发生**之前**就把坐标记下来。
     */
    const lastCropRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

    /**
     * 【custom-v22 循环模式】**已抠标记的坐标系是否已失效**。
     *
     * 标记存的是「整页自然坐标」，只有基准画布仍等于**未经变形的整页**时才对得上。
     * 会打掉它的操作：
     *   · 拉伸（handleStretchDone）—— 基准换成矫正后的图，尺寸、比例全变
     *     （裁剪即提取那次不用它管，`isCroppedRef` 已经覆盖）
     * 会恢复它的操作：
     *   · 「原图」键（回到最初的整页）、新一轮打开编辑器
     *
     * 失效后：① 回传 null，绝不把错坐标记进 doneRects（否则一道拉伸过的题
     * 会把后面几道的绿框全带偏）；② 停止绘制已有标记。
     * 宁可这一道没有标记，也不能给一个位置错误的绿框。
     */
    const rectSpaceStaleRef = useRef(false);

    // ===== 新增状态 =====
    const [mode, setMode] = useState<Mode>("crop");
    const [eraseTool, setEraseTool] = useState<EraseTool>("brush");
    const [brushIdx, setBrushIdx] = useState(1);
    const [labelKind, setLabelKind] = useState<LabelKind>("question");
    const [boxes, setBoxes] = useState<Box[]>([]);
    const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
    const [pendingRect, setPendingRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
    const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
    const [cropToRegions, setCropToRegions] = useState(false);
    const [hasShapes, setHasShapes] = useState(false);
    const [ready, setReady] = useState(false);
    /**
     * 【custom-v33】「本页已录入」绿框的本地副本。
     *
     * 原先直接画 prop 传进来的 doneRects 就够了，加了「🔄转」之后不行了 ——
     * 旋转会让整页坐标系转一次，绿框若不跟着转，就会停在错的位置上。
     * prop 我们不能改，所以留一份副本：prop 一变就整体同步过来，旋转时把副本里的框一起搬。
     */
    const [doneRectsView, setDoneRectsView] = useState<DoneRect[]>([]);
    // 调用方一给新值（比如又录进去一道题）就整体同步，本地不做增量合并
    useEffect(() => { setDoneRectsView(doneRects ?? []); }, [doneRects]);
    const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

    // ===== 画布引用 =====
    const origCanvasRef = useRef<HTMLCanvasElement | null>(null);   // 原始图（撤销重放的基准）
    const workCanvasRef = useRef<HTMLCanvasElement | null>(null);   // 工作画布（原图 + 已擦除）
    const shapesRef = useRef<Shape[]>([]);
    const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);   // 可见层：工作画布内容
    const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null); // 可见层：标注框 + 绘制预览
    const drawingRef = useRef<Shape | null>(null);
    const isCroppedRef = useRef(false); // 已经过“裁剪即提取”，工作画布已是裁剪后的图

    // ===== 缩放 / 平移视图（手机双指捏合 + 电脑滚轮 + 双击） =====
    // zoom：1 = 图片自然像素 1:1；view：图片左上角在视口内的绝对位移（渲染用）
    // pan：相对「居中位置」的偏移（手势用，钳制到 ±(显示尺寸-视口)/2）
    const [zoom, setZoom] = useState(1);
    const [view, setView] = useState({ x: 0, y: 0 });
    const [natSize, setNatSize] = useState({ w: 0, h: 0 }); // 画布自然像素，供 wrapper/overlay 定尺
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const zoomRef = useRef(1);
    const panRef = useRef({ x: 0, y: 0 });
    const viewRef = useRef({ x: 0, y: 0 });
    const natSizeRef = useRef({ w: 0, h: 0 });
    const autoFitRef = useRef(true); // 是否仍处于「自动适应窗口」状态（用户一缩放/平移即为 false）
    const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
    const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);
    const panDragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
    const spaceRef = useRef(false);
    /** 【custom-v27 仅画】按住 Shift 时临时进入「仅画」——见 drawOnly 的说明 */
    const shiftRef = useRef(false);

    // ===== 平移开关 + 右键拖拽平移 =====
    const [panMode, setPanMode] = useState(false);
    /**
     * 【custom-v27 仅画】区域标注页的「强制画框」开关（用户命名「仅画」）。
     *
     * 选中后起手即画新框，不再"点中已有框就选中它" —— 解决"正想画框、
     * 却因为落点靠近旧框而被吃成选中"这个难以根治的矛盾。
     * 电脑端按住 Shift 亦**临时**进入此态（松开即回到由本开关决定），见 onPointerDown。
     */
    const [drawOnly, setDrawOnly] = useState(false);
    /**
     * 【custom-v27 十字基准线】指针在**视口坐标**下的位置。
     * 用视口坐标而非容器坐标：容器被 scale(zoom) 缩放，缩放/平移后容器坐标会与光标脱节；
     * 视口坐标不受缩放影响，渲染时再用 view/zoom 算出图片矩形即可对齐。
     */
    const [crossPos, setCrossPos] = useState<{ x: number; y: number } | null>(null);
    // 首次加载的「最原始整图」副本，供「原图」键一键恢复
    // （裁剪即提取会直接覆盖 origCanvas，所以必须另存一份干净的原始图）
    const firstImageRef = useRef<HTMLCanvasElement | null>(null);
    // 说明弹窗显隐
    const [showHelp, setShowHelp] = useState(false);

    // ===== 拉伸：把当前图送进拍摄扫描器，拖四角拉正 + 漂白/黑白 =====
    // 解决"照片本身拍歪了"——进编辑器后仍能补救（问题③）。
    const [stretchOpen, setStretchOpen] = useState(false);
    const scannerRef = useRef<DocScannerHandle | null>(null);
    // 扫描器必须 portal 到 body（原因见渲染处注释），SSR 阶段没有 document，挂载后再渲染
    const [portalReady, setPortalReady] = useState(false);
    useEffect(() => {
        setPortalReady(true);
    }, []);

    // 【custom-v34】原先这里还有一套"按住标题栏拖动对话框"的实现。
    // 对话框改成整屏铺满之后没有可拖的余地，已整套撤掉（省掉一个状态和三个 window 监听）。

    // ============================================================
    //  初始化 / 重置
    // ============================================================
    useEffect(() => {
        if (!open) return;
        setMode("crop");
        setEraseTool("brush");
        setBoxes([]);
        setSelectedBoxId(null);
        setPendingRect(null);
        setCropRect(null);
        setCropToRegions(false);
        setHasShapes(false);
        setReady(false);
        shapesRef.current = [];
        drawingRef.current = null;
        origCanvasRef.current = null;
        workCanvasRef.current = null;
        isCroppedRef.current = false;
        // 【custom-v22 循环模式】新一轮从整页重新开始，上一道的框选坐标作废
        lastCropRectRef.current = null;
        // 新一轮加载的就是原始整页 → 坐标系重新成立
        rectSpaceStaleRef.current = false;
    }, [open, imageSrc]);

    // 对话框打开后加载原图并初始化画布（不再依赖 <img> 的 onLoad）
    useEffect(() => {
        if (!open) return;
        const img = new Image();
        img.onload = () => {
            ensureCanvases(img);
            // 另存一份最原始整图，供「原图」键恢复到刚上传时的状态
            if (origCanvasRef.current) {
                const fc = document.createElement("canvas");
                fc.width = origCanvasRef.current.width;
                fc.height = origCanvasRef.current.height;
                fc.getContext("2d")?.drawImage(origCanvasRef.current, 0, 0);
                firstImageRef.current = fc;
            }
            redrawWork();
            syncBase();
            redrawOverlay();
            setReady(true);
            // 画布就绪后让整图适应窗口（大图默认看全貌，不再只露中间）
            requestAnimationFrame(() => fitView());
        };
        img.src = imageSrc;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, imageSrc]);

    const ensureCanvases = useCallback((img: HTMLImageElement) => {
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        // 原图只建立一次；后续擦除结果不会覆盖它
        if (!origCanvasRef.current) {
            const oc = document.createElement("canvas");
            oc.width = nw;
            oc.height = nh;
            oc.getContext("2d")?.drawImage(img, 0, 0);
            origCanvasRef.current = oc;
        }
        if (!workCanvasRef.current) {
            const wc = document.createElement("canvas");
            wc.width = nw;
            wc.height = nh;
            // 初始化即画原图，避免从 crop 切出时 workCanvas 是空的（黑屏）
            wc.getContext("2d")?.drawImage(origCanvasRef.current, 0, 0);
            workCanvasRef.current = wc;
        }
        return workCanvasRef.current;
    }, []);

    /** 重放：原图 + 已提交擦除图形。白色填充幂等 → 顺序无关 → 重放即精确撤销 */
    const redrawWork = useCallback(() => {
        const wc = workCanvasRef.current;
        const oc = origCanvasRef.current;
        if (!wc || !oc) return;
        const ctx = wc.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, wc.width, wc.height);
        ctx.drawImage(oc, 0, 0);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#ffffff";
        for (const s of shapesRef.current) {
            if (s.kind === "rect") {
                ctx.fillRect(s.x, s.y, s.w, s.h);
            } else {
                ctx.lineWidth = s.width;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                ctx.beginPath();
                if (s.pts.length === 1) {
                    ctx.arc(s.pts[0].x, s.pts[0].y, s.width / 2, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    ctx.moveTo(s.pts[0].x, s.pts[0].y);
                    for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
                    ctx.stroke();
                }
            }
        }
    }, []);

    const syncBase = useCallback(() => {
        const wc = workCanvasRef.current;
        const base = baseCanvasRef.current;
        if (!wc || !base) return;
        if (base.width !== wc.width || base.height !== wc.height) {
            base.width = wc.width;
            base.height = wc.height;
        }
        const ctx = base.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, base.width, base.height);
        ctx.drawImage(wc, 0, 0);
        // 同步自然尺寸：wrapper / overlay canvas 靠它定尺，fitView 也靠它算比例
        if (natSizeRef.current.w !== wc.width || natSizeRef.current.h !== wc.height) {
            const s = { w: wc.width, h: wc.height };
            natSizeRef.current = s;
            setNatSize(s);
        }
    }, []);

    const redrawOverlay = useCallback(() => {
        const ov = overlayCanvasRef.current;
        const wc = workCanvasRef.current;
        if (!ov || !wc) return;
        if (ov.width !== wc.width || ov.height !== wc.height) {
            ov.width = wc.width;
            ov.height = wc.height;
        }
        const ctx = ov.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, ov.width, ov.height);

        // 框线固定为自然坐标下的细线：最终烘焙到原图时只有 2px，既可见又不挡内容
        const lw = Math.max(1.5, 2);

        const drawFrame = (
            x: number, y: number, w: number, h: number,
            color: string, dashed: boolean
        ) => {
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = lw;
            if (dashed) ctx.setLineDash([lw * 3, lw * 3]);
            ctx.strokeRect(x, y, w, h);
            ctx.setLineDash([]);
            ctx.restore();
        };

        // 橡皮擦矩形预览：白底半透明填充 + 深色虚线边框，白纸上也能看清
        const drawEraseFrame = (
            x: number, y: number, w: number, h: number,
            dashed: boolean
        ) => {
            ctx.save();
            ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = "#1f2937";
            ctx.lineWidth = lw;
            if (dashed) ctx.setLineDash([lw * 3, lw * 3]);
            ctx.strokeRect(x, y, w, h);
            ctx.setLineDash([]);
            ctx.restore();
        };

        // 【custom-v25 绿框】画了绿框 → 把框外压暗，直观表达"这些不要了"。
        // 必须铺在框线之前：遮罩若在后，会把框线一起压灰，看着像失效了。
        const regionBoxes = boxes.filter((b) => b.kind === "region");
        if (regionBoxes.length > 0) {
            ctx.save();
            ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
            ctx.beginPath();
            ctx.rect(0, 0, ov.width, ov.height);
            for (const r of regionBoxes) ctx.rect(r.x, r.y, r.w, r.h);
            // evenodd：整幅矩形里挖掉每个绿框，剩下的就是"会被丢掉的部分"
            ctx.fill("evenodd");
            ctx.restore();
        }

        // 已确认的标注框
        for (const b of boxes) {
            const color = b.kind === "question" ? QUESTION_COLOR
                : b.kind === "answer" ? ANSWER_COLOR
                    : REGION_COLOR;
            drawFrame(b.x, b.y, b.w, b.h, color, false);
            if (b.id === selectedBoxId) {
                ctx.save();
                ctx.strokeStyle = "#00c853";
                ctx.lineWidth = Math.max(1.5, lw * 1.2);
                ctx.setLineDash([lw * 2, lw * 2]);
                ctx.strokeRect(b.x - lw, b.y - lw, b.w + lw * 2, b.h + lw * 2);
                ctx.restore();
            }
        }

        // 待清除的矩形选区（橡皮擦-矩形）
        if (mode === "erase" && pendingRect) {
            drawEraseFrame(pendingRect.x, pendingRect.y, pendingRect.w, pendingRect.h, true);
        }

        // 【custom-v22 循环模式】本页已抠走并入库的题：绿色半透明遮罩 + 圈号。
        // 只在**坐标系仍然成立**时绘制：
        //   · !isCroppedRef —— 裁过之后工作画布已换成裁剪后的小图；
        //   · !rectSpaceStaleRef —— 拉伸之后基准图已换成矫正图。
        // 两种情况下整页坐标都不再对应，画上去只会是错位的一团。
        if (doneRectsView.length > 0 && !isCroppedRef.current && !rectSpaceStaleRef.current) {
            ctx.save();
            for (const d of doneRectsView) {
                ctx.fillStyle = "rgba(0, 200, 83, 0.16)";
                ctx.fillRect(d.x, d.y, d.w, d.h);
                ctx.strokeStyle = "rgba(0, 200, 83, 0.85)";
                ctx.lineWidth = Math.max(1.5, lw);
                ctx.setLineDash([lw * 2, lw * 2]);
                ctx.strokeRect(d.x, d.y, d.w, d.h);
                ctx.setLineDash([]);
            }
            ctx.restore();
            // 圈号半径按画面短边取，避免小图上字号失控、大图上又看不清
            const rr = Math.max(10, Math.min(ov.width, ov.height) * 0.022);
            for (const d of doneRectsView) {
                // 靠左上角画；但夹在画幅内，避免第一行/第一列的圈号被裁掉半个
                const cx = Math.min(Math.max(d.x + rr * 1.3, rr), ov.width - rr);
                const cy = Math.min(Math.max(d.y + rr * 1.3, rr), ov.height - rr);
                drawCircledNumber(ctx, d.index, cx, cy, rr);
            }
        }

        // 【custom-v25 绿框】把"合并后会裁出几道题"直接标在图上：
        // 用户画完三个绿框、其中两个重叠时，应当一眼看到编号是 1、2（而不是 1、2、3）。
        if (regionBoxes.length > 0) {
            const merged = mergeRegions(regionBoxes);
            const rr2 = Math.max(10, Math.min(ov.width, ov.height) * 0.022);
            merged.forEach((r, i) => {
                const cx = Math.min(Math.max(r.x + rr2 * 1.3, rr2), ov.width - rr2);
                const cy = Math.min(Math.max(r.y + rr2 * 1.3, rr2), ov.height - rr2);
                drawCircledNumber(ctx, i + 1, cx, cy, rr2);
            });
        }

        // 裁剪模式：已确认的裁剪框（白框 + 外部暗色遮罩，和 ReactCrop 一样直观）
        if (mode === "crop" && cropRect) {
            ctx.save();
            ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            ctx.fillRect(0, 0, ov.width, ov.height);
            ctx.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = Math.max(1.5, 2);
            ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
            ctx.restore();
        }

        // 正在绘制的形状预览
        const d = drawingRef.current;
        if (d) {
            if (d.kind === "rect") {
                if (mode === "label") {
                    const color = labelKind === "question" ? QUESTION_COLOR
                        : labelKind === "answer" ? ANSWER_COLOR
                            : REGION_COLOR;
                    drawFrame(d.x, d.y, d.w, d.h, color, true);
                } else if (mode === "crop") {
                    // 裁剪拖拽预览：暗色外部 + 亮框
                    ctx.save();
                    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
                    ctx.fillRect(0, 0, ov.width, ov.height);
                    ctx.clearRect(d.x, d.y, d.w, d.h);
                    ctx.strokeStyle = "#ffffff";
                    ctx.lineWidth = Math.max(1.5, 2);
                    ctx.strokeRect(d.x, d.y, d.w, d.h);
                    ctx.restore();
                } else {
                    drawEraseFrame(d.x, d.y, d.w, d.h, true);
                }
            } else {
                ctx.save();
                ctx.fillStyle = "#ffffff";
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = d.width;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                ctx.beginPath();
                if (d.pts.length === 1) {
                    ctx.arc(d.pts[0].x, d.pts[0].y, d.width / 2, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    ctx.moveTo(d.pts[0].x, d.pts[0].y);
                    for (let i = 1; i < d.pts.length; i++) ctx.lineTo(d.pts[i].x, d.pts[i].y);
                    ctx.stroke();
                }
                ctx.restore();
            }
        }
    }, [boxes, selectedBoxId, pendingRect, mode, labelKind, cropRect, doneRectsView]);

    /**
     * 【custom-v26】redrawOverlay 的**稳定引用**桥。
     *
     * 为什么需要：redrawOverlay 的依赖里带着 mode / boxes / pendingRect / selectedBoxId /
     * labelKind / cropRect —— 只要用户切一次工具、画一个框、点中一个框，它的函数引用就换一个新的。
     * 于是任何把 `redrawOverlay` 写进依赖数组的 effect 都会**跟着重跑**。
     * 而「拉伸浮层自愈」那个 effect 里恰好还调了 fitView() → 表现为：
     * 放大到 300% 后切橡皮擦、点一下图片，画面"啪"地弹回适应大小。
     *
     * 需要"最新重绘函数"、又不希望被它的引用变化牵着跑的 effect，一律走这个 ref。
     */
    const redrawOverlayRef = useRef(redrawOverlay);
    useEffect(() => {
        redrawOverlayRef.current = redrawOverlay;
    }, [redrawOverlay]);

    // 模式切换或画布初次就绪时，把 workCanvas 同步到 baseCanvas 并重绘 overlay
    useEffect(() => {
        if (!open) return;
        if (!workCanvasRef.current) return;
        syncBase();
        redrawOverlay();
    }, [mode, open, ready, syncBase, redrawOverlay]);

    useEffect(() => {
        if (!open) return;
        redrawOverlay();
    }, [boxes, selectedBoxId, pendingRect, cropRect, mode, labelKind, open, redrawOverlay]);

    // ============================================================
    //  模式切换
    // ============================================================
    /** 把当前裁剪区域提取成新图，写回 origCanvas/workCanvas，作为后续操作的基准（裁剪即提取） */
    function bakeCropIntoBase() {
        const oc = origCanvasRef.current;
        if (!oc) return;
        // 仅在用户确实拖出过裁剪框（cropRect 有值）才烘焙，避免无框时误裁
        if (!cropRect) return;
        const r = cropRect;
        if (r.w < 5 || r.h < 5) return;

        // 【custom-v22 循环模式】烘焙之后基准画布就换成这张小图、坐标系随之改变，
        // 所以必须在替换**之前**记下整页坐标，供调用方标记"这一道已抠走"。
        lastCropRectRef.current = { x: r.x, y: r.y, w: r.w, h: r.h };

        const cropped = document.createElement("canvas");
        cropped.width = Math.max(1, Math.round(r.w));
        cropped.height = Math.max(1, Math.round(r.h));
        const cctx = cropped.getContext("2d");
        if (!cctx) return;
        // 从原始基准图提取，确保 crop 模式下 workCanvas 尚未重绘也不会拿到黑图
        cctx.drawImage(oc, r.x, r.y, r.w, r.h, 0, 0, cropped.width, cropped.height);

        // 重置基准：原图与工作画布都换成裁剪图，擦除记录清空（基准变了）
        origCanvasRef.current = cropped;
        const newWc = document.createElement("canvas");
        newWc.width = cropped.width;
        newWc.height = cropped.height;
        newWc.getContext("2d")?.drawImage(cropped, 0, 0);
        workCanvasRef.current = newWc;
        shapesRef.current = [];
        setHasShapes(false);
        isCroppedRef.current = true;
        // 裁剪已烘焙进工作画布，旧的 crop 坐标不再适用，清空防止二次误裁
        setCropRect(null);
        syncBase();
        // 图变小了（如裁成窄条），让它在固定大窗口里重新适应，不留下拥挤的小画面
        fitView();
    }

    const switchMode = (m: Mode) => {
        // 从裁剪切到橡皮擦/标注：把裁剪结果"提取"为新基准，后续操作都基于它（裁剪即提取）
        if (mode === "crop" && m !== "crop") {
            bakeCropIntoBase();
        }
        // 切回裁剪：重置裁剪框（基准图可能已变），让用户重新框选
        if (m === "crop") {
            setCropRect(null);
        }
        setMode(m);
        setPendingRect(null);
        drawingRef.current = null;
    };

    // ============================================================
    //  橡皮擦 / 标注 操作
    // ============================================================
    const pushShapeAndRedraw = (s: Shape) => {
        shapesRef.current.push(s);
        redrawWork();
        syncBase();
        setHasShapes(true);
    };

    const undo = () => {
        if (!shapesRef.current.length) return;
        shapesRef.current.pop();
        redrawWork();
        syncBase();
        setHasShapes(shapesRef.current.length > 0);
        redrawOverlay();
    };

    const erasePendingRect = useCallback(() => {
        if (!pendingRect) return;
        pushShapeAndRedraw({ kind: "rect", ...pendingRect });
        setPendingRect(null);
        redrawOverlay();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingRect, redrawOverlay]);

    const removeSelectedBox = useCallback(() => {
        if (!selectedBoxId) return;
        setBoxes((prev) => prev.filter((b) => b.id !== selectedBoxId));
        setSelectedBoxId(null);
    }, [selectedBoxId]);

    // 键盘：Delete 清除选区 / 删除标注框；Ctrl+Z 撤销；Esc 取消
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

            if (e.key === "Escape") {
                setPendingRect(null);
                setSelectedBoxId(null);
                drawingRef.current = null;
                redrawOverlay();
                return;
            }
            if (e.key === "Delete") {
                if (mode === "erase" && pendingRect) {
                    e.preventDefault();
                    erasePendingRect();
                } else if (mode === "label" && selectedBoxId) {
                    e.preventDefault();
                    removeSelectedBox();
                }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && mode === "erase") {
                e.preventDefault();
                undo();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, mode, pendingRect, selectedBoxId, erasePendingRect, removeSelectedBox, redrawOverlay]);

    // 说明弹窗：打开后，下一次任意位置按下鼠标即关闭（含点击卡片本身）
    useEffect(() => {
        if (!showHelp) return;
        const close = () => setShowHelp(false);
        // 延迟一拍再挂监听，避免“打开”的那次点击立刻把自己关掉
        const t = setTimeout(() => document.addEventListener("mousedown", close), 0);
        return () => {
            clearTimeout(t);
            document.removeEventListener("mousedown", close);
        };
    }, [showHelp]);

    // ============================================================
    //  缩放 / 平移视图（手机双指捏合 + 电脑滚轮 + 双击）
    //  模型：zoom=1 即图片自然像素 1:1（不再靠 CSS 百分比偶然适配）；
    //        view = 图片左上角在视口内的绝对位移（渲染用）；
    //        pan  = 相对「居中位置」的偏移，钳制在 ±(显示尺寸-视口)/2
    //               → 图片比视口大就能拖动，比视口小则该轴锁死居中，不会拖乱。
    //  canvas 坐标换算仍走 getBoundingClientRect（天然含 transform），故屏幕→自然
    //  坐标的换算一行都不用改。
    // ============================================================
    /** 应用缩放与平移：唯一的写入口，缩放区间与平移边界都收在这里 */
    const applyView = useCallback((zRaw: number, p: { x: number; y: number }) => {
        const vp = viewportRef.current;
        const { w: nw, h: nh } = natSizeRef.current;
        if (!vp || !nw || !nh) return;
        if (!Number.isFinite(zRaw)) return; // 画布尺寸异常时防 NaN 扩散
        const vw = vp.clientWidth, vh = vp.clientHeight;
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zRaw));
        const sw = nw * z, sh = nh * z;
        const mx = Math.max(0, (sw - vw) / 2);
        const my = Math.max(0, (sh - vh) / 2);
        const px = Number.isFinite(p.x) ? Math.min(mx, Math.max(-mx, p.x)) : 0;
        const py = Number.isFinite(p.y) ? Math.min(my, Math.max(-my, p.y)) : 0;
        const vx = (vw - sw) / 2 + px;
        const vy = (vh - sh) / 2 + py;
        zoomRef.current = z;
        panRef.current = { x: px, y: py };
        viewRef.current = { x: vx, y: vy };
        setZoom(z);
        setView({ x: vx, y: vy });
    }, []);

    /** 以屏幕上某点 (cx,cy) 为焦点缩放：该点下的画面内容保持不动（滚轮/双指用） */
    const zoomAt = useCallback((zRaw: number, cx: number, cy: number) => {
        const vp = viewportRef.current;
        const { w: nw, h: nh } = natSizeRef.current;
        if (!vp || !nw || !nh) return;
        const r = vp.getBoundingClientRect();
        const sx = cx - r.left, sy = cy - r.top; // 视口内坐标
        const z = zoomRef.current;
        // 光标下方的图片自然坐标：缩放前后必须保持不变
        const nx = (sx - viewRef.current.x) / z;
        const ny = (sy - viewRef.current.y) / z;
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zRaw));
        const sw = nw * nz, sh = nh * nz;
        autoFitRef.current = false; // 用户手动缩放，退出「自动适应」
        applyView(nz, {
            x: sx - (vp.clientWidth - sw) / 2 - nx * nz,
            y: sy - (vp.clientHeight - sh) / 2 - ny * nz,
        });
    }, [applyView]);

    /** 计算「整图适应窗口」应有的比例（四周留白；上限 FIT_MAX 避免小图被放大到糊） */
    const computeFitZoom = useCallback(() => {
        const vp = viewportRef.current;
        const { w: nw, h: nh } = natSizeRef.current;
        if (!vp || !nw || !nh) return 1;
        const z = Math.min((vp.clientWidth - FIT_PAD * 2) / nw, (vp.clientHeight - FIT_PAD * 2) / nh);
        return Math.min(FIT_MAX, Math.max(MIN_ZOOM, z));
    }, []);

    /** 整图适应窗口并居中（原「适应」按钮的真身；pan=0 时钳制会自动居中） */
    const fitView = useCallback(() => {
        autoFitRef.current = true;
        applyView(computeFitZoom(), { x: 0, y: 0 });
    }, [applyView, computeFitZoom]);

    /**
     * 【custom-v33】整页逆时针转 90°（工具栏「🔄转」）。
     *
     * 用途：扫描件方向躺倒了。与「📐抻」分工不同 —— 抻治"歪"（梯形透视），
     * 转治"倒"（方向），两件事各管一头。
     *
     * ── 为什么这件事比看上去麻烦 ──────────────────────────────
     * 画布转一下只是一行 drawImage，真正容易出错的是**挂在坐标系上的那些东西**：
     *   · 擦除痕迹（shapes）—— 撤销要靠它重放，坐标必须跟着走，否则一撤销就全错位；
     *   · 标注框（boxes）、裁剪框（cropRect）、拖拽中的临时框；
     *   · 本页已录入的绿框（doneRectsView）；
     *   · 以及"整页已抠坐标"那份记录（lastCropRectRef，回传给调用方标记已抠区域用的）。
     * 少搬任何一样，它就会留在旧位置 —— 框线错位比不转还糟，用户会照着错位的框去操作。
     * 所以这里一次性全搬，宁可代码长一点。
     *
     * 逆时针 90° 的映射用 lib/image-rotation 里那四个纯函数（单测钉着），不在这里另算一套。
     */
    const rotateLeft = useCallback(() => {
        const oc = origCanvasRef.current;
        const wc = workCanvasRef.current;
        if (!oc || !wc) return;
        const srcW = wc.width;
        const srcH = wc.height;
        if (!srcW || !srcH) return;

        /**
         * 复制一份转好的画布：长宽对调，用矩阵一次把"逆时针 90°"写进去。
         *
         * ⚠️【custom-v34 修 bug】尺寸必须走 rotateCanvasSize（长宽对调），而且
         * **原图与工作画布两张都要换**。曾经只换了原图、忘了换工作画布 →
         * redrawWork 把"转后 H×W"的图往"旧 W×H"的画布里画，右边/下边直接被裁掉，
         * 看上去就像"转一下图被截成了正方形"，而且再怎么转都救不回来（只有「原图」键能恢复）。
         */
        const turn = (src: HTMLCanvasElement): HTMLCanvasElement | null => {
            const size = rotateCanvasSize(src.width, src.height);
            const nc = document.createElement("canvas");
            nc.width = size.w;
            nc.height = size.h;
            const ctx = nc.getContext("2d");
            if (!ctx) return null;
            // setTransform(a,b,c,d,e,f) 对应 x' = a·x + c·y + e，y' = b·x + d·y + f。
            // 取 (0,-1,1,0,0,src.width) 即 x'=y、y'=src.width−x —— 正是视觉上的逆时针 90°。
            // 平移量用**这张画布自己的宽**：两张画布的尺寸未必相同，用外面那张的宽会直接错位。
            ctx.setTransform(0, -1, 1, 0, 0, src.width);
            ctx.drawImage(src, 0, 0);
            return nc;
        };

        const noc = turn(oc);
        const nwc = turn(wc);
        if (!noc || !nwc) return;

        /**
         * 【custom-v35】翻转前先清场：擦除痕迹、标注框、裁剪框、待定框一律清空，
         * 转完从一张干净的图重新开始。
         *
         * 为什么不再"把标记跟着一起转"（v33 是这么做的）：
         *   ① 逻辑上就站不住 —— 翻转是因为方向躺倒了没法读，**一定是先转正、再画框**；
         *      "框都画好了再转"这条路，画的时候方向本来就是错的，照样得重画。
         *   ② 工程上是个坑 —— 要让痕迹跟着转就得同时搬运六处坐标（擦除笔画、标注框、
         *      裁剪框、待定框、绿框、整页已抠框），漏掉一处或参照系搞混，就会出现
         *      "擦 A 处、结果白的是 B 处"这种**不报错、只画错**的 bug（v34 正是这么来的）。
         *   ③ 收益为零 —— 没这功能用户也要重画；有了它反而多一个出错的面。
         *
         * 绿框不一样：它是"已经录入过的题"这一**已完成的事实**，不能跟着丢，
         * 所以只有它仍然跟着转（下面那段）。清空只针对还没提交的半成品。
         */
        const hasPendingMarks =
            shapesRef.current.length > 0 || boxes.length > 0 || !!cropRect || !!pendingRect;
        if (hasPendingMarks) {
            const msg = t.common.cropper?.rotateClearConfirm
                || "翻转会清掉你还没提交的标记（擦除痕迹、标注框、裁剪框）。确定要翻转吗？";
            if (!window.confirm(msg)) return;
        }

        origCanvasRef.current = noc;
        // 工作画布也一起换成转好的那份（尺寸随之对调）。下面 redrawWork() 会拿
        // "新基准图 + 清空后的痕迹"重放，结果与直接留用它一致，
        // 但尺寸必须先对上，否则就是上面注释里那个被裁成方形的 bug。
        workCanvasRef.current = nwc;

        shapesRef.current = [];
        setHasShapes(false);
        setBoxes([]);
        setCropRect(null);
        setPendingRect(null);
        setSelectedBoxId(null);
        drawingRef.current = null;

        // 绿框只在"整页坐标系仍然成立"时才会画（见 redrawOverlay）；
        // 那两个前提不成立时它本来就看不见，搬了也白搬，索性一并不动。
        if (!isCroppedRef.current && !rectSpaceStaleRef.current) {
            setDoneRectsView((prev) => prev.map((d) => ({ ...d, ...rotateRectCCW(d, srcW) })));
            lastCropRectRef.current = lastCropRectRef.current
                ? rotateRectCCW(lastCropRectRef.current, srcW)
                : null;
        }

        redrawWork();
        syncBase();
        redrawOverlay();
        // 转完长宽对调，旧的显示比例已经不适用 —— 一律回到"适应大小"
        fitView();
    }, [redrawWork, syncBase, redrawOverlay, fitView, boxes, cropRect, pendingRect, t]);

    /** 「原图」键：一键恢复到刚上传时的整图状态（清空裁剪/橡皮/标注、复位缩放），仍留在编辑器内 */
    const resetToOriginal = useCallback(() => {
        const fi = firstImageRef.current;
        if (!fi) return;
        const cloneOrig = document.createElement("canvas");
        cloneOrig.width = fi.width;
        cloneOrig.height = fi.height;
        cloneOrig.getContext("2d")?.drawImage(fi, 0, 0);
        origCanvasRef.current = cloneOrig;
        const wc = document.createElement("canvas");
        wc.width = fi.width;
        wc.height = fi.height;
        wc.getContext("2d")?.drawImage(fi, 0, 0);
        workCanvasRef.current = wc;
        shapesRef.current = [];
        setHasShapes(false);
        isCroppedRef.current = false;
        setBoxes([]);
        setSelectedBoxId(null);
        setPendingRect(null);
        setCropRect(null);
        setMode("crop");
        pointersRef.current.clear();
        pinchRef.current = null;
        panDragRef.current = null;
        // 【custom-v22 循环模式】回到"最初整页" → 已抠标记的坐标系重新成立
        rectSpaceStaleRef.current = false;
        // 坐标系既然回到最初，绿框也恢复成调用方给的原值（「🔄转」期间搬过的位置作废），
        // 那条"整页已抠坐标"同样不再成立
        setDoneRectsView(doneRects ?? []);
        lastCropRectRef.current = null;
        syncBase();
        redrawOverlay();
        fitView();
    }, [fitView, syncBase, redrawOverlay, doneRects]);

    // ============================================================
    //  拉伸：当前图 → 拍摄扫描器（拖四角拉正 + 漂白/黑白）→ 回传新图作为基准
    //  解决"照片本身就拍歪了"——进了编辑器也还有补救入口（问题③）
    // ============================================================
    /** 导出工作画布当前内容（用户已做的擦除一并带上）交给扫描器 */
    const handleStretch = useCallback(() => {
        const wc = workCanvasRef.current;
        if (!wc) return;
        wc.toBlob(
            (blob) => {
                if (!blob) return;
                setStretchOpen(true);
                scannerRef.current?.openWithFile(
                    new File([blob], "stretch.jpg", { type: "image/jpeg" })
                );
            },
            "image/jpeg",
            0.95
        );
    }, []);

    /**
     * 拉伸完成 → 回传的新图直接替换编辑器**内部**的基准画布。
     *
     * 为什么不换 imageSrc：那是 prop，一改就会触发本组件的重置 effect（依赖 [open, imageSrc]），
     *   zoom / 模式 / 画布全部重来，等于把用户踢出编辑器。
     * 按既定口径：已有的橡皮擦痕迹与框选标注一律清除且不弹提示 —— 坐标系已变，保留只会错位。
     */
    const handleStretchDone = useCallback(
        (blob: Blob) => {
            setStretchOpen(false);
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const base = document.createElement("canvas");
                base.width = img.naturalWidth;
                base.height = img.naturalHeight;
                base.getContext("2d")?.drawImage(img, 0, 0);

                origCanvasRef.current = base;
                const wc = document.createElement("canvas");
                wc.width = base.width;
                wc.height = base.height;
                wc.getContext("2d")?.drawImage(base, 0, 0);
                workCanvasRef.current = wc;

                shapesRef.current = [];
                drawingRef.current = null;
                setHasShapes(false);
                setBoxes([]);
                setSelectedBoxId(null);
                setPendingRect(null);
                setCropRect(null);
                // 新基准就是"整张拉伸结果"，不存在已烘焙的裁剪 → 置 false，
                // 这样用户之后仍能在拉伸结果上重新框选裁剪。
                isCroppedRef.current = false;
                // 【custom-v22 循环模式】基准换成了矫正后的图（尺寸/比例全变），
                // 旧标记的整页坐标不再对应 → 置失效，既不回传也不绘制，避免绿框错位。
                rectSpaceStaleRef.current = true;
                setMode("crop");

                syncBase();
                redrawOverlay();
                fitView();
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                // 读取失败：保持原状，用户可再点一次「拉伸」
            };
            img.src = url;
        },
        [fitView, syncBase, redrawOverlay]
    );

    /**
     * 打开 / 换图时让画面适应窗口。
     *
     * 【custom-v25 撤掉 mode 依赖】原来依赖里带着 `mode`，等于**每切一次工具就强制 fitView**：
     * 用户放大到 300% 正对某一行小字，一点「橡皮擦」，画面"啪"地弹回整图适应大小，
     * 得重新放大、重新找刚才的位置；手机上更明显 —— 框选一结束、手指一抬就弹回去。
     * 按要求改为：**除裁剪烘焙与拉伸回传外，切页面、切工具一律保持当前缩放与位置**，
     * 想回适应大小就双击。
     * 裁剪确实会改变图像尺寸，但那条路走的是 bakeCropIntoBase，它末尾自己 fitView()（用户许可）。
     */
    useEffect(() => {
        if (open) fitView();
    }, [open, imageSrc, fitView]);

    /**
     * 【custom-v20 保险】拉伸浮层开/关时把底图与覆盖层重画一遍。
     *
     * 为什么需要：浮层状态一变，Radix 可能把 DialogContent 的子树卸载重建，
     * 新的 <canvas> 是空白的，而「加载原图」的 effect 依赖 [open, imageSrc] 不会重跑
     * → 编辑器一片空白。基准图（workCanvasRef）是游离在 DOM 之外的 canvas，不会丢，
     * 所以这里只要在**提交之后**重新同步一次即可自愈。
     * 正常情况下（没有重建）这两行也是幂等的，不会产生副作用。
     *
     * 【custom-v26 修掉"放大后一切工具就弹回适应大小"】
     * 这里原来末尾还调了 fitView()，而依赖里带着 redrawOverlay —— 后者每次切工具 / 画框 /
     * 选中框都会换新引用（见 redrawOverlayRef 处的说明），于是**本 effect 被间接反复触发**，
     * 每次都把画面重算成适应大小。上一次修的是另一处 effect（撤掉 mode 依赖），
     * 这一处补刀路径没堵住，所以症状依旧。
     * 改法：① 去掉 fitView（拉伸真正提交时 handleStretchDone 自己会 fit，取消拉伸本就不该动视图）；
     *       ② 依赖收缩到 [stretchOpen, open]，重画改走 redrawOverlayRef，
     *          彻底不被"用户又在图上画了什么"牵着跑。
     */
    useEffect(() => {
        if (!open) return;
        const id = requestAnimationFrame(() => {
            if (!workCanvasRef.current) return;
            syncBase();
            redrawOverlayRef.current();
        });
        return () => cancelAnimationFrame(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stretchOpen, open]);

    // 视口尺寸变化（拖大窗口 / 手机横竖屏）：仍在自动适应则重新适应，否则只重新钳制
    useEffect(() => {
        const vp = viewportRef.current;
        if (!open || !vp) return;
        const ro = new ResizeObserver(() => {
            if (autoFitRef.current) fitView();
            else applyView(zoomRef.current, panRef.current);
        });
        ro.observe(vp);
        return () => ro.disconnect();
    }, [open, fitView, applyView]);

    // 电脑端：滚轮缩放，必须以鼠标所在位置为中心，否则一滚画面就“跑飞”
    useEffect(() => {
        if (!open) return;
        const onWheel = (e: WheelEvent) => {
            const vp = viewportRef.current;
            if (!vp) return;
            // 只在图片视口内（含黑底/canvas）才缩放；Toolbar/Footer/页面滚动不受影响
            if (!vp.contains(e.target as Node)) return;

            e.preventDefault();
            // 归一化滚轮 delta：部分鼠标/触控板以「行」(deltaMode=1) 或「页」(deltaMode=2) 上报
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 16;
            else if (e.deltaMode === 2) dy *= 100;

            const factor = Math.exp(-dy * 0.002);
            zoomAt(zoomRef.current * factor, e.clientX, e.clientY);
        };

        // 关键：挂到 window 的 capture 阶段，先于 Radix Dialog / RemoveScroll 的滚动锁定拿到事件
        window.addEventListener("wheel", onWheel, { passive: false, capture: true });
        return () => window.removeEventListener("wheel", onWheel, { capture: true });
    }, [open, zoomAt]);

    // 电脑端：按住空格 + 拖拽 = 平移（与 Photoshop 习惯一致）
    // 【custom-v27】顺带跟踪 Shift：区域标注页按住 Shift = 临时「仅画」（见 onPointerDown）
    useEffect(() => {
        if (!open) return;
        const down = (e: KeyboardEvent) => {
            if (e.code === "Space") spaceRef.current = true;
            if (e.key === "Shift") shiftRef.current = true;
        };
        const up = (e: KeyboardEvent) => {
            if (e.code === "Space") spaceRef.current = false;
            if (e.key === "Shift") shiftRef.current = false;
        };
        // 切到别的窗口再回来时收不到 keyup → Shift 会卡在按下态。用 blur 兜底复位。
        const blur = () => { shiftRef.current = false; spaceRef.current = false; };
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        window.addEventListener("blur", blur);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
            window.removeEventListener("blur", blur);
            spaceRef.current = false;
            shiftRef.current = false;
        };
    }, [open]);

    // ============================================================
    //  指针交互（橡皮擦 / 标注）
    // ============================================================
    const toNatural = (e: { clientX: number; clientY: number }) => {
        const ov = overlayCanvasRef.current;
        const wc = workCanvasRef.current;
        if (!ov || !wc) return { x: 0, y: 0 };
        const r = ov.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (wc.width / r.width),
            y: (e.clientY - r.top) * (wc.height / r.height),
        };
    };

    /**
     * 【custom-v25】选中框的判定：**点到边框附近才算选中**，点框内部则视为要画新框。
     *
     * 为什么改掉"点在框内即选中"：
     *   旧规则下「在大框里再画一个小框」根本做不到 —— 起手点必然落在大框内部，
     *   那一下直接被吃成"选中大框"，永远画不出里面的小框。
     * 改成边缘带命中后两件事同时成立：
     *   · 大框里能起手画小框（点在深处不命中任何框）；
     *   · 重叠时仍能选到"后画的那一个"（自后向前扫描 → 后画的优先）。
     * 容差按**屏幕像素**折算（8px ÷ zoom），放大到 400% 时不会变成"必须精确戳在线上"。
     * 特例：框本身很窄（宽或高不到两倍容差）时整个框都算边缘，小框照样点得中。
     */
    const hitBoxAt = (p: { x: number; y: number }): Box | null => {
        const tol = 8 / Math.max(zoomRef.current, 0.01);
        for (let i = boxes.length - 1; i >= 0; i--) {
            const b = boxes[i];
            const inOuter =
                p.x >= b.x - tol && p.x <= b.x + b.w + tol &&
                p.y >= b.y - tol && p.y <= b.y + b.h + tol;
            if (!inOuter) continue;
            const inInner =
                p.x >= b.x + tol && p.x <= b.x + b.w - tol &&
                p.y >= b.y + tol && p.y <= b.y + b.h - tol;
            if (!inInner) return b;
        }
        return null;
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!workCanvasRef.current) return;
        e.preventDefault();
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // 双指落下：进入捏合缩放/平移手势，并中断当前绘制，避免手指落下瞬间误画
        if (pointersRef.current.size >= 2) {
            drawingRef.current = null;
            setPendingRect(null);
            autoFitRef.current = false; // 用户手动缩放/平移，退出「自动适应」
            const pts = [...pointersRef.current.values()];
            pinchRef.current = {
                dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
                midX: (pts[0].x + pts[1].x) / 2,
                midY: (pts[0].y + pts[1].y) / 2,
            };
            panDragRef.current = null;
            redrawOverlay();
            return;
        }

        // 空格 + 拖拽 / 鼠标中键 / 鼠标右键 / 平移开关开启：平移视图（不绘制）
        if (spaceRef.current || e.button === 1 || e.button === 2 || panMode) {
            autoFitRef.current = false; // 用户手动平移，退出「自动适应」
            panDragRef.current = {
                sx: e.clientX,
                sy: e.clientY,
                px: panRef.current.x,
                py: panRef.current.y,
            };
            return;
        }

        const p = toNatural(e);

        /**
         * 单指起点落在图片范围外（黑底）时的处理。
         *
         * 【custom-v25】橡皮擦-笔刷**放宽**：只要笔头圆还压着图片（出界不超过一个笔头半径）
         * 就照常擦。旧代码在这里无条件 return，于是"预览绿圈明明已经压到纸边了，
         * 却怎么也擦不动"—— 必须把指针整个挪进图片里才生效。
         * 其余工具维持原判：从黑底起手不画，免得拖出半截框。
         */
        const wcInside = workCanvasRef.current;
        if (wcInside) {
            let slack = 0;
            if (mode === "erase" && eraseTool === "brush") {
                const ovRect = overlayCanvasRef.current?.getBoundingClientRect();
                const scale = ovRect && ovRect.width ? wcInside.width / ovRect.width : 1;
                slack = (BRUSH_SIZES[brushIdx] * scale) / 2;
            }
            if (
                p.x < -slack || p.x > wcInside.width + slack ||
                p.y < -slack || p.y > wcInside.height + slack
            ) return;
        }

        if (mode === "label") {
            // 【custom-v27 仅画】开关选中、或按住 Shift 时，起手一律画新框，
            // 跳过"点边框附近选中旧框"的判定 —— 用户要的就是"我就是要画框"。
            const forceDraw = drawOnly || shiftRef.current;
            if (!forceDraw) {
                const hit = hitBoxAt(p);
                if (hit) {
                    setSelectedBoxId(hit.id);
                    return;
                }
            }
            setSelectedBoxId(null);
            drawingRef.current = { kind: "rect", x: p.x, y: p.y, w: 0, h: 0 };
        } else if (mode === "crop") {
            setCropRect(null);
            drawingRef.current = { kind: "rect", x: p.x, y: p.y, w: 0, h: 0 };
        } else if (mode === "erase") {
            if (eraseTool === "brush") {
                const ovRect = overlayCanvasRef.current?.getBoundingClientRect();
                const scale = ovRect && ovRect.width
                    ? workCanvasRef.current.width / ovRect.width
                    : 1;
                drawingRef.current = {
                    kind: "stroke",
                    pts: [p],
                    width: BRUSH_SIZES[brushIdx] * scale,
                };
            } else {
                setPendingRect(null);
                drawingRef.current = { kind: "rect", x: p.x, y: p.y, w: 0, h: 0 };
            }
        }
        redrawOverlay();
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (pointersRef.current.has(e.pointerId)) {
            pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }

        // 双指手势：捏合缩放（以两指中点为焦点）+ 中点位移平移
        const pts = [...pointersRef.current.values()];
        if (pts.length >= 2 && pinchRef.current) {
            const g = pinchRef.current;
            const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const mx = (pts[0].x + pts[1].x) / 2;
            const my = (pts[0].y + pts[1].y) / 2;
            if (g.dist > 0) zoomAt(zoomRef.current * (d / g.dist), g.midX, g.midY);
            applyView(zoomRef.current, {
                x: panRef.current.x + (mx - g.midX),
                y: panRef.current.y + (my - g.midY),
            });
            g.dist = d;
            g.midX = mx;
            g.midY = my;
            return;
        }

        // 单指/鼠标平移（空格 + 拖拽 或 中键拖拽）
        if (panDragRef.current) {
            const pd = panDragRef.current;
            applyView(zoomRef.current, {
                x: pd.px + (e.clientX - pd.sx),
                y: pd.py + (e.clientY - pd.sy),
            });
            return;
        }

        // 笔刷模式：实时更新跟随光标的圆形预览圈（即使未按下）
        if (mode === "erase" && eraseTool === "brush") {
            const ov = overlayCanvasRef.current;
            const r = ov?.getBoundingClientRect();
            // 预览圈在被缩放的容器内，需换算回容器自身的坐标（除以 zoom）
            if (r) setCursorPos({ x: (e.clientX - r.left) / zoomRef.current, y: (e.clientY - r.top) / zoomRef.current });
        }
        // 【custom-v27 十字基准线】三页通用：记下指针在视口内的位置（是否落在图片上由渲染时判）。
        // 位置没变就返回 prev，避免指针每动一下都触发无谓重渲染。
        {
            const vp = viewportRef.current?.getBoundingClientRect();
            if (vp) {
                const nx = Math.round(e.clientX - vp.left);
                const ny = Math.round(e.clientY - vp.top);
                setCrossPos(prev => (prev && prev.x === nx && prev.y === ny) ? prev : { x: nx, y: ny });
            }
        }
        const d = drawingRef.current;
        if (!d) return;
        const p = toNatural(e);
        if (d.kind === "stroke") {
            const last = d.pts[d.pts.length - 1];
            if (!last || Math.abs(p.x - last.x) > 1 || Math.abs(p.y - last.y) > 1) d.pts.push(p);
        } else {
            d.w = p.x - d.x;
            d.h = p.y - d.y;
        }
        redrawOverlay();
    };

    const onPointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
        if (mode === "erase" && eraseTool === "brush") {
            const ov = overlayCanvasRef.current;
            const r = ov?.getBoundingClientRect();
            if (r) setCursorPos({ x: (e.clientX - r.left) / zoomRef.current, y: (e.clientY - r.top) / zoomRef.current });
        }
        // 【custom-v27】进入即定位十字线，不必等到第一次移动
        const vp = viewportRef.current?.getBoundingClientRect();
        if (vp) setCrossPos({ x: e.clientX - vp.left, y: e.clientY - vp.top });
    };

    const onPointerLeave = () => {
        setCursorPos(null);
        setCrossPos(null);
    };

    const onPointerUp = (e?: React.PointerEvent<HTMLDivElement>) => {
        if (e) pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size < 2) pinchRef.current = null;
        panDragRef.current = null;
        const d = drawingRef.current;
        drawingRef.current = null;
        if (!d) return;

        if (d.kind === "stroke") {
            if (d.pts.length > 0) pushShapeAndRedraw(d);
        } else {
            const r = normalizeRect(d);
            if (r.w > 10 && r.h > 10) {
                if (mode === "label") {
                    setBoxes((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, ...r, kind: labelKind }]);
                } else if (mode === "crop") {
                    setCropRect(r);
                } else {
                    setPendingRect(r);
                }
            }
        }
        redrawOverlay();
    };

    // ============================================================
    //  确认：烘焙标注框 → 计算导出区 → 输出 JPEG
    //  必改点1/2：一律从工作画布导出，不再取 <img>、也不再 fetch 原图
    // ============================================================
    function resolveCropRect(): { x: number; y: number; w: number; h: number } | null {
        return cropRect;
    }

    /**
     * 重叠分图：题干图（红框∪蓝框范围，蓝框涂白 + 序号）在上，
     * 答案图（每个蓝框原样 + 同序号）在下，上下拼接为一张图。
     * 序号按蓝框阅读顺序（上→下、左→右）自动编排，与题干预留白块对应，避免错乱。
     */
    function buildSplitCanvas(
        source: HTMLCanvasElement,
        questions: Box[],
        answers: Box[],
    ): HTMLCanvasElement {
        // 题目范围 = 红框 ∪ 蓝框 并集（用户没画大红框时也能自动兜住所有手写部分）
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const b of [...questions, ...answers]) {
            x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
            x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
        }
        const pad = Math.max(4, (y1 - y0) * 0.01);
        const tx = Math.max(0, Math.floor(x0 - pad));
        const ty = Math.max(0, Math.floor(y0 - pad));
        const tw = Math.min(source.width - tx, Math.ceil((x1 - x0) + pad * 2));
        const th = Math.min(source.height - ty, Math.ceil((y1 - y0) + pad * 2));

        // 题干图：提取题目范围，再把所有蓝框涂白
        const stem = document.createElement("canvas");
        stem.width = tw; stem.height = th;
        const sctx = stem.getContext("2d");
        if (!sctx) return source;
        sctx.fillStyle = "#ffffff";
        sctx.fillRect(0, 0, tw, th);
        sctx.drawImage(source, tx, ty, tw, th, 0, 0, tw, th);
        sctx.fillStyle = "#ffffff";
        for (const a of answers) {
            sctx.fillRect(a.x - tx, a.y - ty, a.w, a.h);
        }

        // 答案图：每个蓝框原样，按阅读顺序排序
        const sorted = [...answers].sort((p, q) => p.y - q.y || p.x - q.x);
        const ansCanvases = sorted.map((a) => {
            const c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(a.w));
            c.height = Math.max(1, Math.round(a.h));
            c.getContext("2d")?.drawImage(source, a.x, a.y, a.w, a.h, 0, 0, c.width, c.height);
            return c;
        });

        // 序号水印：题干白块中心 + 答案图左上角，小圈不挡内容
        sorted.forEach((a, i) => {
            const n = i + 1;
            const cxr = a.x - tx + a.w / 2;
            const cyr = a.y - ty + a.h / 2;
            const r = Math.max(8, Math.min(16, Math.min(a.w, a.h) * 0.4));
            drawCircledNumber(sctx, n, cxr, cyr, r);
        });
        ansCanvases.forEach((c, i) => {
            const n = i + 1;
            const r = Math.max(8, Math.min(16, Math.min(c.width, c.height) * 0.4));
            const actx = c.getContext("2d");
            if (actx) drawCircledNumber(actx, n, Math.min(r, c.width - 2), Math.min(r, c.height - 2), r);
        });

        // 拼接：题干在上、答案在下
        const gap = 24;
        const maxAnsW = ansCanvases.reduce((m, c) => Math.max(m, c.width), 0);
        const totalW = Math.max(stem.width, maxAnsW);
        const totalH = stem.height + gap + ansCanvases.reduce((s, c) => s + c.height, 0);
        const out = document.createElement("canvas");
        out.width = Math.max(1, totalW);
        out.height = Math.max(1, totalH);
        const octx = out.getContext("2d");
        if (!octx) return source;
        octx.fillStyle = "#ffffff";
        octx.fillRect(0, 0, out.width, out.height);
        octx.drawImage(stem, 0, 0);
        let yy = stem.height + gap;
        for (const c of ansCanvases) { octx.drawImage(c, 0, yy); yy += c.height; }
        return out;
    }

    /**
     * 【custom-v25 绿框】把「一块绿框区域」导成一张图。
     *
     * baked 是整个工作画布，region 是**合并后**的绿框（自然坐标）。
     * 区域内的红/蓝框先平移成相对坐标，再走与整图时完全相同的两条路：
     *   · 勾了 省🔡 且红蓝框有重叠 → 分图（题干涂白 + 答案 + 序号）；
     *   · 否则把红/蓝框线烘焙进这一小块。
     * 绿框自己**不画进结果** —— 它只是分区标记，印到题面上纯属干扰。
     */
    function buildRegionCanvas(
        baked: HTMLCanvasElement,
        region: { x: number; y: number; w: number; h: number },
    ): HTMLCanvasElement {
        const sx = Math.max(0, Math.round(region.x));
        const sy = Math.max(0, Math.round(region.y));
        const sw = Math.max(1, Math.round(Math.min(region.w, baked.width - sx)));
        const sh = Math.max(1, Math.round(Math.min(region.h, baked.height - sy)));

        const sub = document.createElement("canvas");
        sub.width = sw;
        sub.height = sh;
        const sctx = sub.getContext("2d");
        if (!sctx) return sub;
        sctx.drawImage(baked, sx, sy, sw, sh, 0, 0, sw, sh);

        // 与这块区域有交集的红/蓝框才算属于这一道，并平移到区域坐标系
        const inside = boxes.filter(
            (b) => b.kind !== "region" && rectsIntersect(b, { x: sx, y: sy, w: sw, h: sh }),
        );
        const questions = inside.filter((b) => b.kind === "question")
            .map((b) => ({ ...b, x: b.x - sx, y: b.y - sy }));
        const answers = inside.filter((b) => b.kind === "answer")
            .map((b) => ({ ...b, x: b.x - sx, y: b.y - sy }));
        const overlaps = questions.length > 0 && answers.length > 0
            && answers.some((a) => questions.some((q) => rectsIntersect(a, q)));

        if (cropToRegions && overlaps) {
            return buildSplitCanvas(sub, questions, answers);
        }
        if (inside.length > 0) {
            const lw = Math.max(1.5, 2);
            for (const b of [...questions, ...answers]) {
                sctx.save();
                sctx.strokeStyle = b.kind === "question" ? QUESTION_COLOR : ANSWER_COLOR;
                sctx.lineWidth = lw;
                sctx.strokeRect(b.x, b.y, b.w, b.h);
                sctx.restore();
            }
        }
        return sub;
    }

    const handleConfirm = async () => {
        const wc = workCanvasRef.current;

        /**
         * 【custom-v25 绿框】画了绿框 → 这一页可能就是好几道题，逐块裁出来分别交出去。
         * 绿框在时 cropRect 不再参与：绿框本身就是裁剪边界（用户："绿框以外的都不要了"）。
         * ⚠️ 这里只是"把图切成几份"，送 AI 与入库由调用方按队列一道道做 ——
         *    编辑器不该知道 AI 的事，否则三个入口都得抄一遍分析流程。
         */
        const regionBoxes = boxes.filter((b) => b.kind === "region");
        if (regionBoxes.length > 0 && onCropBatch && wc) {
            // 循环模式的"已抠标记"在"一图多题"下无意义，回传 null 防止把绿框标到错位置
            onCropRegion?.(null);
            const whole = document.createElement("canvas");
            whole.width = wc.width;
            whole.height = wc.height;
            whole.getContext("2d")?.drawImage(wc, 0, 0);

            const regions = mergeRegions(regionBoxes);
            const blobs: Blob[] = [];
            for (const r of regions) {
                const c = buildRegionCanvas(whole, r);
                const blob = await new Promise<Blob | null>((resolve) => {
                    c.toBlob((b) => resolve(b), "image/jpeg", 0.92);
                });
                if (blob) blobs.push(blob);
            }
            if (blobs.length > 0) {
                onCropBatch(blobs);
                return;
            }
            // 一块都没裁成（理论上不会）：继续往下走单张逻辑，别让这次点击白费
        }

        /**
         * 绿框之外的框才参与"题干/答案"的判定。
         * 绿框是分区用的，混进 cropToRegions 的包围盒会把导出区撑成整幅图。
         */
        const labelBoxes = boxes.filter((b) => b.kind !== "region");
        /** 兜底：调用方没接 onCropBatch（理论上不存在）时，至少按第一个绿框裁一张 */
        const regionClip = regionBoxes.length > 0 ? (mergeRegions(regionBoxes)[0] ?? null) : null;

        // 【custom-v22 循环模式】
        // 情形一：用户切过橡皮擦/标注模式 → bakeCropIntoBase 已把整页坐标记进 lastCropRectRef；
        // 情形二：一直在裁剪模式直接点确定 → 还没记，这里补上。
        if (cropRect && !isCroppedRef.current) {
            lastCropRectRef.current = { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h };
        }
        /**
         * 只有**实际导出区域确实等于裁剪框**时，这个矩形才配当"这一道在整页上的位置"。
         * 两种不成立的情形（可与下面三条导出分支逐条对上）：
         *   · 区域标注 + 按框导出（cropToRegions && boxes.length）→ 导出的是框的包围盒或分图结果，
         *     与 cropRect 无关，照抄会把绿框标到错误位置；
         *   · 坐标系已失效（本题做过拉伸）→ 数值对不上整页，宁可这一道没有标记。
         */
        const regionIsCropRect = !(cropToRegions && labelBoxes.length > 0);
        onCropRegion?.(regionIsCropRect && !rectSpaceStaleRef.current ? lastCropRectRef.current : null);

        // 画布未就绪（极端情况）：退回原图，保持旧行为
        if (!wc) {
            try {
                const res = await fetch(imageSrc);
                onCropComplete(await res.blob());
            } catch (e) {
                console.error(e);
            }
            return;
        }

        // 1) 复制工作画布（已含擦除 + 裁剪提取结果）
        const baked = document.createElement("canvas");
        baked.width = wc.width;
        baked.height = wc.height;
        const bctx = baked.getContext("2d");
        if (!bctx) return;
        bctx.drawImage(wc, 0, 0);

        const questions = labelBoxes.filter((b) => b.kind === "question");
        const answers = labelBoxes.filter((b) => b.kind === "answer");
        const overlaps =
            questions.length > 0 &&
            answers.length > 0 &&
            answers.some((a) => questions.some((q) => rectsIntersect(a, q)));

        // 2) 红框与蓝框重叠/包含 → 分图（题干涂白 + 答案 + 序号），根治"答案混进题干"
        if (cropToRegions && labelBoxes.length > 0 && overlaps) {
            const out = buildSplitCanvas(baked, questions, answers);
            out.toBlob((blob) => {
                if (blob) onCropComplete(blob);
            }, "image/jpeg", 0.92);
            return;
        }

        // 3) 非重叠：烘焙框线 + 决定导出区（原逻辑）
        if (labelBoxes.length > 0) {
            // 烘焙到原图分辨率：2px 细线，不写字，避免遮挡表格/填空题
            const lw = Math.max(1.5, 2);
            for (const b of labelBoxes) {
                const color = b.kind === "question" ? QUESTION_COLOR : ANSWER_COLOR;
                bctx.save();
                bctx.strokeStyle = color;
                bctx.lineWidth = lw;
                bctx.strokeRect(b.x, b.y, b.w, b.h);
                bctx.restore();
            }
        }

        let sx = 0, sy = 0, sw = baked.width, sh = baked.height;
        if (cropToRegions && labelBoxes.length > 0) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const b of labelBoxes) {
                x0 = Math.min(x0, b.x);
                y0 = Math.min(y0, b.y);
                x1 = Math.max(x1, b.x + b.w);
                y1 = Math.max(y1, b.y + b.h);
            }
            const padW = (x1 - x0) * 0.08;
            const padH = (y1 - y0) * 0.08;
            sx = Math.max(0, x0 - padW);
            sy = Math.max(0, y0 - padH);
            sw = Math.min(baked.width - sx, x1 - x0 + padW * 2);
            sh = Math.min(baked.height - sy, y1 - y0 + padH * 2);
        } else if (regionClip && !isCroppedRef.current) {
            // 【custom-v25 兜底】调用方没接 onCropBatch 却画了绿框：至少按第一个绿框裁一张，
            // 否则整幅图（连同绿框以外那些"不要了"的部分）会被当成一道题送出去。
            sx = Math.max(0, regionClip.x);
            sy = Math.max(0, regionClip.y);
            sw = Math.min(baked.width - sx, regionClip.w);
            sh = Math.min(baked.height - sy, regionClip.h);
            if (sw <= 0 || sh <= 0) { sx = 0; sy = 0; sw = baked.width; sh = baked.height; }
        } else {
            // 若已经烘焙过裁剪结果，工作画布本身就是目标区域，不要再按旧 crop 二次裁剪
            if (!isCroppedRef.current) {
                const r = resolveCropRect();
                if (r) { sx = r.x; sy = r.y; sw = r.w; sh = r.h; }
            }
        }

        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(sw));
        out.height = Math.max(1, Math.round(sh));
        const octx = out.getContext("2d");
        if (!octx) return;
        octx.drawImage(baked, sx, sy, sw, sh, 0, 0, out.width, out.height);

        out.toBlob((blob) => {
            if (blob) onCropComplete(blob);
        }, "image/jpeg", 0.92);
    };

    // ============================================================
    //  渲染
    // ============================================================
    const btn = (active: boolean) =>
        `h-8 px-3 text-xs rounded-md border transition-colors ${
            active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-input hover:bg-accent"
        }`;

    // ⚠️【custom-v20 坑】modal 必须**恒定**，绝不能写成 modal={!stretchOpen}。
    //   Radix 的 DialogContent 是按 modal 在 DialogContentModal / DialogContentNonModal
    //   **两种组件类型**之间切换的；组件类型一变，React 就把整棵子树卸载重建，
    //   对话框里的 <canvas> 会被换成新的空白元素（默认 300×150）且无人重绘
    //   → 一开「拉伸」浮层，编辑器就变成一片空白，取消后也回不来。
    //   取非 modal：视口仍被 DialogOverlay 全屏盖住，点不到背后的页面；
    //   DialogContent 的 onPointerDownOutside 已无条件 preventDefault，点外面也不会误关。
    return (
        <Dialog
            open={open}
            onOpenChange={(isOpen) => !isOpen && onClose()}
            modal={false}
        >
            <DialogContent
                // 拉伸浮层期间按 Esc 不该把编辑器一起关掉 —— 那正是"编辑成果丢失"的老路
                onEscapeKeyDown={(e) => {
                    if (stretchOpen) e.preventDefault();
                }}
                // 拉伸浮层是 portal 到 body 的、对话框**之外**的节点。
                // 非 modal 的 Radix 会把「焦点移到外面」「在外层交互」都当成关闭信号，
                // 用户点一下浮层里的「黑白」编辑器就会被静默关掉、编辑成果作废。
                // 浮层展开期间把这两条默认关闭行为挡掉（onPointerDownOutside 由基类挡）。
                onFocusOutside={(e) => {
                    if (stretchOpen) e.preventDefault();
                }}
                onInteractOutside={(e) => {
                    if (stretchOpen) e.preventDefault();
                }}
                className={cn(
                    // ⚠️ 千万不要在这里加 relative：cn() 基于 tailwind-merge，
                    // relative 与基类的 fixed 同组冲突，会把 fixed 挤掉，
                    // 导致对话框掉进文档流被排到页面下方（「偏下且拖不上来」的根因）。
                    // 需要绝对定位基准时，基类的 fixed 本身就已提供。
                    //
                    // 【custom-v34】改成**整屏铺满**：编辑期间用户本来也点不到对话框背后
                    // （基类的 DialogOverlay 全屏盖着），留出四周黑边和标题栏只是白白浪费面积。
                    // 图片才是主角，面积全给它。尺寸写法与收件箱的照片预览页保持一致。
                    "max-w-none h-[100dvh] sm:rounded-none flex flex-col p-0 gap-0 overflow-hidden [&>button]:hidden",
                )}
            >
                {/* 标题栏（含"裁剪图片"四个字与"本页已录 N 道"）已按用户要求撤掉 —— 腾给图片。
                    但 Radix 的 Dialog 需要 Title 才能正确播报，所以留一个只读屏的标题；
                    本页进度挪到底部操作条里，紧挨「原图 / 取消 / 确认」。 */}
                <DialogTitle className="sr-only">
                    {t.common.cropper?.title || "Crop Image"}
                    {loopCount !== undefined
                        ? `　${(t.common.cropper?.loopProgress
                            ? t.common.cropper.loopProgress.replace("{n}", String(loopCount))
                            : `本页已录 ${loopCount} 道`)}`
                        : ""}
                </DialogTitle>

                {/* ===== 工具栏 ===== */}
                {/* 【custom-v24】左上角“模式”二字已按用户要求撤掉 —— 图标型方框按钮本身就是模式开关，不需要再挂一个栏目标题。 */}
                <div className="px-4 py-2 border-b shrink-0 flex flex-wrap items-center gap-2 bg-muted/30">
                    <button type="button" className={btn(mode === "crop")} onClick={() => switchMode("crop")}>
                        {t.common.cropper?.modeCrop || "裁剪"}
                    </button>
                    <button type="button" className={btn(mode === "erase")} onClick={() => switchMode("erase")}>
                        {t.common.cropper?.modeErase || "橡皮擦"}
                    </button>
                    <button type="button" className={btn(mode === "label")} onClick={() => switchMode("label")}>
                        {t.common.cropper?.modeLabel || "区域标注"}
                    </button>

                    {/* 【custom-v33】整页逆时针转 90°（用户指定的位置：📊框 之后）。
                        【custom-v34】原先跟在这里的「🧭移」已按用户要求挪到底部操作条，
                        并改名为「平移」—— 上面这一排全是对图片的**加工**，只有它不是，
                        所以不该混在里面。 */}
                    <button
                        type="button"
                        className={btn(false)}
                        onClick={rotateLeft}
                        disabled={analyzing}
                        title={
                            (t.common.cropper?.rotateTip
                                || "整页逆时针转 90°（再点一次继续转）。还没提交的擦除痕迹、标注框、裁剪框会被清空——所以请先转正，再动笔")
                        }
                    >
                        {t.common.cropper?.rotate || "🔄转"}
                    </button>

                    {/* 拉伸：进编辑器后才发现照片拍歪了的补救入口（问题③）。
                        ⚠️ 这里用字面文案而非 t.common.cropper.stretch —— t 的类型取自
                        translations['en']，新 key 必须所有语种一起补齐才能过类型检查，
                        而编辑器界面本来就是中文，先不铺这一层。
                        【custom-v24】文案改「📐抻」（用户指定），与右侧 📐 图标语义一致。 */}
                    <button
                        type="button"
                        className={btn(false)}
                        onClick={handleStretch}
                        disabled={analyzing}
                        title="把当前图送进拍摄扫描器：拖四角把斜拍的纸拉正，并可漂白 / 黑白"
                    >
                        📐抻
                    </button>

                    <span className="w-px h-5 bg-border mx-1" />

                    {mode === "erase" && (
                        <>
                            <button type="button" className={btn(eraseTool === "brush")} onClick={() => setEraseTool("brush")}>
                                {t.common.cropper?.brush || "笔刷"}
                            </button>
                            <button type="button" className={btn(eraseTool === "rect")} onClick={() => setEraseTool("rect")}>
                                {t.common.cropper?.rectSelect || "矩形选区"}
                            </button>
                            {eraseTool === "brush" && (
                                <span className="flex items-center gap-1">
                                    <span className="text-xs text-muted-foreground">
                                        {t.common.cropper?.brushSize || "粗细"}
                                    </span>
                                    {BRUSH_LABELS.map((label, i) => (
                                        <button
                                            key={i}
                                            type="button"
                                            className={btn(brushIdx === i)}
                                            onClick={() => setBrushIdx(i)}
                                            title={BRUSH_TITLES[i]}
                                            style={{ fontSize: BRUSH_FONT_PX[i], lineHeight: 1 }}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </span>
                            )}
                            <button type="button" className={btn(false)} onClick={undo} disabled={!hasShapes} title="撤销 (Ctrl+Z)">
                                {t.common.cropper?.undo || "↩️"}
                            </button>
                            <button
                                type="button"
                                className={btn(false)}
                                onClick={erasePendingRect}
                                disabled={!pendingRect}
                                title="擦除选区 (Delete)"
                            >
                                {t.common.cropper?.eraseSelection || "🗑️"}
                            </button>
                        </>
                    )}

                    {mode === "label" && (
                        <>
                            <button
                                type="button"
                                className={btn(labelKind === "question")}
                                onClick={() => setLabelKind("question")}
                                style={labelKind === "question" ? { background: QUESTION_COLOR, borderColor: QUESTION_COLOR, color: "#fff" } : undefined}
                            >
                                {t.common.cropper?.labelQuestion || "题干（红框）"}
                            </button>
                            <button
                                type="button"
                                className={btn(labelKind === "answer")}
                                onClick={() => setLabelKind("answer")}
                                style={labelKind === "answer" ? { background: ANSWER_COLOR, borderColor: ANSWER_COLOR, color: "#fff" } : undefined}
                            >
                                {t.common.cropper?.labelAnswer || "手写答案（蓝框）"}
                            </button>
                            {/* 【custom-v25 绿框】区🟩 = 一道题的范围（同时就是裁剪边界）。
                                确认后按"合并后的绿框"逐块裁出来分别送 AI。 */}
                            <button
                                type="button"
                                className={btn(labelKind === "region")}
                                onClick={() => setLabelKind("region")}
                                style={labelKind === "region" ? { background: REGION_COLOR, borderColor: REGION_COLOR, color: "#fff" } : undefined}
                                title="一个绿框 = 一道题；重叠的绿框会合并成一道。确认时会把绿框逐块裁出来分别送 AI，绿框以外不要"
                            >
                                {t.common.cropper?.labelRegion || "区🟩"}
                            </button>
                            {/* 【custom-v27 仅画】强制画框：选中后起手即画新框，不再"点中旧框就选中它"。
                                电脑端按住 Shift 等效于此开关（松开即还原）。 */}
                            <button
                                type="button"
                                className={btn(drawOnly)}
                                onClick={() => setDrawOnly((v) => !v)}
                                title="仅画：起手就画新框，不会选中已有框（电脑端按住 Shift 键同样生效）"
                            >
                                {t.common.cropper?.drawOnly || "仅画"}
                            </button>
                            <button type="button" className={btn(false)} onClick={removeSelectedBox} disabled={!selectedBoxId}>
                                {t.common.cropper?.deleteBox || "删除选中框"}
                            </button>
                            <button
                                type="button"
                                className={btn(cropToRegions)}
                                onClick={() => setCropToRegions((v) => !v)}
                                disabled={boxes.length === 0}
                                title="仅发送标注区域（省 token）"
                            >
                                {t.common.cropper?.cropToRegions || "省🔡"}
                            </button>
                        </>
                    )}

                    {mode === "crop" && boxes.length > 0 && (
                        <button
                            type="button"
                            className={btn(cropToRegions)}
                            onClick={() => setCropToRegions((v) => !v)}
                            title="仅发送标注区域（省 token）"
                        >
                            {t.common.cropper?.cropToRegions || "省🔡"}
                        </button>
                    )}
                </div>

                {/* ===== 图片区：裁剪/橡皮擦/标注全部共用同一套 canvas，坐标完全一致 ===== */}
                <div
                    ref={viewportRef}
                    onDoubleClick={(e) => {
                        // 双击 = 「适应窗口」↔「100%」；若两者本就一样（小图），改用「适应」↔「200%」
                        const fitZ = computeFitZoom();
                        const cur = zoomRef.current;
                        const target = Math.abs(fitZ - 1) < 0.05 ? 2 : 1;
                        if (Math.abs(cur - fitZ) < 0.02 * Math.max(1, fitZ)) {
                            zoomAt(target, e.clientX, e.clientY);
                        } else {
                            fitView();
                        }
                    }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerEnter={onPointerEnter}
                    onPointerLeave={onPointerLeave}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onContextMenu={(e) => e.preventDefault()}
                    className="flex-1 min-h-0 bg-black w-full"
                    style={{ position: "relative", overflow: "hidden", touchAction: "none" }}
                >
                    <div
                        ref={wrapRef}
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            // 显式定尺 = 图片自然像素：绝对定位元素若不设宽高，
                            // shrink-to-fit 会把盒宽截断成包含块宽度，导致 overlay 尺寸算错、坐标错位
                            width: natSize.w || undefined,
                            height: natSize.h || undefined,
                            lineHeight: 0,
                            transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})`,
                            transformOrigin: "0 0",
                        }}
                    >
                        <canvas
                            ref={baseCanvasRef}
                            style={{ display: "block" }}
                        />
                        <canvas
                            ref={overlayCanvasRef}
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: natSize.w || undefined,
                                height: natSize.h || undefined,
                                cursor: panMode
                                    ? "grab"
                                    : mode === "erase" && eraseTool === "brush"
                                        ? "none"
                                        : "crosshair",
                                touchAction: "none",
                            }}
                        />
                        {/* 笔刷光标预览圈：跟随鼠标，大小随粗细变化 */}
                        {mode === "erase" && eraseTool === "brush" && cursorPos && (() => {
                            // BRUSH_SIZES 表示“显示像素直径”，光标直接用该大小，
                            // 实际涂抹按同尺寸换算成自然坐标，保证光标与擦除范围一致
                            // 预览圈位于被缩放的容器内，尺寸需除以 zoom 才能在屏幕上保持原大小
                            const brushSizePx = BRUSH_SIZES[brushIdx] / zoom;
                            return (
                                <div
                                    style={{
                                        position: "absolute",
                                        left: cursorPos.x,
                                        top: cursorPos.y,
                                        width: brushSizePx,
                                        height: brushSizePx,
                                        transform: "translate(-50%, -50%)",
                                        border: `${1.5 / zoom}px solid #00c853`,
                                        borderRadius: "50%",
                                        pointerEvents: "none",
                                        boxSizing: "border-box",
                                    }}
                                />
                            );
                        })()}
                    </div>

                    {/*
                      【custom-v27 十字基准线】三页通用：指针落在图片范围内时，
                      给出贯穿图片编辑区的横纵两条浅青基准线（类似 AutoCAD 的十字光标）。
                      用视口坐标定位、放在被缩放容器**之外**，缩放/平移后仍与光标对齐；
                      线只画在图片矩形内（由 view/zoom 推算），落在黑底上即隐藏。
                    */}
                    {crossPos && (() => {
                        const imgLeft = view.x;
                        const imgTop = view.y;
                        const imgW = (natSize.w || 0) * zoom;
                        const imgH = (natSize.h || 0) * zoom;
                        const inside =
                            crossPos.x >= imgLeft && crossPos.x <= imgLeft + imgW &&
                            crossPos.y >= imgTop && crossPos.y <= imgTop + imgH;
                        if (!inside) return null;
                        const lineColor = "rgba(0, 200, 220, 0.75)"; // 浅青：不抢原图，也不与红/绿/蓝框混淆
                        return (
                            <>
                                <div
                                    style={{
                                        position: "absolute",
                                        left: imgLeft, top: crossPos.y,
                                        width: imgW, height: 1,
                                        background: lineColor,
                                        pointerEvents: "none",
                                    }}
                                />
                                <div
                                    style={{
                                        position: "absolute",
                                        left: crossPos.x, top: imgTop,
                                        width: 1, height: imgH,
                                        background: lineColor,
                                        pointerEvents: "none",
                                    }}
                                />
                            </>
                        );
                    })()}
                </div>

                {/* ===== 底部 ===== */}
                <div className="p-4 border-t bg-background shrink-0">
                    {/* 送 AI 期间对话框不再关闭（失败要保留编辑成果），页面上那套进度提示被
                        对话框盖住了，所以在这里自己给一个反馈，并明说"失败可原地重试"。 */}
                    {analyzing && (
                        <p className="mb-2 flex items-center gap-1.5 text-xs text-primary">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            正在分析…编辑已保留；若失败可直接再点「确定」重试
                        </p>
                    )}
                    <div className="flex flex-wrap justify-between items-center gap-x-4 gap-y-2">
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setShowHelp(true); }}
                            className="text-sm text-primary underline underline-offset-2 hover:opacity-80 shrink-0"
                        >
                            {t.common.cropper?.help || "说明 ⓘ"}
                        </button>
                        {/* 【custom-v34】原来挂标题栏上的「本页已录 N 道」挪到这里 ——
                            标题栏已撤掉，而这个进度在「循环录题」模式下是唯一的进度锚点，
                            不能跟着一起消失。绿框说明收进 title，不占地方。 */}
                        {(loopCount ?? 0) > 0 && (
                            <span
                                className="text-xs text-muted-foreground truncate min-w-0"
                                title={t.common.cropper?.loopHint
                                    || "绿色框是已录入的题，避开它们框下一道；保存后会自动回到本页"}
                            >
                                {t.common.cropper?.loopProgress
                                    ? t.common.cropper.loopProgress.replace("{n}", String(loopCount))
                                    : `本页已录 ${loopCount} 道`}
                            </span>
                        )}
                        {/* 【custom-v34】按钮从 3 个变 4 个（多了「平移」），窄屏会挤出边界 →
                            让这一排允许换行。对话框现在是整屏的，宽度就是手机屏宽，
                            这一排必须自己会折行，不能指望有富余。 */}
                        <div className="flex flex-wrap justify-end gap-2 shrink-0">
                            {/* 【custom-v34】原在工具栏最右的「🧭移」挪到这里并改名「平移」：
                                它不是对图片的加工，只是"鼠标左键用来做什么"的临时开关，
                                放在加工按钮那一排里既容易误触、又拉长了那一排。 */}
                            <Button
                                variant="outline"
                                onClick={() => setPanMode((v) => !v)}
                                disabled={analyzing}
                                aria-pressed={panMode}
                                title="开启后鼠标左键仅用于平移图片（也可随时按住右键拖拽平移）"
                                className={panMode
                                    ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                                    : undefined}
                            >
                                {t.common.cropper?.pan || "平移"}
                            </Button>
                            <Button variant="outline" onClick={resetToOriginal} disabled={analyzing}>
                                {t.common.cropper?.original || "原图"}
                            </Button>
                            {/* 取消保持可用：AI 卡住时留一个逃生口（代价是编辑成果不保，属用户明确选择） */}
                            <Button variant="outline" onClick={onClose}>
                                {t.common.cancel || "Cancel"}
                            </Button>
                            <Button onClick={handleConfirm} disabled={analyzing}>
                                {analyzing
                                    ? t.common.pleaseWait || "请稍候"
                                    : t.common.confirm || "Confirm"}
                            </Button>
                        </div>
                    </div>
                </div>

                {/* 说明弹窗：点任意处关闭（含点击卡片本身） */}
                {showHelp && (
                    <div
                        className="absolute inset-0 z-30 flex items-end justify-center p-4"
                        style={{ background: "rgba(0,0,0,0.35)" }}
                    >
                        <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 text-sm max-w-lg">
                            <div className="font-semibold mb-2">{t.common.cropper?.helpTitle || "操作说明"}</div>
                            <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                                <li>{t.common.cropper?.hint || "✂️裁：在图片上拖拽框选要保留的区域，再切 🧽擦 / 📊框；不框则保留整图"}</li>
                                <li>{t.common.cropper?.hintErase || "🧽擦：🖍️ 按住涂抹即擦掉（涂白）；🟧 拖框后按 Delete 或点 🗑️。🔙 撤销"}</li>
                                <li>{t.common.cropper?.hintLabel || "📊框：先选 题🟥 或 答🟦，再在图上拖框；点边框附近即选中该框"}</li>
                                <li>{t.common.cropper?.hintRegion || "区🟩 一个框 = 一道题：重叠的绿框自动合并；确认时每个区各裁一块分别送 AI，框外不要"}</li>
                                <li>🔍 手机：双指捏合缩放、双指拖动平移（图片或黑底上均可）｜ 电脑：滚轮以鼠标为中心缩放、按住右键拖拽平移、也可开下方的「平移」开关用左键平移、双击放大/复位</li>
                                {/* 【custom-v35】翻转会清空半成品标记，这件事必须提前说清楚，
                                    否则用户擦了半天、点一下转就全没了。 */}
                                <li>🔄转：整页逆时针转 90°（可连续转）。**先把方向转正再动笔** —— 翻转会清掉还没提交的擦除痕迹、标注框和裁剪框；已录入的绿框不受影响，会跟着一起转</li>
                            </ul>
                            <div className="mt-2 text-xs text-muted-foreground">（点击任意位置关闭）</div>
                        </div>
                    </div>
                )}
            </DialogContent>

            {/*
              拉伸浮层（问题③）：把当前图交给拍摄扫描器，拉正 + 漂白/黑白后回传新图。
              ⚠️ 必须 portal 到 body，不能内嵌在 DialogContent 里 —— DialogContent 基类自带
                 translate（由此成为 fixed 后代的包含块）且 overflow-hidden，内嵌的全屏浮层
                 会被裁成对话框那么大，直接废掉。
              浮层期间 Dialog 已切到 modal={false}；DialogContent 的 onPointerDownOutside
              早就 preventDefault，所以点浮层不会误关编辑器。
            */}
            {portalReady &&
                createPortal(
                    <DocScanner
                        ref={scannerRef}
                        onScanComplete={handleStretchDone}
                        onClose={() => setStretchOpen(false)}
                    />,
                    document.body
                )}
        </Dialog>
    );
}
