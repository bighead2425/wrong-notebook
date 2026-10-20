"use client";

/**
 * 【2026-10-20 真真】回录页底部的「这一趟要回录的」清单 —— 空空第 5 条 + 当天追加的那条。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 他的原话：
 *   · "当我点击卡片上的『去回录分析』，在转到回录分析页的同时，将相应的深挖纸、
 *      复练纸的卷号，列在回录分析页的最后面，并且在每个题号后面增加一个录入按钮……"
 *   · "回录分析也最后显示的所有待回录卷号后面，增加这个卷在组卷时给予的 emoji 符号，
 *      这样更方便查找。同时卷号要具有超链接功能，点击这个卷号，
 *      就进入这个卷的『扫到的复练卷/模仿卷』页面，这样也可以通过非图片录入的方式，
 *      直接由用户在每道题后面的圆圈内输入这个卷练习时的对错。"
 *
 * ── 为什么卷号能点 ──────────────────────────────────────────────────
 * `/scan?vol=RE…` 就是那个「扫到的卷」页（`ScanVolumeView`）—— 它本来就是
 * "每道题后面一个圆圈标对错"的界面。她手上**已经有纸**的时候，根本不用再拍一遍：
 * 点卷号进去直接标，比拍照 → 识别 → 校对快得多。
 *
 * ── emoji 从哪来 ────────────────────────────────────────────────────
 * `ReviewVolume.emojiMark`（组卷时随机生成、整卷所有页共用一个）。
 * 卷号长得像，靠这个符号一眼认出"就是那一份"。
 *
 * ── "删除"目前只从**这一次的清单**里去掉 ─────────────────────────────
 * 他原话是"这条待录入不再进行，就此终止"。真要做到"以后也不再提示"，
 * 得再落一张表（像「建议深挖」的留级那样）。这一版**先不落库** ——
 * 因为"终止"的边界不好定（她删了之后，卷里还有没标的行，下次算任务时还算不算？）。
 * 等他说清再决定，别自己拍。
 * ══════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { dayKey } from "@/lib/calendar-grid";
import type { CabinetTasks } from "@/lib/cabinet-targets";
import { Camera, Images, Inbox, Loader2, Trash2 } from "lucide-react";

interface PendingVolume {
    volumeNo: string;
    emojiMark?: string | null;
    unrecoveredCount: number;
}

interface PendingQuestion {
    no: string;
    /** 【2026-10-20】内部 id —— 点题号进详情页要用；取不到就是 null（那一行只显示不可点） */
    id?: string | null;
    /** 深挖纸上印的 emoji（`ErrorItem.emojiMark`） */
    emojiMark?: string | null;
}

interface Props {
    /** 页内相机（回录页那个可连拍的 DocScanner） */
    onShoot: () => void;
    /** 从相册 / 文件夹选 */
    onPickFiles: () => void;
    /** 收件箱（回录页已经有一块 `ScanInboxBar`，这里只负责把她带到那儿） */
    onOpenInbox: () => void;
}

