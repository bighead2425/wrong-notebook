"use client";

/**
 * 【custom-v33】收件箱照片预览页 —— 「扫描收件箱」的子窗口。
 *
 * 起因：收件箱面板里照片一小格一小格，只能看个大概，认不出是哪张卷子；
 * 而"这张到底导没导过"也得点进去才知道。这个页面解决三件事：
 *
 *   ① **看清**：整屏看一张，滚轮/双指缩放、右键拖动平移（手感与裁剪窗口一致）；
 *   ② **校正**：拍歪了就地逆时针转 90°，转一次存一次 —— 以后再打开就是正的；
 *   ③ **归档**：在这里可以直接改"新照片 / 已录入"，也可以顺手删掉不要的。
 *
 * ── 几个刻意的设计取舍 ──────────────────────────────────────────
 *
 * · **旋转不改 NAS 上的文件**，只把"方向"记在台账里（见 lib/scan-inbox 的 InboxEntry）。
 *   理由：原始扫描件留原样，转错了还能转回来；而且每次旋转都重写一遍文件，
 *   会平白刷新修改时间，把"按拍照顺序排列"这个隐含约定搞乱。
 *
 * · **转一次就存一次**（而不是等切走/关闭才存）。用户的原话是"切走或关闭时保存"，
 *   立即存是它的超集：手机没电、浏览器被系统杀后台，都不至于把这几次旋转白转。
 *   为了防"连点三下、请求乱序到达导致存成错误角度"，保存走**串行链**：
 *   后一次一定等前一次落地再发。
 *
 * · **缩放/平移的数学与 image-cropper 完全一致**（applyView / zoomAt / computeFitZoom
 *   同一套坐标模型）。不是抄近路，是因为用户会拿这两个窗口对比手感，
 *   两套算法只要有一点不同（比如滚轮焦点），用起来就会觉得"这个飘"。
 *
 * · 图片用 `<img>` + CSS transform 而不是 canvas：这里只需要"看"，不需要改像素。
 *   旋转交给 CSS 的 rotate，缩放平移交给外层容器的 transform，两者互不干扰。
 *
 * ── 【custom-v34】按设备分工的两套翻页/缩放方式 ──────────────────
 *
 * · **电脑**：左右两侧各一个半透明圆圈（鼠标移进图片区才淡入），点它等同"上一张/下一张"；
 *   双击放大 ↔ 复位。鼠标拖动始终是平移。
 * · **手机**：屏幕上**不出现**那两个圆圈，改成单指横扫 —— 从右往左划看下一张、
 *   从左往右划看上一张；双击放大 / 再双击复位；双指仍是捏合缩放。
 *   两者都靠 `pointerType === "touch"` 分流，互相不干扰。
 *
 * 横扫的判据见 onPointerMove：不看"划了多远"，而看"有多少被边界吃掉了"。
 * 这样一条规则同时管住两种情况 —— 图适应大小时随手一划就翻页，
 * 图放大后要"划到头再接着划"才翻页，中间区域仍是老老实实的平移。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { rotatedSize, rotateCCW } from "@/lib/image-rotation";
import {
    Check,
    ChevronLeft,
    ChevronRight,
    Download,
    Loader2,
    RotateCcw,
    Trash2,
    X,
} from "lucide-react";

export interface ViewerFile {
    name: string;
    size: number;
    mtimeMs: number;
    imported: boolean;
    rotation: number;
}

export interface InboxImageViewerProps {
    open: boolean;
    /** 收件箱当前列表（决定左右切换的顺序：与拍照顺序一致，旧→新） */
    files: ViewerFile[];
    /** 当前看第几张。越界会自动按环形收敛，删图后不必由上层精确修正 */
    index: number;
    onIndexChange: (i: number) => void;
    /** 选中集合由上层持有 —— 预览里点的方框要立刻反映到父窗口的网格上 */
    selected: Set<string>;
    onToggleSelect: (name: string) => void;
    /** 已经在当批队列里的文件名：状态按钮显示「已在队列」且点了无效 */
    inQueue: Set<string>;
    /** 属性改好了，同步给上层（乐观更新，网格角标立刻跟着变） */
    onMetaChange: (name: string, patch: { rotation?: number; imported?: boolean }) => void;
    /** 重新拉一遍收件箱（删除后、或保存失败需要回滚显示时用） */
    onReload: () => Promise<void> | void;
    onClose: () => void;
}

