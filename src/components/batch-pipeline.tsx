"use client";

/**
 * 【custom-v23 · 蓝图 #5 #6 #7 #8】流水线模式（批量上传）
 *
 * 与「循环模式」的分工：
 *   循环模式（v22）：一张整页在上面**逐道抠**，抠一道存一道，图不动。
 *   流水线模式（本文件）：**多张图**一次收进来，先逐张加工，再批量送 AI，最后一道道审阅入库。
 *
 * 蓝图 #5 的骨架在这里落地：
 *   - 两文件夹：待处理（刚收进来的原图）/ 预处理（加工好、等送 AI 的图）
 *   - 【custom-v28】送 AI 改为**按勾选送**：预处理区每张图左上角有勾选框，
 *     标题行右侧配「全选 / 清除 / 未分析」三个按钮，送哪几张完全由用户掌控。
 *     原来的「四选项对话框」（①当前 ②已预处理 ③全部 ④取消）已撤掉。
 *     **待处理区的图不参与送 AI** —— 必须先过编辑器加工成预处理图。
 *   - 每张最多尝试 3 次，每次请求前停 5 秒；正在跑的那张缩略图下面有细进度条。
 *   - 已录入的图也可以重送，重分析后回到「待录」，保存时按 savedId **更新原题**
 *     （题号 source 不变、不新增记录）。
 *   - #8：集中送 AI 后**一道道审阅**，点录入给下一道
 *
 * 数据全部在前端内存（file + blob URL）。已知取舍：**刷新页面会丢**，
 * 所以界面上明确写了提醒 —— 一批别贪多，加工完就送 AI，入库后才是安全的。
 */

import { useState, useEffect, useRef } from "react";
import { ImageCropper } from "@/components/image-cropper";
import { DocScanner, type DocScannerHandle } from "@/components/doc-scanner";
import { CorrectionEditor, ParsedQuestionWithSubject } from "@/components/correction-editor";
import { ParsedQuestion } from "@/lib/ai";
import { apiClient } from "@/lib/api-client";
import { AnalyzeResponse, Notebook } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import { subjectLabel } from "@/lib/notebook-fields";
import { frontendLogger } from "@/lib/frontend-logger";
import { Progress } from "@/components/ui/progress";
import { ProgressFeedback, ProgressStatus } from "@/components/ui/progress-feedback";
import {
    Upload, X, Check, Sparkles, ArrowLeft, Trash2, Layers, PenLine, Camera,
} from "lucide-react";

/** 一张图在流水线里的状态 */
export type BatchStatus =
    | "pending"   // 待处理：刚收进来，还没加工
    | "processed" // 已预处理：加工过了，等送 AI
    | "ready"     // AI 已返回，等审阅入库
    | "error"     // 送 AI 失败
    | "saved"     // 已入库
    | "skipped";  // 审阅时跳过

export interface BatchItem {
    id: string;
    file: File;
    /** 缩略图用的 blob URL */
    previewUrl: string;
    /** 是否加工过（对应蓝图的「预处理文件夹」） */
    processed: boolean;
    /**
     * 【custom-v27】这张**待处理**原图是否已被加工过至少一次。
     * 加工过就变灰显示，但它**仍留在待处理区**，可再次点开反复利用。
     * 与 processed 的区别：processed 表示"它是加工产出的结果图、归在预处理区"。
     */
    treated?: boolean;
    /** 【custom-v27】入库后拿到的题目 id —— 供"点缩略图开详情页"用 */
    savedId?: string;
    /** 送 AI 时压缩后的图，入库时一并存 */
    base64?: string;
    result?: ParsedQuestion;
    status: BatchStatus;
    error?: string;
}

interface BatchPipelineProps {
    language: string;
    aiTimeout: number;
    /** 从哪个错题本进来的（首页可能带 notebookId 参数） */
    defaultNotebookId?: string;
    onExit: () => void;
    /**
     * 【custom-v25 绿框】外面（首页 / 错题本内页的裁剪对话框）用「区🟩」一次裁出来的几道题。
     * 这些图**已经裁剪 + 烘焙**过，直接落进「预处理」文件夹，点一下「送 AI」就能跑。
     * 只在首次挂载时消费一次。
     */
    initialFiles?: File[];
}

/**
 * 一批最多收多少张。
 *
 * 图片全在前端内存里（File + base64 两份），手机浏览器撑不住几十张大图；
 * 而且分析是串行的，一批 30 张最坏要等很久。超出直接挡掉，比跑到一半崩掉强。
 */
const MAX_BATCH = 30;

/**
 * 【custom-v28】送 AI 的尝试次数与请求间隔。
 *
 * 次数：1 次原始 + 2 次重试 = 最多 3 次，3 次都不过才判定失败。
 * 间隔：每次请求前等 5 秒（含重试）。用户拍板「成功比速度更重要」——
 * 13 道题也就多等 1 分钟，但密集请求容易撞上 AI 接口的限流窗口，
 * 拉长间隔能明显减少「莫名其妙失败」。
 */
const MAX_ATTEMPTS = 3;
const RETRY_GAP_MS = 5000;