export function PendingTargets({ onShoot, onPickFiles, onOpenInbox }: Props) {
    const { language } = useLanguage();
    const L = (a: string, b: string) => (language === "zh" ? a : b);

    const [volumes, setVolumes] = useState<PendingVolume[]>([]);
    const [questions, setQuestions] = useState<PendingQuestion[]>([]);
    const [loading, setLoading] = useState(false);
    /** 这一次清单里被她划掉的（不落库，见文件头说明） */
    const [hidden, setHidden] = useState<Set<string>>(new Set());
    /** 「录入」弹框：当前正在给哪一条录（卷号或题号，只用来显示） */
    const [recording, setRecording] = useState<string | null>(null);

    useEffect(() => {
        const qs = new URLSearchParams(window.location.search);
        const vols = (qs.get("volumes") || "")
            .split(",")
            .map((v) => v.trim().toUpperCase())
            .filter(Boolean);
        const nos = (qs.get("nos") || "")
            .split(",")
            .map((v) => v.trim().toUpperCase())
            .filter(Boolean);
        if (vols.length === 0 && nos.length === 0) return;

        /**
         * ⚠️ `react-hooks/set-state-in-effect` 在本仓是 error，这里显式豁免并说明理由：
         * 这两行读的是 **URL**（`?volumes=` / `?nos=`），而服务端渲染时没有 `window`。
         * 想避开 effect 就得用 `useState` 惰性初始化 —— 那会让服务端拿到 `[]`、
         * 客户端拿到有值，hydration 直接不一致（比一次多余的渲染糟得多）。
         * ⇒ 只在挂载后读一次，正是 effect 的适用场景。
         */
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 见上：挂载后读一次 URL
        setQuestions(nos.map((no) => ({ no })));
        if (vols.length === 0 && nos.length === 0) return;

        /**
         * 卷的 emoji / 未录行数、**题的 emoji 与内部 id**，都在 `/api/cabinet` 里。
         *
         * 【2026-10-20 如如】原来这里 `if (vols.length === 0) return;` —— 只有卷才来这里补数据。
         * 现在「待回录分析」的题号前也要 emoji（深挖纸上印的那个），点题号还要能进详情页，
         * 所以**题的 id 与 emojiMark 也从这里取**。取不到就退化成"只有题号、不可点"，
         * 不会整块消失。
         */
        setLoading(true);
        apiClient
            .get<{ tasks: CabinetTasks }>(`/api/cabinet?today=${encodeURIComponent(dayKey(new Date()))}`)
            .then((d) => {
                const byNo = new Map(d.tasks.pendingRecoverVolumes.items.map((i) => [i.volumeNo, i]));
                setVolumes(
                    vols.map((no) => {
                        const hit = byNo.get(no);
                        return {
                            volumeNo: no,
                            emojiMark: hit?.emojiMark ?? null,
                            /** 算不出来（比如已经标完了）就显示 0，不假装有 */
                            unrecoveredCount: hit?.unrecoveredCount ?? 0,
                        };
                    }),
                );

                const qByNo = new Map(
                    (d.tasks.pendingRecover?.items ?? []).map((i) => [
                        (i.source || "").trim().toUpperCase(),
                        i,
                    ]),
                );
                setQuestions(
                    nos.map((no) => {
                        const hit = qByNo.get(no);
                        return { no, id: hit?.id ?? null, emojiMark: hit?.emojiMark ?? null };
                    }),
                );
            })
            .catch((e) => {
                console.error(e);
                /** 取不到也要把卷号/题号列出来 —— 她至少还能点进去标 */
                setVolumes(vols.map((no) => ({ volumeNo: no, emojiMark: null, unrecoveredCount: 0 })));
                setQuestions(nos.map((no) => ({ no, id: null, emojiMark: null })));
            })
            .finally(() => setLoading(false));
    }, []);

    const shownVolumes = volumes.filter((v) => !hidden.has(`v:${v.volumeNo}`));
    const shownQuestions = questions.filter((q) => !hidden.has(`q:${q.no}`));

    if (loading) {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {L("正在找这一趟要回录的卷…", "Loading this round's volumes…")}
            </div>
        );
    }
    if (shownVolumes.length === 0 && shownQuestions.length === 0) return null;

    return (
        <section className="space-y-3 rounded-lg border-2 border-dashed border-amber-400/70 bg-amber-50/40 p-4 dark:border-amber-900 dark:bg-amber-950/20">
            <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-sm font-semibold">{L("这一趟要回录的", "To recover this round")}</h2>
                <span className="text-xs text-muted-foreground">
                    {L(
                        "点卷号可以直接在网页上标对错（不用再拍一遍）",
                        "Tap a volume number to mark right/wrong on screen (no photo needed)",
                    )}
                </span>
            </div>

            {shownVolumes.length > 0 && (
                <ul className="space-y-2">
                    {shownVolumes.map((v) => (
                        <li
                            key={v.volumeNo}
                            className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2"
                        >
                            {/**
                             * 【他追加的要求】**emoji + 卷号，卷号可点**。
                             * 落点是 `/scan?vol=…` —— 那个页面就是"每道题后面一个圆圈标对错"，
                             * 而且 `back` 带回这里，标完按返回能接着录下一份。
                             */}
                            <Link
                                href={`/scan?vol=${encodeURIComponent(v.volumeNo)}&back=${encodeURIComponent("/recover")}`}
                                className="flex min-w-0 items-center gap-1.5 font-mono text-sm underline decoration-dotted hover:text-primary"
                                title={L("打开这一卷，直接在网页上标对错", "Open this volume to mark on screen")}
                            >
                                <span aria-hidden className="text-base leading-none">
                                    {v.emojiMark || "📄"}
                                </span>
                                <span className="truncate">{v.volumeNo}</span>
                            </Link>
                            {v.unrecoveredCount > 0 && (
                                <span className="text-xs text-muted-foreground">
                                    {L(`还有 ${v.unrecoveredCount} 行没标`, `${v.unrecoveredCount} rows unmarked`)}
                                </span>
                            )}
                            <span className="flex-1" />
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setRecording(v.volumeNo)}>
                                {L("录入", "Add photos")}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-muted-foreground"
                                title={L("这一条这次不录了（下次进这一页还会出现）", "Skip for now")}
                                onClick={() => setHidden((prev) => new Set(prev).add(`v:${v.volumeNo}`))}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            {shownQuestions.length > 0 && (
                <ul className="space-y-2">
                    {shownQuestions.map((q) => (
                        <li
                            key={q.no}
                            className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2"
                        >
                            {/**
                             * 【2026-10-20 第 3 条】**emoji + 题号，题号可点进详情页**。
                             *
                             * emoji 是深挖纸上印的那个（`ErrorItem.emojiMark`）——
                             * 她照着它在一叠纸里找那张深挖纸，比看题号快得多。
                             * 取不到 id（比如这条刚被标完）就退化成纯文字，不可点。
                             *
                             * ⚠️ `back` 只带 `/recover`，不带 `?nos=` —— 把带参数的完整 URL
                             *    编进 query 里会形成双重编码，读端容易漏解一层。
                             *    回到回录页就可以了（清单会按当时的数据重算）。
                             */}
                            {q.id ? (
                                <Link
                                    href={`/error-items/${q.id}?back=${encodeURIComponent("/recover")}`}
                                    className="flex min-w-0 items-center gap-1.5 font-mono text-sm underline decoration-dotted hover:text-primary"
                                    title={L("打开这道题的详情", "Open this question")}
                                >
                                    <span aria-hidden className="text-base leading-none">{q.emojiMark || "📄"}</span>
                                    <span className="truncate">{q.no}</span>
                                </Link>
                            ) : (
                                <span className="flex min-w-0 items-center gap-1.5 font-mono text-sm">
                                    <span aria-hidden className="text-base leading-none">{q.emojiMark || "📄"}</span>
                                    <span className="truncate">{q.no}</span>
                                </span>
                            )}
                            <span className="text-xs text-muted-foreground">
                                {/* 【第 3 条】原来写"深挖纸回录（拍纸上的日积月累）"，太长 ⇒ 只留"深挖纸" */}
                                {L("深挖纸", "Deep sheet")}
                            </span>
                            <span className="flex-1" />
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setRecording(q.no)}>
                                {L("录入", "Add photos")}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-muted-foreground"
                                title={L("这一条这次不录了", "Skip for now")}
                                onClick={() => setHidden((prev) => new Set(prev).add(`q:${q.no}`))}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            {/* 「录入」= 三条通道，与页面上半部分那三个按钮**完全同义**，只是把入口搬到手边 */}
            <Dialog
                open={!!recording}
                onOpenChange={(o) => {
                    if (!o) setRecording(null);
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-base">
                            {L(`给 ${recording ?? ""} 录入图片`, `Add photos for ${recording ?? ""}`)}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Button
                            className="h-auto w-full justify-start gap-3 py-3"
                            onClick={() => {
                                setRecording(null);
                                onShoot();
                            }}
                        >
                            <Camera className="h-4 w-4 shrink-0" />
                            <span className="flex flex-col items-start text-left">
                                <span>{L("拍摄", "Take a photo")}</span>
                                <span className="text-xs font-normal opacity-80">
                                    {L("页内相机，可连拍几张", "In-app camera, burst supported")}
                                </span>
                            </span>
                        </Button>
                        <Button
                            variant="outline"
                            className="h-auto w-full justify-start gap-3 py-3"
                            onClick={() => {
                                setRecording(null);
                                onPickFiles();
                            }}
                        >
                            <Images className="h-4 w-4 shrink-0" />
                            <span className="flex flex-col items-start text-left">
                                <span>{L("调入图片", "Pick photos")}</span>
                                <span className="text-xs font-normal opacity-70">
                                    {L("从相册或文件夹选，可多选", "From album or folder, multiple")}
                                </span>
                            </span>
                        </Button>
                        <Button
                            variant="outline"
                            className="h-auto w-full justify-start gap-3 py-3"
                            onClick={() => {
                                setRecording(null);
                                onOpenInbox();
                            }}
                        >
                            <Inbox className="h-4 w-4 shrink-0" />
                            <span className="flex flex-col items-start text-left">
                                <span>{L("收件箱", "Inbox")}</span>
                                <span className="text-xs font-normal opacity-70">
                                    {L("用别的设备扫完丢进 NAS，这里一键拉进来", "Scan elsewhere, pull in from NAS")}
                                </span>
                            </span>
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </section>
    );
}
