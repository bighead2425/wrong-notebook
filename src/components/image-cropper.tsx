"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { DocScanner, type DocScannerHandle } from "@/components/doc-scanner";
import { ccwCanvasMatrix, rotateCanvasSize, rotateRectCCW } from "@/lib/image-rotation";
import { fitEditSize } from "@/lib/edit-canvas-size";
import { toCropBoxKind, rebaseCropRegions, clipCropBoxes, figuresForSplit, type CropRegions } from "@/lib/crop-regions";

/**
 * 取 2D 上下文。**两种后端，按画布用途选**（v36 审计后改的口径，别再混用）：
 *
 * · ctx2d()     —— 默认后端，给**会被显示出来的**画布（base / overlay）。
 *   Chromium 对 GPU 后端画布走"直接合成"快路径，不需要分块栅格化，是更稳的一条路。
 * · ctx2dSoft() —— 软件后端（willReadFrequently: true），给**只在内存里算**的离屏画布
 *   （orig / work / 各种克隆）。这些画布从不显示，软件后端让 getImageData / toBlob
 *   这类读回操作更快，也避免占用显存。
 *
 * ⚠️ 上一版（v36 第一稿）图省事把 willReadFrequently 加到了所有画布上，包括被显示的
 * base/overlay —— 那恰好走反了：Chromium issue #870222 里写得很清楚，**软件后端的画布
 * 会退化成需要分块栅格化的 PictureLayer，超大画布时"栅格化做一半就放弃"**，
 * 表现就是画面被切成几条、新旧内容混排。显示用画布一律不要带这个 flag。
 *
 * flag 只在**首次 getContext** 时生效，所以必须在创建画布的地方就带上。
 */
function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
    return c.getContext("2d");
}

/** 离屏工作画布专用：软件后端，读回快、不占显存（见 ctx2d 注释） */
function ctx2dSoft(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
    return c.getContext("2d", { willReadFrequently: true });
}

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
    /**
     * 【M1 / 2026-09-26】确认时回传**四类框的坐标 + 基准图尺寸**。
     *
     * 为什么必须新开一个回调，而不是复用 `onCropRegion`：
     * `onCropRegion` 回的是"**这一道**在整页上的范围"（单个矩形，给循环模式画已抠标记用），
     * 而这里要的是"**这张图上有哪些框、各是什么语义**"（题干/手写/作用域/题图）。
     * 两者的数据形状和用途都不同，混用必然有一方被将就。
     *
     * ⚠️ **坐标系合同（2026-09-26 二修，最要紧的一条）**：
     * `boxes` 与 `base` 都是相对于**最终存下来的那张图**（= `originalImageUrl`），
     * 不是相对于工作画布、更不是相对于整页。
     * 因为读取端 `useFigureImages` 会拿 `item.originalImageUrl` 的自然尺寸去对 `base`，
     * 两边若不同系，就是"不报错、只裁歪"。编辑器内部已经替调用方把
     * "减去导出区原点"这步算掉了，调用方**拿到就能直接序列化存库**。
     *
     * 传 null 的三种情形（调用方据此走"没有净版"的兜底，**不是**"写一份空坐标"）：
     *   ① 一个框都没画；② 走的"红蓝重叠分图"那一路（框被重排到新位置，原坐标作废）。
     *
     * 传了它 → 确认时会把框坐标一并回传；没传 → 完全保持旧行为，老调用方不受影响。
     */
    onCropRegions?: (payload: CropRegionsPayload | null) => void;
    /**
     * 【M1 / 2026-09-26】绿框"一图多题"路专用：**每张裁出来的图各拿一份坐标**。
     *
     * 与 `onCropRegions` 的分工：那条路一次产出好几张图、每张都会**各存各的**
     * `originalImageUrl`，所以坐标也必须**一图一份**（数组下标与 `onCropBatch`
     * 传出的 `blobs` **一一对应**；某张没框则该项为 null）。
     * 组件会把它与 `onCropBatch` **同一次调用里**传出，调用方应成对消费。
     *
     * 只接了 `onCropRegions` 而没接这个：那条路不写坐标（退化成无净版），
     * 但不会写错 —— 这是有意留的安全边。
     */
    onCropRegionsMulti?: (payloads: (CropRegionsPayload | null)[]) => void;
}

/**
 * 【M1】回传给调用方的框坐标包。
 * 形状**刻意与 `lib/crop-regions.ts` 的 `CropRegions` 一致**，
 * 好让调用方直接 `serializeCropRegions()` 存库，中间不再有一层手工转换。
 */
