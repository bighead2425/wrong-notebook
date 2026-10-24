"use client";

import { useEffect, useState } from "react";
import { DEFAULT_PAPER_CONFIG, type PaperConfig, type PaperSpec } from "./paper";

/**
 * 【2026-10-24 幅面】读"四种纸各用多大"。
 *
 * 挂在四个地方：打印预览、卷管理页、扫到的卷页、积累纸打印页。
 * 它们都要把 `paperFor(kind, cfg)` 传给 `ReviewSheet` / `DeepDiveCard`。
 *
 * ⚠️ 先给默认值（全 B5），拿到响应再更新 ——
 *    不能"等配置回来再渲染"，否则每次打印页都会先白一下。
 *    万一请求失败，就一直按 B5 走（和加这个功能之前一样）。
 */
export function usePaperConfig(): PaperConfig {
    const [paper, setPaper] = useState<PaperConfig>(DEFAULT_PAPER_CONFIG);

    useEffect(() => {
        let alive = true;
        fetch("/api/paper", { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { paper?: Partial<PaperConfig> } | null) => {
                if (!alive || !d?.paper) return;
                setPaper({
                    deepDive: d.paper.deepDive ?? DEFAULT_PAPER_CONFIG.deepDive,
                    review: d.paper.review ?? DEFAULT_PAPER_CONFIG.review,
                    imitate: d.paper.imitate ?? DEFAULT_PAPER_CONFIG.imitate,
                    build: d.paper.build ?? DEFAULT_PAPER_CONFIG.build,
                });
            })
            .catch(() => {
                // 读不到就按 B5 —— 不能因为一个设置读不到就让打印页出不来
            });
        return () => {
            alive = false;
        };
    }, []);

    return paper;
}

/**
 * 【2026-10-24 幅面】让浏览器按指定幅面打印。
 *
 * 为什么必须动态注入：`@page` **不能按元素切换**，一个文档只有一种。
 * `globals.css` 里写死的是 B5（182×257），选 A4 就得在打印前换掉它。
 *
 * 做法：往 head 里放一段 `<style>`（只放一次，之后只改内容）。
 * 它排在 `globals.css` 之后 ⇒ 同优先级下后者胜 ⇒ 覆盖掉 B5 那条。
 *
 * ⚠️ 没有 `window` 的环境（服务端渲染）什么都不做。
 */
export function usePrintPageSize(paper: PaperSpec): void {
    useEffect(() => {
        if (typeof document === "undefined") return;
        const id = "wn-print-page-size";
        let el = document.getElementById(id) as HTMLStyleElement | null;
        if (!el) {
            el = document.createElement("style");
            el.id = id;
            document.head.appendChild(el);
        }
        const m = paper.margin;
        el.textContent =
            `@media print{@page{size:${paper.w}mm ${paper.h}mm;` +
            `margin:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm}}`;
    }, [paper]);
}
