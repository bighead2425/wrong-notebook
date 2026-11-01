"use client";

/**
 * 【2026-11-01】软件内更新的按钮（关于页用）。
 *
 * 流程：点「更新」→ 先查有没有新版 → 有就弹确认 → 确认后触发 watchtower。
 *
 * ⚠️ 触发之后**这个容器会被杀掉重建**，页面会断线 —— 所以成功提示要写成
 *    "两分钟后刷新"，而不是"更新成功"（那时还不知道成没成功）。
 *    真正的判据是刷新后版本号变了。
 */

import { useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";

interface CheckResult {
    current: { version: string | null; commit: string | null };
    latest: { commit: string; builtAt: string; title: string } | null;
    hasUpdate: boolean;
    error?: string;
}

export function UpdateButton() {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const run = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const check = await apiClient.get<CheckResult>("/api/update");
            if (check.error) {
                setMessage(check.error);
                return;
            }
            if (!check.hasUpdate) {
                setMessage("已经是最新版。");
                return;
            }

            const target = check.latest?.title || check.latest?.commit || "最新构建";
            const ok = window.confirm(
                `发现新版本：${target}\n`
                + `当前：${check.current.version ?? "?"} · ${check.current.commit ?? "?"}\n\n`
                + "点确定后，容器会立刻重建（服务中断一两分钟），页面稍后需要刷新。",
            );
            if (!ok) return;

            const apply = await apiClient.post<{ note: string }>("/api/update", {});
            setMessage(apply.note || "已触发更新，约两分钟后刷新页面。");
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "更新没能发起，稍后再试");
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className="inline-flex items-center gap-2">
            <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => void run()}
                disabled={busy}
                title="检查并安装新版本（会短暂中断服务）"
            >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                更新
            </Button>
            {message && (
                <span className="text-xs text-muted-foreground max-w-[280px] truncate" title={message}>
                    {message}
                </span>
            )}
        </span>
    );
}
