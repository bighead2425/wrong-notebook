'use client';

/**
 * 日积月累 · **打印**（第三轮，2026-10-01）
 *
 * 他要的两件事：
 *   ① **另开一屏**，不要把右栏从"录入"就地切成"打印预览" ——
 *      编辑和打印是两种状态（未保存的改动、量高、分页、页码、页内锁定），
 *      塞进同一个右栏久了必然互相打架。左栏还能复用 ==> 左边挑条目、右边看纸。
 *   ② 版面 = **积累纸**（两栏 + 中间灰竖线 + 每条下留白 1 行），
 *      这正是 09-28 已做好的 `kind='build'`，所以**不是从零做**，是把纸里的内容从"题"换成"积累条目"。
 *
 * 屏内两种状态（用网址区分，刷新/后退都不丢）：
 *   · `/insights/print`          组卷态：左栏勾选，右栏**实时**预览（卷号还是占位）
 *   · `/insights/print?vol=<id>` 已成卷：右栏按**快照**还原（不重量、不重排），可打印
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, House, Layers, Printer, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { useLanguage } from '@/contexts/LanguageContext';
import { whenImagesDecoded, whenImagesSettled } from '@/lib/print-image-readiness';
import { SUBJECT_OPTIONS, subjectLabel } from '@/lib/notebook-fields';
import { GRADE_SEMESTER_OPTIONS } from '@/lib/grade-semester-options';
import {
    paginateMeasured,
    layoutFromSnapshot,
    VOLUME_VARIANTS,
    type MeasuredSheetLayout,
    type SnapshotRow,
} from '@/lib/review-card';
import { InsightBlock, InsightSheet, type InsightPrintRow } from '@/components/print/insight-sheet';

/** 列表里的一条（与 /insights 页同一份接口） */
interface InsightRow {
    id: string;
    code: string;
    gradeSemester?: string | null;
    subject?: string | null;
    content?: string | null;
    errorItemNo?: string | null;
    createdAt?: string;
}

/** 已成卷时读回来的结构（与 GET /api/review-volumes/[id] 一致） */
interface VolumeDetail {
    id: string;
    volumeNo: string;
    kind: string;
    pageCount: number;
    defaultBlankLines: number;
    gradeSemester?: string | null;
    title?: string | null;
    items: {
        id: string;
        insightId: string | null;
        itemNo: string | null;
        questionText: string | null;
        figureUrls: string | null;
        seqInVolume: number;
        pageIndex: number;
        columnIndex: number;
        seqInColumn: number;
    }[];
}

/**
 * ⚠️【2026-10-01 构建失败后补的】**用了 `useSearchParams` 的页面必须包 `<Suspense>`**。
 *
 * 这个文件第一版漏了，`custom-v61` 的镜像在 `RUN npm run build` 直接退出码 1 ——
 * 因为 Next.js 给页面做**静态预渲染**时，遇到没有 Suspense 边界的 `useSearchParams`
 * 会直接报 `missing-suspense-with-csr-bailout` 并中断构建。
 * `tsc --noEmit` 和 eslint **都查不出来**（它们只看类型和风格，不看构建期约束），
 * 本机又因为内存小跑不了 `next build` —— 所以这一条只能靠"照着老页面写"来守。
 *
 * 项目里对这个问题的两条正确路线（**新页面二选一，别走第三条**）：
 *   ① 用 `useSearchParams` ⇒ **必须**像本文件这样包 Suspense
 *      （同样的写法见 `app/print-preview/page.tsx`、`app/page.tsx`、`app/practice/page.tsx`）
 *   ② 只在挂载时读一次 query ⇒ 干脆用 `window.location.search`，**不需要** Suspense
 *      （见 `app/scan/page.tsx`、`app/review-volumes/page.tsx`）
 * 这里有 `router.replace(?vol=…)` 的来回切换，需要 query 变化能驱动重渲染，所以选 ①。
 */
