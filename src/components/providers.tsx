"use client";

import { LanguageProvider } from "@/contexts/LanguageContext";
import { SessionProvider } from "next-auth/react";
import { PaperThemeApplier } from "@/components/paper-theme";
import { BackgroundScene } from "@/components/background-scene";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <SessionProvider>
            <LanguageProvider>
                {/* 【2026-11-16】把配置里的底色预设应用到 <html>，挂在这里全局只跑一次 */}
                <PaperThemeApplier />
                {/**
                 * 【2026-11-17 空空】**背景效果层，放在 children 前面。**
                 *
                 * 它在 DOM 里排第一，配合 `z-index: -1` 就永远在最底下；
                 * 不需要给任何页面加 `relative z-10`，也不会挡住点击
                 * （`.bg-scene` 上有 `pointer-events: none`）。
                 *
                 * 默认不显示，靠 `<html data-bg="on">` 才出来。
                 */}
                <BackgroundScene />
                {children}
            </LanguageProvider>
        </SessionProvider>
    );
}
