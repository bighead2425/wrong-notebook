"use client";

import { LanguageProvider } from "@/contexts/LanguageContext";
import { SessionProvider } from "next-auth/react";
import { PaperThemeApplier } from "@/components/paper-theme";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <SessionProvider>
            <LanguageProvider>
                {/* 【2026-11-16】把配置里的底色预设应用到 <html>，挂在这里全局只跑一次 */}
                <PaperThemeApplier />
                {children}
            </LanguageProvider>
        </SessionProvider>
    );
}
