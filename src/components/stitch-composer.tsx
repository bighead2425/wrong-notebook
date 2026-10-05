"use client";

/**
 * 【2026-10-05】拼接窗口 —— 把**跨页的几张纸**各框一段，竖着接成一张。
 *
 * ── 他要的场景 ────────────────────────────────────────────────────────
 * 语文 / 英语阅读、材料题常常跨页：第一页几行原文、第二页还有一段、第三页才是小题。
 * 一张照片拍不下 ⇒ 拍两张（或再取一张），**各自框出有用的那段**，接成一张纸，再拿去裁题。
 *
 * ── 为什么是独立组件、而不是塞进裁剪页 ────────────────────────────────
 * `ImageCropper` 是"单图、单套画布、单套坐标"的封闭编辑器（约 10 处单例假设），
 * 且被**首页 / 录题目 / 批量上传 / 日积月累**四页共用 —— 往里塞第二张图等于把它重构一遍，
 * 会连累另外三个功能。所以拼接独立成这一层，**拼好之后把成品交回上层**
 *（回录页会把它放进「预处理」，接着照常【开始分析】或再【加工】）。
 *
 * ── 规则（他定的 + 我补的，实现都在 `lib/image-stitch.ts`，那儿有 21 条单测）────
 *   · 紫框（`#8b5cf6`，与裁剪页的红/蓝/绿/橙四色都不冲突）；可一直加图，全部画完再拼；
 *   · **同一张图内**两个紫框不许相交、也不许包含（边贴边算合格）；跨图不比较；
 *   · 顺序 = 图序 → 上边 y → 左边 x；等宽（以最宽段为基准等比缩放）；段与段首尾相接；
 *   · 框划到图外（黑背景）只取图内那段；整段在图外则丢弃。
 *
 * ⚠️ **旋转会清掉这张图上已画的框** —— 与裁剪页「🔄转」的既有行为一致
 *    （那边也是"转完未提交的框一律清空"）：图转了尺寸就换了，留着旧框只会框错地方。
 * ⚠️ 本文件**不写模块级子组件**：`L` 是主组件的闭包，模块级子组件拿不到它（踩过这个坑）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DocScanner, type DocScannerHandle } from "@/components/doc-scanner";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import {
    findBoxConflicts,
    planStitch,
    type StitchBox,
    type StitchImage,
} from "@/lib/image-stitch";
import { Camera, FolderOpen, Inbox, Loader2, Plus, RotateCcw, Trash2, Undo2, X } from "lucide-react";

/** 紫框 —— 与裁剪页四色（红 #e50000 / 蓝 #0055ff / 绿 #009a4c / 橙 #ff7a00）不冲突 */
const STITCH_COLOR = "#8b5cf6";

/** 一张待拼的图 */
interface Shot {
    id: string;
    file: File;
    url: string;
    width: number;
    height: number;
}

interface InboxListItem {
    name: string;
    imported: boolean;
    mtimeMs: number;
}

export interface StitchComposerProps {
    open: boolean;
    /** 第一张图（从「待处理」那一格带进来的） */
    seed: File | null;
    /** 已经在采集队列里的文件名 —— 收件箱挑图时给个提醒，不拦（可能就是想用同一张） */
    knownNames?: string[];
    /**
     * 【2026-10-05】"从收件箱挑一张"要读**哪个**收件箱（子目录名）。
     *
     * - 不传 ⇒ 用**默认**那个（= 录错题用的 `scan2wrong`）—— **批量上传页**走这条；
     * - 传 `"scan2recover"` ⇒ 回录分析页那条（它有自己的收件箱）。
     *
     * 两套流水线的目录是分开的，拼接窗口被两边共用，所以必须由调用方指定。
     */
    inboxSubPath?: string;
    onCancel: () => void;
    /** 拼好了：交回上层（放进「预处理」） */
    onDone: (blob: Blob) => void;
}

function loadImg(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("image load failed"));
        img.src = src;
    });
}

let seq = 0;
function uid(): string {
    seq += 1;
    return `st${Date.now().toString(36)}-${seq}`;
}

