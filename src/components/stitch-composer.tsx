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
 *（待处理页会把它当一张新的待处理图收下，收件箱面板会把它写回收件箱）。
 *
 * ── 两种拼法（【2026-10-09 第 6 条】加的是第二种）─────────────────────
 *   ① **按框拼**：在每张图上各框一段（紫框），只把框里的内容接起来（跨页材料题）；
 *   ② **整页拼**：不画框，把每张**整张**接起来 —— 「页横拼」左右并排（等高）、
 *      「页竖拼」上下摞起（等宽）。两者的算方案都在 `lib/image-stitch.ts`（有单测）。
 *
 * ── 规则（他定的 + 我补的，实现都在 `lib/image-stitch.ts`）─────────────
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
    planConcat,
    planStitch,
    type StitchBox,
    type StitchImage,
} from "@/lib/image-stitch";
import { ArrowDown, ArrowUp, Camera, Columns2, FolderOpen, Inbox, Loader2, MoveVertical, Pencil, Plus, RotateCcw, Rows2, Trash2, Undo2, X } from "lucide-react";

/** 紫框 —— 与裁剪页四色（红 #e50000 / 蓝 #0055ff / 绿 #009a4c / 橙 #ff7a00）不冲突 */
const STITCH_COLOR = "#8b5cf6";

/**
 * 紫框的**填充色**（浅紫半透明）。
 * 【2026-10-09 第 5 条】所有已画的框都用它 —— 让"框在哪"一眼看得见，
 * 又不至于把底下的题目文字糊住（他要的是"更醒目"，不是"盖住"）。
 */
