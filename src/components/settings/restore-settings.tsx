"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, FolderOpen, Loader2, RotateCcw, Upload } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { RESTORE_CONFIRM_WORD, SUMMARY_LABELS, type RestorePlan } from "@/lib/restore-types";

type Phase = "idle" | "uploading" | "review" | "applying" | "restarting";

interface LocalFile {
    name: string;
    size: number;
    mtime: string;
}

/** 统一把"接口报错"翻成人话 */
async function readJson(res: Response): Promise<Record<string, unknown>> {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data as Record<string, unknown>;
}

function formatSize(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
}

/**
 * 【2026-10-24 空空】设置 → 导入数据 → **从备份恢复（整库）**
 *
 * ── 两个来源 ──────────────────────────────────────────────────────────
 *   ① 电脑上的文件：他把下载的 .tar.gz 传回来；
 *   ② NAS 上的每周自动备份：宿主机 cron 每周六 03:00 打的包，
 *      在 `/vol2/1000/scan-inbox/backup`，容器里是 `/app/inbox/backup`。
 * 第二条更省事也更适合灾难现场 —— 那时候软件可能已经打不开，
 * 但备份一直躺在 NAS 上。
 *
 * ── 为什么一定要"先出报告再确认" ──────────────────────────────────────
 * 整库替换不可逆。这一屏的作用是让他**在按下之前**看清楚：
 * 现在有多少题、恢复后还剩多少、哪一项会少。看清楚才按。
 */
