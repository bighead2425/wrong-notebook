"use client";

import { useEffect } from "react";
import { apiClient } from "@/lib/api-client";
import { applyBackgroundEffects } from "@/components/background-scene";

/**
 * 【2026-11-16 空空】**主题：浅色四色 + 深色。**
 *
 * ## 两个维度，互不干扰
 *
 * | 维度 | 存在哪 | 取值 |
 * |---|---|---|
 * | `mode` | `<html class="dark">` | `light` / `dark` |
 * | `paper` | `<html data-paper="...">` | `ivory` / `white` / `cool` / `cream` |
 *
 * **深色时 paper 自动失效** —— 不是 JS 判断，而是 CSS 顺序：
 * `[data-paper=...]` 与 `.dark` 特异性相同（都 0,1,0），`.dark` 写在后面。
 * 所以切深色不需要清掉 paper 的值，切回浅色它还在原地。
 *
 * ## 为什么写 localStorage
 *
 * 配置存在服务端，读它要走一次 `/api/settings`。深色用户每次刷新会先看见
 * **一屏纯白**再变黑——夜里这一下很刺眼。
 *
 * 所以：**localStorage 只作"首屏防闪"的缓存**，真实来源仍是服务端配置。
 * 挂载后照样拉一次配置校正（可能你在别的设备上改过）。
 */

export type ThemeMode = "light" | "dark";
export type PaperTheme = "ivory" | "white" | "cool" | "cream";

const PAPER_ATTR = "paper";
const LS_KEY = "wn:appearance";

export const PAPER_THEMES: { id: PaperTheme; zh: string; en: string; swatch: string }[] = [
    { id: "ivory", zh: "纸白", en: "Ivory", swatch: "oklch(0.975 0.007 85)" },
    { id: "white", zh: "纯白", en: "White", swatch: "oklch(1 0 0)" },
    { id: "cool", zh: "浅灰", en: "Cool grey", swatch: "oklch(0.972 0.004 240)" },
    { id: "cream", zh: "米黄", en: "Cream", swatch: "oklch(0.966 0.018 92)" },
];

export interface Appearance {
    paper?: PaperTheme;
    mode?: ThemeMode;
    /**
     * 【2026-11-17】背景效果（纸纹 / 阳光呼吸 / 星点呼吸）。
     *
     * **默认关闭**：装饰对孩子是"可以看的东西"，不该每次打开都塞给她。
     * 想开的人在长按面板里自己开。
     */
    effects?: boolean;
}

/** 只改底色（浅色的四种） */
export function applyPaperTheme(paper?: string | null) {
    if (typeof document === "undefined") return;
    document.documentElement.dataset[PAPER_ATTR] = paper || "ivory";
}

/** 只改明暗 */
export function applyMode(mode?: string | null) {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", mode === "dark");
}

/** 两个一起设，并写缓存（供首屏内联脚本读） */
export function applyAppearance(a?: Appearance | null) {
    if (typeof document === "undefined") return;
    const paper = a?.paper || "ivory";
    const mode = a?.mode || "light";
    const effects = !!a?.effects;
    applyPaperTheme(paper);
    applyMode(mode);
    applyBackgroundEffects(effects);
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({ paper, mode, effects }));
    } catch {
        /* 隐私模式禁用存储：不影响功能，只是下次首屏会闪一下 */
    }
}

export function PaperThemeApplier() {
    useEffect(() => {
        // ① 先用缓存立刻贴上（正常情况下内联脚本已经贴过，这里是兜底）
        let cached: Appearance | null = null;
        try {
            const raw = localStorage.getItem(LS_KEY);
            cached = raw ? (JSON.parse(raw) as Appearance) : null;
        } catch {
            cached = null;
        }
        if (cached) applyAppearance(cached);

        // ② 再拉服务端配置校正（换设备改过的情况）
        let cancelled = false;
        apiClient
            .get<{ appearance?: Appearance }>("/api/settings")
            .then((cfg) => {
                if (cancelled) return;
                /**
                 * 只有当服务端**确实有值**时才覆盖缓存。
                 * 否则：用户在本机选了米黄、还没保存成功，服务端仍是空 ⇒
                 * 一刷新就被打回纸白，等于白选了。
                 */
                const sv = cfg?.appearance;
                if (sv && (sv.paper || sv.mode || typeof sv.effects === "boolean")) applyAppearance(sv);
            })
            .catch(() => {
                /* 读不到就保持缓存/默认，不打扰用户 */
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return null;
}
