"use client";

/**
 * 【2026-10-19 空空第 7 条】批量上传改成**独立页面**（`/batch`）
 *
 * 他原话："如果点击『批量上传』，现在是在主页所有按钮下面插入一个批量上传的板块，
 *          我不想要这样了。我想点击批量上传按钮后，进入一个批量上传的页面，
 *          显示还是这些内容，功能还是这些功能，就是重新建立一个页面，不要再挤在主页中了。"
 *
 * ⇒ 把原来主页里 `batchMode ? <BatchPipeline/>` 那一段整体搬到这一页。
 *   内容、功能、组件**一个字没改**，只是换了住处。
 *
 * ⚠️ `aiTimeout` 这里给的是默认 180s（主页那边是从配置读的）。
 *    批量送 AI 本来就慢，180s 与配置默认值一致；真要按用户配置走，
 *    再把 `/api/config` 的读取搬过来（别在这里猜）。
 */

import { useRouter } from "next/navigation";
import { BatchPipeline } from "@/components/batch-pipeline";
import { useLanguage } from "@/contexts/LanguageContext";

export default function BatchPage() {
    const router = useRouter();
    const { language } = useLanguage();

    return (
        <main className="min-h-screen bg-background">
            <div className="container mx-auto p-4 pb-20">
                <BatchPipeline
                    language={language}
                    aiTimeout={180000}
                    onExit={() => router.push("/")}
                />
            </div>
        </main>
    );
}
