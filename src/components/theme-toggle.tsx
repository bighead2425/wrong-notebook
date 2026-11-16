"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Moon, Sun } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api-client";
import { Switch } from "@/components/ui/switch";
import { BG_DURATIONS, BG_SCALES } from "@/components/background-scene";
import {
    PAPER_THEMES,
    applyAppearance,
    type Appearance,
    type PaperTheme,
    type ThemeMode,
} from "@/components/paper-theme";

/**
 * 【2026-11-16 空空】**主页右上角的明暗开关。**
 *
 * ## 交互（按他的原话实现）
 *
 * | 动作 | 结果 |
 * |---|---|
 * | **短按** | 浅色 ⇄ 深色 循环切换 |
 * | **长按 0.5 秒** | 弹出对话框：四种纸色 + 明暗选择 |
 * | 对话框里点任何一项 | **立即生效并保存**，没有"保存"按钮 |
 *
 * ## 三个容易踩的坑，这里都躲开
 *
 * ① **长按后不能再触发短按。** 手指抬起时会同时产生"长按成功"和"点击"两个信号，
 *    不做标记的话：长按弹窗 → 松手 → 顺手又切了明暗，等于白弹。
 *    解法：`longPressedRef`，在 `pointerdown` 时清零，只有它为 false 才执行短按。
 *
 * ② **移动端长按会弹系统菜单**（"拷贝/全选"那一套），盖住我们的对话框。
 *    解法三件套：`select-none` + `onContextMenu` 拦截 + `-webkit-touch-callout: none`。
 *
 * ③ **手指一滑就该取消长按。** 否则在列表上滑屏时蹭到这个按钮，就会莫名弹窗。
 *    解法：`pointermove` 超过 10px 就清掉计时器。
 *
 * ## 为什么不用 `next-themes`
 *
 * 我们的主题有两个维度（明暗 + 纸色），且要存服务端配置。引一个库还得改造它，
 * 不如 80 行写清楚 —— 出问题时一眼能看懂在干什么。
 */

/** 长按判定时长。500ms 是移动端的通行值，短了容易误触，长了觉得没反应。 */
const LONG_PRESS_MS = 500;
/** 手指/鼠标移动超过这个距离，就认为"他不是在长按，是在滑屏"。 */
const MOVE_TOLERANCE = 10;

