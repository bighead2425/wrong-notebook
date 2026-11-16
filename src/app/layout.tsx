import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * 【2026-11-04 审计 E6】**允许双指缩放**。
 *
 * 原来 `maximumScale: 1` + `userScalable: false` ⇒ 手机上完全不能放大。
 * 后果很具体：打印预览里那些缩略图和说明是小字，**看不清也没法放大**；
 * 而且禁用缩放对视力不好的家庭成员不友好。
 *
 * `maximumScale: 5` 给了放大的余地，同时保留上限（避免有人缩到离谱）。
 * ⚠️ iOS 上输入框聚焦时会自动放大页面（字号 < 16px 时）—— 那是有意的可访问性行为，
 *    不为了躲它再把手势关回去。
 */
export const viewport: Viewport = {
  themeColor: '#f97316',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export const metadata: Metadata = {
  title: "AI智能错题本",
  description: "基于AI的智能错题管理系统，帮助学生高效整理、分析和复习错题",
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: '智能错题本',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: '/icons/icon.png',
    apple: '/icons/icon.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/**
         * 【2026-11-16 空空】**首屏防闪：在页面画出来之前贴上主题。**
         *
         * 主题存在服务端，读它要走一次 `/api/settings`。等 React 起来再贴，
         * 深色用户每次刷新都会先看见**一屏纯白再变黑** —— 夜里这一下很扎眼。
         *
         * 这里读的是 `PaperThemeApplier` 写的 localStorage 缓存（只管首屏），
         * 之后仍会拉服务端配置校正。所以缓存过期最多影响第一眼，不影响正确性。
         *
         * ⚠️ 这段必须是**同步内联**脚本，不能是 next/script 的 afterInteractive ——
         *    那样就等 hydration 了，等于没防。
         * ⚠️ 包了 try：隐私模式下 localStorage 会抛异常，不能让它挡住整页。
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var r=localStorage.getItem('wn:appearance');if(!r)return;var a=JSON.parse(r)||{};if(a.paper)document.documentElement.setAttribute('data-paper',a.paper);if(a.mode==='dark')document.documentElement.classList.add('dark');if(a.effects)document.documentElement.setAttribute('data-bg','on');}catch(e){}})();`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning={true}
      >
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
