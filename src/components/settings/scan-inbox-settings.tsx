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
 *
 * 【2026-10-24 空空】从一个目录改成**三个**：录错题 / 回录分析 / PDF 中转。
 * 三件事走的是同一套机制，但不该共用目录 —— 否则三条流水线会互相看见
 * 对方的照片，界面上就会出现"我扫的卷子怎么跑到回录里去了"。
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

/** 三种用途（与 `lib/scan-inbox.ts` 的 InboxKind 同义，这里只取名字和默认值） */
type InboxKind = "wrong" | "recover" | "pdf";

const KINDS: readonly InboxKind[] = ["wrong", "recover", "pdf"] as const;

/** 出厂默认名（沿用既有约定：老用户升级后不用做任何事） */
const DEFAULT_NAMES: Record<InboxKind, string> = {
    wrong: "scan2wrong",
    recover: "scan2recover",
    pdf: "scan2pdf",
};

interface ScanInboxSettingsProps {
    /** 三个槽位当前的值（保存前的临时值也在用） */
    dirs: Record<InboxKind, string>;
    onDirChange: (kind: InboxKind, value: string) => void;
}

export function ScanInboxSettings({ dirs, onDirChange }: ScanInboxSettingsProps) {
    const { t } = useLanguage();
    const s = t.settings?.general?.scanInbox || {};

    const [probing, setProbing] = useState<Record<InboxKind, boolean>>({
        wrong: false, recover: false, pdf: false,
    });
    const [probes, setProbes] = useState<Record<InboxKind, InboxProbe | null>>({
        wrong: null, recover: null, pdf: null,
    });
    const [probeErrors, setProbeErrors] = useState<Record<InboxKind, string | null>>({
        wrong: null, recover: null, pdf: null,
    });
    /** 底部"已有文件夹"点一下填到哪个框 —— 跟"最后碰过的那个"走 */
    const [active, setActive] = useState<InboxKind>("wrong");

    /**
     * 探测：带 subPath 参数是"试连接" —— 后端只读不落盘，
     * 所以用户改了输入框还没保存，也能先知道这个名字对不对、能不能读到。
     */
    const check = useCallback(async (kind: InboxKind, value: string) => {
        setProbing((p) => ({ ...p, [kind]: true }));
        setProbeErrors((e) => ({ ...e, [kind]: null }));
        try {
            const q = value.trim();
            const data = await apiClient.get<InboxProbe>(
                `/api/scan-inbox${q ? `?subPath=${encodeURIComponent(q)}` : ""}`,
            );
            setProbes((p) => ({ ...p, [kind]: data }));
        } catch (err) {
            setProbes((p) => ({ ...p, [kind]: null }));
            setProbeErrors((e) => ({
                ...e,
                [kind]: err instanceof Error ? err.message : String(err),
            }));
        } finally {
            setProbing((p) => ({ ...p, [kind]: false }));
        }
    }, []);

    // 打开设置对话框就先看一眼三个目录的状态，用户不用点也知道现在通不通。
    // 只在挂载时跑一次：跟着 dirs 走会变成"每敲一个字发一次请求"。
    useEffect(() => {
        // 空框跳过（见 renderStatus 里的说明：不带 subPath 的请求会落到录错题槽）
        for (const k of KINDS) {
            if (dirs[k]?.trim()) void check(k, dirs[k]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fill = (tpl: string | undefined, fallback: string, vars: Record<string, string>) => {
        let out = tpl || fallback;
        for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, v);
        return out;
    };

    const labelOf = (kind: InboxKind): string => {
        if (kind === "wrong") return s.dirWrong || "录错题";
        if (kind === "recover") return s.dirRecover || "回录分析";
        return s.dirPdf || "PDF 中转";
    };

    /**
     * 根目录是同一个，所以三个探测结果里的 folders 一模一样 ——
     * 取第一个拿到的就行，不必为了省一次请求去改后端。
     */
    const folders =
        KINDS.map((k) => probes[k]?.folders).find((f) => f && f.length > 0) || [];

    const renderStatus = (kind: InboxKind) => {
        /**
         * 【2026-10-24】空框**不发请求**，也不显示探测结果。
         *
         * 两个原因：
         *   ① 请求不带 `subPath` 时后端按"不传 ⇒ 录错题槽"处理，对「回录分析」
         *      和「PDF 中转」这两个框来说，探的根本不是它们自己的默认目录；
         *   ② 空目录名不是合法值，探测结果只会是误导。
         */
        if (!dirs[kind]?.trim()) {
            return (
                <span className="text-muted-foreground">
                    留空 = 用默认「{DEFAULT_NAMES[kind]}」
                </span>
            );
        }
        if (probing[kind]) {
            return <span className="text-muted-foreground">{s.checking || "检查中..."}</span>;
        }
        if (probeErrors[kind]) {
            return <span className="text-red-600">✗ {probeErrors[kind]}</span>;
        }
        const probe = probes[kind];
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
                    {KINDS.map((k) => probes[k]?.root).find(Boolean) || "—"}
                </code>
            </div>

            {KINDS.map((k) => probes[k]).some((p) => p && !p.configurable) ? (
                <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                    {s.legacy || "当前容器是按老方式挂载的，这个路径没法在这里改。"}
                </p>
            ) : (
                <div className="space-y-3">
                    {KINDS.map((kind) => (
                        <div key={kind} className="space-y-1">
                            <Label className="text-xs">{labelOf(kind)}</Label>
                            <Input
                                value={dirs[kind] ?? ""}
                                placeholder={DEFAULT_NAMES[kind]}
                                onFocus={() => setActive(kind)}
                                onChange={(e) => onDirChange(kind, e.target.value)}
                            />
                            <div className="text-xs">{renderStatus(kind)}</div>
                        </div>
                    ))}
                </div>
            )}

            {folders.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-muted-foreground">{s.existing || "已有文件夹："}</span>
                    {folders.map((f) => (
                        <button
                            key={f}
                            type="button"
                            onClick={() => onDirChange(active, f)}
                            className={`rounded border px-2 py-0.5 text-xs hover:bg-muted ${
                                f === dirs[active] ? "border-primary font-medium" : ""
                            }`}
                        >
                            {f}
                        </button>
                    ))}
                    <span className="text-[11px] text-muted-foreground">
                        （填给「{labelOf(active)}」）
                    </span>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={KINDS.some((k) => probing[k])}
                    onClick={() => {
                        for (const k of KINDS) {
                            if (dirs[k]?.trim()) void check(k, dirs[k]);
                        }
                    }}
                >
                    {KINDS.some((k) => probing[k])
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
