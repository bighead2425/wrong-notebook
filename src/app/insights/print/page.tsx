'use client';

/**
 * 积累纸 · **打印页**（2026-10-01 按他的职责划分重写）
 *
 * ── 他定的分工（原话）──────────────────────────────────────────
 * > "逻辑上应该是从日积月累页选中推入积累纸打印，这样日积月累页管理的是每条日积月累，
 * >  然后让哪些日积月累组成积累纸就在**日积月累页**决定；送到积累纸打印后，
 * >  用**这个页面**管理生成过哪些打印的积累纸，这些积累纸都有编号，
 * >  在这个打印的页面中还可以进行排版。这样功能就分开并清晰起来。"
 *
 * 他还给了个很准的类比：
 *   日积月累页**左栏 ≈ 错题本页**（清单 + 筛选）／**右栏 ≈ 错题详情页**（单条编辑）
 *   ⇒ **积累纸打印页 ≈ 复练卷页**（左栏列卷、右栏看纸）
 *
 * ⚠️ 所以这一页**不再承担"挑条目"**（那是日积月累页的事），只回答两件事：
 *   ① 我印过哪些积累纸（卷列表，带 `BU…` 编号）；
 *   ② 这一卷的纸长什么样、要不要排版。
 *
 * 屏内两态（用网址区分，刷新/后退都不丢）：
 *   · `/insights/print`          卷列表
 *   · `/insights/print?vol=<id>` 看这一卷的纸 + 排版三件套
 */

