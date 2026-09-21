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
 * 目录没挂载怎么办：后端返回 available=false，这里**整条都不渲染**。
 * 与其摆一个点了报错的按钮，不如让它安静地不存在。
 */

import { useState, useEffect, useCallback } from "react";
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
import { Check, Download, FolderOpen, Loader2, RefreshCw, Trash2 } from "lucide-react";

interface InboxFile {
    name: string;
    size: number;
    mtimeMs: number;
    imported: boolean;
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
                await apiClient.post<{ ok: boolean }, { names: string[] }>("/api/scan-inbox", {
                    names: accepted,
                }).catch(() => undefined);
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
                <div className="flex items-center gap-2 flex-wrap">
                    <button
                        type="button"
                        disabled={disabled || newFiles.length === 0}
                        onClick={() => doImport(newFiles.map(f => f.name))}
                        className="flex-1 min-w-[220px] flex items-center justify-center gap-2 rounded-xl border border-dashed py-3 text-sm font-medium transition-colors disabled:opacity-50 border-primary/60 text-primary hover:bg-primary/5 disabled:hover:bg-transparent"
                    >
                        {working
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Download className="h-4 w-4" />}
                        {pulling
                            ? (s.pulling || "正在拉取 {i}/{n} 张…")
                                .replace("{i}", String(pulling.i))
                                .replace("{n}", String(pulling.n))
                            : newFiles.length > 0
                                ? (s.quick || "📥 收到 {n} 张新照片").replace("{n}", String(newFiles.length))
                                : (s.quickNone || "收件箱暂无新照片")}
                    </button>
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => { load(); setOpen(true); }}
                        className="flex items-center justify-center gap-2 rounded-xl border py-3 px-4 text-sm font-medium text-muted-foreground hover:bg-accent/40 transition-colors disabled:opacity-50"
                    >
                        <FolderOpen className="h-4 w-4" />
                        {(s.open || "打开收件箱（{n}）").replace("{n}", String(files.length))}
                    </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                    {s.hint || "手机 App（夸克扫描王等）分享到飞牛的照片会落在这里"}
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
                            {files.map(f => {
                                const checked = selected.has(f.name);
                                return (
                                    <div key={f.name} className="space-y-1">
                                        <div
                                            className={`relative rounded-lg overflow-hidden border-2 bg-muted cursor-pointer transition-all ${
                                                checked ? "border-sky-500 ring-2 ring-sky-500/30" : "border-transparent hover:border-primary/40"
                                            }`}
                                            onClick={() => { if (!disabled) toggle(f.name); }}
                                        >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={fileUrl(f.name)}
                                                alt={f.name}
                                                loading="lazy"
                                                className="w-full aspect-[3/4] object-cover"
                                            />
                                            <button
                                                type="button"
                                                className={`absolute top-1 left-1 h-5 w-5 rounded border-2 flex items-center justify-center shadow-sm ${
                                                    checked
                                                        ? "bg-sky-500 border-sky-500 text-white"
                                                        : "bg-black/35 border-white/90 text-transparent"
                                                }`}
                                                onClick={(e) => { e.stopPropagation(); if (!disabled) toggle(f.name); }}
                                                title={checked ? "取消选中" : "选中"}
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
        </>
    );
}
