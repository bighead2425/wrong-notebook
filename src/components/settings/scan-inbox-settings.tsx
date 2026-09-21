"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";

/**
 * 【custom-v30】设置 → 通用 → 转存文件夹
 *
 * 为什么要有这一块：手机（夸克扫描王等）分享到 NAS 的照片要靠容器去读，
 * 而 Docker 的挂载必须在启动时定死。所以这里**不**让用户去改挂载点，
 * 只让他改"根目录下的哪个子文件夹" —— 根目录只需在 compose 里挂一次，
 * 之后换目录就在这个框里改，存盘即生效、不用重建容器。
 */
interface InboxProbe {
    available: boolean;
    status: "ok" | "no-root" | "no-subdir" | "invalid" | "error";
    dir: string;
    root: string;
    subPath: string;
    configurable: boolean;
    folders: string[];
    files: { name: string; imported: boolean }[];
    ignored: number;
    reason?: string;
}

interface ScanInboxSettingsProps {
    /** 当前配置里的子路径（保存前的临时值也在用） */
    subPath: string;
    onSubPathChange: (value: string) => void;
}

export function ScanInboxSettings({ subPath, onSubPathChange }: ScanInboxSettingsProps) {
    const { t } = useLanguage();
    const s = t.settings?.general?.scanInbox || {};

    const [probing, setProbing] = useState(false);
    const [probe, setProbe] = useState<InboxProbe | null>(null);
    const [probeError, setProbeError] = useState<string | null>(null);

    /**
     * 探测：带 subPath 参数是"试连接" —— 后端只读不落盘，
     * 所以用户改了输入框还没保存，也能先知道这个名字对不对、能不能读到。
     */
    const check = useCallback(async (value: string) => {
        setProbing(true);
        setProbeError(null);
        try {
            const q = value.trim();
            const data = await apiClient.get<InboxProbe>(
                `/api/scan-inbox${q ? `?subPath=${encodeURIComponent(q)}` : ""}`,
            );
            setProbe(data);
        } catch (err) {
            setProbe(null);
            setProbeError(err instanceof Error ? err.message : String(err));
        } finally {
            setProbing(false);
        }
    }, []);

    // 打开设置对话框就先看一眼当前状态，用户不用点也知道现在通不通。
    // 只在挂载时跑一次：跟着 subPath 走会变成"每敲一个字发一次请求"。
    useEffect(() => {
        void check(subPath);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fill = (tpl: string | undefined, fallback: string, vars: Record<string, string>) => {
        let out = tpl || fallback;
        for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, v);
        return out;
    };

    const renderStatus = () => {
        if (probing) return <span className="text-muted-foreground">{s.checking || "检查中..."}</span>;
        if (probeError) return <span className="text-red-600">✗ {probeError}</span>;
        if (!probe) return <span className="text-muted-foreground">—</span>;

        switch (probe.status) {
            case "ok": {
                const news = probe.files.filter((f) => !f.imported).length;
                if (!probe.files.length) {
                    return <span className="text-green-600">✓ {s.okEmpty || "可以访问 —— 文件夹是空的"}</span>;
                }
                return (
                    <span className="text-green-600">
                        ✓ {fill(s.okCount, "可以访问 —— 共 {n} 张照片，其中 {m} 张是新的", {
                            n: String(probe.files.length),
                            m: String(news),
                        })}
                    </span>
                );
            }
            case "no-root":
                return (
                    <span className="text-amber-600">
                        ✗ {fill(s.noRoot, "容器里看不到 {root}。", { root: probe.root })}
                    </span>
                );
            case "no-subdir":
                return (
                    <span className="text-amber-600">
                        ✗ {fill(s.noSubdir, "子文件夹「{sub}」还不存在。", { sub: probe.subPath })}
                    </span>
                );
            case "invalid":
                return <span className="text-red-600">✗ {s.invalid || "名称不合法"}</span>;
            default:
                return (
                    <span className="text-red-600">
                        ✗ {fill(s.readError, "读不到这个文件夹：{reason}", { reason: probe.reason || "" })}
                    </span>
                );
        }
    };

    return (
        <div className="space-y-3 pt-4 border-t">
            <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4" />
                <Label>{s.title || "转存文件夹"}</Label>
            </div>
            <p className="text-xs text-muted-foreground">
                {s.desc || "手机 App 分享过来的照片会存在 NAS 的这个文件夹里，错题本从它读取。"}
            </p>

            <div className="space-y-1">
                <div className="text-xs text-muted-foreground">{s.rootLabel || "挂载根目录（由 Docker 决定，不可改）"}</div>
                <code className="block rounded bg-muted px-2 py-1 text-xs break-all">
                    {probe?.root || "—"}
                </code>
            </div>

            {probe && !probe.configurable ? (
                <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                    {s.legacy || "当前容器是按老方式挂载的，这个路径没法在这里改。"}
                </p>
            ) : (
                <div className="space-y-1">
                    <Label className="text-xs">{s.subLabel || "子文件夹"}</Label>
                    <Input
                        value={subPath}
                        placeholder={s.subPlaceholder || "scan2wrong"}
                        onChange={(e) => onSubPathChange(e.target.value)}
                    />
                    {probe && probe.folders.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1 pt-1">
                            <span className="text-xs text-muted-foreground">{s.existing || "已有文件夹："}</span>
                            {probe.folders.map((f) => (
                                <button
                                    key={f}
                                    type="button"
                                    onClick={() => onSubPathChange(f)}
                                    className={`rounded border px-2 py-0.5 text-xs hover:bg-muted ${
                                        f === subPath ? "border-primary font-medium" : ""
                                    }`}
                                >
                                    {f}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="space-y-1 rounded border bg-background p-2">
                <div className="text-xs break-all">
                    <span className="text-muted-foreground">{s.actualPath || "实际读取"}：</span>
                    <code>{probe?.dir || "—"}</code>
                </div>
                <div className="text-xs">{renderStatus()}</div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={probing}
                    onClick={() => void check(subPath)}
                >
                    {probing
                        ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                    {s.check || "检查连接"}
                </Button>
                <span className="text-xs text-muted-foreground">
                    {s.hint || "改完保存即刻生效，不用重建容器。文件夹本身要先在 NAS 上建好。"}
                </span>
            </div>
        </div>
    );
}