export function BatchPipeline({ language, aiTimeout, defaultNotebookId, onExit, initialFiles }: BatchPipelineProps) {
    const { t } = useLanguage();

    const [items, setItems] = useState<BatchItem[]>([]);
    /** 最后操作/选中的那张（只用于视觉高亮；送 AI 的范围改由勾选决定） */
    const [activeId, setActiveId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [stage, setStage] = useState<"queue" | "review">("queue");
    const [reviewIdx, setReviewIdx] = useState(0);

    /**
     * 【custom-v28】勾选的预处理图 —— 「送 AI 分析」就送这些，送哪几张完全由用户决定。
     *
     * 只装预处理区（processed=true）的 id。待处理图不参与送 AI：
     * 必须先进编辑器加工成预处理图，才可能被勾上。
     */
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    /** 【custom-v28】当前正在分析的那张 —— 它的缩略图下方显示一条细进度条 */
    const [runningId, setRunningId] = useState<string | null>(null);
    /** 【custom-v28】当前这张正在第几次尝试（1..3），用于在文案里体现重试 */
    const [attempt, setAttempt] = useState(0);

    const [analysisStep, setAnalysisStep] = useState<ProgressStatus>("idle");
    const [progress, setProgress] = useState(0);
    const [run, setRun] = useState<{ i: number; n: number } | null>(null);
    const [savedCount, setSavedCount] = useState(0);

    /** 审阅时用来把 AI 认出的学科对到错题本（与单题流同一套匹配） */
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    /** 用户点了「取消剩余」→ 循环下一轮开头就停 */
    const cancelRef = useRef(false);
    const [canceling, setCanceling] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    /** 【custom-v26】文件正被拖到收图框上方（用于高亮） */
    const [dragActive, setDragActive] = useState(false);

    /** 【custom-v26 连拍】扫描器句柄 + 本轮已拍张数（显示在扫描器顶部条） */
    const scannerRef = useRef<DocScannerHandle>(null);
    const [burstCount, setBurstCount] = useState(0);
    /** 相机可用才显示「连续拍摄」：必须是安全上下文（https / localhost）且浏览器支持 */
    const [camOk, setCamOk] = useState(false);
    useEffect(() => {
        setCamOk(
            typeof navigator !== "undefined" &&
            typeof navigator.mediaDevices?.getUserMedia === "function" &&
            window.isSecureContext === true
        );
    }, []);

    /**
     * 【custom-v26】拖放兜底：拦掉浏览器「打开被拖文件」的默认行为。
     *
     * 为什么必须加：用户在这页攒了十几张图（全在内存里），
     * 要是不小心把图片拖到**虚线框以外**的地方，浏览器会直接导航去打开那张图
     * → 页面一跳，这一批图全没了。拦掉 window 上的默认 drop 就能彻底避免。
     * 本页没有其它放置目标，所以全局拦是安全的。
     */
    useEffect(() => {
        const block = (e: DragEvent) => {
            // 收图框自己处理，这里放行
            if (e.target instanceof HTMLElement && e.target.closest("[data-dropzone]")) return;
            // 只拦「拖文件」：拖选中的文字进输入框不受影响（那类拖拽 types 里没有 Files）
            if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
        };
        window.addEventListener("dragover", block);
        window.addEventListener("drop", block);
        return () => {
            window.removeEventListener("dragover", block);
            window.removeEventListener("drop", block);
        };
    }, []);

    // 卸载时统一回收 blob URL，避免内存泄漏
    const itemsRef = useRef<BatchItem[]>([]);
    useEffect(() => { itemsRef.current = items; }, [items]);
    useEffect(() => () => {
        itemsRef.current.forEach(it => URL.revokeObjectURL(it.previewUrl));
    }, []);

    useEffect(() => {
        apiClient.get<Notebook[]>("/api/notebooks")
            .then(setNotebooks)
            .catch(err => frontendLogger.error('[Batch]', 'Load notebooks failed', { error: String(err) }));
    }, []);

    const editingItem = items.find(i => i.id === editingId) || null;
    const pendingItems = items.filter(i => !i.processed);
    const processedItems = items.filter(i => i.processed);
    const readyItems = items.filter(i => i.status === "ready");

    /**
     * 【custom-v28】送 AI 的范围 = 预处理区里**被勾选**的那些。
     *
     * 与旧版（四选项对话框）的关键差别：
     *   ① 不再包含待处理图 —— 待处理必须先进编辑器加工成预处理图才有资格被送；
     *   ② **不再排除已入库（saved）的图** —— 用户明确要求「已经录入的题经过重新
     *      分析也返回未录入状态」。重跑后按 `savedId` 走**更新原题**，
     *      题号（source，如 SX20260919010）保持不变、也不会多出一道重复题。
     */
    const selectedProcessed = processedItems.filter(i => selectedIds.has(i.id));

    /** 三个批量勾选按钮（只作用于预处理区） */
    const selectAllProcessed = () => setSelectedIds(new Set(processedItems.map(i => i.id)));
    const clearSelection = () => setSelectedIds(new Set());
    /** 「未分析」= 还没送过 AI（processed）+ 送过但失败（error） */
    const selectUnanalyzed = () => setSelectedIds(new Set(
        processedItems.filter(i => i.status === "processed" || i.status === "error").map(i => i.id),
    ));

    /** 送 AI 期间锁住列表交互，免得改到正在分析的那一批 */
    const busy = analysisStep !== "idle";

    /**
     * 审阅时给每一道算出「该归到哪个错题本」。
     *
     * 【为什么必须有】单题流分析完会按 `data.subject` 自动选错题本
     * （首页 page.tsx 的 autoSelectedNotebookId），但流水线原来直接把
     * defaultNotebookId 传下去 —— 从首页进来时那个值是 undefined，
     * 于是**每一道都要手动在下拉菜单里选一次错题本**。10 道就是 10 次，
     * 正好卡在「爸爸代劳录 100 道」最疼的地方。这里把同一套匹配补上。
     */
    const resolveNotebookId = (subject?: string): string | undefined => {
        if (defaultNotebookId) return defaultNotebookId;
        if (!subject || !notebooks.length) return undefined;
        const matched = notebooks.find(n => subjectLabel(n.subject) === subject)
            || notebooks.find(n => n.displayName.includes(subject) || subject.includes(n.displayName));
        return matched?.id;
    };

    /**
     * 【custom-v25 绿框】外面裁好送进来的一批图，落地即「已预处理」。
     * 用 ref 保证只消费一次：这个组件重渲染很频繁（进度、选中都会触发），
     * 不加锁的话每渲染一次就往队列里重复塞一批。
     */
    const initialConsumedRef = useRef(false);
    useEffect(() => {
        if (initialConsumedRef.current || !initialFiles?.length) return;
        initialConsumedRef.current = true;
        const added: BatchItem[] = initialFiles.slice(0, MAX_BATCH).map((f, k) => ({
            id: `b${Date.now()}-i${k}-${Math.random().toString(36).slice(2, 7)}`,
            file: f,
            previewUrl: URL.createObjectURL(f),
            processed: true,
            status: "processed" as BatchStatus,
        }));
        setItems(prev => [...prev, ...added]);
        setActiveId(added[added.length - 1].id);
    }, [initialFiles]);

    /** 退出前拦一道：没入库的图退出即丢，不能一声不响 */
    const requestExit = () => {
        const unsaved = items.filter(i => i.status !== "saved").length;
        if (unsaved > 0) {
            const msg = (t.common.batch?.confirmExit
                || "还有 {n} 张没入库，退出后这些图就没了（图片只存在当前页面）。确定退出？")
                .replace("{n}", String(unsaved));
            if (!confirm(msg)) return;
        }
        onExit();
    };

    /** 收图：一次可以选多张（连拍的那批） */
    const addFiles = (files: File[]) => {
        if (!files.length) return;
        // 【custom-v26】拖放进来的可能夹着 PDF / 文档等，先按 MIME 过滤再进队列，
        // 否则后面预览是裂图、送 AI 也是白花钱。
        const imgs = files.filter(f => f.type.startsWith("image/"));
        if (imgs.length < files.length) {
            alert(t.common.batch?.notImage || "只能收图片（JPG / PNG），其它文件已忽略");
        }
        if (!imgs.length) return;
        const room = MAX_BATCH - items.length;
        if (room <= 0) {
            alert((t.common.batch?.tooMany || "一批最多 {n} 张（建议 10~20 张），请分批处理")
                .replace("{n}", String(MAX_BATCH)));
            return;
        }
        let accepted = imgs;
        if (imgs.length > room) {
            accepted = imgs.slice(0, room);
            alert((t.common.batch?.tooMany || "一批最多 {n} 张（建议 10~20 张），多出的没有加入")
                .replace("{n}", String(MAX_BATCH)));
        }
        const added: BatchItem[] = accepted.map((f, k) => ({
            id: `b${Date.now()}-${k}-${Math.random().toString(36).slice(2, 7)}`,
            file: f,
            previewUrl: URL.createObjectURL(f),
            processed: false,
            status: "pending",
        }));
        setItems(prev => [...prev, ...added]);
        setActiveId(added[added.length - 1].id);
        setStage("queue");
    };

    /**
     * 【custom-v26 连拍】扫描器出的每一张都进「待处理」。
     *
     * 为什么是待处理而不是预处理：扫描器只做了"拉正 + 漂白"，
     * 关键的一步（把这一道从整页里抠出来 / 擦掉多余笔迹）还得进编辑器做，
     * 所以按用户要求先堆在待处理，回头在队列里逐张加工。
     *
     * @param action "again" = 用户还要接着拍（扫描器自己回取景，这里不用管）
     *               "done"  = 收工（扫描器自己会关闭，这里把计数清零，下一轮从头数）
     */
    const handleBurstShot = (blob: Blob, action: "again" | "done") => {
        const f = new File([blob], `burst-${Date.now()}.jpg`, { type: "image/jpeg" });
        addFiles([f]);
        if (action === "done") setBurstCount(0);
        else setBurstCount((c) => c + 1);
    };

    /** 【custom-v28】勾选框：点一下切换选中状态（不影响缩略图本体的点击行为） */
    const toggleSelect = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const removeItem = (id: string) => {
        const it = items.find(i => i.id === id);
        if (it) URL.revokeObjectURL(it.previewUrl);
        setItems(prev => prev.filter(i => i.id !== id));
        if (activeId === id) setActiveId(null);
        // 勾选集里也要清掉，否则残留的 id 会让「送 AI」算出一个已经不在队列里的目标
        setSelectedIds(prev => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    };

    /**
     * 【custom-v27】点缩略图本体 → 按状态分派（用户要求：已分析成功的图不该再进图片编辑器）。
     *   已分析成功（ready）→ 直接进"分析编辑页"（review 定位到这一道），不跳出批处理循环；
     *   已入库（saved）  → **新标签页**打开详情页 —— 本页整批图只在内存里，
     *                     若就地导航过去，整批未入库的图就全丢了；
     *   其余（待处理 / 已预处理 / AI 失败）→ 进图片编辑器加工。
     * 想"再编辑图片"时用右下角的笔头按钮（handleEditItem），与这里分开。
     */
    const handleOpenItem = (it: BatchItem) => {
        setActiveId(it.id);
        if (it.status === "ready") {
            const idx = readyItems.findIndex(r => r.id === it.id);
            if (idx >= 0) {
                setReviewIdx(idx);
                setStage("review");
                return;
            }
        }
        if (it.status === "saved") {
            if (it.savedId) window.open(`/error-items/${it.savedId}`, "_blank", "noopener");
            return;
        }
        setEditingId(it.id);
    };

    /** 右下角笔头按钮：无论什么状态，都是"进图片编辑器再加工" */
    const handleEditItem = (it: BatchItem) => {
        setActiveId(it.id);
        setEditingId(it.id);
    };

    /**
     * 编辑器确认 → **只加工，不送 AI**（这是与单题流最大的差别）。
     *
     * 【custom-v27 改法】原先把这张图"替换"进预处理区，待处理区那张就没了 ——
     * 用户说"如果待处理的图片我还想用，就用不成了"。现在分两种情况：
     *   · 编辑的是**待处理**图：原图**留在待处理区**并标记 treated（变灰），
     *     加工结果作为**新的一张**落进预处理区。同一张原图可反复利用
     *     （再拆一道 / 重画框再送），重复了由用户自己删。
     *   · 编辑的是**预处理**图（点右下角笔头再来编辑）：仍是"替换"，
     *     避免凭空多出一张一模一样的。
     */
    const handleCropComplete = async (blob: Blob) => {
        if (!editingId) return;
        const id = editingId;
        const target = items.find(i => i.id === id);
        const url = URL.createObjectURL(blob);
        const newFile = new File([blob], `crop-${Date.now()}.jpg`, { type: "image/jpeg" });
        const isPending = !!target && !target.processed;

        if (isPending) {
            const added: BatchItem = {
                id: `b${Date.now()}-c${Math.random().toString(36).slice(2, 7)}`,
                file: newFile,
                previewUrl: url,
                processed: true,
                status: "processed",
            };
            setItems(prev => [
                ...prev.map(it => it.id === id ? { ...it, treated: true } : it),
                added,
            ]);
            setActiveId(added.id); // 选中落到刚加工出的结果图：缩略图高亮跟着走，不会停在已变灰的原图上
        } else {
            if (target) URL.revokeObjectURL(target.previewUrl);
            setItems(prev => prev.map(it => it.id === id ? {
                ...it,
                file: newFile,
                previewUrl: url,
                processed: true,
                treated: true,
                status: "processed",
                // 换过图之后，旧的 AI 结果与压缩图都作废
                base64: undefined,
                result: undefined,
                error: undefined,
            } : it));
        }
        setEditingId(null);
    };

    /**
     * 【custom-v25 绿框】编辑器里画了「区🟩」→ 一次交出多张（一区一张，重叠的已并成一块）。
     *
     * 这批图已经裁好、红蓝框也烘焙好了，直接进「预处理」文件夹等送 AI；
     * 被编辑的那张**整页图移出队列** —— 它已经被拆成好几道，留着只会被重复送一次 AI。
     * 与 handleCropComplete 的区别只在这一点：单张是"替换"，多张是"替换成 N 张"。
     */
    const handleCropBatch = (blobs: Blob[]) => {
        if (!blobs.length) return;
        const editing = editingId ? items.find(i => i.id === editingId) : null;
        // 【custom-v27】待处理的整页图被绿框拆成多道后，同样**保留原页**（变灰），
        // 以便再拆／重拆；只有编辑的是预处理图时才把它换掉。
        const keepOriginal = !!editing && !editing.processed;
        const removable = editing && !keepOriginal ? 1 : 0;
        const room = MAX_BATCH - (items.length - removable);
        const accepted = room > 0 ? blobs.slice(0, room) : [];
        if (accepted.length < blobs.length) {
            alert((t.common.batch?.tooMany || "一批最多 {n} 张（建议 10~20 张），多出的没有加入")
                .replace("{n}", String(MAX_BATCH)));
        }
        const added: BatchItem[] = accepted.map((b, k) => ({
            id: `b${Date.now()}-g${k}-${Math.random().toString(36).slice(2, 7)}`,
            file: new File([b], `region-${Date.now()}-${k + 1}.jpg`, { type: "image/jpeg" }),
            previewUrl: URL.createObjectURL(b),
            processed: true,
            status: "processed" as BatchStatus,
        }));
        if (editing && !keepOriginal) URL.revokeObjectURL(editing.previewUrl);
        setItems(prev => [
            ...(keepOriginal
                ? prev.map(i => i.id === editingId ? { ...i, treated: true } : i)
                : prev.filter(i => i.id !== editingId)),
            ...added,
        ]);
        setActiveId(added[added.length - 1]?.id ?? (keepOriginal ? editingId : null));
        setEditingId(null);
        setStage("queue");
    };

    /**
     * 等待 ms 毫秒，但每 100ms 查一次取消标记 —— 让「取消剩余」不必干等满 5 秒。
     * @returns false 表示等待期间被取消
     */
    const waitUnlessCanceled = async (ms: number): Promise<boolean> => {
        const STEP = 100;
        for (let waited = 0; waited < ms; waited += STEP) {
            if (cancelRef.current) return false;
            await new Promise(r => setTimeout(r, Math.min(STEP, ms - waited)));
        }
        return !cancelRef.current;
    };

    /**
     * 【custom-v28】串行送 AI —— 送哪几张由调用方传入（即预处理区里勾选的那些）。
     *
     * 每张最多尝试 MAX_ATTEMPTS（3）次，每次请求前等 RETRY_GAP_MS（5 秒，可被
     * 「取消剩余」在 100ms 内打断）。用户拍板：成功比速度重要。
     */
    const analyzeTargets = async (targets: BatchItem[]) => {
        if (!targets.length) return;
        cancelRef.current = false;
        setCanceling(false);
        // 进度必须**每轮重置**：否则第二批一进来就停在上一批留下的 100%
        setProgress(0);
        setRun({ i: 0, n: targets.length });

        let okCount = 0;
        let canceled = false;
        for (let k = 0; k < targets.length; k++) {
            if (cancelRef.current) { canceled = true; break; }
            const it = targets[k];
            setRun({ i: k + 1, n: targets.length });
            // 进度按「已开始处理几张」推进。原先把 progress 只在末尾置 100，
            // 于是整个批量过程里进度条一直显示 0%，与旁边的「3/20」自相矛盾。
            setProgress(Math.round((k / targets.length) * 100));
            // 【custom-v28】标出「就是这张在跑」：它的缩略图下方会出现细进度条
            setRunningId(it.id);
            setAttempt(1);
            try {
                setAnalysisStep("compressing");
                const b64 = await processImageFile(it.file);

                /**
                 * 【custom-v28】最多尝试 MAX_ATTEMPTS（3）次 = 1 次原始 + 2 次重试。
                 * 3 次都不过才判定失败、标红。
                 *
                 * 为什么必须重试：分析失败几乎都是"AI 返回内容里缺 <question_text> /
                 * <answer_text> / <analysis> 标签"（复杂表格题容易被 max_tokens 截断，
                 * 或模型偶尔不按 XML 格式输出）。单题流失败时用户会手动再点一次"确定"，
                 * 批量流是串行闷头跑、没有人工缓冲 —— 不重试就等于一次不中直接标红，
                 * 看着像"某几张老是失败"。
                 *
                 * 每次请求前等 5 秒：批量是"上一张回来立刻发下一张"，请求密度远高于
                 * 人工操作（人工两道题之间隔着几十秒看结果、改字、保存），密集请求
                 * 容易撞上 AI 接口的限流窗口。等待期间可被「取消剩余」在 100ms 内打断。
                 *
                 * 注意循环变量叫 n 而不是 attempt —— attempt 是组件里那个「第几次尝试」
                 * 的 state，同名会把它遮蔽掉，进度文案就永远不动了。
                 */
                let data: AnalyzeResponse | null = null;
                let lastErr: unknown = null;
                for (let n = 1; n <= MAX_ATTEMPTS && !data; n++) {
                    if (cancelRef.current) break;
                    setAttempt(n);
                    if (n > 1) {
                        frontendLogger.warn('[BatchAnalyze]', 'Retry after AI failure', {
                            id: it.id,
                            attempt: n,
                            error: String(lastErr),
                        });
                    }
                    // 请求间隔（第 1 次也等，让用户看清是从哪张开始跑的）
                    if (!(await waitUnlessCanceled(RETRY_GAP_MS))) break;
                    try {
                        setAnalysisStep("analyzing");
                        data = await apiClient.post<AnalyzeResponse>("/api/analyze", {
                            imageBase64: b64,
                            language,
                            notebookId: defaultNotebookId || undefined,
                        }, { timeout: aiTimeout });
                    } catch (err) {
                        lastErr = err;
                    }
                }
                if (!data) {
                    if (cancelRef.current) throw lastErr ?? new Error("AI analysis canceled");
                    throw lastErr ?? new Error(
                        t.common.batch?.allAttemptsFailed
                        || `连续 ${MAX_ATTEMPTS} 次都没通过`,
                    );
                }

                setItems(prev => prev.map(x => x.id === it.id ? {
                    ...x,
                    base64: b64,
                    result: data as unknown as ParsedQuestion,
                    status: "ready" as BatchStatus,
                    error: undefined,
                } : x));
                okCount++;
            } catch (e: any) {
                // 用户点了「取消剩余」：别把这张半途停下的图标成「AI 失败」，
                // 保持它原来的样子（未送 / 已录），免得白挨一个红标
                if (cancelRef.current) { canceled = true; break; }
                frontendLogger.error('[BatchAnalyze]', 'One image failed', {
                    id: it.id,
                    error: e?.message || String(e),
                });
                setItems(prev => prev.map(x => x.id === it.id ? {
                    ...x,
                    status: "error" as BatchStatus,
                    error: e?.message || String(e),
                } : x));
            }
        }

        setAnalysisStep("idle");
        if (!canceled) setProgress(100);
        setRun(null);
        setRunningId(null);
        setAttempt(0);
        setCanceling(false);
        cancelRef.current = false;
        // 跑完清空勾选：免得手滑把同一批再送一遍，白烧 token
        setSelectedIds(new Set());
        frontendLogger.info('[BatchAnalyze]', 'Batch finished', {
            total: targets.length, ok: okCount, canceled,
        });
        // 【custom-v28】只有真跑出结果才切到审阅页。原先无条件切 ——
        // 对「重分析已入库的题」这种整批可能全失败的场景，会把用户扔进一个
        // 空的审阅页，连失败原因都看不着。
        if (okCount > 0) {
            setReviewIdx(0);
            setStage("review");
        }
    };

    /** 保存当前这道 → 自动落到下一道（蓝图 #8） */
    const handleSaveCurrent = async (data: ParsedQuestionWithSubject) => {
        const cur = readyItems[reviewIdx];
        if (!cur) return;
        try {
            /**
             * 【custom-v28】重新分析「已录入」的图 → **更新原题**，不新增记录。
             *
             * 判据是这张图有没有 savedId（当初入库时记下的题目 id）。有就说明它对应
             * 错题本里已有的一道题 —— 用户在详情页看到的题号（source，如
             * SX20260919010）必须保持不变，否则每重新分析一次就多出一道重复题。
             *
             * PUT 只覆盖分析类字段 + 原图，**不碰 source（题号）**，所以题号天然不变。
             */
            if (cur.savedId) {
                await apiClient.put(`/api/error-items/${cur.savedId}`, {
                    knowledgePoints: data.knowledgePoints,
                    questionText: data.questionText,
                    answerText: data.answerText,
                    analysis: data.analysis,
                    mistakeAnalysis: data.mistakeAnalysis,
                    mistakeStatus: data.mistakeStatus,
                    originalImageUrl: cur.base64 || undefined,
                    notebookId: resolveNotebookId(data.subject),
                });
                frontendLogger.info('[BatchSave]', 'Re-analysis: updated existing item', {
                    batchId: cur.id, itemId: cur.savedId,
                });
                setItems(prev => prev.map(x => x.id === cur.id ? { ...x, status: "saved" } : x));
                setSavedCount(c => c + 1);
                return;
            }

            const res = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", {
                ...data,
                originalImageUrl: cur.base64 || "",
            });
            // 后端 2 秒去重窗口命中会回 duplicate:true，此时并没有新建记录。
            // 单题流会记一条日志，这里也补上，免得排查时看不出「怎么少了一道」。
            if (res.duplicate) {
                frontendLogger.info('[BatchSave]', 'Duplicate submission detected, using existing record', { id: cur.id });
            }
            // 【custom-v27】记下入库 id：缩略图点击时用它新开详情页
            setItems(prev => prev.map(x => x.id === cur.id ? { ...x, status: "saved", savedId: res.id } : x));
            setSavedCount(c => c + 1);
            // 不递增索引：当前项已变 saved，会从 readyItems 里移除，
            // 原索引位置自然就是下一道。
        } catch (e: any) {
            frontendLogger.error('[BatchSave]', 'Save failed', { error: e?.message || String(e) });
            alert(t.common?.messages?.saveFailed || "保存失败");
        }
    };

    const skipCurrent = () => {
        const cur = readyItems[reviewIdx];
        if (!cur) return;
        setItems(prev => prev.map(x => x.id === cur.id ? { ...x, status: "skipped" } : x));
    };

    const progressMessage = () => {
        const prefix = run ? `${run.i}/${run.n} ` : "";
        const base = (() => {
            switch (analysisStep) {
                case "compressing": return t.common.progress?.compressing || "压缩图片…";
                case "analyzing": return t.common.progress?.analyzing || "AI 分析中…";
                case "processing": return t.common.progress?.processing || "处理结果…";
                default: return "";
            }
        })();
        if (!base) return "";
        // 【custom-v28】重试时要说清"不是卡住了，是在重来"，否则用户会以为死机
        const retry = attempt > 1
            ? `（${(t.common.batch?.retryHint || "第 {n} 次尝试").replace("{n}", String(attempt))}）`
            : "";
        return prefix + base + retry;
    };

    const current = readyItems[reviewIdx];

    // ===== 审阅阶段：一道道看 =====
    if (stage === "review") {
        // 全看完了：给个汇总
        if (!current) {
            const errCount = items.filter(i => i.status === "error").length;
            const skippedCount = items.filter(i => i.status === "skipped").length;
            return (
                <div className="space-y-6">
                    <ProgressFeedback status={analysisStep} progress={progress} message={progressMessage()} />
                    <div className="rounded-xl border p-6 text-center space-y-4">
                        <div className="text-4xl">🎉</div>
                        <h2 className="text-xl font-bold">
                            {t.common.batch?.allDone || "本批处理完"}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                            {(t.common.batch?.doneSummary || "已录入 {n} 道")
                                .replace("{n}", String(savedCount))}
                            {skippedCount > 0 && (
                                <span className="text-amber-600">
                                    ，{(t.common.batch?.skippedSummary || "{n} 道已跳过")
                                        .replace("{n}", String(skippedCount))}
                                </span>
                            )}
                            {errCount > 0 && (
                                <span className="text-destructive">
                                    ，{(t.common.batch?.errorSummary || "{n} 道 AI 失败")
                                        .replace("{n}", String(errCount))}
                                </span>
                            )}
                        </p>
                        <div className="flex flex-wrap justify-center gap-3">
                            {/* 「跳过」原来是个单向门：跳过之后 result/base64 还留着，
                                但待审队列只认 ready，用户再也回不到那一道 ——
                                等于 AI 白分析、题也丢了。这里给一条回路。 */}
                            {skippedCount > 0 && (
                                <Button
                                    variant="secondary"
                                    onClick={() => {
                                        setItems(prev => prev.map(x =>
                                            x.status === "skipped" ? { ...x, status: "ready" as BatchStatus } : x));
                                        setReviewIdx(0);
                                    }}
                                >
                                    {(t.common.batch?.reReviewSkipped || "还有 {n} 道跳过的，重新审阅")
                                        .replace("{n}", String(skippedCount))}
                                </Button>
                            )}
                            <Button variant="outline" onClick={() => { setStage("queue"); setReviewIdx(0); }}>
                                <ArrowLeft className="mr-2 h-4 w-4" />
                                {t.common.batch?.backToQueue || "回到队列"}
                            </Button>
                            <Button onClick={requestExit}>
                                {t.common.batch?.finish || "结束批量"}
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div className="space-y-4">
                <ProgressFeedback status={analysisStep} progress={progress} message={progressMessage()} />
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Layers className="h-4 w-4" />
                        {/* 原来写「第 {i} / {n} 道」，但 reviewIdx 恒为 0（入库/跳过都会把当前项
                            从 readyItems 里摘掉，索引自然指向下一道），分子永远显示 1。
                            改成只报「还剩几道」，配合旁边的已录入数，语义才自洽。 */}
                        {(t.common.batch?.reviewProgress || "待审阅 {n} 道")
                            .replace("{n}", String(readyItems.length))}
                        <span className="text-muted-foreground font-normal">
                            ，{t.common.batch?.savedCount ? t.common.batch.savedCount.replace("{n}", String(savedCount)) : `已录入 ${savedCount} 道`}
                        </span>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={skipCurrent}>
                            {t.common.batch?.skip || "跳过这道"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setStage("queue")}>
                            <ArrowLeft className="mr-1 h-4 w-4" />
                            {t.common.batch?.backToQueue || "回到队列"}
                        </Button>
                    </div>
                </div>
                <CorrectionEditor
                    key={current.id}
                    initialData={current.result as ParsedQuestion}
                    onSave={handleSaveCurrent}
                    onCancel={() => setStage("queue")}
                    imagePreview={current.base64}
                    /* 自动对上学科（见 resolveNotebookId 注释），没匹配到也不强塞，
                       编辑器里本来就有错题本下拉，用户自己选。 */
                    initialSubjectId={resolveNotebookId(current.result?.subject)}
                    aiTimeout={aiTimeout}
                />
            </div>
        );
    }

    // ===== 队列阶段：收图 + 逐张加工 =====
    return (
        <div className="space-y-5">
            {/* 这个遮罩是 fixed inset-0 全屏拦截：批量是串行跑 N 张，
                没有 onCancel 的话用户在几十张的批次里被彻底锁死。 */}
            {/* 【custom-v26 连拍】扫描器挂在这里：连拍模式下它自己管理"继续拍 / 收工"，
                每张通过 onBurstShot 回传；onScanComplete 只在单张模式用到，这里给个空实现。 */}
            <DocScanner
                ref={scannerRef}
                burstMode
                burstCount={burstCount}
                onBurstShot={handleBurstShot}
                onScanComplete={() => { }}
                onClose={() => { }}
            />

            {/* 【custom-v28】批量送 AI 的进度不再用全屏遮罩。
                旧的 ProgressFeedback 是 fixed inset-0 z-50 —— 整屏被盖住，
                用户根本看不见"分析到哪张了"，而缩略图下面那条细进度条正是要让人
                看见是哪张在跑。改成列表上方的一条细进度条 + 取消按钮，
                列表全程可见、可滚动，随时能盯着看进展。 */}
            {busy && (
                <div className="rounded-lg border bg-card px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <span className="text-sm font-medium">{progressMessage()}</span>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={canceling}
                            onClick={() => { cancelRef.current = true; setCanceling(true); }}
                        >
                            {canceling
                                ? (t.common.batch?.canceling || "正在取消，等当前这张结束…")
                                : (t.common.batch?.cancelRemaining || "取消剩余")}
                        </Button>
                    </div>
                    <Progress value={progress} className="h-1.5" />
                    <p className="text-xs text-muted-foreground">
                        {t.common.batch?.gapHint
                            || "每张之间停 5 秒，避免请求太密被 AI 接口限流 —— 成功比速度重要"}
                    </p>
                </div>
            )}

            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-xl font-bold">{t.common.batch?.title || "批量上传"}</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        {t.common.batch?.subtitle || "一次收多张 → 逐张加工 → 批量送 AI → 一道道录入"}
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={requestExit}>
                    <X className="mr-1 h-4 w-4" />
                    {t.common.batch?.exit || "退出批量"}
                </Button>
            </div>

            {/* 收图区 */}
            <div
                data-dropzone
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                    dragActive
                        ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                        : "hover:border-primary/60 hover:bg-accent/30"
                }`}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                }}
                onDragOver={(e) => {
                    // 必须 preventDefault，否则浏览器不认这里是放置目标（drop 不触发）
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    if (!dragActive) setDragActive(true);
                }}
                onDragLeave={(e) => {
                    // 只在指针真的离开本框时取消高亮：移到子元素上不算离开，否则会疯狂闪烁
                    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    setDragActive(false);
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragActive(false);
                    const dropped = Array.from(e.dataTransfer?.files || []);
                    if (dropped.length) addFiles(dropped);
                }}
            >
                <Upload className={`mx-auto h-8 w-8 mb-2 ${dragActive ? "text-primary" : "text-muted-foreground"}`} />
                <p className="text-sm font-medium">
                    {dragActive
                        ? (t.common.batch?.dropNow || "松手即加入这一批")
                        : (t.common.batch?.pickHint || "点击选择多张图片（可一次选一批连拍的）")}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                    {t.common.batch?.pickSub || "支持 JPG / PNG"}
                </p>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        addFiles(files);
                        e.target.value = ""; // 允许重复选同一批
                    }}
                />
            </div>

            {/* 【custom-v26 连拍】直接调用摄像头：拍一张 → 确认效果 → 收进待处理 → 接着拍。
                相机不可用（非 https / 浏览器不支持）时整个按钮不出现，避免点了没反应。 */}
            {camOk && (
                <button
                    type="button"
                    onClick={() => scannerRef.current?.openCamera()}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed py-3 text-sm font-medium text-primary hover:bg-primary/5 transition-colors"
                >
                    <Camera className="h-4 w-4" />
                    {t.common.batch?.burst || "连续拍摄：拍一张收一张，拍完一起加工"}
                </button>
            )}

            {items.length > 0 && (
                <>
                    <div className="flex items-center gap-4 text-sm flex-wrap">
                        <span>{t.common.batch?.total ? t.common.batch.total.replace("{n}", String(items.length)) : `共 ${items.length} 张`}</span>
                        <span className="text-muted-foreground">
                            {t.common.batch?.pendingCount ? t.common.batch.pendingCount.replace("{n}", String(pendingItems.length)) : `待处理 ${pendingItems.length}`}
                        </span>
                        <span className="text-green-600">
                            {t.common.batch?.processedCount ? t.common.batch.processedCount.replace("{n}", String(processedItems.length)) : `已预处理 ${processedItems.length}`}
                        </span>
                        <span className="text-xs text-amber-600">
                            {t.common.batch?.noRefresh || "⚠️ 处理中请勿刷新页面（图片暂存在当前页面）"}
                        </span>
                    </div>

                    {/* 两个文件夹：待处理 / 预处理（蓝图 #5）
                        只有预处理区能勾选送 AI —— 待处理图必须先经过编辑器加工、
                        落进预处理区，才可能被送（用户要求：待处理不参与送 AI）。 */}
                    <FolderGrid
                        title={t.common.batch?.pendingFolder || "待处理"}
                        hint={t.common.batch?.pendingHint || "原图（处理过的变灰，仍可再点开继续加工）"}
                        items={pendingItems}
                        activeId={activeId}
                        onOpen={handleOpenItem}
                        onEdit={handleEditItem}
                        onRemove={removeItem}
                        actionIcon={<PenLine className="h-3.5 w-3.5" />}
                        busy={busy}
                    />
                    <FolderGrid
                        title={t.common.batch?.processedFolder || "预处理"}
                        hint={t.common.batch?.processedHint || "勾选要送 AI 的图"}
                        items={processedItems}
                        activeId={activeId}
                        onOpen={handleOpenItem}
                        onEdit={handleEditItem}
                        onRemove={removeItem}
                        actionIcon={<PenLine className="h-3.5 w-3.5" />}
                        busy={busy}
                        selectable
                        selectedIds={selectedIds}
                        onToggleSelect={toggleSelect}
                        runningId={runningId}
                        headerExtra={
                            <>
                                <Button
                                    variant="outline" size="sm" className="h-7 px-2 text-xs"
                                    disabled={busy || !processedItems.length}
                                    onClick={selectAllProcessed}
                                >
                                    {t.common.batch?.selectAll || "全选"}
                                </Button>
                                <Button
                                    variant="outline" size="sm" className="h-7 px-2 text-xs"
                                    disabled={busy || selectedIds.size === 0}
                                    onClick={clearSelection}
                                >
                                    {t.common.batch?.selectClear || "清除"}
                                </Button>
                                <Button
                                    variant="outline" size="sm" className="h-7 px-2 text-xs"
                                    disabled={busy}
                                    onClick={selectUnanalyzed}
                                >
                                    {t.common.batch?.selectUnanalyzed || "未分析"}
                                </Button>
                            </>
                        }
                    />

                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            onClick={() => {
                                // 没勾任何图就别让点进去空跑一轮
                                if (!selectedProcessed.length) {
                                    alert(t.common.batch?.noSelection || "没有选中图片");
                                    return;
                                }
                                analyzeTargets(selectedProcessed);
                            }}
                            disabled={busy}
                        >
                            <Sparkles className="mr-2 h-4 w-4" />
                            {(t.common.batch?.sendSelected || "送 AI 分析（已选 {n} 张）")
                                .replace("{n}", String(selectedProcessed.length))}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            {t.common.batch?.sendScopeHint || "只送预处理区里勾选的图"}
                        </span>
                        {readyItems.length > 0 && (
                            <Button variant="secondary" onClick={() => { setReviewIdx(0); setStage("review"); }}>
                                {(t.common.batch?.gotoReview || "继续审阅（{n} 道待录）")
                                    .replace("{n}", String(readyItems.length))}
                            </Button>
                        )}
                    </div>
                </>
            )}

            {editingItem && (
                <ImageCropper
                    imageSrc={editingItem.previewUrl}
                    open={!!editingId}
                    onClose={() => setEditingId(null)}
                    onCropComplete={handleCropComplete}
                    onCropBatch={handleCropBatch}
                    analyzing={analysisStep !== "idle"}
                />
            )}
        </div>
    );
}

/** 一个「文件夹」的缩略图网格 */
function FolderGrid({
    title, hint, items, activeId, onOpen, onEdit, onRemove, actionIcon,
    busy = false,
    selectable = false,
    selectedIds,
    onToggleSelect,
    runningId,
    headerExtra,
}: {
    title: string;
    hint: string;
    items: BatchItem[];
    activeId: string | null;
    /** 点缩略图本体：按状态分派（见 handleOpenItem） */
    onOpen: (it: BatchItem) => void;
    /** 点右下角笔头：始终进图片编辑器 */
    onEdit: (it: BatchItem) => void;
    onRemove: (id: string) => void;
    actionIcon: React.ReactNode;
    /** 送 AI 期间锁住所有点击，免得改到正在分析的那一批 */
    busy?: boolean;
    /** 【custom-v28】是否显示左上角勾选框（只有预处理区要） */
    selectable?: boolean;
    selectedIds?: Set<string>;
    onToggleSelect?: (id: string) => void;
    /** 【custom-v28】正在分析的那张 —— 它的缩略图下方显示细进度条 */
    runningId?: string | null;
    /** 标题行右侧的附加内容（预处理区的「全选 / 清除 / 未分析」三个按钮） */
    headerExtra?: React.ReactNode;
}) {
    if (!items.length) return null;
    return (
        <div className="space-y-2">
            <div className="flex items-baseline gap-2 flex-wrap">
                <h3 className="text-sm font-semibold">{title}</h3>
                <span className="text-xs text-muted-foreground">{hint}</span>
                {headerExtra && <div className="ml-auto flex items-center gap-1.5">{headerExtra}</div>}
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {items.map(it => {
                    // 【custom-v27】待处理原图已加工过 → 变灰（但保留在待处理区里，可再点开利用）
                    const dimmed = !!it.treated && !it.processed;
                    const checked = !!selectedIds?.has(it.id);
                    const running = runningId === it.id;
                    return (
                    // 外层多包一层：失败原因要写在**图的下面**，不能塞进 overflow-hidden 的图片框里
                    <div key={it.id} className="space-y-1">
                        <div
                            className={`relative group rounded-lg overflow-hidden border-2 bg-muted transition-all ${
                                busy ? "cursor-wait" : "cursor-pointer"
                            } ${
                                checked
                                    ? "border-sky-500 ring-2 ring-sky-500/30"
                                    : activeId === it.id
                                        ? "border-primary"
                                        : "border-transparent hover:border-primary/40"
                            }`}
                            onClick={() => { if (!busy) onOpen(it); }}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={it.previewUrl}
                                alt=""
                                className={`w-full aspect-[3/4] object-cover ${dimmed ? "opacity-40 grayscale" : ""}`}
                            />

                            {/* 【custom-v28】左上角勾选框：只切换勾选，不触发缩略图本体的点击 */}
                            {selectable && (
                                <button
                                    type="button"
                                    className={`absolute top-1 left-1 h-5 w-5 rounded border-2 flex items-center justify-center transition-colors shadow-sm ${
                                        checked
                                            ? "bg-sky-500 border-sky-500 text-white"
                                            // 未选中用「半透明黑底 + 白边」：白底白边在浅色题目照片上会糊成一片看不见
                                            : "bg-black/35 border-white/90 text-transparent hover:bg-black/55"
                                    }`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (!busy) onToggleSelect?.(it.id);
                                    }}
                                    title={checked ? "取消选中" : "选中"}
                                >
                                    <Check className="h-3 w-3" />
                                </button>
                            )}

                            <button
                                className="absolute top-1 right-1 bg-black/60 text-white rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={(e) => { e.stopPropagation(); if (!busy) onRemove(it.id); }}
                                title="移除"
                            >
                                <Trash2 className="h-3 w-3" />
                            </button>
                            {it.status === "ready" && (
                                <span className="absolute bottom-1 left-1 bg-blue-600 text-white text-[10px] rounded px-1">
                                    待录
                                </span>
                            )}
                            {it.status === "saved" && (
                                <span className="absolute bottom-1 left-1 bg-green-600 text-white text-[10px] rounded px-1 flex items-center gap-0.5">
                                    <Check className="h-2.5 w-2.5" />已录
                                </span>
                            )}
                            {it.status === "error" && (
                                <span className="absolute bottom-1 left-1 bg-destructive text-white text-[10px] rounded px-1">
                                    AI 失败
                                </span>
                            )}
                            {dimmed && it.status === "pending" && (
                                <span className="absolute bottom-1 left-1 bg-gray-600 text-white text-[10px] rounded px-1">
                                    已处理
                                </span>
                            )}
                            {/* 【custom-v27】笔头：始终可见，点它进图片编辑器（点图本体是按状态分派） */}
                            <button
                                className="absolute bottom-1 right-1 bg-black/60 text-white rounded p-1 hover:bg-black/80 transition-colors"
                                onClick={(e) => { e.stopPropagation(); if (!busy) onEdit(it); }}
                                title="编辑图片"
                            >
                                {actionIcon}
                            </button>

                            {/*
                              【custom-v28】正在分析的那张：贴一条 3px 细进度条。
                              HTTP 拿不到服务端生成的真实百分比（AI 是一次性返回、不是流式），
                              所以这里做「不确定态」来回滚动，作用是指出**就是这张在跑**；
                              整体进度看列表上方的「3/6」。分析完成即消失。
                            */}
                            {running && (
                                <div className="absolute inset-x-0 bottom-0 h-[3px] bg-sky-500/25 overflow-hidden">
                                    <div className="batch-running-bar h-full w-1/3 bg-sky-500" />
                                </div>
                            )}
                        </div>

                        {/* 【custom-v28】失败原因写在这张图的下面 */}
                        {it.status === "error" && it.error && (
                            <p className="text-[10px] leading-tight text-destructive break-words px-0.5">
                                {humanizeAiError(it.error)}
                            </p>
                        )}
                    </div>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * 把 AI 抛出的英文错误码翻成一句人话，写在失败缩略图的下面。
 *
 * 不接 i18n：这行是**诊断信息**，保留原始错误码反而更利于排查；中文一句话
 * 只是为了让人一眼知道是「格式不对」还是「被限流」还是「网络不通」。
 */
function humanizeAiError(err: string): string {
    const e = err.toUpperCase();
    if (e.includes('MISSING CRITICAL XML') || e.includes('AI_RESPONSE_ERROR') || e.includes('ZOD')) {
        return 'AI 输出格式不完整（3 次都没通过）';
    }
    if (e.includes('TIMEOUT') || e.includes('408')) {
        return '超时（3 次都没通过）';
    }
    if (e.includes('QUOTA') || e.includes('429') || e.includes('RATE')) {
        return 'AI 接口限流（3 次都没通过）';
    }
    if (e.includes('AUTH') || e.includes('PERMISSION') || e.includes('401') || e.includes('403')) {
        return 'AI 密钥或权限有问题';
    }
    if (e.includes('NOT_FOUND') || e.includes('404')) {
        return '模型名不存在（检查 AI 配置）';
    }
    if (e.includes('CONNECTION') || e.includes('SERVICE_UNAVAILABLE') || e.includes('NETWORK')) {
        return '连不上 AI 服务（检查网络/代理）';
    }
    return err.slice(0, 80);
}