function InsightsPrintContent() {
    const router = useRouter();
    const params = useSearchParams();
    const volId = params.get('vol') || '';
    const { language } = useLanguage();
    const zh = language === 'zh';
    const L = (a: string, b: string) => (zh ? a : b);

    // ============ 左栏：筛 + 检索 ============
    const [rows, setRows] = useState<InsightRow[]>([]);
    const [grade, setGrade] = useState('');
    const [subjectSet, setSubjectSet] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loadingList, setLoadingList] = useState(false);

    // ============ 已成卷 ============
    const [detail, setDetail] = useState<VolumeDetail | null>(null);
    const [busy, setBusy] = useState('');
    /** 提示走页面内的一行字（与复练卷页同一套写法，不引新库） */
    const [notice, setNotice] = useState('');

    const loadList = useCallback(async () => {
        setLoadingList(true);
        try {
            const qs = new URLSearchParams();
            if (grade) qs.set('grade', grade);
            if (subjectSet.size > 0) qs.set('subjects', [...subjectSet].join(','));
            if (query.trim()) qs.set('q', query.trim());
            const res = await apiClient.get<{ insights: InsightRow[] }>(`/api/insights?${qs.toString()}`);
            setRows(res.insights || []);
        } catch {
            setRows([]);
        } finally {
            setLoadingList(false);
        }
    }, [grade, subjectSet, query]);

    useEffect(() => {
        if (!volId) loadList();
    }, [loadList, volId]);

    useEffect(() => {
        if (!volId) {
            setDetail(null);
            return;
        }
        let alive = true;
        (async () => {
            try {
                const res = await apiClient.get<{ volume: VolumeDetail }>(`/api/review-volumes/${volId}`);
                if (alive) setDetail(res.volume);
            } catch {
                if (alive) {
                    setNotice(L('这份卷读不到了（可能已被删除）', 'This volume is gone'));
                    router.replace('/insights/print');
                }
            }
        })();
        return () => {
            alive = false;
        };
        // L 每次渲染都是新函数，进依赖会死循环 —— 与复练卷页同一处写法
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volId, router]);

    // ================= 这一屏要印的条目 =================
    /** 已成卷 ⇒ 卷里那几行（按卷内顺序）；组卷态 ⇒ 左栏勾中的（按列表顺序） */
    const printRows = useMemo<InsightPrintRow[]>(() => {
        if (detail) {
            return detail.items
                .filter((it) => it.insightId)
                .sort((a, b) => a.seqInVolume - b.seqInVolume)
                .map((it) => ({
                    id: it.insightId!,
                    code: it.itemNo || '',
                    content: it.questionText || '',
                    photoUrl: firstFigure(it.figureUrls),
                }));
        }
        return rows.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, code: r.code, content: r.content || '' }));
    }, [detail, rows, selected]);

    /** 组卷态拿不到图（列表接口刻意不返回图本体）⇒ 预览里先不画，建卷时服务端补进快照 */
    const rowByKey = useMemo(() => {
        const m: Record<string, InsightPrintRow> = {};
        for (const r of printRows) m[r.id] = r;
        return m;
    }, [printRows]);

    // ================= 量高度 → 分页（与复练纸同一套：先量真实高度，再分页） =================
    const [measured, setMeasured] = useState<Record<string, number>>({});
    const measureRef = useRef<HTMLDivElement | null>(null);
    const measureKey = useMemo(() => printRows.map((r) => r.id).join('|'), [printRows]);

    useEffect(() => {
        if (printRows.length === 0) {
            setMeasured({});
            return;
        }
        let cancelled = false;
        (async () => {
            await whenImagesSettled();
            await whenImagesDecoded(measureRef.current);
            if (cancelled) return;
            const el = measureRef.current;
            if (!el) return;
            const out: Record<string, number> = {};
            el.querySelectorAll<HTMLElement>('[data-insight-block]').forEach((node) => {
                const key = node.dataset.insightBlock;
                if (!key) return;
                // px → mm（与复练卷页完全同一个换算，别写第二份）
                out[key] = (node.getBoundingClientRect().height * 25.4) / 96;
            });
            if (!cancelled) setMeasured(out);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [measureKey]);

    const blankLines = detail?.defaultBlankLines ?? VOLUME_VARIANTS.build.defaultBlankLines;

    /**
     * 版面：已成卷 ⇒ **按快照还原**（不重量、不重排 —— 页归属只认快照，
     * 否则手机扫这一页的二维码跳出来就对不上了）；组卷态 ⇒ 现量现排。
     */
    const layout = useMemo<MeasuredSheetLayout | null>(() => {
        if (detail) {
            const snap: SnapshotRow[] = detail.items.map((it) => ({
                key: it.insightId || it.id,
                seq: it.seqInVolume,
                pageIndex: it.pageIndex,
                columnIndex: it.columnIndex,
                seqInColumn: it.seqInColumn,
            }));
            return layoutFromSnapshot(snap, 'build');
        }
        if (printRows.length === 0 || Object.keys(measured).length === 0) return null;
        const blocks = printRows.map((r) => ({ key: r.id, heightMM: measured[r.id] ?? 0 }));
        return paginateMeasured(blocks, 'build');
    }, [detail, printRows, measured]);

    const pageCount = layout?.pages.length ?? 0;
    /** 组卷态给个占位卷号（纸上要有个东西占位；真正印之前一定先建卷） */
    const volumeNo = detail?.volumeNo || L('（未生成）', '(not built)');

    // ================= 建卷 / 打印 =================
    const buildVolume = useCallback(async () => {
        if (printRows.length === 0 || !layout) return;
        setBusy('building');
        try {
            const items = layout.pages.flatMap((page, pi) =>
                page.columns.flatMap((col, ci) =>
                    col.blocks.map((b, bi) => {
                        const row = rowByKey[b.key];
                        return {
                            insightId: row?.id ?? null,
                            errorItemId: null,
                            seqInVolume: b.seq,
                            pageIndex: pi + 1,
                            columnIndex: ci,
                            seqInColumn: bi + 1,
                            // **快照**：编号 + 正文（图由服务端按 insightId 补）
                            itemNo: row?.code ?? null,
                            questionText: row?.content ?? null,
                        };
                    }),
                ),
            );
            const res = await apiClient.post<{ volume: { id: string } }>('/api/review-volumes', {
                kind: 'build',
                gradeSemester: grade || null,
                defaultBlankLines: blankLines,
                pageCount: layout.pages.length,
                items,
            });
            setNotice(L('已生成积累卷', 'Volume built'));
            router.replace(`/insights/print?vol=${res.volume.id}`);
        } catch {
            setNotice(L('生成失败，请重试', 'Failed, please retry'));
        } finally {
            setBusy('');
        }
        // 同上：L 不进依赖
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [printRows, layout, rowByKey, grade, blankLines, router]);

    const doPrint = useCallback(() => {
        window.print();
    }, []);

    const toggleAll = () => {
        if (selected.size === rows.length) setSelected(new Set());
        else setSelected(new Set(rows.map((r) => r.id)));
    };
    const toggleOne = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    return (
        <div className="min-h-screen bg-muted/30">
            {/* ===== 顶栏 ===== */}
            <div className="no-print flex items-center gap-2 border-b bg-background px-3 py-2">
                <Button
                    variant="ghost"
                    size="icon"
                    title={L('返回日积月累', 'Back to takeaways')}
                    onClick={() => router.push('/insights')}
                >
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <h1 className="text-base sm:text-lg font-semibold truncate">
                    {L('积累纸 · 打印', 'Takeaways · print')}
                </h1>
                {detail && (
                    <span className="text-xs font-mono text-muted-foreground hidden sm:inline">{detail.volumeNo}</span>
                )}
                <span className="flex-1" />
                {detail ? (
                    <>
                        <Button variant="outline" size="sm" onClick={() => router.replace('/insights/print')}>
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            {L('重新挑', 'Pick again')}
                        </Button>
                        <Button size="sm" onClick={doPrint}>
                            <Printer className="mr-1.5 h-3.5 w-3.5" />
                            {L('打印', 'Print')}
                        </Button>
                    </>
                ) : (
                    <Button size="sm" disabled={printRows.length === 0 || !layout || busy === 'building'} onClick={buildVolume}>
                        <Layers className="mr-1.5 h-3.5 w-3.5" />
                        {busy === 'building'
                            ? L('生成中…', 'Building…')
                            : L(`生成积累卷（${printRows.length} 条）`, `Build (${printRows.length})`)}
                    </Button>
                )}
                <Link href="/">
                    <Button variant="ghost" size="icon" title={L('回主页', 'Home')}>
                        <House className="h-5 w-5" />
                    </Button>
                </Link>
            </div>

            {notice && (
                <div className="no-print px-3 pt-2">
                    <div className="rounded-md border bg-background px-3 py-1.5 text-sm">{notice}</div>
                </div>
            )}

            <div className="flex flex-col lg:flex-row gap-3 p-3">
                {/* ===== 左栏：挑条目 ===== */}
                <aside className="no-print w-full lg:w-[320px] shrink-0 space-y-2">
                    <div className="rounded-lg border bg-background p-3 space-y-2">
                        <div className="text-sm font-semibold">{L('挑要印的条目', 'Pick entries')}</div>
                        <select
                            className="w-full h-8 rounded-md border bg-background px-2 text-sm"
                            value={grade}
                            onChange={(e) => setGrade(e.target.value)}
                        >
                            <option value="">{L('全部年级/学期', 'All terms')}</option>
                            {GRADE_SEMESTER_OPTIONS.map((g) => (
                                <option key={g} value={g}>
                                    {g}
                                </option>
                            ))}
                        </select>
                        <div className="flex flex-wrap gap-1">
                            {SUBJECT_OPTIONS.map((s) => {
                                const on = subjectSet.has(s.key);
                                return (
                                    <button
                                        key={s.key}
                                        type="button"
                                        onClick={() =>
                                            setSubjectSet((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(s.key)) next.delete(s.key);
                                                else next.add(s.key);
                                                return next;
                                            })
                                        }
                                        className={
                                            on
                                                ? 'rounded border px-2 py-0.5 text-xs bg-primary text-primary-foreground'
                                                : 'rounded border px-2 py-0.5 text-xs bg-background hover:bg-accent'
                                        }
                                    >
                                        {subjectLabel(s.key)}
                                    </button>
                                );
                            })}
                        </div>
                        <input
                            className="w-full h-8 rounded-md border bg-background px-2 text-sm"
                            placeholder={L('搜编号或内容', 'Search code or text')}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                                {L('共', 'Total')} {rows.length} {L('条', '')} · {L('已选', 'Picked')} {selected.size}
                            </span>
                            <button type="button" className="underline" onClick={toggleAll}>
                                {selected.size === rows.length ? L('全不选', 'None') : L('全选', 'All')}
                            </button>
                        </div>
                    </div>

                    <div className="space-y-1 max-h-[55vh] overflow-y-auto">
                        {loadingList && <div className="p-3 text-sm text-muted-foreground">{L('加载中…', 'Loading…')}</div>}
                        {!loadingList && rows.length === 0 && (
                            <div className="p-3 text-sm text-muted-foreground">
                                {L('没有符合条件的条目', 'Nothing here')}
                            </div>
                        )}
                        {rows.map((r) => (
                            <label
                                key={r.id}
                                className="flex gap-2 rounded-md border bg-background p-2 text-sm cursor-pointer hover:bg-accent/40"
                            >
                                <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={selected.has(r.id)}
                                    onChange={() => toggleOne(r.id)}
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="block font-mono text-xs text-muted-foreground">{r.code}</span>
                                    <span className="block line-clamp-2">{(r.content || '').replace(/[#>*_`-]/g, ' ')}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                </aside>

                {/* ===== 右栏：纸 ===== */}
                <main className="flex-1 min-w-0">
                    {printRows.length === 0 ? (
                        <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
                            {detail
                                ? L('这一卷没有内容', 'This volume is empty')
                                : L('在左边勾几条，这里就会出纸', 'Pick some entries on the left')}
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {layout?.pages.map((page, i) => (
                                <InsightSheet
                                    key={i}
                                    page={page}
                                    pageNo={i + 1}
                                    pageCount={pageCount}
                                    volumeNo={volumeNo}
                                    gradeText={detail?.gradeSemester ?? grade ?? null}
                                    rowByKey={rowByKey}
                                    blankLines={blankLines}
                                    L={L}
                                />
                            ))}
                        </div>
                    )}
                </main>
            </div>

            {/* ===== 量尺容器：与正式渲染**同一个** InsightBlock，保证"量到的"就是"印出来的" ===== */}
            <div
                ref={measureRef}
                aria-hidden="true"
                className="print-review-measure no-print"
                style={{ position: 'absolute', left: '-10000px', top: 0, width: '182mm' }}
            >
                {printRows.map((r) => (
                    <InsightBlock key={r.id} row={r} blankLines={blankLines} showDivider={false} L={L} />
                ))}
            </div>
        </div>
    );
}

export default function InsightsPrintPage() {
    const { t } = useLanguage();
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">{t.common.loading}</div>
            }
        >
            <InsightsPrintContent />
        </Suspense>
    );
}

/** 快照里的图（JSON 数组字符串）取第一张 —— 一条积累最多一张（他定的规则） */
function firstFigure(raw: string | null): string | null {
    if (!raw) return null;
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) && typeof arr[0] === 'string' ? arr[0] : null;
    } catch {
        return null;
    }
}