export interface CropRegionsPayload {
    boxes: { kind: 'scope' | 'question' | 'handwriting' | 'figure'; x: number; y: number; w: number; h: number }[];
    base: { w: number; h: number; rotation: number };
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
 *
 * 【M1 / 2026-09-26】figure = 橙框「图🟧」= 题图（不可 OCR 的图像部分）。
 * 与绿框同属"分区"层，不进「题干/手写」的判定：它是给净版用的 ——
 * 净版要把 蓝（手写）∪ 橙（题图）一起涂白，题图再单独裁出来放到题干下方。
 * 见 `lib/crop-regions.ts` 的 `planNetVersion`。
 */
type LabelKind = "question" | "answer" | "region" | "figure";
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
/**
 * 【M1 / 2026-09-26】橙 = 题图（图🟧，不可 OCR 的图像部分）。
 * 选饱和橙：与红的题干 (#e50000) 拉得开 —— 红偏暗、橙偏亮，叠在同一页也能分清。
 * ⚠️ 与"擦除-矩形选区"的 🟧 是同一个色系，但两者不在同一模式下同时出现，不会混。
 */
const FIGURE_COLOR = "#ff7a00";
/**
 * 【M1】四种框 → 颜色的**唯一**映射表。
 * 原先三处各写一遍 `kind === "question" ? ... : kind === "answer" ? ... : REGION_COLOR`，
 * 加第四种时必然漏改某一处（且漏改不报错、只是画错颜色）。收成一张表，只此一份。
 */
const LABEL_COLORS: Record<LabelKind, string> = {
    question: QUESTION_COLOR,
    answer: ANSWER_COLOR,
    region: REGION_COLOR,
    figure: FIGURE_COLOR,
};
/**
 * 【M1】哪些框是"分区层"—— 它们**不参与**「告诉 AI 这段是什么」的判定。
 *
 * **作用域层**（不是"分区层"）：只划范围、不参与「这段像素是什么」的判定。
 *   region 绿 = 这道题的范围（裁剪边界）
 *
 * ⚠️ 2026-09-26 修：橙框（figure）**不在**这一层。
 *    设计是两层：作用域 = 绿框；语义 = 蓝 > 橙 > 红。
 *    橙框和红蓝框一样要回答"这段是什么"（它是"题图"），所以属语义层。
 *    原先把 figure 也算进来，导致：
 *      ① 导出区包围盒不算橙框（题图可能被裁掉）；
 *      ② 红蓝重叠分图时橙框坐标被一起丢弃（线上 bug SX20260926002：题图消失）。
 *    ⚠️ 但**框线不上纸**这条不变：橙框仍不该 strokeRect 到导出图上。
 *    两件事分开办 —— "要不要算进坐标"与"要不要画出来"不是同一个问题。
 */
const SCOPE_KINDS: readonly LabelKind[] = ["region"];
function isScopeKind(kind: LabelKind): boolean {
    return SCOPE_KINDS.includes(kind);
}
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
    onCropRegions,
    onCropRegionsMulti,
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
    // 画布内部像素尺寸（自然分辨率）。wrapper 的**布局**尺寸 = 它 × zoom（见 wrap 的长注释）
    const [natSize, setNatSize] = useState({ w: 0, h: 0 });
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
     * 用视口坐标而非容器坐标：容器随缩放/平移移动，容器坐标会与光标脱节；
     * 视口坐标直接与十字线定位（view/zoom 推算）对齐，画在容器**之外**也不受其影响。
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
                ctx2dSoft(fc)?.drawImage(origCanvasRef.current, 0, 0);
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
        // 【custom-v36】超大图等比收到长边 MAX_EDIT_EDGE 以内再进工作画布：
        // 全分辨率画布是"转一下就碎成拼条"的直接诱因（见 ctx2d 注释），
        // 3200 也远高于下游实际用量（AI 1920 / 落库 1920），画质不吃亏。
        // 原始文件不动，缩的只是裁剪窗里的工作副本。
        const size = fitEditSize(nw, nh);
        // 原图只建立一次；后续擦除结果不会覆盖它
        if (!origCanvasRef.current) {
            const oc = document.createElement("canvas");
            oc.width = size.w;
            oc.height = size.h;
            ctx2dSoft(oc)?.drawImage(img, 0, 0, size.w, size.h);
            origCanvasRef.current = oc;
        }
        if (!workCanvasRef.current) {
            const wc = document.createElement("canvas");
            wc.width = size.w;
            wc.height = size.h;
            // 初始化即画原图，避免从 crop 切出时 workCanvas 是空的（黑屏）
            ctx2dSoft(wc)?.drawImage(origCanvasRef.current, 0, 0);
            workCanvasRef.current = wc;
        }
        return workCanvasRef.current;
    }, []);

    /** 重放：原图 + 已提交擦除图形。白色填充幂等 → 顺序无关 → 重放即精确撤销 */
    const redrawWork = useCallback(() => {
        const wc = workCanvasRef.current;
        const oc = origCanvasRef.current;
        if (!wc || !oc) return;
        const ctx = ctx2dSoft(wc);
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
        const ctx = ctx2d(base);
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
        const ctx = ctx2d(ov);
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
            const color = LABEL_COLORS[b.kind];
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
                    const color = LABEL_COLORS[labelKind];
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
        const cctx = ctx2dSoft(cropped);
        if (!cctx) return;
        // 从原始基准图提取，确保 crop 模式下 workCanvas 尚未重绘也不会拿到黑图
        cctx.drawImage(oc, r.x, r.y, r.w, r.h, 0, 0, cropped.width, cropped.height);

        // 重置基准：原图与工作画布都换成裁剪图，擦除记录清空（基准变了）
        origCanvasRef.current = cropped;
        const newWc = document.createElement("canvas");
        newWc.width = cropped.width;
        newWc.height = cropped.height;
        ctx2dSoft(newWc)?.drawImage(cropped, 0, 0);
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
    //  显示尺寸 = 自然像素 × zoom —— 这个等式是全套换算的地基：
    //  渲染靠 wrapper 的宽高直接写成显示尺寸（v36 起，不再用 scale 变换），
    //  屏幕→自然坐标一律用「覆盖层实际屏幕宽度」反推（getBoundingClientRect），
    //  所以换模型时这些换算一行都不用改。
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
     * 【custom-v33 立；custom-v35 改口径；custom-v36 审计调整】整页逆时针转 90°（工具栏「转」）。
     *
     * 用途：扫描件方向躺倒了。与「抻」分工不同 —— 抻治"歪"（梯形透视），转治"倒"（方向）。
     *
     * ── 挂在坐标系上的东西怎么办（口径变过两次，以现在为准）─────────────
     * 曾经（v33）是把擦除痕迹、标注框、裁剪框、绿框一起"搬"到新坐标系，代价是要同时搬运
     * 六处坐标，漏一处或参照系搞混就是"擦 A 处、白的是 B 处"这种**不报错、只画错**的 bug。
     * v35 起改成：**尚未提交的标记一律清空**（用户本来就是"先转正、再动笔"），
     * 只有代表既成事实的绿框（本页已录入的题）与"整页已抠坐标"继续跟着转。
     * 清空是有前提的 —— 因为它意味着 wc ≡ oc，v36 顺势把工作画布改成**克隆转好的基准图**，
     * 不再让两张画布各转一次（见下面 turn/cloneCanvas 的注释）。
     *
     * 逆时针 90° 的映射一律取自 lib/image-rotation（纯函数 + 单测钉着），
     * 图片走 ccwCanvasMatrix、框走 rotateRectCCW，两者有交叉验证保证同一参照系。
     */
    const rotateLeft = useCallback(() => {
        const oc = origCanvasRef.current;
        const wc = workCanvasRef.current;
        if (!oc || !wc) return;
        const srcW = wc.width;
        const srcH = wc.height;
        if (!srcW || !srcH) return;

        /**
         * 【custom-v36 审计调整】先问后做：确认弹窗挪到**建画布之前**。
         *
         * 上一版是先转好两张全分辨率画布、再问用户"确定要翻转吗"。用户点"取消"时
         * 那两张画布已经白建了 —— 在本机/手机上等于凭空申请几十上百 MB，
         * 而我们正是在内存吃紧的机器上排查问题，没必要自己给自己加压。
         */
        const hasPendingMarks =
            shapesRef.current.length > 0 || boxes.length > 0 || !!cropRect || !!pendingRect;
        if (hasPendingMarks) {
            const msg = t.common.cropper?.rotateClearConfirm
                || "翻转会清掉你还没提交的标记（擦除痕迹、标注框、裁剪框）。确定要翻转吗？";
            if (!window.confirm(msg)) return;
        }

        /**
         * 转基准图。长宽对调（rotateCanvasSize），矩阵来自 lib（见 turn 内注释）。
         *
         * ⚠️【custom-v34 教训】转完**基准图与工作画布两张都得换成新尺寸**。
         * 曾经只换基准图、工作画布留在旧尺寸 → redrawWork 把"转后 H×W"的图往
         * "旧 W×H"的画布里画，右边/下边被直接裁掉，看上去就像"转一下图被截成了方形"。
         *
         * 【custom-v36 审计调整】工作画布不再"自己转一遍"，而是**克隆转好的基准图**。
         * 为什么这样更对：按 v35 的既定口径，翻转会把尚未提交的痕迹全部清空，
         * 那么转完之后 工作画布 ≡ 基准图（内容与尺寸完全一致）—— 这是可以直接构造的，
         * 没必要让两张画布各自跑一次同样的变换、再指望它们必然一致。
         * 两张画布一旦因为任何原因漂移（历史 bug 家族：尺寸不同步、参照系搞混），
         * redrawWork 就变成"把大图往小画布里画"，**不报错、只把内容裁掉**，
         * 是最难查的一类故障。克隆法让这类漂移从结构上不可能发生，顺带少画一张大画布。
         */
        const turn = (src: HTMLCanvasElement): HTMLCanvasElement | null => {
            const size = rotateCanvasSize(src.width, src.height);
            const nc = document.createElement("canvas");
            nc.width = size.w;
            nc.height = size.h;
            const ctx = ctx2dSoft(nc);
            if (!ctx) return null;
            // 逆时针 90° 的矩阵来自 lib/image-rotation（单测钉着，与搬框用的
            // rotateRectCCW 是同一套参照系 —— 两者必须一致，否则框线会与图错开）。
            // 平移量用**这张画布自己的宽**：两张画布的尺寸未必相同，用外面那张的宽会直接错位。
            const m = ccwCanvasMatrix(src.width);
            ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
            ctx.drawImage(src, 0, 0);
            return nc;
        };

        /** 无变换地整张复制（尺寸/内容与源完全一致） */
        const cloneCanvas = (src: HTMLCanvasElement): HTMLCanvasElement | null => {
            const nc = document.createElement("canvas");
            nc.width = src.width;
            nc.height = src.height;
            const ctx = ctx2dSoft(nc);
            if (!ctx) return null;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(src, 0, 0);
            return nc;
        };

        const noc = turn(oc);
        if (!noc) return;
        const nwc = cloneCanvas(noc);
        if (!nwc) return;

        /**
         * 【custom-v35】翻转前清场：擦除痕迹、标注框、裁剪框、待定框一律清空，
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
        origCanvasRef.current = noc;
        // 工作画布是上面克隆出来的"转好的基准图"，尺寸/内容与 noc 完全一致 ——
        // 下面 redrawWork() 只是把清空后的痕迹（空集）重放一遍，结果不变，但保持了
        // "工作画布 = 基准图 + 已提交痕迹"这条不变量，不留下特例。
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
        ctx2dSoft(cloneOrig)?.drawImage(fi, 0, 0);
        origCanvasRef.current = cloneOrig;
        const wc = document.createElement("canvas");
        wc.width = fi.width;
        wc.height = fi.height;
        ctx2dSoft(wc)?.drawImage(fi, 0, 0);
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
                /**
                 * 【custom-v36 审计补齐】「抻」回来的图同样要过 fitEditSize。
                 *
                 * 今天 doc-scan 的出图上限是 MAX_OUTPUT_EDGE = 1920，所以这一步看不出差别；
                 * 但"编辑器里的画布尺寸不超过 MAX_EDIT_EDGE"必须是一条**没有例外**的不变量 ——
                 * 只要有一条入口能塞进来一张超大图，画布/内存那套毛病就又从这条缝里回来。
                 * 与其依赖"上游恰好也限制尺寸"，不如在自己这道门上再收一次边（幂等，小图不动）。
                 */
                const size = fitEditSize(img.naturalWidth, img.naturalHeight);
                const base = document.createElement("canvas");
                base.width = size.w;
                base.height = size.h;
                ctx2dSoft(base)?.drawImage(img, 0, 0, size.w, size.h);

                origCanvasRef.current = base;
                const wc = document.createElement("canvas");
                wc.width = base.width;
                wc.height = base.height;
                ctx2dSoft(wc)?.drawImage(base, 0, 0);
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
     *
     * 返回值：
     *   · `canvas` —— 要存下来的那张图；
     *   · `stem`   —— **题干区在这张图上的位置**（相对 `source` 的原点）。
     *     调用方要靠它把"没被搬动"的橙框坐标换算过来（见 `figuresForSplit`）。
     *
     *   ⚠️ `stem === null` 表示**其实没分成图**（拿不到 canvas 上下文，只能原样返回
     *      `source`）—— 此时布局就是 `source` 的布局，调用方**不能**按分图口径换算。
     *      分不成图的概率极低，但谎报布局的后果是"坐标全错"，宁可让它退化成"没有坐标"。
     */
    function buildSplitCanvas(
        source: HTMLCanvasElement,
        questions: Box[],
        answers: Box[],
        /**
         * **只参与"题干范围"计算**的附加框 —— 即橙框（题图）。
         *
         * ⚠️ 【2026-09-26 四修】为什么要加这个参数：分图产物是**存下来的那张图**
         *    （`originalImageUrl`），而题干范围原来只算 红∪蓝。橙框若压在红蓝包围盒
         *    之外（比如题图在题干下方、或手写没盖到它），那块像素**根本不在产物里**
         *    —— 题图自然就裁不出来了，用户看到的是"背面那张图没有了"。
         *
         *    设计上"文字 + 图 = 真题"（P5），所以题图本来就该算进题干范围。
         *    注意：这些框**只扩大范围**，不参与涂白、不参与画框线。
         */
        extraContent: Box[] = [],
    ): { canvas: HTMLCanvasElement; stem: { x: number; y: number; w: number; h: number } | null } {
        // 题目范围 = 红框 ∪ 蓝框 ∪ 橙框 并集
        // （红蓝是原逻辑；橙框见上面 extraContent 的说明）
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const b of [...questions, ...answers, ...extraContent]) {
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
        if (!sctx) return { canvas: source, stem: null };
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
        if (!octx) return { canvas: source, stem: null };
        octx.fillStyle = "#ffffff";
        octx.fillRect(0, 0, out.width, out.height);
        octx.drawImage(stem, 0, 0);
        let yy = stem.height + gap;
        for (const c of ansCanvases) { octx.drawImage(c, 0, yy); yy += c.height; }
        return { canvas: out, stem: { x: tx, y: ty, w: tw, h: th } };
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
    ): { canvas: HTMLCanvasElement; stem: { x: number; y: number; w: number; h: number } | null } {
        const sx = Math.max(0, Math.round(region.x));
        const sy = Math.max(0, Math.round(region.y));
        const sw = Math.max(1, Math.round(Math.min(region.w, baked.width - sx)));
        const sh = Math.max(1, Math.round(Math.min(region.h, baked.height - sy)));

        const sub = document.createElement("canvas");
        sub.width = sw;
        sub.height = sh;
        const sctx = sub.getContext("2d");
        if (!sctx) return { canvas: sub, stem: null };
        sctx.drawImage(baked, sx, sy, sw, sh, 0, 0, sw, sh);

        // 与这块区域有交集的红/蓝框才算属于这一道（题干/答案分图只认这两种），
        // 并平移到区域坐标系。
        // ⚠️ 这里**刻意只要红蓝**：绿框是裁剪边界（本函数的 region 参数就是它），
        //    橙框是"题图"、既不是题干也不是答案，混进来会被 drawSplit 当内容处理。
        //    橙框的归属由调用方的 `clipCropBoxes` 单独算（那边按"有交集"取，含橙框）。
        const inside = boxes.filter(
            (b) => (b.kind === "question" || b.kind === "answer")
                && rectsIntersect(b, { x: sx, y: sy, w: sw, h: sh }),
        );
        const questions = inside.filter((b) => b.kind === "question")
            .map((b) => ({ ...b, x: b.x - sx, y: b.y - sy }));
        const answers = inside.filter((b) => b.kind === "answer")
            .map((b) => ({ ...b, x: b.x - sx, y: b.y - sy }));
        /**
         * 橙框（题图）也在这一块里时，要把它算进**题干范围**：
         * 否则分图产物里根本没有那块像素，题图就再也裁不出来了。
         * （只扩范围，不涂白、不画线。）
         */
        const figuresHere = boxes
            .filter((b) => b.kind === "figure" && rectsIntersect(b, { x: sx, y: sy, w: sw, h: sh }))
            .map((b) => ({ ...b, x: b.x - sx, y: b.y - sy }));
        const overlaps = questions.length > 0 && answers.length > 0
            && answers.some((a) => questions.some((q) => rectsIntersect(a, q)));

        if (cropToRegions && overlaps) {
            /**
             * ⚠️ 【2026-09-26 三修】这里以前注释写着"stem 在绿框路径用不到"——**错的**。
             *
             * 分图产物是"题干区 + gap + 答案堆叠"的重排图，而这一路存进
             * `originalImageUrl` 的就是它。调用方若还按**绿框尺寸**算坐标
             * （base = clip），读取端拿拼图的实际尺寸去比，就会既缩又移，
             * 把题图裁到别处 —— 同款"不报错只裁歪"。
             * 所以必须把 stem 交出去，让调用方按拼图布局换算橙框坐标。
             */
            const split = buildSplitCanvas(sub, questions, answers, figuresHere);
            return { canvas: split.canvas, stem: split.stem };
        }
        if (inside.length > 0) {
            const lw = Math.max(1.5, 2);
            for (const b of [...questions, ...answers]) {
                sctx.save();
                sctx.strokeStyle = LABEL_COLORS[b.kind];
                sctx.lineWidth = lw;
                sctx.strokeRect(b.x, b.y, b.w, b.h);
                sctx.restore();
            }
        }
        return { canvas: sub, stem: null };
    }

    /**
     * 【M1 / 2026-09-26】把当前所有框收成"可落库"的坐标包。
     *
     * 三件事必须一起做对，否则就是"不报错、只画错"：
     *   ① 用 `toCropBoxKind` 把 UI 名翻成规范名（answer→handwriting、region→scope）；
     *   ② 带上**基准图尺寸** —— 只存框不存尺寸，图一换尺寸框就全错位；
     *   ③ 认不出的框类型**整包判废**（返回 null），不半信半疑地塞进去。
     *      宁可这一道没有坐标（退化成"没有净版"），也不能给一份错坐标
     *      （错坐标的后果是手写没擦干净、孩子看见自己的答案）。
     *
     * ── ⚠️ 2026-09-26 补：基准必须与**存下来的那张图**对齐 ──────────────
     * 本函数只能拿到"当前工作画布"的尺寸，而存进 `originalImageUrl` 的图是
     * **这一幕之后被裁过的**（见 handleConfirm 的分支 sx/sy/sw/sh，之后 processImageFile
     * 还可能再压缩一次）。若直接拿工作画布尺寸当 base，读的那一头
     * （`useFigureImages` 从 `originalImageUrl` 上按 base 换算）就会把框裁歪。
     *
     * 所以这里改成**由调用方决定坐标系**：
     *   · `base` 传"存下来的那张图"的尺寸；
     *   · 画布坐标 → 存图坐标的换算（减去裁剪原点 + 按缩放比缩放）一并交给本函数，
     *     因为它跟 `boxes` 一样是"这一刻的地理"，外面拿不到更准的值。
     *
     * 调用方在**扣掉框线烘焙之前**调用（`bctx.strokeRect` 只是把线画在导出的副本上，
     * 不改 `boxes`，所以那一刻取坐标仍然干净）。
     */
    const collectCropRegions = (
        canvas: HTMLCanvasElement,
        frame?: {
            offsetX: number;
            offsetY: number;
            scaleX?: number;
            scaleY?: number;
            /**
             * **存下来的那张图**的实际宽高（不传则按画布尺寸推）。
             *
             * ⚠️ 【2026-09-26 四修】这个参数是补上一个真 bug 的：
             *    原来 base 恒等于 `canvas.width/height`（调用方 scaleX 都传 1），
             *    可导出区是**画布的一块子矩形**时（裁剪框 / 按框导出），
             *    存下来的图比画布小 ⇒ base 偏大 ⇒ 读取端按"实际图尺寸 ÷ base"
             *    去缩坐标，题图就被裁到**偏左上的一块**（又是"不报错只画歪"）。
             *    本函数文档一直写着"base = 存下来的那张图的尺寸"，
             *    实现却够不到这个信息 —— 现在由调用方显式传进来。
             */
            outW?: number;
            outH?: number;
        },
    ): CropRegionsPayload | null => {
        const out: CropRegionsPayload['boxes'] = [];
        for (const b of boxes) {
            const kind = toCropBoxKind(b.kind);
            if (!kind) return null; // 认不出 → 整包不要，别猜
            if (!(b.w > 0) || !(b.h > 0)) continue; // 零面积框丢弃：留着只会污染涂白并集
            out.push({ kind, x: b.x, y: b.y, w: b.w, h: b.h });
        }
        // 没有任何框：不回传（调用方据此知道"这道没有坐标"，走兜底）
        if (out.length === 0) return null;

        // 基准 = **存下来的那张图**的尺寸；rotation 记 0 ——
        // 当前实现里旋转是**烘进画布像素**的（见 rotateCanvasSize 的用法），
        // 导出时画布已是"转过之后"的样子，坐标与它同系，读取端不必再转。
        const raw: CropRegions = {
            boxes: out,
            base: { w: canvas.width, h: canvas.height, rotation: 0 },
        };

        // 无 frame（整页语义，读取端拿到的就是这张画布）→ 原样返回
        if (!frame) return raw;

        // 有 frame（导出区≠整画布）→ 走**同一个**换算函数。
        // ⚠️ 换算必须复用 `rebaseCropRegions` 而不是在这儿再写一遍加减法：
        //    这类"看着对、差一格"的活，两处实现就是两份未来的 bug。
        const sx = frame.scaleX ?? 1;
        const sy = frame.scaleY ?? 1;
        return rebaseCropRegions(raw, {
            offsetX: frame.offsetX,
            offsetY: frame.offsetY,
            scaleX: sx,
            scaleY: sy,
            // 优先用调用方给的"存图尺寸"；没给才按画布推（scaleX 为 1 时二者相同）
            baseW: frame.outW ?? canvas.width * sx,
            baseH: frame.outH ?? canvas.height * sy,
        });
    };

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
            /**
             * 【2026-09-26 三修】这一路走的是 `onCropRegionsMulti`（每块一张图各带一份坐标），
             * **不会**经过单张的 `onCropRegions`。所以必须显式把单张通道清成 null ——
             * 否则调用方里暂存的"上一道题的坐标"会被留到下一次单张保存上，
             * 表现是"这道题按上一道的位置涂白/裁题图"，又是一次不报错只画错。
             */
            onCropRegions?.(null);
            const whole = document.createElement("canvas");
            whole.width = wc.width;
            whole.height = wc.height;
            whole.getContext("2d")?.drawImage(wc, 0, 0);

            const regions = mergeRegions(regionBoxes);
            const blobs: Blob[] = [];
            /**
             * 【M1】每张裁出的图，各自对应的裁剪区（与 blobs 同序）—— 坐标要靠它换算。
             * 这里必须与 `buildRegionCanvas` 用**同一个口径**算裁剪区（同 round、同夹取），
             * 否则图与坐标会差一两个像素：图上看得见的小错，落到纸上就是净版边上
             * 留一条没擦干净的手写。所以下面单独算一遍，取值规则抄它的。
             */
            /**
             * 【2026-09-26 三修】每张图**实际**的三件事，与 blobs 同序：
             *   · `clip`  绿框在整页上的位置（用来把整页坐标平移到这张图上）；
             *   · `stem`  分图产物的题干区位置（null = 没分图）；
             *   · `w/h`   **真正存下来的那张图**的尺寸 —— base 必须用它。
             * 之前只记了 `clip`，等于默认"图 = 绿框那一小块"；
             * 而省🔡 + 红蓝重叠时，图其实是重排过的拼图，尺寸和布局都变了。
             */
            const parts: {
                clip: { x: number; y: number; w: number; h: number };
                stem: { x: number; y: number; w: number; h: number } | null;
                w: number;
                h: number;
            }[] = [];
            for (const r of regions) {
                const clipX = Math.max(0, Math.round(r.x));
                const clipY = Math.max(0, Math.round(r.y));
                const clipW = Math.max(1, Math.round(Math.min(r.w, wc.width - clipX)));
                const clipH = Math.max(1, Math.round(Math.min(r.h, wc.height - clipY)));
                const built = buildRegionCanvas(whole, r);
                const blob = await new Promise<Blob | null>((resolve) => {
                    built.canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92);
                });
                if (blob) {
                    blobs.push(blob);
                    parts.push({
                        clip: { x: clipX, y: clipY, w: clipW, h: clipH },
                        stem: built.stem,
                        w: built.canvas.width,
                        h: built.canvas.height,
                    });
                }
            }
            if (blobs.length > 0) {
                /**
                 * 【M1】这条分支在下面统一点之前就 return 了，坐标得在这儿单独回传。
                 *
                 * ⚠️ 但**不能整页回传**：这一路每张图是"绿框裁出来的一小块"，
                 * 而 `originalImageUrl` 存的就是这一小块（见 handleCropBatch → 流水线逐张送 AI 入库），
                 * 坐标若还挂在整页上，读取端从那一小块上按整页尺寸换算，必然裁歪。
                 *
                 * 换一种存法：**每张图各存一份、坐标系跟着自己那张图走**。
                 * 没框的那张回 null（读取端走"没有净版"兜底，不是写空坐标）。
                 *
                 * ── 两种图，两套口径（2026-09-26 三修）──────────────────
                 * ① **普通裁块**（`stem === null`）：图 = 绿框那一小块，尺寸就是绿框尺寸
                 *    ⇒ 只留与它有交集的框（含橙框），base = 绿框尺寸。
                 * ② **分图产物**（`stem !== null`）：图是"题干 + 答案"重排的拼图，
                 *    红/蓝/绿的坐标全部作废；只有落在题干区内的**橙框**位置仍成立
                 *    ⇒ 由 `figuresForSplit` 统一换算（与 handleConfirm 那条路共用一份实现）。
                 */
                const payloads: (CropRegionsPayload | null)[] = parts.map((part) => {
                    const rebased = collectCropRegions(wc, {
                        offsetX: part.clip.x,
                        offsetY: part.clip.y,
                    });
                    if (!rebased) return null;

                    if (part.stem) {
                        const figs = figuresForSplit(rebased.boxes, part.stem, {
                            w: part.w,
                            h: part.h,
                        });
                        if (figs.length === 0) return null;
                        return { boxes: figs, base: { w: part.w, h: part.h, rotation: 0 } };
                    }

                    const kept = clipCropBoxes(rebased, {
                        x: 0,
                        y: 0,
                        w: part.clip.w,
                        h: part.clip.h,
                    });
                    if (kept.length === 0) return null;
                    return { boxes: kept, base: { w: part.clip.w, h: part.clip.h, rotation: 0 } };
                });
                onCropRegionsMulti?.(payloads);
                onCropBatch(blobs);
                return;
            }
            // 一块都没裁成（理论上不会）：继续往下走单张逻辑，别让这次点击白费
        }

        /**
         * 参与"这道题的图"计算的框：红（题干）+ 蓝（手写）+ 橙（题图）。
         * **只排除绿框** —— 绿框是"这道题在整页的哪一块"，是裁剪边界本身，
         * 混进 `cropToRegions` 的包围盒会把导出区撑成整幅图（那是它的本职，不是 bug）。
         *
         * ⚠️ 2026-09-26 修（线上 bug SX20260926002：橙框失效）：
         *    原实现是 `!isPartitionKind(kind)`，而 `isPartitionKind` 同时含绿+橙
         *    ⇒ 橙框被一起排除 ⇒ 两个后果：
         *      ① 导出区包围盒不含橙框，题图可能被裁到框外；
         *      ② 红蓝重叠走分图时，`onCropRegions(null)` 把橙框坐标也扔了。
         *    设计《…比对结论》§B 明写两层：作用域=绿；语义=蓝>橙>红。
         *    **橙框跟红蓝同层**，没有理由跟绿框一起被排除。
         */
        const labelBoxes = boxes.filter((b) => !isScopeKind(b.kind));
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
            onCropRegions?.(null);
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
            /**
             * 橙框（题图）要算进题干范围：分图产物是要存下来当 `originalImageUrl` 的，
             * 题图若压在红蓝包围盒之外，那块像素**不在产物里** ⇒ 之后再也裁不出题图
             * （用户看到的就是"背面那张图没有了"）。详见 buildSplitCanvas 的形参说明。
             */
            const figuresForStem = labelBoxes.filter((b) => b.kind === "figure");
            const split = buildSplitCanvas(baked, questions, answers, figuresForStem);
            const out = split.canvas;
            /**
             * 【M1 · 2026-09-26 修】这一路把红蓝框重排成了"题干涂白 + 答案 + 序号"
             * 的一列拼图，**红蓝框**的原坐标确实不再成立 —— 该丢。
             *
             * 但**橙框（题图）不在此列**：它属语义层、跟红蓝同级，
             * `buildSplitCanvas` 只重排红蓝、**根本没碰橙框**。
             * 原来的实现一刀切 `onCropRegions(null)`，把橙框坐标也扔了
             * ⇒ 读取端 `figures` 为空 ⇒ 题图裁不出来（线上 bug SX20260926002）。
             *
             * 换算交给 `figuresForSplit`（`lib/crop-regions.ts`）——
             * 与绿框路径那一处**共用同一份实现**。这条换算线上已经有两次
             * "两处各写一遍、其中一处漏了"的教训（坐标系错位、橙框连坐），
             * 所以规矩是：**换算只允许一处实现，其余地方调它**。
             */
            const canon = collectCropRegions(out);

            if (!split.stem) {
                // 其实没分成图（拿不到上下文，原样返回 baked）⇒ 存下来的就是整张 baked，
                // 坐标照原样即可，base 也正好是 baked 尺寸。
                onCropRegions?.(canon);
            } else if (canon) {
                const figures = figuresForSplit(canon.boxes, split.stem, {
                    w: canon.base.w,
                    h: canon.base.h,
                });
                // 橙框落在题干区外 ⇒ 坐标已失效，宁可这一道没有题图
                onCropRegions?.(figures.length > 0 ? { boxes: figures, base: canon.base } : null);
            } else {
                onCropRegions?.(null);
            }
            out.toBlob((blob) => {
                if (blob) onCropComplete(blob);
            }, "image/jpeg", 0.92);
            return;
        }

        // 3) 决定导出区（原逻辑）—— **必须先算出来**，因为框坐标要按它换算到"存图坐标系"
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

        /**
         * 【M1】框坐标在这里回传。位置是**故意挪到这里的**（2026-09-26 二修）。
         *
         * 为什么不能更早：导出区 `sx/sy/sw/sh` 到上面才定下来，而存进
         * `originalImageUrl` 的就是"按这个区裁出来的图"。坐标若不减去这个原点，
         * 读取端（`useFigureImages` → `toPixelRects`）就会拿整页坐标去裁一张局部图，
         * 结果是**不报错、只裁歪**。所以换算必须等导出区确定之后再算。
         *
         * 为什么不能更晚：下面要把框线 `strokeRect` 烘进 `baked`（导出副本，
         * 不影响 `wc` 与 `boxes`），再往下就只剩 `toBlob` 了。
         * 放在烘焙前，是为了让"此刻 wc 与 boxes 同系"这件事一眼可验 ——
         * 虽然烘焙落在 baked 上、动不到 boxes，但把取坐标放在任何画布操作之前，
         * 这条不变量才不依赖"baked 是副本"这种需要现场推的细节。
         *
         * 换算比 scaleX/scaleY 取 1：`toBlob` 不改尺寸（out 就是 sw×sh），
         * 真正的缩放发生在后面 `processImageFile` 压缩，而读取端是拿**实际存的图**
         * 的自然尺寸去比 base 的，两边同比例，不必在这儿预算。
         *
         * ⚠️ 【2026-09-26 四修】还必须把 **out 的实际宽高**传进去当 base。
         *    之前没传，base 就落到"整个工作画布"上了 —— 而导出区常常只是画布的一块
         *    （画了裁剪框、或按框导出）。这时 base 偏大，读取端按
         *    "存图宽 ÷ base 宽" 缩坐标，题图就裁到偏左上的一块：
         *    纸面上要么图不对、要么那块是空白 —— 用户看到的就是"题图没了"。
         */
        const regionsPayload = collectCropRegions(wc, {
            offsetX: sx,
            offsetY: sy,
            scaleX: 1,
            scaleY: 1,
            // 与下面 `out` 的取整口径保持一致，避免差一格
            outW: Math.max(1, Math.round(sw)),
            outH: Math.max(1, Math.round(sh)),
        });
        onCropRegions?.(regionsPayload);

        // 4) 非重叠：把框线烘进导出副本（原逻辑）
        //    注意这是「不烧像素」原则的**遗留**：线画在导出副本上，只为了让用户复核，
        //    框坐标另有 cropRegions 承担。真正去框靠读取端按坐标涂白（M1 第 ④ 步）。
        //
        // ⚠️ 2026-09-26：这里**只烘红蓝**，不再遍历 labelBoxes。
        //    `labelBoxes` 现在含橙框（修 SX20260926002 时改的），若照旧遍历，
        //    橙框线会被画到题面上 —— 违反「框只活在软件里，不印到纸上」。
        //    两件事必须分开办：**算坐标**时橙框算（题图要留下来）、
        //    **画线**时橙框不画（它是软件里的标记，不是试卷上的内容）。
        const drawBoxes = [...questions, ...answers];
        if (drawBoxes.length > 0) {
            // 烘焙到原图分辨率：2px 细线，不写字，避免遮挡表格/填空题
            const lw = Math.max(1.5, 2);
            for (const b of drawBoxes) {
                const color = LABEL_COLORS[b.kind];
                bctx.save();
                bctx.strokeStyle = color;
                bctx.lineWidth = lw;
                bctx.strokeRect(b.x, b.y, b.w, b.h);
                bctx.restore();
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
                                style={labelKind === "question" ? { background: LABEL_COLORS.question, borderColor: LABEL_COLORS.question, color: "#fff" } : undefined}
                            >
                                {t.common.cropper?.labelQuestion || "题干（红框）"}
                            </button>
                            <button
                                type="button"
                                className={btn(labelKind === "answer")}
                                onClick={() => setLabelKind("answer")}
                                style={labelKind === "answer" ? { background: LABEL_COLORS.answer, borderColor: LABEL_COLORS.answer, color: "#fff" } : undefined}
                            >
                                {t.common.cropper?.labelAnswer || "手写答案（蓝框）"}
                            </button>
                            {/* 【custom-v25 绿框】区🟩 = 一道题的范围（同时就是裁剪边界）。
                                确认后按"合并后的绿框"逐块裁出来分别送 AI。 */}
                            <button
                                type="button"
                                className={btn(labelKind === "region")}
                                onClick={() => setLabelKind("region")}
                                style={labelKind === "region" ? { background: LABEL_COLORS.region, borderColor: LABEL_COLORS.region, color: "#fff" } : undefined}
                                title="一个绿框 = 一道题；重叠的绿框会合并成一道。确认时会把绿框逐块裁出来分别送 AI，绿框以外不要"
                            >
                                {t.common.cropper?.labelRegion || "区🟩"}
                            </button>
                            {/* 【M1】图🟧 = 题图（不能 OCR 的图像部分，如示意图/几何图）。
                                框了它，印"净版"时这块会被涂白、再单独裁出来放在题干下方 ——
                                不框也不影响出题，只是净版里会留着一张图。 */}
                            <button
                                type="button"
                                className={btn(labelKind === "figure")}
                                onClick={() => setLabelKind("figure")}
                                style={labelKind === "figure" ? { background: LABEL_COLORS.figure, borderColor: LABEL_COLORS.figure, color: "#fff" } : undefined}
                                title="框住题目里那张图（示意图/几何图等）。印净版时这块会被涂白，再单独裁出来放到题干下方。不框也行，只是净版里会留着它"
                            >
                                {t.common.cropper?.labelFigure || "图🟧"}
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
                            /**
                             * 【custom-v36 审计重做】布局尺寸 = **显示尺寸**（自然像素 × zoom），
                             * 缩放靠"改尺寸"实现，不再用 `transform: scale()`。
                             *
                             * 这是"转一下画面碎成拼条"的正主。上一版把布局尺寸设成图片自然像素
                             * （4000×3000 CSS px），再用 scale(0.2) 缩小显示；而 Chromium 的
                             * 栅格化预算是按 **元素布局尺寸 × 设备像素比** 算的 —— 布局 4000px
                             * 宽、DPR 1.25~2 时，一次"按原生比例栅格化"就要 75~300MB，超过 tile
                             * 内存上限后它**栅格化做一半就放弃**（Chromium issue #870222 的原话），
                             * 屏幕上就是"一部分是新内容、一部分是旧内容碎片、比例还各不相同"
                             * —— 正是用户看到的样子。
                             *
                             * 改成布局尺寸 = 显示尺寸后，栅格化尺寸永远被视口封顶，与图片分辨率、
                             * 设备像素比都无关，这条故障路从结构上被堵死。画布内部分辨率不受影响
                             * （仍是自然像素，见 syncBase），只是由浏览器做一次降采样显示。
                             *
                             * 平移仍走 transform（只 translate、不改比例）：合成器挪现成图层即可，
                             * 拖动手感不变，也不会触发重新栅格化。
                             */
                            width: natSize.w ? natSize.w * zoom : undefined,
                            height: natSize.h ? natSize.h * zoom : undefined,
                            lineHeight: 0,
                            transform: `translate(${view.x}px, ${view.y}px)`,
                        }}
                    >
                        <canvas
                            ref={baseCanvasRef}
                            // CSS 盒 = 显示尺寸（撑满容器），内部像素仍是自然分辨率
                            style={{ display: "block", width: "100%", height: "100%" }}
                        />
                        <canvas
                            ref={overlayCanvasRef}
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                height: "100%",
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
                            // BRUSH_SIZES 表示"显示像素直径"，光标直接用该大小，
                            // 实际涂抹按同尺寸换算成自然坐标，保证光标与擦除范围一致。
                            // 【custom-v36 审计】容器不再被 scale 缩放，容器坐标空间就是显示像素，
                            // 所以尺寸**不再需要除以 zoom**、位置要把自然坐标乘回 zoom
                            // （cursorPos 存的是自然坐标，见 onPointerMove 的换算）。
                            const brushSizePx = BRUSH_SIZES[brushIdx];
                            return (
                                <div
                                    style={{
                                        position: "absolute",
                                        left: cursorPos.x * zoom,
                                        top: cursorPos.y * zoom,
                                        width: brushSizePx,
                                        height: brushSizePx,
                                        transform: "translate(-50%, -50%)",
                                        border: "1.5px solid #00c853",
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
