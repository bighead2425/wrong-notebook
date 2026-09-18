"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ProgressStatus = 'compressing' | 'uploading' | 'analyzing' | 'processing' | 'idle';

interface ProgressFeedbackProps {
    status: ProgressStatus;
    progress?: number;
    message?: string;
    className?: string;
    /**
     * 【custom-v23】可选的中止入口。
     *
     * 这个遮罩是 `fixed inset-0 z-50`，只要 status 不为 idle 就盖住整屏 ——
     * 单张分析几秒钟无所谓，但批量送 AI 是**串行**跑 N 张，20 张最坏能锁屏几十分钟，
     * 用户完全没有退路。给了 onCancel 才不至于把人关在里面。
     */
    onCancel?: () => void;
    cancelLabel?: string;
}

import { useLanguage } from "@/contexts/LanguageContext";

export function ProgressFeedback({ status, progress, message, className, onCancel, cancelLabel }: ProgressFeedbackProps) {
    const { t } = useLanguage();
    // 确保只在客户端挂载完成后才渲染遮罩层，防止 SSR/Hydration 问题
    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    // 只有在客户端挂载完成且 status 不为 idle 时才渲染
    if (!isMounted || status === 'idle') return null;

    return (
        <div className={cn(
            "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm",
            className
        )}>
            <div className="w-full max-w-md p-6 space-y-6 bg-card rounded-lg border shadow-lg mx-4">
                <div className="flex flex-col items-center justify-center space-y-4 text-center">
                    <div className="relative">
                        <Loader2 className="h-12 w-12 animate-spin text-primary" />
                        <div className="absolute inset-0 flex items-center justify-center">
                            {/* Optional: Add an icon inside the spinner if needed */}
                        </div>
                    </div>

                    <div className="space-y-2 w-full">
                        <h3 className="text-lg font-semibold tracking-tight">
                            {message}
                        </h3>
                        {progress !== undefined && (
                            <Progress value={progress} className="h-2 w-full" />
                        )}
                    </div>

                    <p className="text-sm text-muted-foreground">
                        {progress !== undefined ? `${Math.round(progress)}%` : (t.common.pleaseWait || 'Please wait...')}
                    </p>

                    {onCancel && (
                        <Button variant="outline" size="sm" onClick={onCancel}>
                            {cancelLabel || '取消'}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