export function ThemeToggle({ className = "" }: { className?: string }) {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<ThemeMode>("light");
    const [paper, setPaper] = useState<PaperTheme>("ivory");
    /** 背景效果（纸纹 / 阳光 / 星点）。默认关 —— 见 `paper-theme.tsx` 的说明。 */
    const [effects, setEffects] = useState(false);
    /** 两根滑条的档位索引（0..4）。默认最慢、最小。 */
    const [speedIdx, setSpeedIdx] = useState(BG_DURATIONS.length - 1);
    const [sizeIdx, setSizeIdx] = useState(0);
    /** 滑块是连续拖动的，保存要防抖，否则一次拖动会发十几个请求 */
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [mounted, setMounted] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressedRef = useRef(false);
    const startRef = useRef({ x: 0, y: 0 });

    /**
     * 初始状态从 DOM 读 —— 因为首屏内联脚本已经把 class / data-paper 贴上了，
     * 从 DOM 读才能和"用户眼前实际看到的"一致。
     *
     * 用 `mounted` 挡一次：服务端不知道用户选了什么，直接渲染会 hydration 不匹配。
     *
     * ## 为什么这里要压掉 `set-state-in-effect`
     *
     * 那条规则针对的是"能用 props/state 算出来却放进 effect 再 setState"。
     * 这里**没有别的来源**：主题存在 `<html class="dark">` 和 `data-paper` 上，
     * 而且首屏是由 HTML 里的内联脚本贴的，React 完全不知道。
     *
     * 换成 `useState` 惰性初始化会更好看，但服务端渲染只能给 `light`，
     * 客户端拿到真实值 ⇒ 图标 hydration 不匹配。这是 `next-themes` 等库
     * 同样绕不开的点，它们也走 mounted + effect 这条路。
     */
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 读的是插件写在 <html> 上的外部状态，无 state/props 可推
        setMode(document.documentElement.classList.contains("dark") ? "dark" : "light");
        setPaper((document.documentElement.dataset.paper as PaperTheme) || "ivory");
        setEffects(document.documentElement.dataset.bg === "on");
        /* 从 CSS 变量反推档位：`--bg-dur` 是 "20s"，parseInt 正好得 20 */
        const cs = getComputedStyle(document.documentElement);
        const dur = parseInt(cs.getPropertyValue("--bg-dur"), 10);
        const sc = parseFloat(cs.getPropertyValue("--bg-scale"));
        const di = BG_DURATIONS.indexOf((Number.isFinite(dur) ? dur : 20) as (typeof BG_DURATIONS)[number]);
        const si = BG_SCALES.indexOf((Number.isFinite(sc) ? sc : 1) as (typeof BG_SCALES)[number]);
        setSpeedIdx(di >= 0 ? di : BG_DURATIONS.length - 1);
        setSizeIdx(si >= 0 ? si : 0);
        setMounted(true);
    }, []);

    /** 立即应用 + 存服务端。**先应用再存**：界面不等网络，失败也只是没存上。 */
    const applyAndSave = useCallback(
        (next: Appearance, debounce = false) => {
            const merged: Appearance = {
                paper: next.paper ?? paper,
                mode: next.mode ?? mode,
                /* 注意用 `??` 而不是 `||`：`false` 是合法值（关掉效果），不能被当成空 */
                effects: next.effects ?? effects,
                effectDuration: next.effectDuration ?? BG_DURATIONS[speedIdx],
                effectScale: next.effectScale ?? BG_SCALES[sizeIdx],
            };
            setPaper(merged.paper as PaperTheme);
            setMode(merged.mode as ThemeMode);
            setEffects(!!merged.effects);
            /* **先应用**：拖动滑块时界面要跟手，不能等网络 */
            applyAppearance(merged);

            const send = () => {
                setSaving(true);
                setError(null);
                apiClient
                    .post("/api/settings", { appearance: next })
                    .catch(() => {
                        /**
                         * 失败只说一句，不回滚界面 —— 回滚会让"点下去又弹回来"，更让人困惑。
                         * 下次刷新会回到服务端存的旧值，那时候才发现没存上。
                         */
                        setError("保存失败，换个网络再选一次");
                    })
                    .finally(() => setSaving(false));
            };

            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            /* 滑块连续拖动：停下 450ms 再存，否则一次拖动会打十几次接口 */
            if (debounce) saveTimerRef.current = setTimeout(send, 450);
            else send();
        },
        [paper, mode, effects, speedIdx, sizeIdx]
    );

    /**
     * 卸载时清掉待发的计时器。
     *
     * 不补发：正常情况下关掉弹窗**不会卸载**这个组件（Dialog 只是隐藏），
     * 450ms 后照常发出。真正卸载 = 离开页面，那时补发也多半会被浏览器中断，
     * 而视觉上已经应用过了，下次打开会以服务端值为准 —— 不会造成"看着变了其实没变"的困惑。
     */
    useEffect(() => {
        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, []);

    /** 短按：浅色 ⇄ 深色 */
    const toggleMode = useCallback(() => {
        applyAndSave({ mode: mode === "dark" ? "light" : "dark" });
    }, [mode, applyAndSave]);

    /**
     * 选纸色。
     *
     * **深色模式下点纸色 ⇒ 顺手切回浅色。**
     * 他说"深色下这四种颜色选中了也无效"——机制上确实无效（CSS 被 `.dark` 压住）。
     * 但"点了没反应"会被当成坏了，所以这里让它既选色、也回到浅色去看效果。
     */
    const pickPaper = useCallback(
        (p: PaperTheme) => {
            applyAndSave({ paper: p, mode: "light" });
        },
        [applyAndSave]
    );

    const clearTimer = () => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    };

    const onPointerDown = (e: React.PointerEvent) => {
        longPressedRef.current = false;
        startRef.current = { x: e.clientX, y: e.clientY };
        clearTimer();
        timerRef.current = setTimeout(() => {
            longPressedRef.current = true;
            setOpen(true);
            /* 部分安卓机会在长按末尾补一个震动，这里主动给一点反馈，让人知道"成了" */
            if (typeof navigator !== "undefined" && "vibrate" in navigator) {
                try {
                    navigator.vibrate(12);
                } catch {
                    /* 不支持就算了 */
                }
            }
        }, LONG_PRESS_MS);
    };

    const onPointerUp = () => {
        clearTimer();
        if (!longPressedRef.current) toggleMode();
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const dx = e.clientX - startRef.current.x;
        const dy = e.clientY - startRef.current.y;
        if (Math.abs(dx) > MOVE_TOLERANCE || Math.abs(dy) > MOVE_TOLERANCE) clearTimer();
    };

    useEffect(() => clearTimer, []);

    const isDark = mode === "dark";

    return (
        <>
            <button
                type="button"
                aria-label={isDark ? "当前深色，点击切换浅色；长按选择颜色" : "当前浅色，点击切换深色；长按选择颜色"}
                title={isDark ? "点击切浅色 · 长按选颜色" : "点击切深色 · 长按选颜色"}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerLeave={clearTimer}
                onPointerCancel={clearTimer}
                onPointerMove={onPointerMove}
                /* 移动端长按会弹系统菜单，盖住我们的对话框 */
                onContextMenu={(e) => e.preventDefault()}
                className={
                    "flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full border bg-card " +
                    "transition-colors hover:bg-accent active:scale-95 " +
                    className
                }
                style={{ WebkitTouchCallout: "none", touchAction: "manipulation" }}
            >
                {/* 未挂载时先画太阳（默认浅色），避免 hydration 前后图标打架 */}
                {mounted && isDark ? (
                    /* "银色月亮"：不带黄，偏冷白，在深底上像金属反光 */
                    <Moon className="h-4 w-4" style={{ color: "oklch(0.84 0.012 250)" }} />
                ) : (
                    <Sun className="h-4 w-4 text-amber-500" />
                )}
            </button>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>界面主题</DialogTitle>
                        <DialogDescription>
                            点选立即生效，不用保存。
                        </DialogDescription>
                    </DialogHeader>

                    {/* —— 纸色（四种）—— */}
                    <div className="space-y-3">
                        <div className="flex items-baseline justify-between">
                            <span className="text-sm font-medium">浅色纸面</span>
                            {isDark && (
                                <span className="text-xs text-muted-foreground">深色下不生效</span>
                            )}
                        </div>

                        <div className="grid grid-cols-4 gap-2">
                            {PAPER_THEMES.map((t) => {
                                const selected = !isDark && paper === t.id;
                                return (
                                    <button
                                        key={t.id}
                                        type="button"
                                        onClick={() => pickPaper(t.id)}
                                        className="group flex flex-col items-center gap-1.5"
                                        aria-pressed={selected}
                                    >
                                        <span
                                            className={
                                                "relative flex h-11 w-11 items-center justify-center rounded-full border-2 transition-all " +
                                                (selected
                                                    ? "border-primary ring-2 ring-primary/25"
                                                    : "border-border group-hover:border-muted-foreground/50")
                                            }
                                            style={{ background: t.swatch }}
                                        >
                                            {selected && (
                                                /* 浅底色上白勾看不见，所以用深色勾 + 白描边 */
                                                <Check
                                                    className="h-4 w-4"
                                                    strokeWidth={3}
                                                    style={{ color: "oklch(0.35 0.02 85)" }}
                                                />
                                            )}
                                        </span>
                                        <span
                                            className={
                                                "text-xs " +
                                                (selected ? "font-medium text-foreground" : "text-muted-foreground")
                                            }
                                        >
                                            {t.zh}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* —— 明暗 —— */}
                    <div className="space-y-2 border-t pt-3">
                        <span className="text-sm font-medium">明暗</span>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => applyAndSave({ mode: "light" })}
                                className={
                                    "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors " +
                                    (!isDark ? "border-primary bg-accent font-medium" : "hover:bg-accent/50")
                                }
                                aria-pressed={!isDark}
                            >
                                <Sun className="h-4 w-4 text-amber-500" />
                                浅色
                            </button>
                            <button
                                type="button"
                                onClick={() => applyAndSave({ mode: "dark" })}
                                className={
                                    "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors " +
                                    (isDark ? "border-primary bg-accent font-medium" : "hover:bg-accent/50")
                                }
                                aria-pressed={isDark}
                            >
                                <Moon className="h-4 w-4" style={{ color: "oklch(0.72 0.012 250)" }} />
                                深色
                            </button>
                        </div>
                    </div>

                    {/* —— 背景效果 —— */}
                    <div className="flex items-start justify-between gap-3 border-t pt-3">
                        <div className="space-y-0.5">
                            <span className="text-sm font-medium">背景效果</span>
                            <p className="text-xs leading-relaxed text-muted-foreground">
                                浅色是纸纹与阳光，深色是极淡的星点。都很慢，几乎看不出在动。
                            </p>
                        </div>
                        <Switch
                            checked={effects}
                            onCheckedChange={(v) => applyAndSave({ effects: v })}
                            aria-label="背景效果开关"
                            className="mt-0.5 shrink-0"
                        />
                    </div>

                    {/* —— 两个可调项（只在开着的时候出现）—— */}
                    {effects && (
                        <div className="space-y-3 rounded-lg bg-muted/50 px-3 py-2.5">
                            <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-medium">呼吸节奏</span>
                                    <span className="text-xs tabular-nums text-muted-foreground">
                                        {BG_DURATIONS[speedIdx]} 秒
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={BG_DURATIONS.length - 1}
                                    step={1}
                                    value={speedIdx}
                                    onChange={(e) => {
                                        const i = Number(e.target.value);
                                        setSpeedIdx(i);
                                        /* 拖动中不发请求，停下 450ms 再存 */
                                        applyAndSave({ effectDuration: BG_DURATIONS[i] }, true);
                                    }}
                                    className="w-full cursor-pointer"
                                    style={{ accentColor: "var(--primary)" }}
                                    aria-label="呼吸节奏：越快越靠左"
                                />
                                <div className="flex justify-between text-xs text-subtle-foreground">
                                    <span>快</span>
                                    <span>慢</span>
                                </div>
                            </div>

                            <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-medium">大小</span>
                                    <span className="text-xs tabular-nums text-muted-foreground">
                                        {BG_SCALES[sizeIdx]}×
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={BG_SCALES.length - 1}
                                    step={1}
                                    value={sizeIdx}
                                    onChange={(e) => {
                                        const i = Number(e.target.value);
                                        setSizeIdx(i);
                                        applyAndSave({ effectScale: BG_SCALES[i] }, true);
                                    }}
                                    className="w-full cursor-pointer"
                                    style={{ accentColor: "var(--primary)" }}
                                    aria-label="光与星的大小"
                                />
                                <div className="flex justify-between text-xs text-subtle-foreground">
                                    <span>小</span>
                                    <span>大</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* 保存失败才出现，平时不占位 */}
                    {(saving || error) && (
                        <p className={"text-xs " + (error ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                            {error || "保存中…"}
                        </p>
                    )}

                    <p className="text-xs text-muted-foreground">
                        长按右上角的圆圈随时打开这里。
                    </p>
                </DialogContent>
            </Dialog>
        </>
    );
}
