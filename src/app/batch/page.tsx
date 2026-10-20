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
 * ── 【2026-10-21 如如】多了两个地址栏参数 ──────────────────────────
 *   `?dir=scan2pdf`  —— 收件箱换成 PDF 中转目录（举一反三从收件箱拉取）。
 *   `?parent=<题id>` —— 这一批导入的题**全部挂到那道题下面**（附题）。
 *   两个都不传 ⇒ 与原来完全一样（`scan2wrong` + 不关联）。
 *
 * ⚠️ 用 `window.location` 读一次，**不用** `useSearchParams`：
 *    后者会把整页拖进 Suspense 边界（2026-10-01 正因为漏包 Suspense 炸过 `next build`）。
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BatchPipeline } from "@/components/batch-pipeline";
import { useLanguage } from "@/contexts/LanguageContext";

export default function BatchPage() {
    const router = useRouter();
    const { language } = useLanguage();
    const [params, setParams] = useState<{ dir?: string; parent?: string }>({});

    useEffect(() => {
        const qs = new URLSearchParams(window.location.search);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后读一次地址栏（SSR 时没有 window）
        setParams({
            dir: qs.get("dir") || undefined,
            parent: qs.get("parent") || undefined,
        });
    }, []);

    return (
        <main className="min-h-screen bg-background">
            <div className="container mx-auto p-4 pb-20">
                <BatchPipeline
                    language={language}
                    aiTimeout={180000}
                    onExit={() => router.push(params.parent ? `/error-items/${params.parent}` : "/")}
                    inboxSubPath={params.dir}
                    linkToId={params.parent}
                />
            </div>
        </main>
    );
}