export function RestoreSettings() {
    const { t, language } = useLanguage();
    const zh = language === "zh";

    const [phase, setPhase] = useState<Phase>("idle");
    const [plan, setPlan] = useState<RestorePlan | null>(null);
    const [token, setToken] = useState("");
    const [source, setSource] = useState("");
    const [withConfig, setWithConfig] = useState(false);
    const [confirmText, setConfirmText] = useState("");
    const [error, setError] = useState("");
    const [hasConfigNow, setHasConfigNow] = useState(false);

    const [localOpen, setLocalOpen] = useState(false);
    const [localLoading, setLocalLoading] = useState(false);
    const [localFiles, setLocalFiles] = useState<LocalFile[]>([]);
    const [localDir, setLocalDir] = useState("");
    const [localExists, setLocalExists] = useState(true);

    const fileRef = useRef<HTMLInputElement>(null);

    const applyPlan = useCallback((data: Record<string, unknown>) => {
        const p = data.plan as RestorePlan;
        setPlan(p);
        setToken(String(data.token ?? ""));
        setHasConfigNow(Boolean(data.currentHasConfig));
        setWithConfig(false);
        setConfirmText("");
        setPhase("review");
    }, []);

    /** 来源一：电脑上的文件 */
    const uploadFromComputer = useCallback(
        async (file: File) => {
            setError("");
            setPhase("uploading");
            setSource(file.name);
            try {
                // 直接把 File 当 body 发：浏览器流式上传，服务端流式接收，
                // 两边都不把 33MB 塞进内存。用 FormData 会多一层 multipart 封装。
                const res = await fetch("/api/restore/upload", {
                    method: "POST",
                    headers: { "x-backup-filename": encodeURIComponent(file.name) },
                    body: file,
                });
                applyPlan(await readJson(res));
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setPhase("idle");
            }
        },
        [applyPlan],
    );

    /** 来源二：NAS 上的每周自动备份 */
    const loadLocalFiles = useCallback(async () => {
        setError("");
        setLocalLoading(true);
        setLocalOpen(true);
        try {
            const res = await fetch("/api/restore/local", { cache: "no-store" });
            const data = await readJson(res);
            setLocalFiles((data.files as LocalFile[]) ?? []);
            setLocalDir(String(data.dir ?? ""));
            setLocalExists(Boolean(data.exists));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLocalLoading(false);
        }
    }, []);

    const pickLocal = useCallback(
        async (name: string) => {
            setError("");
            setPhase("uploading");
            setSource(name);
            try {
                const res = await fetch("/api/restore/local", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name }),
                });
                applyPlan(await readJson(res));
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setPhase("idle");
            }
        },
        [applyPlan],
    );

    /** 真正动手：暂存 + 让容器重启 */
    const doRestore = useCallback(async () => {
        setError("");
        setPhase("applying");
        try {
            await readJson(
                await fetch("/api/restore/apply", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token, confirm: confirmText, withConfig }),
                }),
            );
            setPhase("restarting");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase("review");
        }
    }, [token, confirmText, withConfig]);

    /**
     * 等容器回来。
     *
     * 不能轮询需要登录的接口 —— 恢复时 cookie 已经被清掉了。
     * 轮询 `/login` 这种公开页就够了：能拿到 200 说明进程活着。
     */
    useEffect(() => {
        if (phase !== "restarting") return;
        const started = Date.now();
        const timer = setInterval(async () => {
            try {
                const res = await fetch("/login", { cache: "no-store" });
                if (res.ok) {
                    clearInterval(timer);
                    window.location.href = "/login?restored=1";
                    return;
                }
            } catch {
                // 还没起来，正常
            }
            if (Date.now() - started > 180_000) {
                clearInterval(timer);
                setError(
                    zh
                        ? "等了 3 分钟容器还没回来。在 NAS 上看一眼：docker logs --tail 50 wrong-notebook。" +
                              "如果容器已经停了，执行 docker compose up -d 拉起来。" +
                              "恢复前的库还在 data/.restore/before-restore.db，随时能换回去。"
                        : "Container didn't come back in 3 minutes. On the NAS: docker logs --tail 50 wrong-notebook. " +
                              "If it has stopped, run docker compose up -d. " +
                              "The pre-restore database is still at data/.restore/before-restore.db.",
                );
            }
        }, 3000);
        return () => clearInterval(timer);
    }, [phase, zh]);

    const reset = () => {
        setPhase("idle");
        setPlan(null);
        setToken("");
        setSource("");
        setConfirmText("");
        setWithConfig(false);
        setError("");
    };

    const dangerBox =
        "rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800";

    return (
        <div className="space-y-3 pt-4 border-t border-red-200">
            <div className="flex items-center gap-2">
                <RotateCcw className="h-4 w-4 text-red-700" />
                <h4 className="text-sm font-bold text-red-900">
                    {t.settings?.restoreTitle || "Restore from Backup"}
                </h4>
            </div>
            <p className="text-xs text-red-800">{t.settings?.restoreDanger || "This overwrites all current data. There is no undo."}</p>

            {/* 来源选择 */}
            {phase === "idle" && !error && (
                <div className="space-y-2">
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".gz,.tgz,application/gzip"
                        className="hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = ""; // 允许重复选同一个文件
                            if (f) void uploadFromComputer(f);
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-red-300 bg-white px-3 py-2 text-sm text-red-900 hover:bg-red-50"
                    >
                        <Upload className="h-4 w-4" />
                        {t.settings?.restorePick || "Choose backup file"}（电脑上）
                    </button>

                    <button
                        type="button"
                        onClick={() => void loadLocalFiles()}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
                    >
                        <FolderOpen className="h-4 w-4" />
                        {zh ? "从 NAS 的备份目录里选" : "Pick from NAS backup folder"}
                    </button>

                    {localOpen && (
                        <div className="rounded-md border border-gray-200 bg-gray-50 p-2">
                            {localLoading ? (
                                <div className="flex items-center gap-2 text-xs text-gray-600">
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    {zh ? "正在读取…" : "Loading…"}
                                </div>
                            ) : localFiles.length === 0 ? (
                                <p className="text-xs text-gray-600">
                                    {localExists
                                        ? zh
                                            ? "这个目录里还没有备份文件。"
                                            : "No backups in this folder yet."
                                        : zh
                                          ? `容器里看不到这个目录：${localDir}`
                                          : `Folder not visible in container: ${localDir}`}
                                </p>
                            ) : (
                                <ul className="space-y-1">
                                    {localFiles.map((f) => (
                                        <li key={f.name}>
                                            <button
                                                type="button"
                                                onClick={() => void pickLocal(f.name)}
                                                className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-white"
                                            >
                                                <span className="truncate text-gray-800">{f.name}</span>
                                                <span className="ml-2 shrink-0 text-gray-500">
                                                    {formatSize(f.size)}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            )}

            {(phase === "uploading" || phase === "applying") && (
                <div className="flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-700">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {phase === "uploading"
                        ? `${t.settings?.restoreUploading || "Checking the package…"} ${source}`
                        : zh
                          ? "正在写入并准备重启…"
                          : "Staging and preparing restart…"}
                </div>
            )}

            {phase === "restarting" && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    {t.settings?.restoreRestarting ||
                        "Restarting… the page comes back by itself in about 30 seconds."}
                </div>
            )}

            {/* 报告 + 确认 */}
            {phase === "review" && plan && (
                <div className="space-y-3">
                    <div className="rounded-md border border-gray-200 p-3">
                        <div className="mb-2 flex items-baseline justify-between">
                            <span className="text-xs font-medium text-gray-700">
                                {t.settings?.restoreReport || "What's in this backup"}
                            </span>
                            <span className="text-xs text-gray-500">
                                {t.settings?.restoreStamp || "Backup date"}:{" "}
                                <b className="text-gray-800">{plan.stamp || "?"}</b>
                                {" · "}
                                {formatSize(plan.dbSize)}
                            </span>
                        </div>

                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-gray-500">
                                    <th className="py-1 text-left font-normal"></th>
                                    <th className="py-1 text-right font-normal">
                                        {t.settings?.restoreNow || "Now"}
                                    </th>
                                    <th className="py-1 text-right font-normal">
                                        {t.settings?.restoreAfter || "After restore"}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {SUMMARY_LABELS.map(({ key, zh: labelZh, en }) => {
                                    const after = plan.backup[key];
                                    const now = plan.current[key];
                                    const changed = after !== now;
                                    return (
                                        <tr
                                            key={key}
                                            className={changed ? "font-medium text-red-700" : "text-gray-700"}
                                        >
                                            <td className="py-0.5">{zh ? labelZh : en}</td>
                                            <td className="py-0.5 text-right tabular-nums">{now}</td>
                                            <td className="py-0.5 text-right tabular-nums">{after}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {plan.warnings.length > 0 && (
                        <ul className={`space-y-1 ${dangerBox}`}>
                            {plan.warnings.map((w) => (
                                <li key={w} className="flex gap-1.5">
                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                    <span>{w}</span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {hasConfigNow && plan.hasConfig && (
                        <label className="flex items-start gap-2 text-xs text-gray-700">
                            <input
                                type="checkbox"
                                checked={withConfig}
                                onChange={(e) => setWithConfig(e.target.checked)}
                                className="mt-0.5"
                            />
                            <span>
                                {t.settings?.restoreWithConfig ||
                                    "Also restore settings (AI keys, prompts, inbox folders)"}
                                <span className="ml-1 text-gray-500">
                                    {zh
                                        ? "—— 不勾就只换数据，现在的设置保持不动"
                                        : "— leave unchecked to keep current settings"}
                                </span>
                            </span>
                        </label>
                    )}

                    <div>
                        <label className="mb-1 block text-xs text-gray-700">
                            {t.settings?.restoreConfirmLabel || "Type 恢复 to confirm"}
                        </label>
                        <input
                            type="text"
                            value={confirmText}
                            onChange={(e) => setConfirmText(e.target.value)}
                            placeholder={RESTORE_CONFIRM_WORD}
                            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                        />
                    </div>

                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => void doRestore()}
                            disabled={confirmText.trim() !== RESTORE_CONFIRM_WORD}
                            className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                        >
                            <RotateCcw className="h-4 w-4" />
                            {t.settings?.restoreApply || "Restore now"}
                        </button>
                        <button
                            type="button"
                            onClick={reset}
                            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        >
                            {t.settings?.restoreCancel || "Choose another file"}
                        </button>
                    </div>
                </div>
            )}

            {error && (
                <div className={dangerBox}>
                    <div className="flex gap-1.5">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{error}</span>
                    </div>
                    {phase === "idle" && (
                        <button
                            type="button"
                            onClick={() => setError("")}
                            className="mt-2 text-xs underline"
                        >
                            {zh ? "知道了" : "Dismiss"}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
