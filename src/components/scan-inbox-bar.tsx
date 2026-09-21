"use client";

/**
 * 【custom-v29】扫描收件箱 —— 批量上传页上的「外部照片入口」
 *
 * 背景：手机上用夸克扫描王之类的 App 拍完，用「分享 → 飞牛」丢进 NAS 的固定目录
 * （目前是 /vol2/1000/scan2wrong，容器里挂成 /app/scan2wrong）。以前这些照片
 * 还得再回相册里一张张找、一张张选；现在页面上直接多一条：
 *
 *   📥 收到 N 张新照片        —— 一键把没导过的照片拉进「待处理」
 *   📂 打开收件箱（共 M 张）   —— 看全部照片（含导过的旧照片），可勾选重导 / 删掉清理
 *
 * 两个动作刻意分开，是为了同时满足两件事：
 *   ① 日常最常用的就是「刚扫完的几张，直接进来」——一步到位，不用先进目录再挑；
 *   ② 「旧照片还要再拉一遍」的活口必须留着 —— 目录里导过的照片**不会自动消失**，
 *      任何时候都能从面板里勾回来重导，也可以一次性删掉清场。
 *
 * 【custom-v33】收件箱现在有**四条进图通道**，面板里补上唯一缺的那条：
 *   ① 手机 App 分享（夸克扫描王 → 飞牛）   —— 原本就有，工作流的主体
 *   ② 在 NAS 上直接把文件贴进目录          —— 原本就有
 *   ③ 连拍转存（拍一张存一张，见 batch-pipeline 的 handleBurstShot）
 *   ④ **在本面板顶部「从本机选照片传进收件箱」**（custom-v33 新增）：手机弹相册、
 *      电脑弹文件夹，可一次多选，逐张传到收件箱，走的是和 ③ 同一个接口。
 *      ④ 的意义是不必绕手机 App —— 电脑上已有的图、别人微信发来的图，都能直接进来。
 *
 * 目录没挂载怎么办：后端返回 available=false，这里**整条都不渲染**。
 * 与其摆一个点了报错的按钮，不如让它安静地不存在。
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { Check, Download, FolderOpen, ImageUp, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { InboxImageViewer } from "@/components/inbox-image-viewer";

interface InboxFile {
    name: string;
    size: number;
    mtimeMs: number;
    imported: boolean;
    /** 【custom-v33】逆时针累计角度（0/90/180/270）—— 缩略图也照它转，两边显示一致 */
    rotation: number;
}

interface InboxListing {
    available: boolean;
    path: string;
    files: InboxFile[];
    ignored: number;
    reason?: string;
}

interface ScanInboxBarProps {
    /** 当前这一批里已有哪些文件名 —— 用来避免同一张照片重复进队列 */
    existingNames: string[];
    /**
     * 拉到的照片交给上层（走现成的 addFiles 流程落进「待处理」）。
     *
     * @returns 真正进了队列的文件名。可能比传入的少（一批最多 30 张），
     *          少掉的那些**不能**记为"已导入"，否则它们就从「收到 N 张新照片」里消失了。
     */
    onImport: (files: File[]) => string[];
    /** 正在送 AI / 加工时锁住操作，别在这时候往队列里塞东西 */
    busy?: boolean;
    /**
     * 【custom-v31】把「收件箱到底能不能用」告诉上层。
     *
     * 上层（连续拍摄）要靠它决定照片的落点：能用就转存进收件箱（拍摄与加工之间留个断点），
     * 不能用就退回老行为直接进待处理 —— 绝不能让照片没地方去。
     * 本组件探测完就上报一次，没有挂载时会报 false。
     */
    onAvailability?: (available: boolean) => void;
    /**
     * 【custom-v31】刷新信号：数字一变就重新读一遍目录。
     * 连拍转存完照片后，上层把它 +1，「收到 N 张新照片」立刻跟着变。
     */
    refreshToken?: number;
}

