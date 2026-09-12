"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactCrop, { Crop, PixelCrop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
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

// Helper to center the crop initially
function centerAspectCrop(
    mediaWidth: number,
    mediaHeight: number,
    aspect: number,
) {
    return centerCrop(
        makeAspectCrop(
            {
                unit: '%',
                width: 90,
            },
            aspect,
            mediaWidth,
            mediaHeight,
        ),
        mediaWidth,
        mediaHeight,
    )
}

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
    const { t, language } = useLanguage();
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
    const imgRef = useRef<HTMLImageElement>(null);

    // ===== 新增状态 =====
    const [mode, setMode] = useState<Mode>("crop");
    const [eraseTool, setEraseTool] = useState<EraseTool>("brush");
    const [displaySrc, setDisplaySrc] = useState<string>(imageSrc);
    const [brushIdx, setBrushIdx] = useState(1);
    const [labelKind, setLabelKind] = useState<LabelKind>("question");
    const [boxes, setBoxes] = useState<Box[]>([]);
    const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
    const [pendingRect, setPendingRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
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
    const displayRectRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
    const imgDispRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

    // ============================================================
    //  初始化 / 重置
    // ============================================================
    useEffect(() => {
        if (!open) return;
        setMode("crop");
        setEraseTool("brush");
        setDisplaySrc(imageSrc);
        setBoxes([]);
        setSelectedBoxId(null);
        setPendingRect(null);
        setCropToRegions(false);
        setHasShapes(false);
        setReady(false);
        shapesRef.current = [];
        drawingRef.current = null;
        origCanvasRef.current = null;
        workCanvasRef.current = null;
        setCrop(undefined);
        setCompletedCrop(undefined);
    }, [open, imageSrc]);

    const ensureCanvases = useCallback((img: HTMLImageElement) => {
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        // 原图只建立一次；后续 displaySrc 变更（含擦除结果）绝不能覆盖它
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
            drawFrame(pendingRect.x, pendingRect.y, pendingRect.w, pendingRect.h, "#ffffff", true);
        }

        // 正在绘制的形状预览
        const d = drawingRef.current;
        if (d) {
            if (d.kind === "rect") {
                if (mode === "label") {
                    const color = labelKind === "question" ? QUESTION_COLOR : ANSWER_COLOR;
                    drawFrame(d.x, d.y, d.w, d.h, color, true);
                } else {
                    drawFrame(d.x, d.y, d.w, d.h, "#ffffff", true);
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
    }, [boxes, selectedBoxId, pendingRect, mode, labelKind]);

    // 切到非裁剪模式时画布刚挂载，需要同步一次
    useEffect(() => {
        if (!open || mode === "crop") return;
        if (!workCanvasRef.current) return;
        syncBase();
        redrawOverlay();
    }, [mode, open, ready, syncBase, redrawOverlay]);

    useEffect(() => {
        if (!open || mode === "crop") return;
        redrawOverlay();
    }, [boxes, selectedBoxId, pendingRect, mode, labelKind, open, redrawOverlay]);

    // ============================================================
    //  图片加载
    // ============================================================
    function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
        const img = e.currentTarget;
        const { width, height } = img;
        imgDispRef.current = { w: width, h: height };
        ensureCanvases(img);
        redrawWork();
        setReady(true);

        // 必改点4：displaySrc 变更会重新触发 onLoad，
        // 已有裁剪框时不再重置，避免用户调好的框被冲掉
        if (!crop) {
            const initialCrop = centerCrop(
                { unit: '%', width: 80, height: 50, x: 10, y: 25 },
                width,
                height
            );
            setCrop(initialCrop);
        }
    }

    // ============================================================
    //  模式切换
    // ============================================================
    /** 把当前裁剪区域提取成新图，写回 origCanvas/workCanvas，作为后续操作的基准（裁剪即提取） */
    function bakeCropIntoBase() {
        const wc = workCanvasRef.current;
        if (!wc) return;
        const r = resolveCropRect();
        // 仅在用户确实完成过拖拽裁剪（completedCrop 有值）才烘焙，避免把默认 80% 框误裁掉
        if (!completedCrop || !r || r.w < 5 || r.h < 5) return;

        const cropped = document.createElement("canvas");
        cropped.width = Math.max(1, Math.round(r.w));
        cropped.height = Math.max(1, Math.round(r.h));
        const cctx = cropped.getContext("2d");
        if (!cctx) return;
        cctx.drawImage(wc, r.x, r.y, r.w, r.h, 0, 0, cropped.width, cropped.height);

        // 重置基准：原图与工作画布都换成裁剪图，擦除记录清空（基准变了）
        origCanvasRef.current = cropped;
        const newWc = document.createElement("canvas");
        newWc.width = cropped.width;
        newWc.height = cropped.height;
        newWc.getContext("2d")?.drawImage(cropped, 0, 0);
        workCanvasRef.current = newWc;
        shapesRef.current = [];
        setHasShapes(false);
        setDisplaySrc(cropped.toDataURL("image/jpeg", 0.92));
        redrawWork();
        syncBase();
    }

    const switchMode = (m: Mode) => {
        // 从裁剪切到橡皮擦/标注：把裁剪结果"提取"为新基准，后续操作都基于它（裁剪即提取）
        if (mode === "crop" && m !== "crop") {
            bakeCropIntoBase();
        }
        // 离开橡皮擦时，把擦除结果同步进裁剪视图（仅在确有擦除时）
        else if (mode === "erase" && m !== "erase" && hasShapes && workCanvasRef.current) {
            setDisplaySrc(workCanvasRef.current.toDataURL("image/jpeg", 0.92));
        }
        // 切回裁剪：重置裁剪框（基准图可能已变），让用户重新框选
        if (m === "crop") {
            setCrop(undefined);
            setCompletedCrop(undefined);
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

    // ============================================================
    //  指针交互（橡皮擦 / 标注）
    // ============================================================
    const toNatural = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const ov = overlayCanvasRef.current;
        const wc = workCanvasRef.current;
        if (!ov || !wc) return { x: 0, y: 0 };
        const r = ov.getBoundingClientRect();
        displayRectRef.current = { w: r.width, h: r.height };
        return {
            x: (e.clientX - r.left) * (wc.width / r.width),
            y: (e.clientY - r.top) * (wc.height / r.height),
        };
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (mode === "crop" || !workCanvasRef.current) return;
        e.preventDefault();
        try { (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const p = toNatural(e);

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
        } else if (mode === "erase") {
            if (eraseTool === "brush") {
                const scale = displayRectRef.current.w
                    ? workCanvasRef.current.width / displayRectRef.current.w
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

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        // 笔刷模式：实时更新跟随光标的圆形预览圈（即使未按下）
        if (mode === "erase" && eraseTool === "brush") {
            const ov = overlayCanvasRef.current;
            const r = ov?.getBoundingClientRect();
            if (r) setCursorPos({ x: e.clientX - r.left, y: e.clientY - r.top });
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

    const onPointerEnter = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (mode === "erase" && eraseTool === "brush") {
            const ov = overlayCanvasRef.current;
            const r = ov?.getBoundingClientRect();
            if (r) setCursorPos({ x: e.clientX - r.left, y: e.clientY - r.top });
        }
    };

    const onPointerLeave = () => {
        setCursorPos(null);
    };

    const onPointerUp = () => {
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
        const wc = workCanvasRef.current;
        if (!wc) return null;
        const dispW = imgDispRef.current.w || 1;
        const dispH = imgDispRef.current.h || 1;
        const sx = wc.width / dispW;
        const sy = wc.height / dispH;

        if (completedCrop && completedCrop.width > 0 && completedCrop.height > 0) {
            return {
                x: completedCrop.x * sx,
                y: completedCrop.y * sy,
                w: completedCrop.width * sx,
                h: completedCrop.height * sy,
            };
        }
        if (crop && crop.width > 0 && crop.height > 0) {
            if (crop.unit === "%") {
                return {
                    x: (crop.x / 100) * wc.width,
                    y: (crop.y / 100) * wc.height,
                    w: (crop.width / 100) * wc.width,
                    h: (crop.height / 100) * wc.height,
                };
            }
            return { x: crop.x * sx, y: crop.y * sy, w: crop.width * sx, h: crop.height * sy };
        }
        return null;
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
            const r = resolveCropRect();
            if (r) { sx = r.x; sy = r.y; sw = r.w; sh = r.h; }
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
            <DialogContent className="max-w-3xl h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="p-4 border-b shrink-0">
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

                {/* ===== 图片区 ===== */}
                <div className="flex-1 bg-black w-full overflow-auto flex items-center justify-center p-4">
                    {mode === "crop" ? (
                        // 裁剪模式：沿用 react-image-crop
                        <ReactCrop
                            crop={crop}
                            onChange={(_, percentCrop) => setCrop(percentCrop)}
                            onComplete={(c) => setCompletedCrop(c)}
                            className="max-h-full"
                        >
                            <img
                                ref={imgRef}
                                alt="Crop me"
                                src={displaySrc}
                                onLoad={onImageLoad}
                                style={{ maxHeight: '70vh', maxWidth: '100%', objectFit: 'contain' }}
                            />
                        </ReactCrop>
                    ) : (
                        // 橡皮擦 / 标注模式：不套 ReactCrop（它会拦截指针事件）
                        <div style={{ position: "relative", display: "inline-block", lineHeight: 0, maxHeight: "70vh" }}>
                            <canvas
                                ref={baseCanvasRef}
                                style={{ display: "block", maxHeight: "70vh", maxWidth: "100%" }}
                            />
                            <canvas
                                ref={overlayCanvasRef}
                                onPointerDown={onPointerDown}
                                onPointerMove={onPointerMove}
                                onPointerEnter={onPointerEnter}
                                onPointerLeave={onPointerLeave}
                                onPointerUp={onPointerUp}
                                onPointerCancel={onPointerUp}
                                style={{
                                    position: "absolute",
                                    top: 0,
                                    left: 0,
                                    width: "100%",
                                    height: "100%",
                                    cursor: mode === "erase" && eraseTool === "brush" ? "none" : "crosshair",
                                    touchAction: "none",
                                }}
                            />
                            {/* 笔刷光标预览圈：跟随鼠标，大小随粗细变化 */}
                            {mode === "erase" && eraseTool === "brush" && cursorPos && (() => {
                                const ov = overlayCanvasRef.current;
                                const dispW = ov ? ov.getBoundingClientRect().width : 0;
                                const showScale = workCanvasRef.current && dispW
                                    ? workCanvasRef.current.width / dispW
                                    : 1;
                                const brushSizePx = BRUSH_SIZES[brushIdx] / showScale;
                                return (
                                    <div
                                        style={{
                                            position: "absolute",
                                            left: cursorPos.x,
                                            top: cursorPos.y,
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
                    )}
                </div>

                {/* ===== 底部 ===== */}
                <div className="p-4 border-t bg-background shrink-0">
                    <div className="flex justify-between items-center gap-4">
                        <p className="text-sm text-muted-foreground">
                            {mode === "crop"
                                ? (t.common.cropper?.hint || "💡 Drag to adjust crop area")
                                : mode === "erase"
                                    ? (t.common.cropper?.hintErase ||
                                        "🧽 笔刷：按住涂抹即擦掉（涂白）；矩形选区：拖框后按 Delete 或点“擦除选区”。Ctrl+Z 撤销")
                                    : (t.common.cropper?.hintLabel ||
                                        "🖍️ 先选“题干（红框）”或“手写答案（蓝框）”，再在图上拖框；点中已有框可删除。AI 会据此区分题干与手写答案")}
                        </p>
                        <div className="flex gap-2 shrink-0">
                            <Button variant="outline" onClick={onClose}>
                                {t.common.cancel || "Cancel"}
                            </Button>
                            <Button onClick={handleConfirm}>
                                {t.common.confirm || "Confirm"}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