/** 把一张图逆时针转 90°（重编码成新 File）—— 旋转后的坐标全部以新图为准，省掉一套坐标映射 */
async function rotateFile(file: File): Promise<{ file: File; width: number; height: number; url: string }> {
    const url = URL.createObjectURL(file);
    const img = await loadImg(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = h;
    canvas.height = w;
    const ctx = canvas.getContext("2d")!;
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.95));
    if (!blob) throw new Error("rotate failed");
    const nextFile = new File([blob], file.name || "shot.jpg", { type: "image/jpeg" });
    return { file: nextFile, width: h, height: w, url: URL.createObjectURL(nextFile) };
}

export function StitchComposer({
    open,
    seed,
    knownNames = [],
    inboxSubPath,
    onCancel,
    onDone,
}: StitchComposerProps) {
    const { language } = useLanguage();
    const L = useCallback(
        (a: string, b: string) => (language === "zh" ? a : b),
        [language],
    );

    /** 收件箱那三处请求要带的"哪个目录"（空串 = 默认那个，批量上传页就是这条） */
    const inboxDirQ = inboxSubPath ? `dir=${encodeURIComponent(inboxSubPath)}` : "";
    /** 面板文案里显示给用户看的目录名 */
    const inboxLabel = inboxSubPath || "scan2wrong";

    const [shots, setShots] = useState<Shot[]>([]);
    const [boxes, setBoxes] = useState<StitchBox[]>([]);
    const [selected, setSelected] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    /** 收件箱挑选面板 */
    const [inboxOpen, setInboxOpen] = useState(false);
    const [inboxFiles, setInboxFiles] = useState<InboxListItem[] | null>(null);
    const [inboxLoading, setInboxLoading] = useState(false);
    /** 正在画的那个框（还没落进 boxes） */
    const drawingRef = useRef<{ imageIndex: number; x0: number; y0: number; x: number; y: number } | null>(null);

    const cameraRef = useRef<DocScannerHandle | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    /** 每张图的叠层 canvas（画紫框 + 接指针） */
    const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
    /** boxes 的可变副本 —— 指针事件里要读最新的 */
    const boxesRef = useRef<StitchBox[]>([]);
    const shotsRef = useRef<Shot[]>([]);

    useEffect(() => {
        boxesRef.current = boxes;
    }, [boxes]);
    useEffect(() => {
        shotsRef.current = shots;
    }, [shots]);

    /** 打开时把第一张图装进来；关掉时清空（objectURL 一并还回去） */
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const run = async () => {
            const list: Shot[] = [];
            if (seed) {
                try {
                    const url = URL.createObjectURL(seed);
                    const img = await loadImg(url);
                    list.push({ id: uid(), file: seed, url, width: img.naturalWidth, height: img.naturalHeight });
                } catch {
                    /* 图坏了就当没有 */
                }
            }
            if (cancelled) return;
            setShots(list);
            setBoxes([]);
            setSelected(null);
            setNotice(null);
            setInboxOpen(false);
        };
        void run();
        return () => {
            cancelled = true;
        };
    }, [open, seed]);

    /** 关掉时把临时地址还回去 */
    useEffect(() => {
        if (open) return;
        const stale = shotsRef.current;
        stale.forEach((s) => URL.revokeObjectURL(s.url));
        setShots([]);
        setBoxes([]);
        setSelected(null);
        setInboxOpen(false);
    }, [open]);

    /** 加一张图（三条通道最终都汇到这里） */
    const addShot = useCallback(async (file: File) => {
        const url = URL.createObjectURL(file);
        try {
            const img = await loadImg(url);
            const shot: Shot = {
                id: uid(),
                file,
                url,
                width: img.naturalWidth,
                height: img.naturalHeight,
            };
            setShots((prev) => [...prev, shot]);
            setNotice(null);
        } catch {
            URL.revokeObjectURL(url);
            setNotice(L("这张图读不出来，换一张试试。", "This image can't be read; try another one."));
        }
    }, [L]);

    /** 取图①：本机文件（**故意不加 capture**，与项目其它入口一致） */
    const onPickFiles = useCallback(
        (list: FileList | null) => {
            const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
            if (!files.length) return;
            // 一次只收一张：拼接是"一张一张接"的动作，多选会让人不知道接到哪了
            void addShot(files[0]);
        },
        [addShot],
    );

    /** 取图②：页内相机（走 DocScanner，不用系统摄像机） */
    const openCamera = useCallback(() => {
        setNotice(null);
        cameraRef.current?.openCamera();
    }, []);

    /** 取图③：从回录专用收件箱里挑一张 */
    const openInbox = useCallback(async () => {
        setInboxOpen(true);
        setInboxLoading(true);
        try {
            const data = await apiClient.get<{ available: boolean; files: InboxListItem[] }>(
                inboxDirQ ? `/api/scan-inbox?${inboxDirQ}` : "/api/scan-inbox",
            );
            setInboxFiles(data.available ? data.files : []);
        } catch {
            setInboxFiles([]);
        } finally {
            setInboxLoading(false);
        }
    }, [inboxDirQ]);

    const pickFromInbox = useCallback(
        async (name: string) => {
            setInboxLoading(true);
            try {
                const res = await fetch(
                    `/api/scan-inbox/file?name=${encodeURIComponent(name)}${inboxDirQ ? `&${inboxDirQ}` : ""}`,
                );
                if (!res.ok) throw new Error("fetch failed");
                const blob = await res.blob();
                await addShot(new File([blob], name, { type: blob.type || "image/jpeg" }));
                setInboxOpen(false);
            } catch {
                setNotice(L("这张没取下来，稍后再试。", "Couldn't fetch that one; try again later."));
            } finally {
                setInboxLoading(false);
            }
        },
                [addShot, L, inboxDirQ],
            );

    /** 相机/本地图过来之后，都要先过一遍"确认扫描效果"（可拉正四角、切漂白/黑白）—— 他说了要进拉伸页 */
    const handleScanned = useCallback(
        (blob: Blob) => {
            void addShot(new File([blob], `stitch-${Date.now()}.jpg`, { type: "image/jpeg" }));
        },
        [addShot],
    );

    /** 把某张图再送进"确认扫描效果"过一遍（拉伸/拉正） */
    const stretchShot = useCallback((index: number) => {
        const shot = shotsRef.current[index];
        if (shot) cameraRef.current?.openWithFile(shot.file);
    }, []);

    /** 旋转某一张（顺带清掉这张图上的框 —— 图转了尺寸就换了，旧框会框错地方） */
    const rotateShot = useCallback(async (index: number) => {
        const shot = shotsRef.current[index];
        if (!shot) return;
        setBusy(true);
        try {
            const next = await rotateFile(shot.file);
            URL.revokeObjectURL(shot.url);
            setShots((prev) =>
                prev.map((s, i) => (i === index ? { ...s, file: next.file, url: next.url, width: next.width, height: next.height } : s)),
            );
            setBoxes((prev) => prev.filter((b) => b.imageIndex !== index));
            setSelected(null);
            setNotice(L("这张已旋转；它原来的框已清掉，请重新框。", "Rotated; its boxes were cleared — please re-draw."));
        } catch {
            setNotice(L("旋转失败，换一张试试。", "Rotate failed."));
        } finally {
            setBusy(false);
        }
    }, [L]);

    const removeShot = useCallback((index: number) => {
        setShots((prev) => {
            if (prev.length <= 1) {
                setNotice(L("至少要留一张。", "Keep at least one."));
                return prev;
            }
            URL.revokeObjectURL(prev[index].url);
            return prev.filter((_, i) => i !== index);
        });
        // 后面的图整体前移一格 ⇒ 框的归属也要跟着挪
        setBoxes((prev) =>
            prev
                .filter((b) => b.imageIndex !== index)
                .map((b) => (b.imageIndex > index ? { ...b, imageIndex: b.imageIndex - 1 } : b)),
        );
        setSelected(null);
    }, [L]);

    const removeSelectedBox = useCallback(() => {
        if (selected === null) return;
        setBoxes((prev) => prev.filter((_, i) => i !== selected));
        setSelected(null);
    }, [selected]);

    const undoBox = useCallback(() => {
        setBoxes((prev) => prev.slice(0, -1));
        setSelected(null);
    }, []);

    /** 重画所有叠层 canvas */
    const redraw = useCallback(() => {
        shots.forEach((shot, i) => {
            const canvas = canvasRefs.current[i];
            if (!canvas) return;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const sx = canvas.width / shot.width;
            const sy = canvas.height / shot.height;
            boxes.forEach((b, bi) => {
                if (b.imageIndex !== i) return;
                const isSel = bi === selected;
                ctx.lineWidth = isSel ? 3 : 2;
                ctx.strokeStyle = STITCH_COLOR;
                ctx.setLineDash(isSel ? [] : [6, 4]);
                ctx.strokeRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
                ctx.setLineDash([]);
                if (isSel) {
                    ctx.fillStyle = "rgba(139,92,246,0.12)";
                    ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
                }
            });
            const d = drawingRef.current;
            if (d && d.imageIndex === i) {
                ctx.lineWidth = 2;
                ctx.strokeStyle = STITCH_COLOR;
                ctx.setLineDash([4, 3]);
                ctx.strokeRect(
                    Math.min(d.x0, d.x) * sx,
                    Math.min(d.y0, d.y) * sy,
                    Math.abs(d.x - d.x0) * sx,
                    Math.abs(d.y - d.y0) * sy,
                );
                ctx.setLineDash([]);
            }
        });
    }, [shots, boxes, selected]);

    useEffect(() => {
        redraw();
    }, [redraw]);

    /* ===== 指针：在图上画紫框 ===== */
    const onPointerDown = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>, index: number) => {
            const canvas = canvasRefs.current[index];
            const shot = shotsRef.current[index];
            if (!canvas || !shot || busy) return;
            const r = canvas.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * shot.width;
            const y = ((e.clientY - r.top) / r.height) * shot.height;
            drawingRef.current = { imageIndex: index, x0: x, y0: y, x, y };
            setSelected(null);
            canvas.setPointerCapture?.(e.pointerId);
        },
        [busy],
    );

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>, index: number) => {
        const d = drawingRef.current;
        const canvas = canvasRefs.current[index];
        const shot = shotsRef.current[index];
        if (!d || d.imageIndex !== index || !canvas || !shot) return;
        const r = canvas.getBoundingClientRect();
        d.x = ((e.clientX - r.left) / r.width) * shot.width;
        d.y = ((e.clientY - r.top) / r.height) * shot.height;
        redraw();
    }, [redraw]);

    const onPointerUp = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>, index: number) => {
            const d = drawingRef.current;
            drawingRef.current = null;
            const canvas = canvasRefs.current[index];
            const shot = shotsRef.current[index];
            if (!d || d.imageIndex !== index || !canvas || !shot) return;
            // 不用再量 rect：起点/终点在 pointerdown / pointermove 时就已经换算成**自然坐标**了
            // （画框期间视口不会动），这里直接用 d.x0 / d.x。
            const x1 = Math.min(d.x0, d.x);
            const y1 = Math.min(d.y0, d.y);
            const w = Math.abs(d.x - d.x0);
            const h = Math.abs(d.y - d.y0);
            // 太小当误触
            if (w < Math.max(4, shot.width * 0.01) || h < Math.max(4, shot.height * 0.01)) {
                redraw();
                return;
            }
            const next = [...boxesRef.current, { imageIndex: index, x: x1, y: y1, w, h }];
            // 他定的规则：同一张图内不许相交、也不许包含
            const conflicts = findBoxConflicts(next);
            const me = next.length - 1;
            if (conflicts.some((c) => c.a === me || c.b === me)) {
                setNotice(
                    L(
                        "这个框和已有的框叠在一起了（不许交叉）—— 换一处再画。",
                        "This box overlaps another one (crossing not allowed) — try elsewhere.",
                    ),
                );
                redraw();
                return;
            }
            canvas.setPointerCapture?.(e.pointerId);
            setNotice(null);
            setBoxes(next);
            setSelected(me);
        },
        [L, redraw],
    );

    /** 【拼接】—— 用纯逻辑算出方案，再照着一块块画上去 */
    const doStitch = useCallback(async () => {
        const list = shotsRef.current;
        const list_boxes = boxesRef.current;
        if (list.length === 0 || list_boxes.length < 2) {
            setNotice(L("至少框两段才需要拼接。", "Box at least two segments to stitch."));
            return;
        }
        setBusy(true);
        setNotice(null);
        try {
            const els = await Promise.all(list.map((s) => loadImg(s.url)));
            const images: StitchImage[] = els.map((el) => ({
                width: el.naturalWidth,
                height: el.naturalHeight,
            }));
            const plan = planStitch(list_boxes, images);
            if (plan.segments.length === 0) {
                setNotice(L("框都落在图片外面了，重新框一下。", "All boxes fell outside the images."));
                return;
            }
            const canvas = document.createElement("canvas");
            canvas.width = plan.width;
            canvas.height = plan.height;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, plan.width, plan.height);
            for (const seg of plan.segments) {
                ctx.drawImage(
                    els[seg.imageIndex],
                    seg.sx,
                    seg.sy,
                    seg.sw,
                    seg.sh,
                    0,
                    seg.dy,
                    plan.width,
                    seg.dh,
                );
            }
            const blob: Blob | null = await new Promise((res) =>
                canvas.toBlob((b) => res(b), "image/jpeg", 0.92),
            );
            if (!blob) {
                setNotice(L("拼接出图失败，再试一次。", "Stitch failed; try again."));
                return;
            }
            onDone(blob);
        } catch {
            setNotice(L("拼接出错了，再试一次。", "Stitch error; try again."));
        } finally {
            setBusy(false);
        }
    }, [L, onDone]);

    if (!open) return null;

    const boxCount = boxes.length;

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
            {/* ===== 顶栏 ===== */}
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                <span className="text-sm font-semibold">
                    {L("拼接（把跨页的几段接成一张）", "Stitch pages into one")}
                </span>
                <span className="text-xs text-muted-foreground">
                    {L(`共 ${shots.length} 张图 · 已框 ${boxCount} 段`, `${shots.length} image(s) · ${boxCount} segment(s)`)}
                </span>
                <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
                        <X className="mr-1 h-4 w-4" />
                        {L("取消", "Cancel")}
                    </Button>
                    <Button size="sm" onClick={() => void doStitch()} disabled={busy || boxCount < 2}>
                        {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                        {L(`拼接这 ${boxCount} 段`, `Stitch ${boxCount} segment(s)`)}
                    </Button>
                </div>
            </div>

            {/* ===== 工具条：加图 + 画框操作 ===== */}
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
                <span className="text-xs font-medium text-muted-foreground">{L("再加一张：", "Add:")}</span>
                <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                    <FolderOpen className="mr-1 h-4 w-4" />
                    {L("本机文件", "This device")}
                </Button>
                <Button size="sm" variant="outline" onClick={openCamera} disabled={busy}>
                    <Camera className="mr-1 h-4 w-4" />
                    {L("页内相机", "Camera")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void openInbox()} disabled={busy}>
                    <Inbox className="mr-1 h-4 w-4" />
                    {L("从收件箱挑", "From inbox")}
                </Button>

                <span className="mx-1 h-5 w-px bg-border" />

                <Button size="sm" variant="outline" onClick={undoBox} disabled={busy || boxCount === 0}>
                    <Undo2 className="mr-1 h-4 w-4" />
                    {L("撤销一个框", "Undo box")}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={removeSelectedBox}
                    disabled={busy || selected === null}
                >
                    <Trash2 className="mr-1 h-4 w-4" />
                    {L("删掉选中的框", "Delete box")}
                </Button>
                <span className="text-xs text-muted-foreground">
                    {L("在图上按住拖，画紫色框；框之间不许交叉", "Drag on an image to draw a purple box; boxes must not cross")}
                </span>
            </div>

            {notice && (
                <p className="border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    {notice}
                </p>
            )}

            {/* ===== 图列表：上下排列，每张各自可旋转 / 再过一遍扫描效果 / 移除 ===== */}
            <div className="flex-1 overflow-auto p-3">
                <div className="mx-auto flex max-w-3xl flex-col gap-3">
                    {shots.map((shot, i) => (
                        <div key={shot.id} className="rounded-lg border">
                            <div className="flex items-center gap-2 border-b bg-muted/30 px-2 py-1">
                                <span className="text-xs font-medium">
                                    {L(`第 ${i + 1} 张`, `Image ${i + 1}`)}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                    {shot.width}×{shot.height}
                                </span>
                                <div className="ml-auto flex items-center gap-1">
                                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void rotateShot(i)} disabled={busy}>
                                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                                        {L("旋转", "Rotate")}
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => stretchShot(i)} disabled={busy}>
                                        {L("拉正 / 漂白", "Straighten")}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-xs text-muted-foreground"
                                        onClick={() => removeShot(i)}
                                        disabled={busy}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                            </div>
                            <div className="relative">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={shot.url} alt={`shot-${i + 1}`} className="block w-full" />
                                <canvas
                                    ref={(el) => {
                                        canvasRefs.current[i] = el;
                                    }}
                                    width={shot.width}
                                    height={shot.height}
                                    className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                                    onPointerDown={(e) => onPointerDown(e, i)}
                                    onPointerMove={(e) => onPointerMove(e, i)}
                                    onPointerUp={(e) => onPointerUp(e, i)}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                    onPickFiles(e.target.files);
                    e.target.value = "";
                }}
            />

            {/* ===== 收件箱挑选面板（回录专用目录） ===== */}
            {inboxOpen && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-4">
                    <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg border bg-background p-3">
                        <div className="mb-2 flex items-center gap-2">
                            <span className="text-sm font-medium">
                                {L(`从收件箱（${inboxLabel}）挑一张`, `Pick one from the inbox (${inboxLabel})`)}
                            </span>
                            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setInboxOpen(false)}>
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                        {inboxLoading && (
                            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                {L("读取中…", "Loading…")}
                            </p>
                        )}
                        {!inboxLoading && inboxFiles && inboxFiles.length === 0 && (
                            <p className="py-6 text-sm text-muted-foreground">
                                {L(
                                    `这个收件箱里还没有照片（NAS 上的 ${inboxLabel} 文件夹）。`,
                                    "The inbox folder is empty.",
                                )}
                            </p>
                        )}
                        {!inboxLoading && inboxFiles && inboxFiles.length > 0 && (
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {inboxFiles.map((f) => (
                                    <button
                                        key={f.name}
                                        type="button"
                                        onClick={() => void pickFromInbox(f.name)}
                                        className="overflow-hidden rounded border text-left hover:border-primary"
                                    >
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                            src={`/api/scan-inbox/file?name=${encodeURIComponent(f.name)}${inboxDirQ ? `&${inboxDirQ}` : ""}`}
                                            alt={f.name}
                                            className="h-24 w-full bg-muted object-cover"
                                        />
                                        <span className="block truncate px-1 py-0.5 text-[11px] text-muted-foreground">
                                            {knownNames.includes(f.name) ? L("（已用过）", "(used)") + " " : ""}
                                            {f.name}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* 单张模式的扫描器：拍一张 与 "把某张再拉正/漂白" 都走它 */}
            <DocScanner ref={cameraRef} onScanComplete={handleScanned} onClose={() => undefined} />

            {/* 空白处的提示：还没有图时 */}
            {shots.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <p className="flex items-center gap-2 rounded border bg-background/90 px-3 py-2 text-sm text-muted-foreground">
                        <Plus className="h-4 w-4" />
                        {L("先用上面的按钮加一张图。", "Add an image with the buttons above.")}
                    </p>
                </div>
            )}
        </div>
    );
}
