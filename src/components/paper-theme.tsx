"use client";

import { useEffect } from "react";
import { apiClient } from "@/lib/api-client";

/**
 * 【2026-11-16 空空】**把配置里的底色预设应用到 `<html>` 上。**
 *
 * 为什么不在服务端 layout 里直接写 `data-paper`：
 *   那会让整个 app 变成动态渲染（每次请求都读配置文件），得不偿失。
 *   这里用客户端读一次设置、设一个 attribute，代价是**选非默认色时首屏闪一下**。
 *
 * 为什么不闪得明显：
 *   `:root` 的默认值就是 ivory（暖象牙），选 ivory 的人完全不闪；
 *   选其他色的，最坏情况是 0.1 秒的暖白，肉眼难察觉。
 *
 * 失败时静默：读不到设置就保持默认色，不影响任何功能。
 */
const PAPER_ATTR = "paper";

export function applyPaperTheme(paper?: string | null) {
    if (typeof document === "undefined") return;
    document.documentElement.dataset[PAPER_ATTR] = paper || "ivory";
}

export function PaperThemeApplier() {
    useEffect(() => {
        let cancelled = false;
        apiClient
            .get<{ appearance?: { paper?: string } }>("/api/settings")
            .then((cfg) => {
                if (cancelled) return;
                applyPaperTheme(cfg?.appearance?.paper);
            })
            .catch(() => {
                /* 读不到就用默认色，不打扰用户 */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    return null;
}
