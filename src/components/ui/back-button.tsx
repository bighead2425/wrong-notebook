"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useBackHref } from "@/lib/back";

interface BackButtonProps {
    /**
     * 兜底目标（逻辑上的父页面）。
     *
     * 【2026-10-25 路由审计】现在 `?back=` 优先：
     * 从别的页面进来的（比如「册详情 → 打印预览」），返回就回册详情；
     * 直接打开这个地址、或从别处乱跳进来的，才用这个兜底。
     */
    fallbackUrl: string;
    className?: string;
}

/**
 * 返回按钮：优先回**来源页**，没有来源才回逻辑父页面。
 *
 * 原来是 `router.push(fallbackUrl)` 写死 —— 于是"从册详情进打印预览、
 * 点返回却回主页"。改法统一在 `lib/back.ts`：入口带 `?back=`，这里认它。
 *
 * ⚠️ 只认站内路径（校验在 `useBackHref` 里），不然 `back` 就是个开放重定向口子。
 */
export function BackButton({ fallbackUrl, className }: BackButtonProps) {
    const router = useRouter();
    const href = useBackHref(fallbackUrl);

    const handleBack = () => {
        router.push(href);
    };

    return (
        <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            className={className}
        >
            <ArrowLeft className="h-5 w-5" />
        </Button>
    );
}