import {
    Suspense,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
    ArrowLeft,
    House,
    Loader2,
    PanelLeftClose,
    PanelLeftOpen,
    Pencil,
    Printer,
    Save,
    ScanLine,
    Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { useLanguage } from '@/contexts/LanguageContext';
import { whenImagesDecoded, whenImagesSettled } from '@/lib/print-image-readiness';
import {
    paginateMeasured,
    layoutFromSnapshot,
    VOLUME_VARIANTS,
    figureScaleFromDrag,
    type MeasuredSheetLayout,
    type SnapshotRow,
} from '@/lib/review-card';
import { makeQrDataUrl } from '@/lib/qr';
import { pageQrPayload } from '@/components/print/review-card';
import {
    INSIGHT_FOOTER_MM,
    InsightBlock,
    InsightSheet,
    type InsightPrintRow,
} from '@/components/print/insight-sheet';
import { SheetZoom } from '@/components/print/sheet-zoom';
import { InsightScanView } from '@/components/insight-scan-view';
import { buildPageCode } from '@/lib/volume-code';
import { shouldWarnBeforeLeaving, unsavedLeaveMessage } from '@/lib/unsaved-guard';

/** 卷列表里的一项 */
interface VolumeSummary {
    id: string;
    volumeNo: string;
    title?: string | null;
    kind: string;
    pageCount: number;
    itemCount: number;
    gradeSemester?: string | null;
    createdAt: string;
}

/** 卷内一行（快照列 + 软链接） */
interface VolumeItemRow {
    id: string;
    insightId: string | null;
    itemNo: string | null;
    questionText: string | null;
    figureUrls: string | null;
    figureScale: number;
    seqInVolume: number;
    pageIndex: number;
    columnIndex: number;
    seqInColumn: number;
}

interface VolumeDetail {
    id: string;
    volumeNo: string;
    kind: string;
    pageCount: number;
    defaultBlankLines: number;
    gradeSemester?: string | null;
    title?: string | null;
    /** 【2026-10-03 需求第 10 条】这份积累纸的随机 emoji 标识（整份所有页共用） */
    emojiMark?: string | null;
    createdAt: string;
    items: VolumeItemRow[];
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

/**
 * ⚠️ **必须包 Suspense**：`useSearchParams` 没有被 Suspense 边界包住时，
 * Next 给页面做静态预渲染会报 `missing-suspense-with-csr-bailout` 并**中断构建**
 * （2026-10-01 `custom-v61` 就是这么炸的）。
 * 项目里有自检测试守着：`src/__tests__/unit/next-build-conventions.test.ts`。
 */
export default function InsightsPrintPage() {
    const { t } = useLanguage();
    return (
        <Suspense
            fallback={<div className="flex min-h-screen items-center justify-center">{t.common.loading}</div>}
        >
            <PrintContent />
        </Suspense>
    );
}

function PrintContent() {
    const params = useSearchParams();
    const volId = params.get('vol') || '';
    const newIds = params.get('new') || '';
    // 【2026-10-01】日积月累页勾完点【送入积累纸打印】⇒ 跳这里带上 `?new=id,id,…`
    if (newIds) return <NewVolume ids={newIds.split(',').filter(Boolean)} />;
    return <PrintWorkspace volId={volId} />;
}

/* ══════════════════════════════════════════════════════════════════
 * 工作台：**左右两栏**（他 2026-10-02 要求把"卷列表页"和"看纸页"合并）
 *
 * 他原话："积累纸·打印页面，和点击其中某一卷后打开的那份具体版面页，进行合并，
 * 做成左右两栏格式，标题名还叫'积累纸·打印'；左边栏是每次生成的积累纸名称，
 * 点击某个内容后，右边栏生成这份积累纸的版面预览，形式和日积月累页版面一样，
 * 上面也配备一个左边栏隐藏的按钮。"
 * ⇒ 与复练卷页、日积月累页**同一个版式语言**：左栏列表 + 右栏内容 + 可藏左栏。
 * ══════════════════════════════════════════════════════════════════ */

function PrintWorkspace({ volId }: { volId: string }) {
    const router = useRouter();
    const { language } = useLanguage();
    const zh = language === 'zh';
    const L = (a: string, b: string) => (zh ? a : b);

    const [listOpen, setListOpen] = useState(true);
    const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState('');
    /**
     * 【2026-10-03 需求第 4 条】右栏那份纸"改过版面还没保存"没有 —— 由子组件 `VolumePaper`
     * 报上来（脏状态本身在它那儿）。顶栏的返回/主页、左栏的切卷都据此拦截。
     */
    const [paperDirty, setPaperDirty] = useState(false);
    /** 【2026-10-03 需求第 5 条】【扫码图】那一屏（非空即进入）；返回时清空、回到同一份纸 */
    const [scanCode, setScanCode] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiClient.get<{ volumes: VolumeSummary[] }>(
                '/api/review-volumes?kind=build&limit=100',
            );
            setVolumes(res.volumes || []);
        } catch {
            setNotice(L('卷列表读不出来', 'Failed to load volumes'));
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const removeVolume = async (v: VolumeSummary) => {
        if (
            !confirm(
                L(
                    `删掉积累纸 ${v.volumeNo}？（纸没了，积累条目本身不受影响）`,
                    `Delete ${v.volumeNo}? (the entries themselves are untouched)`,
                ),
            )
        ) {
            return;
        }
        try {
            await apiClient.delete(`/api/review-volumes/${v.id}`);
            setVolumes((prev) => prev.filter((x) => x.id !== v.id));
            if (v.id === volId) router.replace('/insights/print');
        } catch {
            setNotice(L('删除失败', 'Delete failed'));
        }
    };

    /** 会丢改动的动作先问一句；点取消返回 false（停在原地、改动还在） */
    const confirmDiscard = useCallback(
        (actionZh: string, actionEn: string) => {
            if (!shouldWarnBeforeLeaving(paperDirty)) return true;
            return window.confirm(unsavedLeaveMessage(zh, actionZh, actionEn));
        },
        [paperDirty, zh],
    );

    /** 切换 / 打开另一份积累纸（左栏点击）—— 改过没保存时拦一下 */
    const openSheet = (id: string) => {
        if (id === volId) return; // 已经是这一份：不做无意义的导航
        if (!confirmDiscard('切换积累纸', 'Switch sheet')) return;
        setScanCode(null);
        setPaperDirty(false);
        router.push(`/insights/print?vol=${id}`);
    };

    /**
     * 【2026-10-03 需求第 4 条】浏览器**关闭 / 刷新**标签页那一手也拦一下：
     * 仅在 `paperDirty` 时挂监听（没改就正常关，别无故弹原生框）。
     */
    useEffect(() => {
        if (!paperDirty) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [paperDirty]);

    return (
        <div className="min-h-screen bg-muted/30">
            {/* 顶栏：标题 + 藏左栏 + 去日积月累挑 + 回主页。
                【2026-10-02】他嫌原来那句说明太长 ⇒ 已删（原话："不要了，太长了"）。 */}
            {/* 【2026-10-03 他要求】顶栏也**居中限宽**（原来标题顶左、按钮顶右），规格与
                左右两栏、日积月累页、复练卷页一致。
                另外他明确："右上角那个'去勾选条目'的按钮可以不要了，
                在'积累纸·打印'标签前增加一个向左的箭头，点击回到日积月累页"。 */}
            <div className="no-print border-b bg-background shadow-sm">
                <div className="mx-auto flex w-full max-w-[1600px] items-center gap-2 px-4 py-3 md:px-8">
                    <Button
                        variant="ghost"
                        size="icon"
                        title={L('返回日积月累', 'Back to takeaways')}
                        onClick={() => {
                            if (!confirmDiscard('返回', 'Go back')) return;
                            router.push('/insights');
                        }}
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <h1 className="text-base font-semibold sm:text-lg">
                        {L('积累纸 · 打印', 'Takeaways · print')}
                    </h1>
                    <span className="flex-1" />
                    <Button
                        variant="outline"
                        size="icon"
                        title={listOpen ? L('隐藏左栏', 'Hide list') : L('显示左栏', 'Show list')}
                        onClick={() => setListOpen((v) => !v)}
                    >
                        {listOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                    </Button>
                    <Link
                        href="/"
                        onClick={(e) => {
                            if (!confirmDiscard('回主页', 'Go home')) e.preventDefault();
                        }}
                    >
                        <Button variant="ghost" size="icon" title={L('回主页', 'Home')}>
                            <House className="h-5 w-5" />
                        </Button>
                    </Link>
                </div>
            </div>

            {notice && (
                <div className="no-print px-3 pt-2 md:px-8">
                    <div className="mx-auto max-w-[1600px] rounded-md border bg-background px-3 py-1.5 text-sm">
                        {notice}
                    </div>
                </div>
            )}

            {/* ⚠️ 内容**居中限宽**（他："日积月累页面的上面就比较合适，
                现在积累纸·打印页面左右又顶在左右边上了"）——与日积月累页同一个包裹。 */}
            <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-3 md:px-8 lg:flex-row">
                {listOpen && (
                    <aside className="w-full shrink-0 lg:w-[300px]">
                        <div className="flex max-h-[76vh] flex-col gap-2 overflow-y-auto rounded-md border bg-background p-2">
                            {loading ? (
                                <div className="flex items-center justify-center py-10 text-muted-foreground">
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    {L('正在读…', 'Loading…')}
                                </div>
                            ) : volumes.length === 0 ? (
                                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                                    {L(
                                        '还没有印过积累纸。到日积月累页勾几条，点【送入积累纸打印】。',
                                        'No sheets yet. Pick entries on the takeaways page.',
                                    )}
                                </div>
                            ) : (
                                volumes.map((v) => {
                                    const active = v.id === volId;
                                    return (
                                        <div
                                            key={v.id}
                                            className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 transition-colors ${
                                                active ? 'border-primary bg-accent/60' : 'hover:bg-accent/30'
                                            }`}
                                            onClick={() => openSheet(v.id)}
                                        >
                                            <div className="min-w-0 flex-1">
                                                <div className="font-mono text-xs font-semibold">{v.volumeNo}</div>
                                                {v.title && (
                                                    <div className="truncate text-[11px] text-muted-foreground">
                                                        {v.title}
                                                    </div>
                                                )}
                                                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                                                    <span>{L(`${v.itemCount} 条`, `${v.itemCount}`)}</span>
                                                    <span>·</span>
                                                    <span>{L(`${v.pageCount} 页`, `${v.pageCount}p`)}</span>
                                                    <span>·</span>
                                                    <span>
                                                        {new Date(v.createdAt).toLocaleDateString(
                                                            zh ? 'zh-CN' : 'en-US',
                                                        )}
                                                    </span>
                                                </div>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                className="text-muted-foreground hover:text-destructive"
                                                title={L('删掉这一卷', 'Delete')}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    removeVolume(v);
                                                }}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </aside>
                )}

                <section className="min-w-0 flex-1">
                    {scanCode ? (
                        /* 【2026-10-03 需求第 5 条】【扫码图】那一屏：复用扫码页的 `InsightScanView`
                           （只多传了个 backLabel）。返回按钮文案改成"回到预览"，
                           点了清空 scanCode ⇒ 回到同一份纸的预览（volId 没动过）。 */
                        <div className="space-y-3">
                            <h1 className="flex items-center gap-2 text-lg font-bold">
                                <ScanLine className="h-5 w-5" />
                                {L('扫到的积累纸', 'Scanned takeaway sheet')}
                            </h1>
                            <InsightScanView
                                code={scanCode}
                                backLabel={L('回到预览', 'Back to preview')}
                                onBack={() => setScanCode(null)}
                                onPickItem={(insightCode) =>
                                    router.push(
                                        `/insights?pick=${encodeURIComponent(insightCode)}&noleft=1&back=${encodeURIComponent(`/insights/print?vol=${volId}`)}`,
                                    )
                                }
                            />
                        </div>
                    ) : volId ? (
                        <VolumePaper
                            id={volId}
                            onDirtyChange={setPaperDirty}
                            onScan={(code) => {
                                setPaperDirty(false);
                                setScanCode(code);
                            }}
                        />
                    ) : (
                        <div className="rounded-lg border border-dashed bg-background px-6 py-16 text-center text-sm text-muted-foreground">
                            {L('左边点一份积累纸，这里就能看到它的纸面。', 'Pick a sheet on the left.')}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
 * 过渡态：**把刚挑好的条目排成卷**
 *
 * 为什么这一步放在打印页、而不是日积月累页直接建卷：
 *   建卷必须知道**每一条排在第几页第几栏**，而那要先**量出真实高度**再分栏分页
 *   （与复练卷同一个算法）。量高要靠真正的 DOM 渲染 —— 这套能力在打印页有，
 *   日积月累页没有。所以做法是：日积月累页只负责"挑"（传过来一串 id），
 *   到这里排好、存成卷，再跳到 `?vol=` 让用户看到纸。
 *   他期望的体感仍是"勾完一点就来到纸上"，中间这一步是瞬时的。
 * ══════════════════════════════════════════════════════════════════ */

function NewVolume({ ids }: { ids: string[] }) {
    const router = useRouter();
    const { language } = useLanguage();
    const zh = language === 'zh';
    const L = (a: string, b: string) => (zh ? a : b);

    const [rows, setRows] = useState<InsightPrintRow[]>([]);
    const [gradeSemester, setGradeSemester] = useState<string | null>(null);
    const [measured, setMeasured] = useState<Record<string, number>>({});
    const [failed, setFailed] = useState('');
    const measureRef = useRef<HTMLDivElement | null>(null);
    /** 防重复建卷（React 严格模式 / 重渲染都会跑两次 effect） */
    const builtRef = useRef(false);

    const blankLines = 1;

    /** 拉条目（含配图）—— 逐条取；勾选量一般是几条到几十条，并行取够快 */
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const list = await Promise.all(
                    ids.map((id) =>
                        apiClient
                            .get<{ id: string; code: string; content?: string | null; photo?: string | null; gradeSemester?: string | null }>(
                                `/api/insights/${id}`,
                            )
                            .catch(() => null),
                    ),
                );
                if (!alive) return;
                const ok = list.filter(Boolean) as Array<{
                    id: string;
                    code: string;
                    content?: string | null;
                    photo?: string | null;
                    gradeSemester?: string | null;
                }>;
                setRows(
                    ok.map((r) => ({ id: r.id, code: r.code, content: r.content || '', photoUrl: r.photo || null })),
                );
                setGradeSemester(ok.find((r) => r.gradeSemester)?.gradeSemester ?? null);
                if (ok.length === 0) setFailed(L('这些条目读不到了', 'Entries not found'));
            } catch {
                if (alive) setFailed(L('读取失败', 'Failed to load'));
            }
        })();
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ids.join(',')]);

    const rowByKey = useMemo(() => {
        const m: Record<string, InsightPrintRow> = {};
        for (const r of rows) m[r.id] = r;
        return m;
    }, [rows]);

    /** 量高（图片解码后）—— 与复练卷页同一个换算 px→mm */
    useEffect(() => {
        if (rows.length === 0) return;
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
                out[key] = (node.getBoundingClientRect().height * 25.4) / 96;
            });
            if (!cancelled) setMeasured(out);
        })();
        return () => {
            cancelled = true;
        };
    }, [rows]);

    const layout = useMemo<MeasuredSheetLayout | null>(() => {
        if (rows.length === 0 || Object.keys(measured).length === 0) return null;
        // ⚠️ 第三个参数 = 纸面下边留的页脚空隙（与 InsightSheet 的 paddingBottom 同源）——
        //    不传的话算法会以为还能多塞 6mm ⇒ 最后一屏溢出。
        return paginateMeasured(
            rows.map((r) => ({ key: r.id, heightMM: measured[r.id] ?? 0 })),
            'build',
            INSIGHT_FOOTER_MM,
        );
    }, [rows, measured]);

    /** 排好了就建卷、然后跳到那一卷的纸 */
    useEffect(() => {
        if (!layout || builtRef.current || rows.length === 0) return;
        builtRef.current = true;
        (async () => {
            try {
                const items = layout.pages.flatMap((page, pi) =>
                    page.columns.flatMap((col, ci) =>
                        col.blocks.map((b, bi) => {
                            const row = rowByKey[b.key];
                            return {
                                insightId: b.key,
                                errorItemId: null,
                                seqInVolume: b.seq,
                                pageIndex: pi + 1,
                                columnIndex: ci,
                                seqInColumn: bi + 1,
                                // 快照：编号 + 正文（**配图由服务端按 insightId 补**，前端不必传）
                                itemNo: row?.code ?? null,
                                questionText: row?.content ?? null,
                                manageType: null,
                                blankLines,
                                figureScale: 100,
                            };
                        }),
                    ),
                );
                const res = await apiClient.post<{ volume: { id: string } }>('/api/review-volumes', {
                    kind: 'build',
                    gradeSemester,
                    defaultBlankLines: blankLines,
                    pageCount: layout.pages.length,
                    items,
                });
                // replace 而不是 push：这一屏是个中间步骤，不该留在后退栈里
                router.replace(`/insights/print?vol=${res.volume.id}`);
            } catch {
                builtRef.current = false;
                setFailed(L('生成积累纸失败，请重试', 'Failed to build the sheet'));
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layout, rows.length, gradeSemester]);

    return (
        <div className="min-h-screen bg-muted/30">
            <div className="no-print flex items-center gap-2 border-b bg-background px-3 py-2">
                <h1 className="text-base font-semibold sm:text-lg">
                    {L('正在把这几条排成积累纸…', 'Laying out your sheet…')}
                </h1>
            </div>
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-muted-foreground">
                {failed ? (
                    <>
                        <p className="text-sm">{failed}</p>
                        <Link href="/insights">
                            <Button variant="outline" size="sm">
                                {L('回日积月累页', 'Back')}
                            </Button>
                        </Link>
                    </>
                ) : (
                    <>
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <p className="text-sm">
                            {L(`${rows.length} 条 · 正在量尺寸、分栏分页`, `${rows.length} entries — measuring…`)}
                        </p>
                    </>
                )}
            </div>

            {/* 隐藏量尺：与正式渲染**同一个** InsightBlock（"量到的"就是"印出来的"） */}
            <div
                ref={measureRef}
                aria-hidden="true"
                className="print-review-measure no-print"
                style={{
                        position: 'absolute',
                        left: '-10000px',
                        top: 0,
                        /**
                         * 【2026-10-02 修·分页 bug 根因】量尺宽度必须是**单栏宽**
         * （积累纸两栏，每栏约 83mm），不能是整纸 182mm！
         * 我第一版用 182mm ⇒ 文字在量尺里铺得很开、量出来的高度**远小于**
         * 真实两栏里的高度 ⇒ 分页算法以为全塞得下 ⇒ **一页堆死、内容溢出**
         * （他截图里"纸面上左右两栏都有打印出去的情况"正是这个）。
         * 复练纸没踩这个坑是因为它是**单栏**，量尺宽度恰好等于栏宽。
         */
                        width: `${VOLUME_VARIANTS.build.columnWidthMM}mm`,
                    }}
            >
                {rows.map((r) => (
                    <InsightBlock key={r.id} row={r} blankLines={blankLines} showDivider={false} L={L} />
                ))}
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
 * 二、看某一卷的纸 + 排版三件套
 *
 * 三件套（他 2026-10-01 拍板"三个都要"）：
 *   ① 每条下面的**留白行数**  ② 条目的**先后顺序**  ③ 配图的**大小**
 *
 * 改动先落**本地草稿**，工具栏出现【保存版面】才写回快照 ——
 * 与复练卷页的"更新组卷"同一套手感（卷是印出去的凭证，不能一点就变）。
 * ══════════════════════════════════════════════════════════════════ */

function VolumePaper({
    id,
    onDirtyChange,
    onScan,
}: {
    id: string;
    /** 【2026-10-03 需求第 4 条】把"这份纸改过没保存"报给上层（顶栏/左栏据此拦截） */
    onDirtyChange: (dirty: boolean) => void;
    /** 【2026-10-03 需求第 5 条】点【扫码图】⇒ 上层切到扫码预览那一屏（传页二维码内容） */
    onScan: (code: string) => void;
}) {
    const router = useRouter();
    const { language } = useLanguage();
    const zh = language === 'zh';
    const L = (a: string, b: string) => (zh ? a : b);

    const [detail, setDetail] = useState<VolumeDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState('');
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');

    /** 草稿：条目顺序 / 每条图缩放 / 整卷留白行数 */
    const [order, setOrder] = useState<string[]>([]);
    const [figures, setFigures] = useState<Record<string, number>>({});
    const [blankLines, setBlankLines] = useState<number>(1);

    /** 量出来的每条高度（改过版面才需要重排，那时只能现量） */
    const [measured, setMeasured] = useState<Record<string, number>>({});
    const measureRef = useRef<HTMLDivElement | null>(null);
    /** 页眉二维码（dataURL，按页号）—— 见下面那个 effect 的说明 */
    const [pageQrMap, setPageQrMap] = useState<Record<number, string>>({});

    useEffect(() => {
        let alive = true;
        (async () => {
            setLoading(true);
            try {
                const res = await apiClient.get<{ volume: VolumeDetail }>(`/api/review-volumes/${id}`);
                if (!alive) return;
                const v = res.volume;
                setDetail(v);
                setTitleDraft(v.title || '');
                setBlankLines(v.defaultBlankLines ?? 1);
                const sorted = [...(v.items || [])]
                    .filter((it) => it.insightId)
                    .sort((a, b) => a.seqInVolume - b.seqInVolume);
                setOrder(sorted.map((it) => it.insightId!));
                const fig: Record<string, number> = {};
                for (const it of sorted) fig[it.insightId!] = it.figureScale ?? 100;
                setFigures(fig);
            } catch {
                if (alive) {
                    setNotice(L('这份卷读不到了（可能已被删除）', 'This volume is gone'));
                    router.replace('/insights/print');
                }
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    /** 卷内行（按 insightId 索引）—— 排纸时要用它的**快照内容** */
    const rowById = useMemo(() => {
        const m: Record<string, VolumeItemRow> = {};
        for (const it of detail?.items || []) {
            if (it.insightId) m[it.insightId] = it;
        }
        return m;
    }, [detail]);

    /** 当前顺序下的打印行 */
    const printRows = useMemo<InsightPrintRow[]>(
        () =>
            order
                .map((k) => rowById[k])
                .filter(Boolean)
                .map((r) => ({
                    id: r.insightId!,
                    code: r.itemNo || '',
                    content: r.questionText || '',
                    photoUrl: firstFigure(r.figureUrls),
                })),
        [order, rowById],
    );

    const rowByKey = useMemo(() => {
        const m: Record<string, InsightPrintRow> = {};
        for (const r of printRows) m[r.id] = r;
        return m;
    }, [printRows]);

    /** 改过版面没有（改了才出【保存版面】） */
    const dirty = useMemo(() => {
        if (!detail) return false;
        const orig = [...(detail.items || [])]
            .filter((it) => it.insightId)
            .sort((a, b) => a.seqInVolume - b.seqInVolume)
            .map((it) => it.insightId!);
        if (orig.length !== order.length || orig.some((k, i) => k !== order[i])) return true;
        if ((detail.defaultBlankLines ?? 1) !== blankLines) return true;
        for (const it of detail.items || []) {
            if (!it.insightId) continue;
            if ((figures[it.insightId] ?? 100) !== (it.figureScale ?? 100)) return true;
        }
        return false;
    }, [detail, order, blankLines, figures]);

    /** 【2026-10-03 需求第 4 条】把脏状态报给上层 —— 顶栏的返回/主页、左栏的切卷据此弹确认 */
    useEffect(() => {
        onDirtyChange(dirty);
    }, [dirty, onDirtyChange]);

    /* ── 量高：只有"改过版面"时才需要（没改就按**快照**还原，一个字不重量） ── */
    const measureKey = useMemo(
        () =>
            `${dirty ? 'draft' : 'snap'}#${printRows.map((r) => r.id).join('|')}#${blankLines}#${JSON.stringify(figures)}`,
        [dirty, printRows, blankLines, figures],
    );

    useEffect(() => {
        if (!dirty || printRows.length === 0) return;
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
                out[key] = (node.getBoundingClientRect().height * 25.4) / 96;
            });
            if (!cancelled) setMeasured(out);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [measureKey]);

    /**
     * 版面：
     *  · **没改** ⇒ 按快照还原（不重量不重排 —— 页归属只认快照，扫码才对得上）；
     *  · **改了** ⇒ 拿量出来的真实高度重新分栏分页（与组卷时同一个算法）。
     */
    const layout = useMemo<MeasuredSheetLayout | null>(() => {
        if (!detail) return null;
        if (!dirty) {
            const snap: SnapshotRow[] = (detail.items || [])
                .filter((it) => it.insightId)
                .map((it) => ({
                    key: it.insightId!,
                    seq: it.seqInVolume,
                    pageIndex: it.pageIndex,
                    columnIndex: it.columnIndex,
                    seqInColumn: it.seqInColumn,
                }));
            return layoutFromSnapshot(snap, 'build');
        }
        if (printRows.length === 0 || Object.keys(measured).length === 0) return null;
        const blocks = printRows.map((r) => ({ key: r.id, heightMM: measured[r.id] ?? 0 }));
        return paginateMeasured(blocks, 'build', INSIGHT_FOOTER_MM);
    }, [detail, dirty, printRows, measured]);

    /* ── 三件套的操作 ── */

    /** ① 留白行数（整卷） */
    const bumpBlank = (delta: number) => setBlankLines((n) => Math.max(0, Math.min(12, n + delta)));

    /** ② 顺序：上移 / 下移一位 */
    const moveItem = (itemId: string, dir: -1 | 1) => {
        setOrder((prev) => {
            const i = prev.indexOf(itemId);
            const j = i + dir;
            if (i < 0 || j < 0 || j >= prev.length) return prev;
            const next = [...prev];
            [next[i], next[j]] = [next[j], next[i]];
            return next;
        });
    };

    /**
     * ③ 图大小 —— 【2026-10-02 他要求】改回**拖把手**（复练卷页那套），
     * 不再用 −/+ 百分比按钮。左上角固定、拖右下角把手等比缩放。
     * 拖动过程与收尾都在**全局 pointermove/pointerup** 里（监听一次，见下面的 effect）——
     * 与复练卷页完全同一套做法，免得两个页面手感不一样。
     */
    const figureDragRef = useRef<{ id: string; startX: number; startY: number; startPx: number } | null>(null);

    const handleFigureDown = useCallback(
        (itemId: string) => (e: ReactPointerEvent) => {
            const box = (e.currentTarget as HTMLElement).parentElement;
            figureDragRef.current = {
                id: itemId,
                startX: e.clientX,
                startY: e.clientY,
                startPx: box ? box.getBoundingClientRect().width : 1,
            };
            document.body.style.cursor = 'nwse-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        },
        [],
    );

    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const fig = figureDragRef.current;
            if (!fig) return;
            // 横竖位移都算，「哪个方向移得多听哪个」：向右/向下变大，向左/向上变小
            // （与复练卷页、打印预览共用一个纯函数，免得三处手感各写各的）
            const next = figureScaleFromDrag(fig.startPx, e.clientX - fig.startX, e.clientY - fig.startY);
            setFigures((prev) => ({ ...prev, [fig.id]: next }));
        };
        const onUp = () => {
            if (!figureDragRef.current) return;
            figureDragRef.current = null;
            document.body.style.cursor = '';
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

    /* ── 保存 / 打印 / 改名 / 删除 ── */

    const saveLayout = async () => {
        if (!detail || !layout) return;
        setBusy('saving');
        setNotice('');
        try {
            const items = layout.pages.flatMap((page, pi) =>
                page.columns.flatMap((col, ci) =>
                    col.blocks.map((b, bi) => {
                        const src = rowById[b.key];
                        return {
                            insightId: b.key,
                            errorItemId: null,
                            seqInVolume: b.seq,
                            pageIndex: pi + 1,
                            columnIndex: ci,
                            seqInColumn: bi + 1,
                            itemNo: src?.itemNo ?? null,
                            questionText: src?.questionText ?? null,
                            manageType: null,
                            blankLines,
                            figureScale: figures[b.key] ?? 100,
                        };
                    }),
                ),
            );
            await apiClient.patch(`/api/review-volumes/${id}`, {
                items,
                pageCount: layout.pages.length,
                defaultBlankLines: blankLines,
            });
            const res = await apiClient.get<{ volume: VolumeDetail }>(`/api/review-volumes/${id}`);
            setDetail(res.volume);
            await whenImagesSettled();
            setNotice(L('版面已保存', 'Layout saved'));
        } catch {
            setNotice(L('保存失败，请重试', 'Save failed'));
        } finally {
            setBusy('');
        }
    };

    /**
     * 打印：改过没保存时先确认 —— 否则印出来的是改动后的版面、库里还是旧的。
     * （与顶栏/左栏那几处同一句文案，走同一个纯逻辑。）
     */
    const doPrint = () => {
        if (shouldWarnBeforeLeaving(dirty) && !window.confirm(unsavedLeaveMessage(zh, '打印', 'Print'))) return;
        window.print();
    };

    const saveTitle = async () => {
        setBusy('renaming');
        try {
            await apiClient.patch(`/api/review-volumes/${id}`, { title: titleDraft });
            setDetail((prev) => (prev ? { ...prev, title: titleDraft } : prev));
            setEditingTitle(false);
        } catch {
            setNotice(L('改名失败', 'Rename failed'));
        } finally {
            setBusy('');
        }
    };

    /* 【2026-10-02】删除按钮已搬到**左栏那条**上（清单里每条自带垃圾桶），
       这里不再留一份 —— 同一件事两个入口，久了必然两套行为。 */

    const pageCount = layout?.pages.length ?? 0;

    /**
     * 【2026-10-02 修】页眉二维码：先把文本**画成图**（dataURL）再传进纸面。
     * 我第一版把二维码的**文本内容**直接塞给了 `<img src>` ⇒ 全是裂图。
     * 二维码内容 `BU…-01` 本身就带页码（复练卷同一条 payload 规则），不用另做。
     */
    useEffect(() => {
        if (!detail) return;
        let alive = true;
        (async () => {
            const entries: Record<number, string> = {};
            await Promise.all(
                Array.from({ length: Math.max(pageCount, 1) }, async (_, i) => {
                    try {
                        entries[i + 1] = await makeQrDataUrl(pageQrPayload(detail.volumeNo, i + 1), {
                            width: 120,
                            margin: 1,
                        });
                    } catch {
                        entries[i + 1] = '';
                    }
                }),
            );
            if (alive) setPageQrMap(entries);
        })();
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detail?.volumeNo, pageCount]);

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {L('正在打开这份积累纸…', 'Opening…')}
            </div>
        );
    }
    if (!detail) return null;

    return (
        /* 【2026-10-02】这里是**右栏内容**（左栏是卷列表，见 PrintWorkspace）——
           所以不再有自己的整页外壳、也没有"返回列表"按钮（左栏点一下就换卷）。 */
        <div className="rounded-lg border bg-background">
            <div className="no-print flex flex-wrap items-center gap-2 border-b px-3 py-2">
                <span className="font-mono text-sm font-semibold">{detail.volumeNo}</span>
                {editingTitle ? (
                    <span className="flex items-center gap-1">
                        <input
                            className="w-44 rounded-md border bg-background px-2 py-1 text-sm"
                            placeholder={L('比如：五年级上 期末温故', 'e.g. Term review')}
                            value={titleDraft}
                            onChange={(e) => setTitleDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') saveTitle();
                                if (e.key === 'Escape') setEditingTitle(false);
                            }}
                            autoFocus
                        />
                        <Button
                            size="icon"
                            variant="ghost"
                            title={L('保存名字', 'Save')}
                            onClick={saveTitle}
                            disabled={busy === 'renaming'}
                        >
                            <Save className="h-4 w-4" />
                        </Button>
                    </span>
                ) : (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingTitle(true)}
                        title={L('给这份积累纸起个名字（只在软件里）', 'Name it (software only)')}
                    >
                        <Pencil className="mr-1.5 h-3.5 w-3.5" />
                        {detail.title || L('起名', 'Name')}
                    </Button>
                )}
                <span className="text-xs text-muted-foreground sm:text-sm">
                    {L('共', 'total')} {pageCount} {L('页', 'pages')}
                </span>

                <span className="flex-1" />

                {/* ── 排版三件套之一：留白行数（顺序与图大小在纸上每一条的身上） ── */}
                <span className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                    <span className="text-muted-foreground">{L('留白', 'Blank')}</span>
                    <button type="button" title={L('少一行', 'Less')} onClick={() => bumpBlank(-1)} className="px-1">
                        −
                    </button>
                    <span className="w-4 text-center">{blankLines}</span>
                    <button type="button" title={L('多一行', 'More')} onClick={() => bumpBlank(1)} className="px-1">
                        ＋
                    </button>
                </span>

                {dirty && (
                    <Button size="sm" variant="outline" onClick={saveLayout} disabled={busy === 'saving'}>
                        <Save className="mr-1.5 h-3.5 w-3.5" />
                        {busy === 'saving' ? L('保存中…', 'Saving…') : L('保存版面', 'Save layout')}
                    </Button>
                )}
                {/*
                 * 【2026-10-03 需求第 5 条】【扫码图】：进"扫描这张纸第一页"的预览。
                 * **改过版面没保存时不可点** —— 不然扫出来的是库里那版、屏上是改过的这版。
                 */}
                <Button
                    size="sm"
                    variant="outline"
                    disabled={dirty}
                    title={
                        dirty
                            ? L('先保存版面（点【保存版面】）才能进扫码图', 'Save the layout first')
                            : L('看这张纸第一页的扫码预览', 'Scan preview of page 1')
                    }
                    onClick={() => onScan(buildPageCode(detail.volumeNo, 1))}
                >
                    <ScanLine className="mr-1.5 h-3.5 w-3.5" />
                    {L('扫码图', 'Scan view')}
                </Button>
                <Button size="sm" onClick={doPrint}>
                    <Printer className="mr-1.5 h-3.5 w-3.5" />
                    {L('打印', 'Print')}
                </Button>
                {/* 删除在**左栏那条**上（这里是右栏，不再重复放一遍按钮） */}
            </div>

            {notice && (
                <div className="no-print px-3 pt-2 md:px-8">
                    <div className="mx-auto max-w-[1600px] rounded-md border bg-background px-3 py-1.5 text-sm">
                        {notice}
                    </div>
                </div>
            )}

            {/* 【2026-10-03 需求第 4 条】原来那句琥珀色"版面改过了但还没保存…"提示**删掉** ——
                他明确"有确认提示就够了"（切走时会拦，不必常驻一句）。 */}

            <div className="mx-auto w-full max-w-[1600px] px-4 py-3 md:px-8">
                {printRows.length === 0 ? (
                    <div className="rounded-lg border border-dashed bg-background px-6 py-14 text-center text-sm text-muted-foreground">
                        {L('这一卷没有内容', 'This volume is empty')}
                    </div>
                ) : !layout ? (
                    <div className="flex items-center justify-center py-16 text-muted-foreground">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {L('正在排…', 'Laying out…')}
                    </div>
                ) : (
                    /* ⚠️ `print-sheet` 这层不能少：它把纸定成 **152mm 宽**。
                       少了它纸会被撑成整个右栏那么宽（他看到的"横版、左右太满"就是这个）。
                       同一条规矩：**新页面要照抄老页面的整条包裹链**。 */
                    <SheetZoom
                        className="mx-auto max-w-6xl px-4 py-6 print:max-w-none print:px-0 print:py-0"
                        L={L}
                    >
                        <div className="print-sheet">
                            {layout.pages.map((page, i) => (
                                <InsightSheet
                                    key={i}
                                    page={page}
                                    pageNo={i + 1}
                                    pageCount={pageCount}
                                    volumeNo={detail.volumeNo}
                                    gradeText={detail.gradeSemester ?? null}
                                    emojiMark={detail.emojiMark}
                                    rowByKey={rowByKey}
                                    blankLines={blankLines}
                                    figureScaleOf={(rid) => figures[rid] ?? 100}
                                    onMoveItem={moveItem}
                                    onFigureScaleStart={handleFigureDown}
                                    totalCount={printRows.length}
                                    pageQr={pageQrMap[i + 1]}
                                    L={L}
                                />
                            ))}
                        </div>
                    </SheetZoom>
                )}
            </div>

            {/* 量尺容器：与正式渲染**同一个** InsightBlock（"量到的"就是"印出来的"）。
                只在**改过版面**时才挂（没改时按快照还原，不需要量）。 */}
            {dirty && (
                <div
                    ref={measureRef}
                    aria-hidden="true"
                    className="print-review-measure no-print"
                    style={{
                        position: 'absolute',
                        left: '-10000px',
                        top: 0,
                        /**
                         * 【2026-10-02 修·分页 bug 根因】量尺宽度必须是**单栏宽**
         * （积累纸两栏，每栏约 83mm），不能是整纸 182mm！
         * 我第一版用 182mm ⇒ 文字在量尺里铺得很开、量出来的高度**远小于**
         * 真实两栏里的高度 ⇒ 分页算法以为全塞得下 ⇒ **一页堆死、内容溢出**
         * （他截图里"纸面上左右两栏都有打印出去的情况"正是这个）。
         * 复练纸没踩这个坑是因为它是**单栏**，量尺宽度恰好等于栏宽。
         */
                        width: `${VOLUME_VARIANTS.build.columnWidthMM}mm`,
                    }}
                >
                    {printRows.map((r) => (
                        <InsightBlock
                            key={r.id}
                            row={r}
                            blankLines={blankLines}
                            showDivider={false}
                            figureScale={figures[r.id] ?? 100}
                            L={L}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
