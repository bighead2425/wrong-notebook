"use client";

import { getSubjectColorDef, getSubjectTint } from "@/lib/subject-colors";

interface SubjectChipProps {
    /** Notebook.subject（subjectKey），如 math / chinese */
    subjectKey?: string | null;
    /** 打印模式：实心填充 + 纯白字（看清 + 省墨）；UI 模式：浅底 + 深色字 */
    variant?: "print" | "ui";
    /** 是否显示中文名（打印色块同时印学科名 + 简拼，冗余识别） */
    showLabel?: boolean;
    className?: string;
}

/**
 * 学科色标（#9 / 5.6）
 *
 * 打印：22mm×7mm 实心色块 + 白字，圆角 1.5mm —— 必须实心，细边框喷墨易晕。
 * UI  ：同色 12% 浅底 + 深色文字（屏幕上看起来柔和些，也不影响可读性）。
 *
 * ⚠️ 两种模式都必须同时带上 2 字母简拼（SX/YY/WL…）——这是「天然冗余」第三条原则：
 *    黑白复印或色觉差异时，只看字母也能分辨学科。
 */
export function SubjectChip({
    subjectKey,
    variant = "ui",
    showLabel = true,
    className = "",
}: SubjectChipProps) {
    const def = getSubjectColorDef(subjectKey);

    if (variant === "print") {
        return (
            <span
                className={`subject-chip ${className}`}
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "1.5mm",
                    width: "22mm",
                    height: "7mm",
                    borderRadius: "1.5mm",
                    background: def.hex,
                    color: "#FFFFFF",
                    fontSize: "10pt",
                    fontWeight: 700,
                    letterSpacing: "0.3px",
                    lineHeight: 1,
                    flexShrink: 0,
                }}
            >
                {showLabel && <span>{def.label}</span>}
                <span style={{ fontWeight: 800 }}>{def.code}</span>
            </span>
        );
    }

    return (
        <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold ${className}`}
            style={{
                background: getSubjectTint(def.key, 0.12),
                color: def.hex,
            }}
        >
            {showLabel && <span>{def.label}</span>}
            <span className="font-bold">{def.code}</span>
        </span>
    );
}
