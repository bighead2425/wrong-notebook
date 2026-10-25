"use client";

import { useEffect, useState } from "react";

/**
 * 【2026-10-25 路由审计】**"从哪来、回哪去"的统一做法。**
 *
 * 背景：25 个页面里原来只有「错题详情」一个做对了（`?back=`），
 * 其余全是固定返回目标 —— 于是从册详情进打印预览、点返回却回主页。
 *
 * 约定：
 *   · **入口**负责带来源：`withBack("/print-preview?ids=x")`
 *   · **页面**负责认来源：`useBackHref("/notebooks")`
 *   · 没有 `back=` 时用兜底目标，所以"直接打开这个地址"也不会坏。
 *
 * ⚠️ **只认站内路径**：`back` 是从地址栏读来的，不校验就是一个
 *    "想跳哪就跳哪"的开放重定向口子。和 `error-items/[id]` 10-01 那套同一条规矩。
 */

/** 太长的 back 一定不是我们生成的（多半是被人塞的），直接不认 */
const MAX_BACK_LEN = 2048;

/**
 * 校验一个 `back` 值。不合法返回 `null`（调用方自己决定兜底）。
 *
 * 过滤掉：
 *   · 不以 `/` 开头的（`javascript:`、`http://evil`）
 *   · `//evil.com`（协议相对，会被当外站）
 *   · 超长的
 */
export function sanitizeBack(raw: string | null | undefined): string | null {
    if (!raw) return null;
    if (raw.length > MAX_BACK_LEN) return null;
    if (!raw.startsWith("/")) return null;
    if (raw.startsWith("//")) return null;
    return raw;
}

/** 当前这一屏的路径（带 query）。只在客户端调；SSR 时给 `/`。 */
export function currentPath(): string {
    if (typeof window === "undefined") return "/";
    return window.location.pathname + window.location.search;
}

export function hasBackParam(raw: string): boolean {
    const i = raw.indexOf("?");
    if (i < 0) return false;
    return new URLSearchParams(raw.slice(i + 1)).has("back");
}

/**
 * 给一个站内路径挂上 `back=<当前页>`。
 *
 * 已经带 `back=` 的**不重复挂**（否则 `back` 会套娃，
 * 返回时跳到"上一次的返回目标"而不是真来源）。
 */
export function withBack(href: string, from?: string): string {
    if (hasBackParam(href)) return href;
    const src = from ?? currentPath();
    const sep = href.includes("?") ? "&" : "?";
    return `${href}${sep}back=${encodeURIComponent(src)}`;
}

/**
 * 页面用：返回键该去哪。
 *
 * 读 `?back=`（校验过），没有就用 `fallback`。
 * 在 effect 里读 `window.location`：服务端渲染时没有 window，
 * 而且这样不用给页面套 `<Suspense>`（`useSearchParams` 会要求）。
 */
export function useBackHref(fallback: string): string {
    const [href, setHref] = useState(fallback);

    useEffect(() => {
        const raw = new URLSearchParams(window.location.search).get("back");
        const safe = sanitizeBack(raw);
        if (safe) setHref(safe);
    }, []);

    return href;
}
