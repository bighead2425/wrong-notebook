"use client";

import { getSubjectColorDef, getSubjectTint } from "@/lib/subject-colors";

interface SubjectChipProps {
    /** Notebook.subject（subjectKey），如 math / chinese */
    subjectKey?: string | null;
    /** 打印模式：实心填充 + 纯白字（看清 + 省墨）；UI 模式：浅底 + 深色字 */
    variant?: "print" | "ui";
    /** 是否显示中文名（打印色块同时印学科名 + 简拼，冗余识别） */
    showLabel?: boolean;
    /**
     * 是否显示 2 字母简拼（SX/YY/WL…）。
     * 【custom-v24】打印场景改传 false：色块后面紧跟着题号（SX20260912001），
     * 题号前两位本来就是学科简拼，色块再印一遍属于重复占位（用户要求去掉）。
     * UI 场景仍默认显示，屏幕上看色块 + 两字母最省事。
     */
    showCode?: boolean;
    className?: string;
}

/**
 * 学科色标（#9 / 5.6）
 *
 * 打印：高度 7mm、宽度随文字伸缩的实心色块 + 白字，圆角 1.5mm —— 必须实心，细边框喷墨易晕。
 *   宽度不再写死（见下方 style 里的说明）：实心块按面积吃墨，能窄一毫米是一毫米。
 * UI  ：同色 12% 浅底 + 深色文字（屏幕上看起来柔和些，也不影响可读性）。
 *
 * ⚠️ 默认两种模式都带上 2 字母简拼（SX/YY/WL…）——这是「天然冗余」第三条原则：
 *    黑白复印或色觉差异时，只看字母也能分辨学科。
 *
 * 【custom-v24 例外】打印场景改由调用方传 showCode={false}：
 *    错题卡里色块右边紧跟题号（SX20260912001），题号前两位就是学科简拼，
 *    同一行印两遍属于重复。冗余性原则不破 —— 简拼仍在，只是挪到了题号里。
 */
export function SubjectChip({
    subjectKey,
    variant = "ui",
    showLabel = true,
    showCode = true,
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
                    // 【custom-v26】宽度改为随文字伸缩（原来写死 22mm）。
                    // 学科名大多是两个汉字，22mm 的实心块里文字只占中间一小条，
                    // 两侧全是空白色块 —— 实心色块是最费墨的，白占的每一毫米都在烧墨。
                    // 现在由 padding 撑出留白，两个字约 11mm，省掉近一半。
                    // minWidth 兜底：万一将来出现单字学科名，也不至于塌成一个小圆点。
                    minWidth: "9mm",
                    padding: "0 2mm",
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
                {showCode && <span style={{ fontWeight: 800 }}>{def.code}</span>}
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
            {showCode && <span className="font-bold">{def.code}</span>}
        </span>
    );
}