const STITCH_FILL = "rgba(139,92,246,0.18)";

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
    /**
     * 进窗口时就摆好的图。
     *
     * 【2026-10-09 第 4 条】从 `File | null` 改成数组 —— 现在有**两个入口**：
     *   · 单张（批量上传页 / 回录页 的「待处理」缩略图左下角那个拼接按钮）；
     *   · **多张**（收件箱面板里勾选 ≥2 张后点「拼接」）。
     * 两条路都只是"先把这几张摆进来"，后面的操作完全一样，所以合并成一个数组入口。
     */
    seeds: File[];
    /** 已经在采集队列里的文件名 —— 收件箱挑图时给个提醒，不拦（可能就是想用同一张） */
    knownNames?: string[];
    /**
     * 【2026-10-05】"自收件箱挑一张"要读**哪个**收件箱（子目录名）。
     *
     * - 不传 ⇒ 用**默认**那个（= 录错题用的 `scan2wrong`）—— **批量上传页**走这条；
     * - 传 `"scan2recover"` ⇒ 回录分析页那条（它有自己的收件箱）。
     *
     * 两套流水线的目录是分开的，拼接窗口被两边共用，所以必须由调用方指定。
     */
    inboxSubPath?: string;
    onCancel: () => void;
    /**
     * 拼好了：交回上层。
     *
     * 【2026-10-09 第 3 / 6 条】**去向由调用方决定**，本组件不管：
     *   · 从「待处理」进来（批量上传页 / 回录页）⇒ 上层把它当**一张待处理图**收下；
     *   · 从「收件箱」进来（收件箱面板）⇒ 上层把它**写回那个收件箱**，
     *     文件名 `拼接_yyyymmdd_hhmmss.jpg`。
     * 组件只负责"拼出来一张图"，不去猜它该去哪 —— 猜错了就是"拼完的图不见了"。
     */
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
    seeds,
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

    /**
     * 【2026-10-05 修】他报的问题：**手机端**加进来的第二张图"滚不上来"。
     *
     * 根因：叠在图上的那块 canvas 写了 `touch-none`（`touch-action: none`）——
     * 手指按在图上时，浏览器**连滚动都不允许**（因为要在图上画框，不能让页面跟着动）。
     * 电脑端靠滚轮滚动，不受 `touch-action` 管 ⇒ 所以他只在手机上撞到，症状完全吻合。
     *
     * 矛盾一句话说清：**手机上一根手指只能干一件事** ——
     * 要么画框（那页面就不能滚），要么滚动（那就画不了框）。
     * 所以手机端给一个开关：
     *   · 默认 **画框**（跟原来一模一样，不改变他熟悉的用法）；
     *   · 想看下面那张图就切到 **滚动**（此时 canvas 用 `touch-pan-y`，手指正常滚页面）。
     * 鼠标 / 触控笔**不受影响**，任何模式下都能画 —— 他在电脑上完全感觉不到这个开关。
     */
    const [touchOnly, setTouchOnly] = useState(false);
    const [touchMode, setTouchMode] = useState<"draw" | "scroll">("draw");
    useEffect(() => {
        if (typeof window === "undefined" || !window.matchMedia) return;
        setTouchOnly(window.matchMedia("(hover: none)").matches);
    }, []);
    /** 手机端且切到了"滚动" ⇒ 手指只滚页面，不画框 */
    const touchScrollMode = touchOnly && touchMode === "scroll";

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

    /**
     * 【2026-10-09】`seeds` 是数组 ⇒ **不能直接进依赖数组**。
     *
     * 调用方写的是 `seeds={stitchSeed ? [stitchSeed] : []}`：每次渲染都是一个新数组，
     * 拿它当依赖 ⇒ 每次渲染都重跑"装载"那个 effect，而 effect 里又 setShots
     * ⇒ 渲染 → effect → setState → 渲染……**死循环**。
     * 所以：数组放 ref（每次渲染更新一次），依赖只用一个由内容拼出来的字符串
     *（同样几张图 ⇒ 字符串一样 ⇒ effect 不会重跑）。
     */
    const seedsRef = useRef(seeds);
    seedsRef.current = seeds;
    const seedKey = seeds.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join("|");

    /** 打开时把带进来的图逐张装好；关掉时清空（objectURL 一并还回去） */
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const run = async () => {
            const list: Shot[] = [];
            for (const file of seedsRef.current) {
                try {
                    const url = URL.createObjectURL(file);
                    const img = await loadImg(url);
                    list.push({
                        id: uid(),
                        file,
                        url,
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                    });
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
    }, [open, seedKey]);

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

    /**
     * 【2026-10-09 第 5 条】把某张图与**上一张 / 下一张**对调位置。
     *
     * 他要的是"页序我说了算"：拍反了、或者从收件箱挑的顺序不对，
     * 不用退出去重来，点一下箭头就换过来。
     *
     * ⚠️ **框要跟着图走**：框的 `imageIndex` 指的是"第几张图"，
     *    两张图一换，挂在它们身上的框必须一起换，否则框会跑到另一张图上。
     */
    const moveShot = useCallback((index: number, dir: -1 | 1) => {
        const target = index + dir;
        setShots((prev) => {
            if (target < 0 || target >= prev.length) return prev;
            const next = [...prev];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
        setBoxes((prev) =>
            prev.map((b) => {
                if (b.imageIndex === index) return { ...b, imageIndex: target };
                if (b.imageIndex === target) return { ...b, imageIndex: index };
                return b;
            }),
        );
        setSelected(null);
    }, []);

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
                /**
                 * 【2026-10-09 第 5 条】**所有**已画的框都保持"紫边 + 浅紫半透明填充"。
                 *
                 * 原先的写法是"只有刚画的那个填色 + 实线，之前的框变虚线**且不填充**"——
                 * 他的反馈：这样上一个框反而看不清了（虚线细、又没底色，压在题目文字上近乎看不见）。
                 * 现在统一填充，刚画的那个只是**线更粗一点**，用来提示"这是你最后画的"。
                 */
                ctx.lineWidth = isSel ? 3 : 2;
                ctx.strokeStyle = STITCH_COLOR;
                ctx.setLineDash([]);
                ctx.fillStyle = STITCH_FILL;
                ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
                ctx.strokeRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
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
            // 手机端切到「滚动」时，手指只用来滚页面 —— 别在这里拦下来画框（见 touchMode 的说明）
            if (touchScrollMode && e.pointerType === "touch") return;
            const r = canvas.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * shot.width;
            const y = ((e.clientY - r.top) / r.height) * shot.height;
            drawingRef.current = { imageIndex: index, x0: x, y0: y, x, y };
            setSelected(null);
            canvas.setPointerCapture?.(e.pointerId);
        },
        [busy, touchScrollMode],
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

    /**
     * 【2026-10-05 顺手补一个真 bug】浏览器决定"这一指用来滚动页面"时会发 `pointercancel`，
     * 原来没接这个事件 ⇒ 画到一半的 `drawingRef` 一直挂着，
     * 下一次在任何地方抬手都会被当成"落框"（落出一个巨框）。
     * 现在收到 cancel 就把它丢掉，并重画一遍（把半截框擦掉）。
     */
    const onPointerCancel = useCallback(() => {
        if (!drawingRef.current) return;
        drawingRef.current = null;
        redraw();
    }, [redraw]);

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

    /**
     * 【2026-10-09 第 6 条】页横拼 / 页竖拼 —— **不画框**，把每一张整页接成一张。
     *
     * 与上面 `doStitch`（按紫框挑段）是两条路，共用同一套"算方案 → 建画布 → 交回上层"：
     *   · `"horizontal"` 横向并排（**等高**，其余按比例缩）；
     *   · `"vertical"`   纵向摞起（**等宽**）。
     * 他自己说明了这么做的用途：整页拼不需要挑内容（比如两页原样并成一张对照）。
     *
     * ⚠️ 已有的紫框**一律忽略**，但**不清掉** —— 他可能拼完整页、又想按框拼一次，
     *    把他的框抹了就得重画。
     */
    const doConcat = useCallback(
        async (axis: "horizontal" | "vertical") => {
            const list = shotsRef.current;
            if (list.length < 2) {
                setNotice(L("至少两张图才需要整页拼。", "Whole-page stitching needs at least two images."));
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
                const plan = planConcat(images, axis);
                if (plan.segments.length === 0) {
                    setNotice(L("这些图读不出尺寸，拼不了。", "These images have no usable size."));
                    return;
                }
                const canvas = document.createElement("canvas");
                canvas.width = plan.width;
                canvas.height = plan.height;
                const ctx = canvas.getContext("2d")!;
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, plan.width, plan.height);
                for (const seg of plan.segments) {
                    // 整页缩放：源矩形就是整张图，目标矩形由 planConcat 算好
                    ctx.drawImage(els[seg.imageIndex], seg.dx, seg.dy, seg.dw, seg.dh);
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
        },
        [L, onDone],
    );

    if (!open) return null;

    const boxCount = boxes.length;

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
            {/* ===== 顶栏 ===== */}
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                <span className="text-sm font-semibold">
                    {/* 【2026-10-09 第 4 条】标题就叫「拼接」—— 原来那串括号太长，页签上挤成一团 */}
                    {L("拼接", "Stitch")}
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

            {/* ===== 【2026-10-09 第 6 条】整页拼：不画框，把每张原样接起来 =====
                单独一行、放在"画框"那一行上面 —— 这是一条**独立的用法**
                （整页拼 vs 按框挑段），并排挤在一行里容易点错。 */}
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2">
                <span className="text-xs font-medium text-muted-foreground">{L("整页拼：", "Whole page:")}</span>
                <Button size="sm" variant="outline" onClick={() => void doConcat("horizontal")} disabled={busy || shots.length < 2}>
                    <Columns2 className="mr-1 h-4 w-4" />
                    {L("页横拼", "Side by side")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void doConcat("vertical")} disabled={busy || shots.length < 2}>
                    <Rows2 className="mr-1 h-4 w-4" />
                    {L("页竖拼", "Stacked")}
                </Button>
                <span className="text-xs text-muted-foreground">
                    {L("忽略所有紫框，把每张整页接起来（横拼等高、竖拼等宽）", "Ignores the purple boxes; joins whole pages (same height / same width)")}
                </span>
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
                    {L("自收件箱", "From inbox")}
                </Button>

                {/* 【2026-10-05】手机端专用开关：手指要么画框、要么滚页面（见 touchMode 的说明）。
                    只在这类设备上出现 —— 电脑上滚轮就能滚，多一个按钮纯属添乱。 */}
                {touchOnly && (
                    <Button
                        size="sm"
                        variant={touchScrollMode ? "default" : "outline"}
                        onClick={() => setTouchMode(touchScrollMode ? "draw" : "scroll")}
                        title={L(
                            "手机上一个手指只能干一件事：画框，或者滚动页面",
                            "On a phone one finger can either draw or scroll",
                        )}
                    >
                        {touchScrollMode ? (
                            <MoveVertical className="mr-1 h-4 w-4" />
                        ) : (
                            <Pencil className="mr-1 h-4 w-4" />
                        )}
                        {/* 【2026-10-09 第 5 条】文案只留两个字：原来那串括号太长，手机上一眼看不完，
                            而"点一下会切到另一个模式"这件事，他自己的说法就是"点一下切回" —— 说得再细也是这两下。 */}
                        {touchScrollMode
                            ? L("滚动", "Scroll")
                            : L("画框", "Draw")}
                    </Button>
                )}

                <span className="mx-1 h-5 w-px bg-border" />

                <Button size="sm" variant="outline" onClick={undoBox} disabled={busy || boxCount === 0}>
                    <Undo2 className="mr-1 h-4 w-4" />
                    {L("撤销", "Undo")}
                </Button>
                {/* 【2026-10-09 第 5 条】原来这里还有个「删掉选中的框」，**去掉了** ——
                    他自己查出来那个按钮永远点不动（画完的框没法再"选中"），
                    而"画错了"这件事用「撤销」就够了（撤销就是撤掉最后画的那个）。 */}
                <span className="text-xs text-muted-foreground">
                    {L("在图上按住拖，画紫色框；框之间不许交叉", "Drag on an image to draw a purple box; boxes must not cross")}
                    {touchOnly
                        ? L(
                              " · 手机上：想看下面那张图，先点上面的「滚动」",
                              " · Phone: to reach the next image, switch to Scroll first",
                          )
                        : ""}
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
                                {/* 【2026-10-09 第 7 条】上移 / 下移：和上一张 / 下一张**对调位置**。
                                    放最左边（他指定的位置）—— 这两个按钮管的是"这张图整体排第几"，
                                    和最右边那三个"管这张图本身"的按钮分开，不容易按错。 */}
                                <div className="flex items-center gap-0.5">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 w-7 p-0"
                                        onClick={() => moveShot(i, -1)}
                                        disabled={busy || i === 0}
                                        title={L("上移一张（和上一张换位置）", "Move up (swap with previous)")}
                                    >
                                        <ArrowUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 w-7 p-0"
                                        onClick={() => moveShot(i, 1)}
                                        disabled={busy || i === shots.length - 1}
                                        title={L("下移一张（和下一张换位置）", "Move down (swap with next)")}
                                    >
                                        <ArrowDown className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
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
                                    className={`absolute inset-0 h-full w-full cursor-crosshair ${touchScrollMode ? "touch-pan-y" : "touch-none"}`}
                                    onPointerDown={(e) => onPointerDown(e, i)}
                                    onPointerMove={(e) => onPointerMove(e, i)}
                                    onPointerUp={(e) => onPointerUp(e, i)}
                                    onPointerCancel={onPointerCancel}
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
