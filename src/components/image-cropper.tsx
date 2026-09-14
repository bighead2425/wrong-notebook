"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";

interface ImageCropperProps {
    imageSrc: string;
    open: boolean;
    onClose: () => void;
    onCropComplete: (croppedImageBlob: Blob) => void;
}

// ============================================================
//  图片编辑模式：裁剪(原有) / 橡皮擦(涂白) / 区域标注(题干·手写答案)
// ============================================================
type Mode = "crop" | "erase" | "label";
type LabelKind = "question" | "answer";
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
const BRUSH_SIZES = [10, 20, 40, 80];
const BRUSH_LABELS = ["小", "中", "大", "特大"];

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

export function ImageCropper({ imageSrc, open, onClose, onCropComplete }: ImageCropperProps) {
    const { t } = useLanguage();

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

    // ===== 平移开关 + 右键拖拽平移 =====
    const [panMode, setPanMode] = useState(false);
    // 首次加载的「最原始整图」副本，供「原图」键一键恢复
    // （裁剪即提取会直接覆盖 origCanvas，所以必须另存一份干净的原始图）
    const firstImageRef = useRef<HTMLCanvasElement | null>(null);
    // 说明弹窗显隐
    const [showHelp, setShowHelp] = useState(false);

    // ===== 对话框拖拽位移（按住标题栏拖动） =====
    const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);

    /**
     * 按住标题栏拖动对话框。
     * 监听挂在 window 上（而不是标题栏自身），这样指针移出标题栏也能继续拖，不会「拖到一半卡住」。
     * 同时做边界保护：至少保留 80px 在视口内，避免把对话框拖丢找不回来。
     */
    const startDialogDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return; // 仅左键
        const dlg = e.currentTarget.closest('[role="dialog"]') as HTMLElement | null;
        const rect = dlg?.getBoundingClientRect();
        const start = dragOffset ?? { x: 0, y: 0 };
        const fromX = e.clientX;
        const fromY = e.clientY;
        const MARGIN = 80;
        const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

        const onMove = (ev: PointerEvent) => {
            let dx = start.x + (ev.clientX - fromX);
            let dy = start.y + (ev.clientY - fromY);
            if (rect) {
                // rect 是「已含当前偏移」的视觉位置，减去偏移得到未变换的基准位置
                const baseLeft = rect.left - start.x;
                const baseTop = rect.top - start.y;
                dx = clamp(dx, -(baseLeft + rect.width - MARGIN), window.innerWidth - MARGIN - baseLeft);
                dy = clamp(dy, -(baseTop + rect.height - MARGIN), window.innerHeight - MARGIN - baseTop);
            }
            setDragOffset({ x: dx, y: dy });
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    }, [dragOffset]);

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
        // 每次打开都复位拖拽位置，避免沿用上一次的偏移
        setDragOffset(null);
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

        // 已确认的标注框
        for (const b of boxes) {
            const color = b.kind === "question" ? QUESTION_COLOR : ANSWER_COLOR;
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
                    const color = labelKind === "question" ? QUESTION_COLOR : ANSWER_COLOR;
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
    }, [boxes, selectedBoxId, pendingRect, mode, labelKind, cropRect]);

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
        syncBase();
        redrawOverlay();
        fitView();
    }, [fitView, syncBase, redrawOverlay]);

    // 打开/换图/切模式时让画面适应窗口（裁剪烘焙后图像尺寸会变，必须重算）
    useEffect(() => {
        if (open) fitView();
    }, [open, imageSrc, mode, fitView]);

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
    useEffect(() => {
        if (!open) return;
        const down = (e: KeyboardEvent) => { if (e.code === "Space") spaceRef.current = true; };
        const up = (e: KeyboardEvent) => { if (e.code === "Space") spaceRef.current = false; };
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
            spaceRef.current = false;
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

        // 单指落在图片范围外（黑底）时不绘制，避免画出半截框；
        // 两指手势已在前面处理，这里只约束单指画图区域
        const wcInside = workCanvasRef.current;
        if (wcInside && (p.x < 0 || p.x > wcInside.width || p.y < 0 || p.y > wcInside.height)) return;

        if (mode === "label") {
            const hit = [...boxes].reverse().find(
                (b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
            );
            if (hit) {
                setSelectedBoxId(hit.id);
                return;
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
    };

    const onPointerLeave = () => {
        setCursorPos(null);
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

    const handleConfirm = async () => {
        const wc = workCanvasRef.current;

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

        const questions = boxes.filter((b) => b.kind === "question");
        const answers = boxes.filter((b) => b.kind === "answer");
        const overlaps =
            questions.length > 0 &&
            answers.length > 0 &&
            answers.some((a) => questions.some((q) => rectsIntersect(a, q)));

        // 2) 红框与蓝框重叠/包含 → 分图（题干涂白 + 答案 + 序号），根治"答案混进题干"
        if (cropToRegions && boxes.length > 0 && overlaps) {
            const out = buildSplitCanvas(baked, questions, answers);
            out.toBlob((blob) => {
                if (blob) onCropComplete(blob);
            }, "image/jpeg", 0.92);
            return;
        }

        // 3) 非重叠：烘焙框线 + 决定导出区（原逻辑）
        if (boxes.length > 0) {
            // 烘焙到原图分辨率：2px 细线，不写字，避免遮挡表格/填空题
            const lw = Math.max(1.5, 2);
            for (const b of boxes) {
                const color = b.kind === "question" ? QUESTION_COLOR : ANSWER_COLOR;
                bctx.save();
                bctx.strokeStyle = color;
                bctx.lineWidth = lw;
                bctx.strokeRect(b.x, b.y, b.w, b.h);
                bctx.restore();
            }
        }

        let sx = 0, sy = 0, sw = baked.width, sh = baked.height;
        if (cropToRegions && boxes.length > 0) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const b of boxes) {
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

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <DialogContent
                className={cn(
                    // ⚠️ 千万不要在这里加 relative：cn() 基于 tailwind-merge，
                    // relative 与基类的 fixed 同组冲突，会把 fixed 挤掉，
                    // 导致对话框掉进文档流被排到页面下方（「偏下且拖不上来」的根因）。
                    // 需要绝对定位基准时，基类的 fixed 本身就已提供。
                    // 固定窗口：高度恒为 90dvh、宽度上限 1024px（max-w-5xl）。
                    // 基类自带 w-full，所以手机上宽度仍是全屏，只有桌面才被 1024px 封顶。
                    // 图片区是 flex-1，窗口不会随图片大小（尤其裁剪后的窄条）变化。
                    "max-w-5xl h-[90dvh] flex flex-col p-0 gap-0 overflow-hidden",
                    dragOffset && "translate-x-0 translate-y-0",
                )}
                style={
                    dragOffset
                        ? {
                              left: `calc(50% + ${dragOffset.x}px)`,
                              top: `calc(50% + ${dragOffset.y}px)`,
                              transform: "translate(-50%, -50%)",
                          }
                        : undefined
                }
            >
                <DialogHeader
                    className="p-4 border-b shrink-0 cursor-move select-none"
                    onPointerDown={startDialogDrag}
                >
                    <DialogTitle>{t.common.cropper?.title || "Crop Image"}</DialogTitle>
                </DialogHeader>

                {/* ===== 工具栏 ===== */}
                <div className="px-4 py-2 border-b shrink-0 flex flex-wrap items-center gap-2 bg-muted/30">
                    <span className="text-xs text-muted-foreground mr-1">
                        {t.common.cropper?.mode || "模式"}
                    </span>
                    <button type="button" className={btn(mode === "crop")} onClick={() => switchMode("crop")}>
                        {t.common.cropper?.modeCrop || "裁剪"}
                    </button>
                    <button type="button" className={btn(mode === "erase")} onClick={() => switchMode("erase")}>
                        {t.common.cropper?.modeErase || "橡皮擦"}
                    </button>
                    <button type="button" className={btn(mode === "label")} onClick={() => switchMode("label")}>
                        {t.common.cropper?.modeLabel || "区域标注"}
                    </button>

                    <button
                        type="button"
                        className={btn(panMode)}
                        onClick={() => setPanMode((v) => !v)}
                        title="开启后鼠标左键仅用于平移图片（也可随时按住右键拖拽平移）"
                    >
                        {t.common.cropper?.pan || "平移"}
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
                                            key={label}
                                            type="button"
                                            className={btn(brushIdx === i)}
                                            onClick={() => setBrushIdx(i)}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </span>
                            )}
                            <button type="button" className={btn(false)} onClick={undo} disabled={!hasShapes}>
                                {t.common.cropper?.undo || "撤销 (Ctrl+Z)"}
                            </button>
                            <button
                                type="button"
                                className={btn(false)}
                                onClick={erasePendingRect}
                                disabled={!pendingRect}
                            >
                                {t.common.cropper?.eraseSelection || "擦除选区 (Delete)"}
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
                            <button type="button" className={btn(false)} onClick={removeSelectedBox} disabled={!selectedBoxId}>
                                {t.common.cropper?.deleteBox || "删除选中框"}
                            </button>
                            <button
                                type="button"
                                className={btn(cropToRegions)}
                                onClick={() => setCropToRegions((v) => !v)}
                                disabled={boxes.length === 0}
                            >
                                {t.common.cropper?.cropToRegions || "仅发送标注区域（省 token）"}
                            </button>
                        </>
                    )}

                    {mode === "crop" && boxes.length > 0 && (
                        <button
                            type="button"
                            className={btn(cropToRegions)}
                            onClick={() => setCropToRegions((v) => !v)}
                        >
                            {t.common.cropper?.cropToRegions || "仅发送标注区域（省 token）"}
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
                </div>

                {/* ===== 底部 ===== */}
                <div className="p-4 border-t bg-background shrink-0">
                    <div className="flex justify-between items-center gap-4">
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setShowHelp(true); }}
                            className="text-sm text-primary underline underline-offset-2 hover:opacity-80 shrink-0"
                        >
                            {t.common.cropper?.help || "说明 ⓘ"}
                        </button>
                        <div className="flex gap-2 shrink-0">
                            <Button variant="outline" onClick={resetToOriginal}>
                                {t.common.cropper?.original || "原图"}
                            </Button>
                            <Button variant="outline" onClick={onClose}>
                                {t.common.cancel || "Cancel"}
                            </Button>
                            <Button onClick={handleConfirm}>
                                {t.common.confirm || "Confirm"}
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
                                <li>{t.common.cropper?.hint || "裁剪：在图片上拖拽框选要保留的区域，再切橡皮擦/标注；不框则保留整图"}</li>
                                <li>{t.common.cropper?.hintErase || "橡皮擦：笔刷按住涂抹即擦掉（涂白）；矩形选区拖框后按 Delete 或点“擦除选区”。Ctrl+Z 撤销"}</li>
                                <li>{t.common.cropper?.hintLabel || "区域标注：先选“题干（红框）”或“手写答案（蓝框）”，再在图上拖框；点中已有框可删除"}</li>
                                <li>🔍 手机：双指捏合缩放、双指拖动平移（图片或黑底上均可）｜ 电脑：滚轮以鼠标为中心缩放、按住右键拖拽平移、也可开「平移」开关用左键平移、双击放大/复位</li>
                            </ul>
                            <div className="mt-2 text-xs text-muted-foreground">（点击任意位置关闭）</div>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