/* 与 image-cropper 保持同一组数值 —— 两个窗口的手感必须一致 */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const FIT_PAD = 16;
const FIT_MAX = 2;

/** 【custom-v34】手机端手势的三个阈值：横扫翻页的距离、双击允许的手指抖动、双击的时间窗 */
const SWIPE_PX = 70;
const TAP_SLOP = 24;
const DOUBLE_TAP_MS = 320;
/** 双击放大到"当前的多少倍" —— 按当前显示倍数放大，而不是写死绝对倍率：
 *  大图适应窗口后可能是 0.3 倍，写死 2 倍反而会缩小。 */
const DOUBLE_TAP_FACTOR = 2.5;

/** 工具栏图标按钮的统一长相 */
const iconBtn =
    "h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-background disabled:hover:text-muted-foreground";

export function InboxImageViewer({
    open,
    files,
    index,
    onIndexChange,
    selected,
    onToggleSelect,
    inQueue,
    onMetaChange,
    onReload,
    onClose,
}: InboxImageViewerProps) {
    const { t } = useLanguage();
    const s = t.common.batch?.inbox || {};

    /* ===== 当前这张是谁 ===== */
    const count = files.length;
    // 环形收敛：删掉最后一张后 index 会短暂越界，取模一步到位，不必让上层算
    const idx = count > 0 ? ((index % count) + count) % count : 0;
    const cur = count > 0 ? files[idx] : null;
    const name = cur?.name ?? "";
    const rot = cur?.rotation ?? 0;
    const isQueued = cur ? inQueue.has(name) : false;
    const isChecked = cur ? selected.has(name) : false;

    /* ===== 视图状态（缩放 / 平移），坐标模型与裁剪窗口一致 ===== */
    const viewportRef = useRef<HTMLDivElement | null>(null);
    /** 当前这张图的自然像素尺寸（onLoad 读到）。换图期间保持不动 —— 清成 0 会让 fit 算不出来、画面空一帧 */
    const [nat, setNat] = useState({ w: 0, h: 0 });
    const [zoom, setZoom] = useState(1);
    const [view, setView] = useState({ x: 0, y: 0 });
    const zoomRef = useRef(1);
    const viewRef = useRef({ x: 0, y: 0 });
    const panRef = useRef({ x: 0, y: 0 });
    /** 旋转后的外框尺寸 —— 所有 fit/钳制都按它算，而不是原图自然尺寸 */
    const dispRef = useRef({ w: 0, h: 0 });
    const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
    const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);
    const panDragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

    /* 【custom-v34】手机端手势：单指横扫切照片、双击放大/复位。
     * 两者都只在 `pointerType === "touch"` 时生效 —— 电脑端有左右按钮和滚轮，
     * 不该让鼠标拖动变成"翻页"，也不该让双击和滚轮抢。
     * swipeRef 兼作"这一指是不是原地点击"的判据（看走了多远）。 */
    const swipeRef = useRef<{ sx: number; sy: number } | null>(null);
    const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
    /** 触摸设备（没有 hover 能力）上不显示左右那两个半透明圆圈 —— 手机用滑动翻页 */
    const [touchOnly, setTouchOnly] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined" || !window.matchMedia) return;
        setTouchOnly(window.matchMedia("(hover: none)").matches);
    }, []);
    /**
     * 是否仍处于「自动适应」状态（与 image-cropper 同一套判断）。
     * 用户一旦自己缩放/平移就退出自动适应 —— 否则手机收个地址栏、窗口高度变一下，
     * 画面就被拽回整图，用户刚放大的那个细节白找了。
     */
    const autoFitRef = useRef(true);

    const [busy, setBusy] = useState(false);
    const [working, setWorking] = useState(false);

    /* ===== 保存串行链 =====
     * 连点三下旋转会发三次请求，并发到达服务端的顺序是不保证的 ——
     * 一旦乱序，最后落库的可能反而是中间那一次，用户看到的就是"转回去了一下"。
     * 挂到同一条 Promise 链上依次发，顺序就是点击顺序。
     * persistFailed 记下"这次没存上"，关闭时据此决定要不要整体重读一遍。 */
    const saveChainRef = useRef<Promise<void>>(Promise.resolve());
    const persistFailedRef = useRef(false);

    const saveMeta = useCallback(
        (target: string, patch: { rotation?: number; imported?: boolean }) => {
            // 先乐观更新界面（父窗口的网格也跟着变），再后台存
            onMetaChange(target, patch);
            saveChainRef.current = saveChainRef.current.then(async () => {
                try {
                    await apiClient.post("/api/scan-inbox", { names: [target], ...patch });
                } catch {
                    persistFailedRef.current = true;
                }
            });
        },
        [onMetaChange],
    );

    /* ===== 缩放 / 平移 ===== */
    const applyView = useCallback((zRaw: number, p: { x: number; y: number }) => {
        const vp = viewportRef.current;
        const { w: nw, h: nh } = dispRef.current;
        if (!vp || !nw || !nh) return;
        if (!Number.isFinite(zRaw)) return;
        const vw = vp.clientWidth;
        const vh = vp.clientHeight;
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zRaw));
        const sw = nw * z;
        const sh = nh * z;
        // 图比视口小的时候不允许拖动，否则能把图拖出屏幕外找不回来
        const mx = Math.max(0, (sw - vw) / 2);
        const my = Math.max(0, (sh - vh) / 2);
        const px = Number.isFinite(p.x) ? Math.min(mx, Math.max(-mx, p.x)) : 0;
        const py = Number.isFinite(p.y) ? Math.min(my, Math.max(-my, p.y)) : 0;
        zoomRef.current = z;
        panRef.current = { x: px, y: py };
        viewRef.current = { x: (vw - sw) / 2 + px, y: (vh - sh) / 2 + py };
        setZoom(z);
        setView({ x: (vw - sw) / 2 + px, y: (vh - sh) / 2 + py });
    }, []);

    /** 以屏幕上某点为中心缩放：该点下的内容保持不动（滚轮 / 双指用） */
    const zoomAt = useCallback(
        (zRaw: number, cx: number, cy: number) => {
            const vp = viewportRef.current;
            const { w: nw, h: nh } = dispRef.current;
            if (!vp || !nw || !nh) return;
            const r = vp.getBoundingClientRect();
            const sx = cx - r.left;
            const sy = cy - r.top;
            const z = zoomRef.current;
            const nx = (sx - viewRef.current.x) / z;
            const ny = (sy - viewRef.current.y) / z;
            const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zRaw));
            const sw = nw * nz;
            const sh = nh * nz;
            autoFitRef.current = false; // 用户手动缩放，退出「自动适应」
            applyView(nz, {
                x: sx - (vp.clientWidth - sw) / 2 - nx * nz,
                y: sy - (vp.clientHeight - sh) / 2 - ny * nz,
            });
        },
        [applyView],
    );

    const computeFitZoom = useCallback(() => {
        const vp = viewportRef.current;
        const { w: nw, h: nh } = dispRef.current;
        if (!vp || !nw || !nh) return 1;
        const z = Math.min(
            (vp.clientWidth - FIT_PAD * 2) / nw,
            (vp.clientHeight - FIT_PAD * 2) / nh,
        );
        return Math.min(FIT_MAX, Math.max(MIN_ZOOM, z));
    }, []);

    /** 「适应大小」：整图居中铺满 —— 换图、旋转之后一律回到这个状态 */
    const fitView = useCallback(() => {
        autoFitRef.current = true;
        applyView(computeFitZoom(), { x: 0, y: 0 });
    }, [applyView, computeFitZoom]);

    /** 同步"旋转后的外框尺寸"，它是 fit/钳制的唯一基准 */
    useEffect(() => {
        const d = rotatedSize(nat.w, nat.h, rot);
        dispRef.current = d;
    }, [nat.w, nat.h, rot]);

    /**
     * 换图 / 图加载完 / 旋转了 → 一律回到适应大小。
     *
     * 为什么用两个 rAF：对话框是 Radix 的 Portal + 有入场动画，第一帧里
     * viewport 的 clientWidth 还是 0，直接算 fit 会得到一个荒谬的比例。
     * 等两帧，布局稳定了再算。
     */
    useEffect(() => {
        if (!open) return;
        const id = requestAnimationFrame(() => {
            requestAnimationFrame(() => fitView());
        });
        return () => cancelAnimationFrame(id);
    }, [open, name, rot, nat.w, nat.h, fitView]);

    // 窗口尺寸变化（手机横竖屏 / 拖大窗口）：没手动缩放过就重新适应，否则只把画面钳回边界内
    useEffect(() => {
        const vp = viewportRef.current;
        if (!open || !vp) return;
        const ro = new ResizeObserver(() => {
            if (autoFitRef.current) fitView();
            else applyView(zoomRef.current, panRef.current);
        });
        ro.observe(vp);
        return () => ro.disconnect();
    }, [open, fitView, applyView]);

    // 电脑端滚轮缩放：以鼠标位置为中心
    useEffect(() => {
        if (!open) return;
        const onWheel = (e: WheelEvent) => {
            const vp = viewportRef.current;
            if (!vp) return;
            if (!vp.contains(e.target as Node)) return;
            e.preventDefault();
            // 归一化：有些鼠标/触控板按"行"或"页"上报
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 16;
            else if (e.deltaMode === 2) dy *= 100;
            zoomAt(zoomRef.current * Math.exp(-dy * 0.002), e.clientX, e.clientY);
        };
        // 挂到 window 的捕获阶段：先于 Radix Dialog 的滚动锁定拿到事件，
        // 否则滚轮会被 Dialog 吞掉（裁剪窗口踩过同一个坑）
        window.addEventListener("wheel", onWheel, { passive: false, capture: true });
        return () => window.removeEventListener("wheel", onWheel, { capture: true });
    }, [open, zoomAt]);

    // 指针交互：双指捏合+平移 / 右键或中键拖动平移 / 单指拖动平移
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dispRef.current.w) return;
        e.preventDefault();
        try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
            /* 某些浏览器在极端情况下会抛，忽略即可 —— 拿不到捕获只是拖动可能中断 */
        }
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointersRef.current.size >= 2) {
            const pts = [...pointersRef.current.values()];
            pinchRef.current = {
                dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
                midX: (pts[0].x + pts[1].x) / 2,
                midY: (pts[0].y + pts[1].y) / 2,
            };
            panDragRef.current = null;
            return;
        }

        // 右键 / 中键：平移（左键同样平移 —— 这里没有绘制功能，不需要区分工具）
        if (e.button === 0 || e.button === 1 || e.button === 2) {
            // 【custom-v34】这里**不再**立刻把 autoFitRef 关掉：单纯点一下（尤其手机上
            // 双击放大的第一下）不该被当成"用户自己调过视角"，否则收个地址栏、转个屏
            // 就不再自动适应了。改成"真的发生位移时才关"（见 onPointerMove）。
            // 触摸时顺手记下起手位置：判断这一指是"划"（翻页）还是"点"（双击）。
            swipeRef.current = e.pointerType === "touch"
                ? { sx: e.clientX, sy: e.clientY }
                : null;
            panDragRef.current = {
                sx: e.clientX,
                sy: e.clientY,
                px: panRef.current.x,
                py: panRef.current.y,
            };
        }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (pointersRef.current.has(e.pointerId)) {
            pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }

        const pts = [...pointersRef.current.values()];
        if (pts.length >= 2 && pinchRef.current) {
            const g = pinchRef.current;
            const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const mx = (pts[0].x + pts[1].x) / 2;
            const my = (pts[0].y + pts[1].y) / 2;
            if (g.dist > 0) zoomAt(zoomRef.current * (d / g.dist), g.midX, g.midY);
            applyView(zoomRef.current, {
                x: panRef.current.x + (mx - g.midX),
                y: panRef.current.y + (my - g.midY),
            });
            g.dist = d;
            g.midX = mx;
            g.midY = my;
            return;
        }

        if (panDragRef.current) {
            const pd = panDragRef.current;
            const wantX = pd.px + (e.clientX - pd.sx);
            const wantY = pd.py + (e.clientY - pd.sy);
            autoFitRef.current = false; // 真的拖动过了，退出「自动适应」
            applyView(zoomRef.current, { x: wantX, y: wantY });

            /**
             * 【custom-v34】手机端单指横扫切换照片。
             *
             * 判据不是"划了多少"，而是"有多少被边界吃掉了"（overshoot）——
             * applyView 会把平移量夹在边界内，所以「想要的位移 − 实际得到的位移」
             * 正好是"顶到边还在继续推"的那部分。这一条规则同时覆盖两种情况：
             *   · 图处于适应大小（比屏幕小、根本推不动）：横向拖动被全额吃掉，
             *     划够 SWIPE_PX 即翻页；
             *   · 图被放大过、已经推到最右/最左：再同方向继续推才翻页 ——
             *     这正是看大图时"划到头接着划就翻页"的习惯动作，
             *     而中间区域照常是平移，不会误翻。
             * 另要求横向明显大于纵向（1.5 倍），免得斜着拖被误判成翻页。
             */
            if (e.pointerType === "touch" && swipeRef.current) {
                const sw = swipeRef.current;
                const overshoot = wantX - panRef.current.x;
                const dx = e.clientX - sw.sx;
                const dy = e.clientY - sw.sy;
                if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(overshoot) > SWIPE_PX) {
                    swipeRef.current = null; // 一次手势只翻一张，免得一划到底连翻好几张
                    lastTapRef.current = null;
                    panDragRef.current = null;
                    // overshoot < 0 = 手指向左划 = 看下一张（与用户指定的方向一致）
                    goStep(overshoot < 0 ? 1 : -1);
                    return;
                }
            }
        }
    };

    const onPointerUp = (e?: React.PointerEvent<HTMLDivElement>) => {
        if (e) {
            pointersRef.current.delete(e.pointerId);
            /**
             * 【custom-v34】手机端双击 = 放大 / 复位。
             *
             * 为什么要自己判双击：视口上有 `touch-action: none` 且 pointerdown 里
             * preventDefault，浏览器合成的 dblclick 在触屏上基本不触发；就算触发，
             * 也带不出准确定位。所以用"两次间隔够短 + 两次落点够近 + 两下都没怎么移动"来判。
             * 划动过的手势走不进这里（moved 超过容差就直接清掉计时）。
             */
            if (e.pointerType === "touch") {
                const sw = swipeRef.current;
                const moved = sw ? Math.hypot(e.clientX - sw.sx, e.clientY - sw.sy) : 999;
                swipeRef.current = null;
                const last = lastTapRef.current;
                if (
                    moved < TAP_SLOP && last &&
                    Date.now() - last.t < DOUBLE_TAP_MS &&
                    Math.abs(e.clientX - last.x) < TAP_SLOP &&
                    Math.abs(e.clientY - last.y) < TAP_SLOP
                ) {
                    lastTapRef.current = null;
                    const fitZ = computeFitZoom();
                    // 本来就在适应大小 → 按当前倍数放大；否则一律回到适应大小
                    if (Math.abs(zoomRef.current - fitZ) < 0.02 * Math.max(1, fitZ)) {
                        zoomAt(fitZ * DOUBLE_TAP_FACTOR, e.clientX, e.clientY);
                    } else {
                        fitView();
                    }
                } else if (moved < TAP_SLOP) {
                    lastTapRef.current = { t: Date.now(), x: e.clientX, y: e.clientY };
                } else {
                    lastTapRef.current = null;
                }
            }
        }
        if (pointersRef.current.size < 2) pinchRef.current = null;
        if (pointersRef.current.size === 0) panDragRef.current = null;
    };

    /* ===== 动作 ===== */

    const goStep = (d: number) => {
        if (count < 2) return;
        // 环形：第一张再往前 = 最后一张；最后一张再往后 = 第一张
        onIndexChange(((idx + d) % count + count) % count);
    };

    /** 逆时针转 90° —— 转完立刻存，并且回到适应大小（长宽对调后旧比例已经不对了） */
    const doRotate = () => {
        if (!cur) return;
        saveMeta(cur.name, { rotation: rotateCCW(rot) });
    };

    const toggleImported = () => {
        if (!cur || isQueued) return; // 已在队列 → 点击无效
        saveMeta(cur.name, { imported: !cur.imported });
    };

    /**
     * 下载 / 保存这张照片。
     *
     * 【custom-v34】手机端原来点了"没反应" —— 这是浏览器的限制，不是没写对：
     * 手机浏览器普遍忽略 `<a download>`（iOS Safari 直接把它当导航、把图片打开在
     * 新标签里，什么都不落盘；Android 也大多没有任何可见反馈），而网页**没有权限**
     * 直接往相册里写。能触达相册的唯一正路是**系统分享面板**（那里才有"存储到图像 /
     * 保存到文件"）。所以手机端先走 navigator.share 交文件；分享不可用再退回浏览器
     * 下载，并明确告诉用户去哪儿找。电脑端保持原样 —— 那边 `<a download>` 是好用的，
     * 弹的是"另存为"对话框，比分享面板顺手。
     */
    const doDownload = async () => {
        if (!cur) return;
        const url = `/api/scan-inbox/file?name=${encodeURIComponent(cur.name)}`;
        const isTouch = touchOnly
            || (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);

        if (isTouch && typeof navigator !== "undefined" && navigator.share) {
            try {
                const res = await fetch(url);
                if (res.ok) {
                    const blob = await res.blob();
                    const file = new File([blob], cur.name, { type: blob.type || "image/jpeg" });
                    const data: ShareData = { files: [file] };
                    if (navigator.canShare?.(data)) {
                        await navigator.share(data);
                        return; // 已经交给系统面板（存相册 / 存文件都在那里），不再重复下载
                    }
                }
            } catch (err) {
                // 用户自己把分享面板划掉不算失败，静默结束
                if ((err as { name?: string } | null)?.name === "AbortError") return;
                // 其它情况（浏览器不支持带文件的分享等）→ 往下走浏览器下载这条路兜底
            }
        }

        const a = document.createElement("a");
        a.href = url;
        a.download = cur.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // 手机上这条路大概率是"静默的"（点了像没反应），所以给一句明确交代
        if (isTouch) {
            alert(s.viewerDownloadHint
                || "已交给浏览器下载。手机上如果相册里没有，请到「文件 / 下载」里找。");
        }
    };

    const doDelete = async () => {
        if (!cur || busy) return;
        const msg = (s.viewerDeleteConfirm || "确定把这张从收件箱里删掉吗？删了就找不回来了。")
            .replace("{name}", cur.name);
        if (!confirm(msg)) return;
        setBusy(true);
        const target = cur.name;
        try {
            const res = await fetch("/api/scan-inbox", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ names: [target] }),
            });
            const data = res.ok ? await res.json().catch(() => null) : null;
            if (!data || (Array.isArray(data.failed) && data.failed.length)) {
                alert(s.viewerDeleteFailed || "删除失败，请稍后再试");
                return;
            }
            await onReload();
            /**
             * 删完自动落到"下一张"：索引不动，原来排在后面的那张就顶到了当前位置。
             * 删的若是最后一张，索引会越界 —— 越界由上面的环形取模收敛到第一张，
             * 语义正好也是"下一张"（从头开始）。
             */
        } finally {
            setBusy(false);
        }
    };

    /** 关闭：等所有保存落地 → 让父窗口重读一遍 → 收起窗口 */
    const close = async () => {
        if (working) return;
        setWorking(true);
        try {
            await saveChainRef.current;
            if (persistFailedRef.current) {
                persistFailedRef.current = false;
                alert(s.viewerSaveFailed || "刚才的改动没能存到服务器，已重新读取收件箱");
            }
            await onReload();
        } finally {
            setWorking(false);
            onClose();
        }
    };

    // 照片被删光了（可能是在别处删的）→ 自动收起，别留一个空窗口
    useEffect(() => {
        if (open && count === 0) onClose();
    }, [open, count, onClose]);

    if (!cur) return null;

    const disp = rotatedSize(nat.w, nat.h, rot);

    /* 【custom-v34】状态按钮上的字改成 New / Old（用户指定）：
       中文两个字、英文一个词，短且等长，按钮不会随状态换宽。
       网格缩略图角标上仍是「新 / 已导入」—— 那里空间小，中文更省地方。 */
    const statusText = isQueued
        ? (s.badgeQueued || "已在队列")
        : cur.imported
            ? (s.viewerStatusOld || "Old")
            : (s.viewerStatusNew || "New");

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
            <DialogContent
                className="max-w-none w-full h-[100dvh] sm:rounded-none p-0 gap-0 flex flex-col overflow-hidden [&>button]:hidden"
                aria-describedby={undefined}
            >
                <DialogTitle className="sr-only">{s.viewerTitle || "照片预览"}</DialogTitle>
                <DialogDescription className="sr-only">
                    {s.viewerDesc || "缩放、旋转、标记或删除收件箱里的这张照片"}
                </DialogDescription>

                {/* ===== 工具栏 ===== */}
                <div className="flex items-center gap-2 px-3 py-2 border-b bg-background shrink-0 flex-wrap">
                    {/* 选中状态：**方框 + 文字做成一个按钮，宽度钉死**。
                        原先方框是按钮、文字是旁边的 span，两段文字长短不一
                        （"未选中" vs "已选中，导入时会带上这张"）—— 点一下就换行宽，
                        后面那一串按钮跟着左右跳。现在文字收进按钮里、宽度固定，怎么点都不动。 */}
                    <button
                        type="button"
                        onClick={() => onToggleSelect(name)}
                        aria-pressed={isChecked}
                        className={`h-9 w-[122px] shrink-0 px-2.5 inline-flex items-center justify-start gap-2 rounded-md border text-sm transition-colors ${
                            isChecked
                                ? "border-sky-500 bg-sky-500/10 text-sky-600"
                                : "border-input bg-background text-muted-foreground hover:border-sky-500"
                        }`}
                        title={isChecked ? (s.viewerUnselect || "取消选中") : (s.viewerSelect || "选中")}
                    >
                        <span
                            className={`h-4 w-4 shrink-0 rounded border-2 flex items-center justify-center ${
                                isChecked
                                    ? "bg-sky-500 border-sky-500 text-white"
                                    : "border-muted-foreground/50 text-transparent"
                            }`}
                        >
                            <Check className="h-3 w-3" />
                        </span>
                        <span className="truncate">
                            {isChecked
                                ? (s.viewerChecked || "已选中")
                                : (s.viewerUnchecked || "未选中")}
                        </span>
                    </button>

                    <span className="w-px h-5 bg-border mx-1" />

                    {/* 左右切换：第一张再往前 = 最后一张，反之亦然 */}
                    <button
                        type="button" className={iconBtn}
                        onClick={() => goStep(-1)}
                        disabled={count < 2 || busy}
                        title={s.viewerPrev || "上一张"}
                    >
                        <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                        type="button" className={iconBtn}
                        onClick={() => goStep(1)}
                        disabled={count < 2 || busy}
                        title={s.viewerNext || "下一张"}
                    >
                        <ChevronRight className="h-5 w-5" />
                    </button>

                    {/* 逆时针转 90°，点一次转一次，转完即存 */}
                    <button
                        type="button" className={iconBtn}
                        onClick={doRotate}
                        disabled={busy}
                        title={s.viewerRotate || "逆时针旋转 90°"}
                    >
                        <RotateCcw className="h-5 w-5" />
                    </button>

                    {/* 状态：新 ↔ 已录入 互相切；已在队列时点击无效 */}
                    <button
                        type="button"
                        onClick={toggleImported}
                        disabled={busy || isQueued}
                        title={isQueued
                            ? (s.viewerQueuedHint || "这张已经进了待处理队列，状态改不了了")
                            : (s.viewerStatusHint || "点一下，在「新照片」和「已录入」之间切换")}
                        className={`h-9 min-w-[68px] px-3 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md border text-sm transition-colors disabled:opacity-70 ${
                            isQueued
                                ? "bg-teal-600 border-teal-600 text-white"
                                : cur.imported
                                    ? "bg-gray-700 border-gray-700 text-white hover:bg-gray-600"
                                    : "bg-sky-600 border-sky-600 text-white hover:bg-sky-500"
                        }`}
                    >
                        {statusText}
                    </button>

                    <span className="w-px h-5 bg-border mx-1" />

                    <button
                        type="button" className={iconBtn}
                        onClick={doDownload}
                        disabled={busy}
                        title={s.viewerDownload || "下载这张照片"}
                    >
                        <Download className="h-5 w-5" />
                    </button>
                    <button
                        type="button" className={iconBtn}
                        onClick={doDelete}
                        disabled={busy}
                        title={s.viewerDelete || "从收件箱删掉这张"}
                    >
                        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Trash2 className="h-5 w-5" />}
                    </button>

                    <div className="ml-auto flex items-center gap-2">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {(s.viewerIndex || "第 {i} / {n} 张")
                                .replace("{i}", String(idx + 1))
                                .replace("{n}", String(count))}
                        </span>
                        <button
                            type="button" className={iconBtn}
                            onClick={close}
                            disabled={busy || working}
                            title={s.viewerClose || "关闭"}
                        >
                            {working ? <Loader2 className="h-5 w-5 animate-spin" /> : <X className="h-5 w-5" />}
                        </button>
                    </div>
                </div>

                {/* ===== 图片区 ===== */}
                <div
                    ref={viewportRef}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onContextMenu={(e) => e.preventDefault()}
                    className="group flex-1 min-h-0 bg-black w-full"
                    style={{ position: "relative", overflow: "hidden", touchAction: "none", cursor: "grab" }}
                >
                    <div
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            // 显式定尺，且是**旋转之后**的尺寸：fit/钳制都以它为基准
                            width: disp.w || undefined,
                            height: disp.h || undefined,
                            lineHeight: 0,
                            transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})`,
                            transformOrigin: "0 0",
                        }}
                    >
                        {/*
                          图片本身保持原始像素尺寸，旋转只作用在它自己身上；
                          因为外层盒子的尺寸是「旋转后的尺寸」，居中之后正好铺满，
                          转 90° 时也不会多出一圈空白或者被裁掉一条。
                        */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            key={name}
                            src={`/api/scan-inbox/file?name=${encodeURIComponent(name)}`}
                            alt={name}
                            draggable={false}
                            onLoad={(e) => {
                                const el = e.currentTarget;
                                setNat({ w: el.naturalWidth, h: el.naturalHeight });
                            }}
                            style={{
                                position: "absolute",
                                left: "50%",
                                top: "50%",
                                // 宽高刻意不设 —— 让浏览器按自然尺寸渲染，
                                // translate(-50%,-50%) 的百分比才会正好等于"半个自己"
                                transform: `translate(-50%, -50%) rotate(${rot}deg)`,
                                userSelect: "none",
                                pointerEvents: "none",
                            }}
                        />
                    </div>

                    {/* 【custom-v34】电脑端左右两侧的"翻页圆圈"：鼠标移进图片区才淡入
                        （`group-hover`），不抢画面。手机端**不渲染** —— 那边用左右滑动翻页
                        （见 onPointerMove 的 overshoot 判定），再多两个圆圈只会挡图。
                        指针事件在这里 stopPropagation：不让点击圆圈顺带起一次平移。 */}
                    {!touchOnly && count > 1 && (
                        <>
                            {([
                                { d: -1, Icon: ChevronLeft, label: s.viewerPrev || "上一张", pos: "left-3" },
                                { d: 1, Icon: ChevronRight, label: s.viewerNext || "下一张", pos: "right-3" },
                            ] as const).map(({ d, Icon, label, pos }) => (
                                <button
                                    key={d}
                                    type="button"
                                    disabled={busy}
                                    title={label}
                                    aria-label={label}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={() => goStep(d)}
                                    className={`absolute ${pos} top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-black/40 hover:bg-black/70 text-white/90 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-0`}
                                >
                                    <Icon className="h-6 w-6" />
                                </button>
                            ))}
                        </>
                    )}
                </div>

                {/* ===== 底部：文件名与操作提示 ===== */}
                <div className="flex items-center gap-3 px-3 py-2 border-t bg-background shrink-0 text-xs text-muted-foreground">
                    <span className="truncate" title={name}>{name}</span>
                    <span className="ml-auto whitespace-nowrap hidden sm:inline">
                        {(s.viewerFitHint || "滚轮缩放 · 右键拖动平移 · 双指可缩放与移动")}
                    </span>
                </div>
            </DialogContent>
        </Dialog>
    );
}