/** 2582314 → "2.5 MB" */
function humanSize(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(n / 1024)} KB`;
}

export function ScanInboxBar({
    existingNames,
    onImport,
    busy,
    onAvailability,
    refreshToken = 0,
}: ScanInboxBarProps) {
    const { t } = useLanguage();
    const s = t.common.batch?.inbox || {};

    const [listing, setListing] = useState<InboxListing | null>(null);
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [working, setWorking] = useState(false);
    /** 逐张下载的进度（几十张串行下载要等一会儿，光转圈会让人以为卡死） */
    const [pulling, setPulling] = useState<{ i: number; n: number } | null>(null);

    /* ===== 【custom-v33】从本机传入收件箱 ===== */
    const uploadInputRef = useRef<HTMLInputElement>(null);
    /** 逐张上传的进度（同一条理由：几十张串行上传，得让人看见在动） */
    const [uploading, setUploading] = useState<{ i: number; n: number } | null>(null);
    /** 刚传完的交代 —— 手机上列表在下面，传完不一定看得见变化，给一句结果 */
    const [uploadedNote, setUploadedNote] = useState<{ ok: number; bad: number } | null>(null);

    /**
     * 【custom-v33】预览页正在看第几张；null = 没开。
     *
     * 索引由本组件持有（而不是预览页自己记）：删除照片后列表会重读、数组会变短，
     * "当前看的是谁"必须交给一个知道列表全貌的地方来收敛。
     */
    const [viewerIndex, setViewerIndex] = useState<number | null>(null);

    /**
     * 预览页改了属性（旋转方向 / 是否已录入）→ 就地更新这一条。
     *
     * 为什么乐观更新而不是等服务端回话再重读整份列表：重读会换掉 files 数组的引用，
     * 整个网格重渲染、缩略图重新请求，转一下抖一下很难受。就地改一条最平滑；
     * 预览页那边若保存失败，会在关闭时调 onReload 把真实状态拉回来。
     */
    const patchFile = useCallback((name: string, patch: Partial<InboxFile>) => {
        setListing(prev => (prev
            ? { ...prev, files: prev.files.map(f => (f.name === name ? { ...f, ...patch } : f)) }
            : prev));
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiClient.get<InboxListing>("/api/scan-inbox");
            setListing(data);
            const fresh = data.files.filter(f => !f.imported).map(f => f.name);
            setSelected(new Set(fresh));
        } catch {
            // 探测失败就当没挂在这个目录 —— 不要弹错误打扰用户
            setListing({ available: false, path: "", files: [], ignored: 0 });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load, refreshToken]);

    /** 【custom-v31】探测完就把"能不能用"报上去（上层据此决定连拍照片往哪落） */
    useEffect(() => {
        if (!listing) return;
        onAvailability?.(listing.available);
    }, [listing, onAvailability]);

    // 目录没挂载时整条都不出现（同样也适用于没有 files 的极端情况）
    if (!listing || !listing.available) return null;

    const inQueue = new Set(existingNames);
    /** 「新」= 既没导过、也不在当批队列里的（防止误把同名的重复塞进来） */
    const newFiles = listing.files.filter(f => !f.imported && !inQueue.has(f.name));
    const files = listing.files;

    const fileUrl = (name: string) => `/api/scan-inbox/file?name=${encodeURIComponent(name)}`;

    /** 把一批照片从 NAS 拉下来 → 包成 File → 交给上层 → 按上层回传的名单记台账 */
    const doImport = async (names: string[]) => {
        if (!names.length) return;
        setWorking(true);
        try {
            const pulled: File[] = [];
            const missed: string[] = [];
            for (let i = 0; i < names.length; i++) {
                setPulling({ i: i + 1, n: names.length });
                try {
                    const res = await fetch(fileUrl(names[i]));
                    if (!res.ok) { missed.push(names[i]); continue; }
                    const blob = await res.blob();
                    pulled.push(new File([blob], names[i], { type: blob.type || "image/jpeg" }));
                } catch {
                    missed.push(names[i]);
                }
            }
            if (!pulled.length) {
                alert(s.pullFailed || "一张都没读到，照片可能已被别的工具删掉了");
                await load();
                return;
            }

            // 先交给上层（addFiles 有"一批最多 30 张"的上限，会回传真正进队列的名单），
            // **只把进队列的记为"已导入"**：被上限截掉的那几张下次仍会出现在「新照片」里，
            // 否则它们会从"新照片"里消失，用户只能去面板的"已导入"堆里翻。
            const accepted = onImport(pulled);
            const acceptedSet = new Set(accepted);
            const rejected = pulled.filter(f => !acceptedSet.has(f.name));

            if (accepted.length) {
                // 必须**显式**写 imported: true —— 接口的规矩是"没提到的字段一概不动"
                // （见 lib/scan-inbox 的 setInboxMeta）。这里就是要标记已导入，只传 names 是不够的。
                await apiClient.post<{ ok: boolean }, { names: string[]; imported: boolean }>(
                    "/api/scan-inbox",
                    { names: accepted, imported: true },
                ).catch(() => undefined);
            }

            setSelected(new Set());
            setOpen(false);
            await load();

            if (missed.length) {
                alert((s.pullPartial || "有 {n} 张没读到，可能已被其它工具删掉").replace("{n}", String(missed.length)));
            } else if (rejected.length) {
                alert((s.queueFull || "这一批已经放不下 {n} 张了，它们还在收件箱里，下一批再导就行")
                    .replace("{n}", String(rejected.length)));
            }
        } finally {
            setPulling(null);
            setWorking(false);
        }
    };

    const doDelete = async (names: string[]) => {
        if (!names.length) return;
        const msg = (s.deleteConfirm || "确定要从收件箱里删掉这 {n} 张照片吗？删了就找不回来了。")
            .replace("{n}", String(names.length));
        if (!confirm(msg)) return;
        setWorking(true);
        try {
            const res = await fetch("/api/scan-inbox", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ names }),
            });
            const data = res.ok ? await res.json().catch(() => null) : null;
            /**
             * 【为什么必须看返回】
             * 删文件是会失败的（NAS 权限、文件被别的 App 占用、目录被卸载）。
             * 原先不管成功失败都刷新列表 —— 删不掉的还好好躺在那儿，
             * 用户以为删干净了，回头发现"怎么又冒出来"。
             */
            if (!data) {
                alert(s.deleteFailed || "删除失败，请稍后再试");
            } else if (Array.isArray(data.failed) && data.failed.length) {
                alert((s.deletePartial || "有 {n} 张没删掉（可能没有权限）").replace("{n}", String(data.failed.length)));
            }
            setSelected(new Set());
            await load();
        } finally {
            setWorking(false);
        }
    };

    /**
     * 【custom-v33】把**本机**的照片传进收件箱（手机相册 / 电脑文件夹）。
     *
     * 走的是连拍转存用的同一个接口（POST /api/scan-inbox/upload），所以安全闸完全一致：
     * 必须是登录用户、文件名由服务端生成、文件头必须是真图片、单张有上限、
     * 目标目录 realpath 必须在挂载根之下。这里只负责挑文件、逐张传、报进度。
     *
     * 为什么逐张串行：一次几十张并发挤上去，局域网的 NAS 未必舒服，
     * 进度也没法显示成「i/n」——用户只会看到"所有条一起转"。
     *
     * 传完是**留在收件箱里**（状态是「新」），不直接进待处理 —— 收件箱是暂存区，
     * 什么时候拉进流水线由用户在下面勾选决定，和从夸克分享进来的一视同仁。
     */
    const doUpload = async (files: File[]) => {
        // 同一个文件选择框既可能选到图、也可能选到别的东西（尤其电脑端）
        const imgs = files.filter(f => f.type.startsWith("image/"));
        if (imgs.length < files.length) {
            alert(s.uploadNotImage || "只能传图片（JPG / PNG / WebP），其它文件已忽略");
        }
        if (!imgs.length) return;

        setWorking(true);
        setUploadedNote(null);
        let ok = 0;
        let bad = 0;
        try {
            for (let i = 0; i < imgs.length; i++) {
                setUploading({ i: i + 1, n: imgs.length });
                try {
                    const fd = new FormData();
                    fd.append("file", imgs[i], imgs[i].name);
                    const res = await fetch("/api/scan-inbox/upload", { method: "POST", body: fd });
                    const data = res.ok ? await res.json().catch(() => null) : null;
                    if (data?.ok) ok++;
                    else bad++;
                } catch {
                    bad++;
                }
            }
        } finally {
            setUploading(null);
            setWorking(false);
        }

        setUploadedNote({ ok, bad });
        // 传完重新读一遍目录：新传上来的会带着「新」的角标出现在下面，并可点「导入选中的」
        await load();
    };

    const toggle = (name: string) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
    });

    const selectedNames = files.filter(f => selected.has(f.name)).map(f => f.name);
    const disabled = busy || working || loading;

    return (
        <>
            <div className="space-y-2">
                {/* 【custom-v32】这两个按钮按首页那四个（批量上传 / 查看题册 / 标签管理 / 统计中心）
                    的尺寸来：h-11 + text-sm + 16px 简笔画。原先又大一圈、还同时挂了 emoji 和简笔画
                    （emoji 已从文案里去掉，只留简笔画）。
                    【custom-v34】宽度改为"按内容自适应 + 左右内边距"，不再 flex-1 撑满：
                    原来第一个按钮 flex-1 会一直撑到容器右边缘，第二个按钮就被挤到下一行、
                    或者两者之间空出一大截。现在两个都是内容宽度，窄屏也尽量并在同一行
                    （flex-wrap 兜底，实在放不下才换行）。 */}
                <div className="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        disabled={disabled || newFiles.length === 0}
                        onClick={() => doImport(newFiles.map(f => f.name))}
                        className="h-11 text-sm px-4 flex items-center justify-center gap-2 rounded-md border border-dashed border-primary/60 font-medium text-primary shadow-sm transition-all hover:bg-primary/5 hover:shadow-md disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:shadow-sm"
                    >
                        {working
                            ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                            : <Download className="h-4 w-4 shrink-0" />}
                        <span className="truncate">
                            {pulling
                                ? (s.pulling || "正在拉取 {i}/{n} 张…")
                                    .replace("{i}", String(pulling.i))
                                    .replace("{n}", String(pulling.n))
                                : newFiles.length > 0
                                    ? (s.quick || "收到 {n} 张新照片").replace("{n}", String(newFiles.length))
                                    : (s.quickNone || "收件箱暂无新照片")}
                        </span>
                    </button>
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => { load(); setOpen(true); }}
                        className="h-11 text-sm flex items-center justify-center gap-2 rounded-md border bg-background px-4 font-medium text-muted-foreground shadow-sm transition-all hover:border-primary/50 hover:bg-accent/40 hover:text-foreground hover:shadow-md disabled:opacity-50"
                    >
                        <FolderOpen className="h-4 w-4 shrink-0" />
                        <span className="truncate">{(s.open || "打开收件箱（{n}）").replace("{n}", String(files.length))}</span>
                    </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                    {s.hint || "手机 App（夸克扫描王等）分享进来的、以及在本页直接传上来的照片，都会落进这个文件夹"}
                </p>
            </div>

            <Dialog open={open} onOpenChange={(v) => { if (!working) setOpen(v); }}>
                <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{s.title || "扫描收件箱"}</DialogTitle>
                        <DialogDescription>
                            {(s.desc || "这里的照片不会被自动删掉，导过的随时能重导；不需要了手动删掉清场。")
                                .replace("{n}", String(files.length))}
                        </DialogDescription>
                    </DialogHeader>

                    {/* 【custom-v33】收件箱面板顶部的「输入」入口 —— 补上第四条进图通道。
                        同一个 input 两端通吃：`accept="image/*"` + `multiple` 让手机弹相册、
                        电脑弹文件夹、可一次多选。**故意不加 `capture`** —— 加了会强制开摄像头，
                        在手机上是"拍一张"，反而打不开相册。 */}
                    <div className="flex items-center gap-3 flex-wrap">
                        <Button
                            variant="outline"
                            className="h-9 shadow-xs hover:border-primary/50"
                            disabled={disabled}
                            onClick={() => { setUploadedNote(null); uploadInputRef.current?.click(); }}
                        >
                            {uploading
                                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                : <ImageUp className="mr-2 h-4 w-4" />}
                            {uploading
                                ? (s.uploading || "正在传入 {i}/{n} 张…")
                                    .replace("{i}", String(uploading.i))
                                    .replace("{n}", String(uploading.n))
                                : (s.uploadBtn || "从本机选照片传进收件箱")}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            {s.uploadHint || "手机上打开相册、电脑上打开文件夹，可一次多选"}
                        </span>
                        {uploadedNote && !uploading && (
                            <span className={`text-xs ${uploadedNote.bad ? "text-amber-600" : "text-green-600"}`}>
                                {uploadedNote.bad
                                    ? (s.uploadPartial || "已传入 {ok} 张，{bad} 张没传上去")
                                        .replace("{ok}", String(uploadedNote.ok))
                                        .replace("{bad}", String(uploadedNote.bad))
                                    : (s.uploadDone || "已传入 {n} 张，可在下面勾选导入")
                                        .replace("{n}", String(uploadedNote.ok))}
                            </span>
                        )}
                        <input
                            ref={uploadInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                                const picked = Array.from(e.target.files || []);
                                e.target.value = ""; // 允许重复选同一批
                                if (picked.length) doUpload(picked);
                            }}
                        />
                    </div>

                    <div className="flex items-center gap-2 flex-wrap text-xs">
                        <span className="text-muted-foreground">
                            {(s.total || "共 {n} 张").replace("{n}", String(files.length))}
                        </span>
                        {newFiles.length > 0 && (
                            <span className="text-primary font-medium">
                                {(s.totalNew || "其中 {n} 张是新的").replace("{n}", String(newFiles.length))}
                            </span>
                        )}
                        {listing.ignored > 0 && (
                            <span className="text-amber-600">
                                {(s.ignored || "另有 {n} 个非图片文件已忽略").replace("{n}", String(listing.ignored))}
                            </span>
                        )}
                        <div className="ml-auto flex items-center gap-1.5">
                            <Button variant="outline" size="sm" className="h-7 px-2 text-xs"
                                disabled={disabled}
                                onClick={() => setSelected(new Set(files.map(f => f.name)))}>
                                {s.selectAll || "全选"}
                            </Button>
                            <Button variant="outline" size="sm" className="h-7 px-2 text-xs"
                                disabled={disabled}
                                onClick={() => setSelected(new Set(newFiles.map(f => f.name)))}>
                                {s.selectNew || "只看新的"}
                            </Button>
                            {/* 「只看已导入的」= 清理快捷键：照片越攒越多时，
                                一键把导过的旧照片全勾上、然后删掉清场 */}
                            <Button variant="outline" size="sm" className="h-7 px-2 text-xs"
                                disabled={disabled}
                                onClick={() => setSelected(new Set(
                                    files.filter(f => f.imported).map(f => f.name),
                                ))}>
                                {s.selectImported || "只看已导入的"}
                            </Button>
                            <Button variant="outline" size="sm" className="h-7 px-2 text-xs"
                                disabled={disabled || selected.size === 0}
                                onClick={() => setSelected(new Set())}>
                                {s.selectClear || "清除"}
                            </Button>
                            <Button variant="outline" size="sm" className="h-7 px-2 text-xs"
                                disabled={disabled} onClick={load}>
                                <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
                            </Button>
                        </div>
                    </div>

                    {files.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-8">
                            {s.empty || "收件箱是空的 —— 用手机 App 把照片分享进这个文件夹试试"}
                        </p>
                    ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                            {files.map((f, i) => {
                                const checked = selected.has(f.name);
                                /** 转过 90°/270° 的图，长宽是对调的 —— 缩略图约束得跟着换 */
                                const turned = f.rotation % 180 !== 0;
                                return (
                                    <div key={f.name} className="space-y-1">
                                        <div
                                            className={`relative rounded-lg overflow-hidden border-2 bg-muted transition-all ${
                                                checked ? "border-sky-500 ring-2 ring-sky-500/30" : "border-transparent hover:border-primary/40"
                                            }`}
                                        >
                                            {/* 点图片 = 看大图。选和看是两种意图，拆开（见文件头注释） */}
                                            <div
                                                className="w-full aspect-[3/4] flex items-center justify-center cursor-zoom-in"
                                                onClick={() => { if (!disabled) setViewerIndex(i); }}
                                                title={s.viewerOpenHint || "点击查看大图"}
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                    src={fileUrl(f.name)}
                                                    alt={f.name}
                                                    loading="lazy"
                                                    draggable={false}
                                                    style={{
                                                        transform: `rotate(${f.rotation}deg)`,
                                                        // 容器固定 3:4（宽:高）。转 90° 后要让"宽"受容器**高**约束、
                                                        // "高"受容器**宽**约束，所以两个上限正好互换（4/3 与 3/4）。
                                                        // 不换的话，竖图转横以后会被裁掉左右两条。
                                                        ...(turned
                                                            ? { maxWidth: "133.333%", maxHeight: "75%" }
                                                            : { maxWidth: "100%", maxHeight: "100%" }),
                                                        minWidth: 0,
                                                        minHeight: 0,
                                                    }}
                                                />
                                            </div>
                                            {/* 左上角方框 = 只管选中 */}
                                            <button
                                                type="button"
                                                className={`absolute top-1 left-1 h-5 w-5 rounded border-2 flex items-center justify-center shadow-sm ${
                                                    checked
                                                        ? "bg-sky-500 border-sky-500 text-white"
                                                        : "bg-black/35 border-white/90 text-transparent"
                                                }`}
                                                onClick={(e) => { e.stopPropagation(); if (!disabled) toggle(f.name); }}
                                                title={checked
                                                    ? (s.viewerUnselect || "取消选中")
                                                    : (s.viewerSelect || "选中")}
                                            >
                                                <Check className="h-3 w-3" />
                                            </button>
                                            {inQueue.has(f.name) ? (
                                                <span className="absolute bottom-1 left-1 bg-teal-600 text-white text-[10px] rounded px-1">
                                                    {s.badgeQueued || "已在队列"}
                                                </span>
                                            ) : f.imported ? (
                                                <span className="absolute bottom-1 left-1 bg-gray-700 text-white text-[10px] rounded px-1">
                                                    {s.badgeImported || "已导入"}
                                                </span>
                                            ) : (
                                                <span className="absolute bottom-1 left-1 bg-sky-600 text-white text-[10px] rounded px-1">
                                                    {s.badgeNew || "新"}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[10px] text-muted-foreground truncate px-0.5" title={f.name}>
                                            {f.name}
                                        </p>
                                        <p className="text-[10px] text-muted-foreground px-0.5">{humanSize(f.size)}</p>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <DialogFooter className="gap-2 sm:gap-2">
                        <span className="mr-auto text-xs text-muted-foreground self-center">
                            {pulling
                                ? (s.pulling || "正在拉取 {i}/{n} 张…")
                                    .replace("{i}", String(pulling.i))
                                    .replace("{n}", String(pulling.n))
                                : (s.selectedCount || "已选 {n} 张").replace("{n}", String(selectedNames.length))}
                        </span>
                        <Button
                            variant="outline"
                            disabled={disabled || selectedNames.length === 0}
                            onClick={() => doDelete(selectedNames)}
                        >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {(s.deleteBtn || "删除选中的 {n} 张").replace("{n}", String(selectedNames.length))}
                        </Button>
                        <Button
                            disabled={disabled || selectedNames.length === 0}
                            onClick={() => doImport(selectedNames)}
                        >
                            <Download className="mr-2 h-4 w-4" />
                            {(s.importBtn || "导入选中的 {n} 张").replace("{n}", String(selectedNames.length))}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 【custom-v33】照片预览页：整屏看大图、转方向、改状态、下载、删除。
                它挂在收件箱对话框**外面** —— 两个 Dialog 各自独立，关掉预览页
                仍然回到收件箱，而不是把收件箱一起带走。 */}
            {viewerIndex !== null && (
                <InboxImageViewer
                    open
                    files={files}
                    index={viewerIndex}
                    onIndexChange={setViewerIndex}
                    selected={selected}
                    onToggleSelect={toggle}
                    inQueue={inQueue}
                    onMetaChange={patchFile}
                    onReload={load}
                    onClose={() => setViewerIndex(null)}
                />
            )}
        </>
    );
}
