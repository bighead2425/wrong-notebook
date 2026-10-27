"use client";

/**
 * 「共享打印」的两个小窗：
 *   ① `PrintOptionsDialog` —— 四格设置（份数 / 单双面 / 纸型 / 页范围），记住上次；
 *   ② `PrintRouteDialog`   —— 出口选「本机 / 共享」时用（配置选了"每次询问"才弹）。
 *
 * 为什么共享打印必须先弹这一下：一张纸打错就是废纸，**双面/纸型**错了是整摞都废。
 * 所以这四项必须让能看见、能改；其余（色彩、送纸盒）交给打印机自己的默认值。
 */

import { useState } from "react";
import { Loader2, Printer, Monitor } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    DEFAULT_PRINT_OPTIONS,
    PRINT_OPTIONS_STORAGE_KEY,
    normalizePrintOptions,
    type PrintOptions,
    type PrintPaper,
    type PrintRoute,
} from "@/lib/print-route";

/** 读"上次怎么打的"。读不到/坏了就按当前幅面给默认值 */
export function readStoredPrintOptions(paper: PrintPaper): PrintOptions {
    if (typeof window === 'undefined') return { ...DEFAULT_PRINT_OPTIONS, paper };
    try {
        const raw = window.localStorage.getItem(PRINT_OPTIONS_STORAGE_KEY);
        return normalizePrintOptions(raw ? JSON.parse(raw) : null, paper);
    } catch {
        return { ...DEFAULT_PRINT_OPTIONS, paper };
    }
}

export function storePrintOptions(opts: PrintOptions): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(PRINT_OPTIONS_STORAGE_KEY, JSON.stringify(opts));
    } catch {
        /* 隐私模式下写不进去，不影响这次打印 */
    }
}

interface OptionsDialogProps {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    /** 当前幅面：第一次用时的默认纸型 */
    paper: PrintPaper;
    /** 这次要印几页（给用户一个"是不是印多了"的提示） */
    pageCount: number;
    busy: boolean;
    /** 已经送出去了：主按钮变成"完成"，别让同一份又打一遍 */
    done: boolean;
    status: string | null;
    error: string | null;
    onConfirm: (opts: PrintOptions) => void;
}

export function PrintOptionsDialog({
    open, onOpenChange, paper, pageCount, busy, done, status, error, onConfirm,
}: OptionsDialogProps) {
    /**
     * 初值 = 上次在这台设备上怎么打的。
     * ⚠️ **靠父组件"打开时才挂载"**（`{optionsOpen && <PrintOptionsDialog/>}`）来保证新鲜：
     *    每次打开都是新实例、重新读一次 localStorage，所以这里不需要 effect 去同步 ——
     *    在 effect 里 setState 会多一轮渲染，还会被 `react-hooks/set-state-in-effect` 拦下。
     */
    const [opts, setOpts] = useState<PrintOptions>(() => readStoredPrintOptions(paper));

    const patch = (p: Partial<PrintOptions>) => setOpts((prev) => ({ ...prev, ...p }));

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Printer className="h-4 w-4" />
                        送到共享打印机
                    </DialogTitle>
                    <DialogDescription>
                        这一份会先变成 PDF，再由 NAS 递给打印机。共 {pageCount} 页。
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">份数</Label>
                            <Input
                                type="number"
                                min={1}
                                max={99}
                                value={opts.copies}
                                disabled={busy || done}
                                onChange={(e) => patch({ copies: Number(e.target.value) || 1 })}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">单双面</Label>
                            <Select
                                value={opts.duplex}
                                disabled={busy || done}
                                onValueChange={(v) => patch({ duplex: v as PrintOptions['duplex'] })}
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="long">双面（长边翻转，像翻书）</SelectItem>
                                    <SelectItem value="none">单面</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">纸型</Label>
                            <Select
                                value={opts.paper}
                                disabled={busy || done}
                                onValueChange={(v) => patch({ paper: v as PrintPaper })}
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="B5">B5（182×257）</SelectItem>
                                    <SelectItem value="A4">A4（210×297）</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">页范围</Label>
                            <Select
                                value={opts.range}
                                disabled={busy || done}
                                onValueChange={(v) => patch({ range: v as PrintOptions['range'] })}
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">全部页</SelectItem>
                                    <SelectItem value="current">只印第一面</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <p className="text-xs text-muted-foreground">
                        纸型要和打印机里装的纸一致；双面会在同一张纸的背面接着印。
                    </p>

                    {busy && (
                        <p className="flex items-center gap-2 text-sm">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {status || '正在处理…'}
                        </p>
                    )}
                    {!busy && error && (
                        <p className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-700">
                            {error}
                        </p>
                    )}
                    {!busy && !error && status && (
                        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-700">
                            {status}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                        {done ? "关闭" : "取消"}
                    </Button>
                    <Button
                        onClick={() => {
                            if (done) {
                                onOpenChange(false);
                                return;
                            }
                            storePrintOptions(opts);
                            onConfirm(opts);
                        }}
                        disabled={busy}
                    >
                        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}
                        {done ? "完成" : "开始打印"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

interface RouteDialogProps {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    onPick: (route: Exclude<PrintRoute, 'ask'>, remember: boolean) => void;
}

/**
 * 「每次询问」时的选择窗。
 * 用两个大按钮而不是下拉：这个窗口只出现几秒，目标是"一眼点中"。
 */
export function PrintRouteDialog({ open, onOpenChange, onPick }: RouteDialogProps) {
    /* 同样是"打开时才挂载"⇒ 每次都是新实例，勾选状态天然从 false 开始 */
    const [remember, setRemember] = useState(false);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>这次在哪里打印？</DialogTitle>
                    <DialogDescription>
                        本机会弹出浏览器打印窗口；共享会直接送到 NAS 上那台打印机。
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-2 py-2">
                    <Button
                        variant="outline"
                        className="h-auto w-full justify-start gap-3 py-3"
                        onClick={() => onPick('local', remember)}
                    >
                        <Monitor className="h-5 w-5" />
                        <span className="text-left">
                            <span className="block">本机打印</span>
                            <span className="block text-xs text-muted-foreground">用这台设备的打印对话框（手机上会存成 PDF）</span>
                        </span>
                    </Button>
                    <Button
                        variant="outline"
                        className="h-auto w-full justify-start gap-3 py-3"
                        onClick={() => onPick('shared', remember)}
                    >
                        <Printer className="h-5 w-5" />
                        <span className="text-left">
                            <span className="block">共享打印机</span>
                            <span className="block text-xs text-muted-foreground">送到家里的 Brother，直接出纸</span>
                        </span>
                    </Button>
                </div>

                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                        className="h-4 w-4"
                    />
                    以后这台设备都这样（可在设置里改回来）
                </label>
            </DialogContent>
        </Dialog>
    );
}
