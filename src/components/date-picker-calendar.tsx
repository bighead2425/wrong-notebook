"use client";

/**
 * 【2026-09-30 新增】**录入日期选择日历**（错题本页筛选里的「其他日期」）。
 *
 * 他的需求（逐条）：
 *   · 月历**连在一起**上下排（像 Windows 自带日历），可上下滚动（手机拖动 / 电脑滚轮）；
 *   · **今天**的日期数字用**橙红黄**；**录入过错题**的日子底色**浅粉**；
 *   · 点一下"有记录"的日子 ⇒ 底色变**绿**（可多选，再点变回浅粉）；
 *     点"没记录"的日子 ⇒ **无反应**；
 *   · **双击**任意日子 ⇒ 变**蓝**，并**清掉所有绿色**（选了时间段，单点方式就作废）；
 *     再双击一天 ⇒ 两个蓝点之间全部**淡蓝**；
 *   · 拖动蓝点可以调整区间长短（拖到屏幕上下边缘会让日历自动滚动）；
 *   · 再双击那个蓝点本身 ⇒ 蓝色失效；已经有两点时，双击其他日子无效；
 *   · 底部三按钮：**清除**（把所有标色全清）/ **取消**（返回，作废本次选择）/ **确认**（黑底白字）。
 *
 * ⚠️ 时区：这里只算"本地日子"，真正传给服务端的是**绝对时刻**
 *    （见 `calendar-grid.ts` 的 `dayBoundsISO` / `rangeBoundsISO`）——
 *    容器跑在 UTC，服务端自己分"天"会偏 8 小时。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    buildMonths,
    dayKey,
    inDayRange,
    moveEndpoint,
    normalizeRange,
    type CalDay,
} from '@/lib/calendar-grid';

const PINK = '#fbe3ea';
const GREEN = '#4caf50';
const BLUE = '#3b82f6';
const LIGHT_BLUE = '#dbeafe';
const TODAY = '#d9480f';

type Selection = { points: string[]; range: { from: string; to: string } | null };

export function DatePickerCalendar({
    counts,
    initialPoints,
    initialRange,
    minKey,
    maxKey,
    onCancel,
    onConfirm,
    L,
}: {
    /** 有错题的日期 → 条数 */
    counts: Record<string, number>;
    initialPoints: string[];
    initialRange: { from: string; to: string } | null;
    /** 日历从哪个月画到哪个月（数据范围） */
    minKey: string;
    maxKey: string;
    onCancel: () => void;
    onConfirm: (sel: Selection) => void;
    L: (zh: string, en: string) => string;
}) {
    const [selection, setSelection] = useState<Selection>({
        points: initialPoints,
        range: initialRange,
    });
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<'from' | 'to' | null>(null);
    const [dragging, setDragging] = useState<'from' | 'to' | null>(null);
    const rangeStartRef = useRef<{ x: number; y: number } | null>(null);

    const todayKey = useMemo(() => dayKey(new Date()), []);
    /** 今天必须始终在日历里（哪怕数据都在别的月份） */
    const { from, to } = useMemo(() => {
        const lo = [minKey || todayKey, todayKey].sort()[0];
        const hi = [maxKey || todayKey, todayKey].sort().slice(-1)[0];
        return { from: lo, to: hi };
    }, [minKey, maxKey, todayKey]);
    const months = useMemo(() => buildMonths(from, to), [from, to]);

    const hasRecords = useCallback((key: string) => (counts[key] ?? 0) > 0, [counts]);

    /** 单点切换：只认"有记录"的日子；已有蓝色区间时单点作废（他定的） */
    const onDayClick = useCallback(
        (d: CalDay) => {
            if (selection.range) return;
            if (!hasRecords(d.key)) return;
            setSelection((prev) => {
                const has = prev.points.includes(d.key);
                return {
                    ...prev,
                    points: has ? prev.points.filter((k) => k !== d.key) : [...prev.points, d.key],
                };
            });
        },
        [selection.range, hasRecords],
    );

    /** 双击：起/止蓝色端点（第一下清空绿色；再双击同一个点 = 取消） */
    const onDayDoubleClick = useCallback(
        (d: CalDay) => {
            setSelection((prev) => {
                const r = prev.range;
                if (!r) {
                    // 还没开始选段：这一下变成"单点蓝"，并清掉所有绿
                    return { points: [], range: { from: d.key, to: d.key } };
                }
                const isSingle = r.from === r.to;
                if (isSingle) {
                    // 只有一端：双击同一个点 ⇒ 取消；双击别的日子 ⇒ 定另一端
                    return r.from === d.key ? { points: [], range: null } : { points: [], range: { from: r.from, to: d.key } };
                }
                // 已经有两个端点：其他日子一律无效（他只允许拖端点来改）
                return prev;
            });
        },
        [],
    );

    /** 拖蓝色端点（含自动滚动） */
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const which = dragRef.current;
            if (!which) return;
            const sc = scrollRef.current;
            if (sc) {
                const r = sc.getBoundingClientRect();
                // 拖到上下边缘 ⇒ 日历跟着滚（他要的"能继续调整"）
                if (e.clientY < r.top + 48) sc.scrollTop -= 14;
                else if (e.clientY > r.bottom - 48) sc.scrollTop += 14;
            }
            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
            const dayEl = el?.closest('[data-day]') as HTMLElement | null;
            const key = dayEl?.dataset.day;
            if (!key) return;
            setSelection((prev) => (prev.range ? { ...prev, range: moveEndpoint(prev.range, which, key) } : prev));
        };
        const onUp = () => {
            if (!dragRef.current) return;
            dragRef.current = null;
            setDragging(null);
            document.body.style.userSelect = '';
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
    }, []);

    const startDrag = (which: 'from' | 'to') => (e: React.PointerEvent) => {
        dragRef.current = which;
        setDragging(which);
        rangeStartRef.current = { x: e.clientX, y: e.clientY };
        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
    };

    const cells = months.map((m) => ({ month: m, flat: m.weeks.flat() }));
    const selCount = selection.range
        ? Math.abs(
              (new Date(normalizeRange(selection.range.from, selection.range.to).to).getTime() -
                  new Date(normalizeRange(selection.range.from, selection.range.to).from).getTime()) /
                  (24 * 3600 * 1000),
          ) + 1
        : selection.points.length;

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-3 sm:p-6"
            onClick={(e) => {
                // 点遮罩 = 取消
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="w-full max-w-[520px] rounded-lg bg-background shadow-xl border">
                <div className="flex items-center justify-between border-b px-3 py-2">
                    <span className="text-sm font-semibold">{L("选择录入日期", "Pick record dates")}</span>
                    <span className="text-xs text-muted-foreground">
                        {selection.range
                            ? L(`已选一段（${selCount} 天）`, `${selCount} days`)
                            : L(`已选 ${selCount} 天`, `${selCount} days`)}
                    </span>
                </div>

                {/* 星期表头（吸顶） */}
                <div className="grid grid-cols-7 gap-1 px-3 pt-2 pb-1 text-center text-[11px] text-muted-foreground sticky top-0 bg-background z-10">
                    {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
                        <span key={w}>{w}</span>
                    ))}
                </div>

                {/* 月历本体：上下滚动（手机拖动 / 电脑滚轮） */}
                <div
                    ref={scrollRef}
                    className="max-h-[62vh] overflow-y-auto overscroll-contain px-3 pb-2 touch-pan-y"
                >
                    {cells.map(({ month, flat }) => (
                        <div key={month.title} className="mb-3">
                            <div className="py-1 text-xs font-medium text-muted-foreground">{month.title}</div>
                            <div className="grid grid-cols-7 gap-1">
                                {flat.map((d) => {
                                    const isToday = d.key === todayKey;
                                    const has = hasRecords(d.key);
                                    const isPoint = selection.points.includes(d.key);
                                    const r = selection.range;
                                    const isEnd = !!r && (r.from === d.key || r.to === d.key);
                                    const inRange = !!r && inDayRange(d.key, r.from, r.to);
                                    const bg = isPoint ? GREEN : inRange ? (isEnd ? BLUE : LIGHT_BLUE) : has ? PINK : 'transparent';
                                    const fg = isPoint || isEnd ? '#fff' : d.inMonth ? undefined : '#c0c0c0';
                                    return (
                                        <button
                                            key={d.key}
                                            type="button"
                                            data-day={d.key}
                                            data-range-end={isEnd ? (r!.from === d.key ? 'from' : 'to') : undefined}
                                            onClick={() => onDayClick(d)}
                                            onDoubleClick={() => onDayDoubleClick(d)}
                                            onPointerDown={
                                                isEnd
                                                    ? startDrag(r!.from === d.key ? 'from' : 'to')
                                                    : undefined
                                            }
                                            title={
                                                has
                                                    ? L(`${d.key}（${counts[d.key]} 道）`, `${d.key} (${counts[d.key]})`)
                                                    : d.key
                                            }
                                            className="h-9 rounded text-[13px] tabular-nums relative select-none"
                                            style={{
                                                background: bg,
                                                color: fg,
                                                fontWeight: isToday ? 700 : 400,
                                                outline: isEnd && dragging ? '2px solid #1e40af' : undefined,
                                            }}
                                        >
                                            {/* 今天：橙红黄（他指定的颜色） */}
                                            <span style={isToday && !isPoint && !isEnd ? { color: TODAY } : undefined}>
                                                {d.day}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
                    <span className="text-[11px] leading-tight text-muted-foreground">
                        {L(
                            "点：有记录的日子（变绿）· 双击：起止两端（蓝，可拖）· 再双击蓝点先取消",
                            "Click a recorded day (green) · double-click for a range (blue, draggable)",
                        )}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            className="rounded border px-3 py-1 text-sm"
                            onClick={() => setSelection({ points: [], range: null })}
                        >
                            {L("清除", "Clear")}
                        </button>
                        <button type="button" className="rounded border px-3 py-1 text-sm" onClick={onCancel}>
                            {L("取消", "Cancel")}
                        </button>
                        <button
                            type="button"
                            className="rounded bg-black px-3 py-1 text-sm text-white"
                            onClick={() => onConfirm(selection)}
                        >
                            {L("确认", "OK")}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
