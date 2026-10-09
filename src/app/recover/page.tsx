"use client";

/**
 * 回录分析（深挖纸回录）—— **纸回录的第一步**。
 *
 * 她做完一道深挖纸，会在**正面下半部分**手写"我卡在哪"；这里拍一张照，
 * 系统读出来，变成一条**日积月累**（关联到那道题）。于是"错题 → 深挖纸 → 日积月累 → 打印 → 再做"
 * 转成一个循环。
 *
 * ── 一步到底发生了什么（他 2026-10-04 定的链路）──────────────────────
 *   选/拍照片 → jsQR 解二维码拿到题号 → 用题号查题（/api/scan）
 *     → 把「照片 + 这道题的信息」交给 AI（/api/recover）
 *       → 得到可编辑的日积月累正文 → 校对、可改 → 保存进日积月累（/api/insights）
 *
 * ── 三条这条链路必须守住的规矩 ────────────────────────────────────────
 *   ① **留下她的原话**：保存时把这张照片（压缩后）一并写进日积月累（InsightPhoto）。
 *      —— AI 认手写一定会错，原图才是唯一真相；她以后翻积累本看到"这是我自己写的"才有价值。
 *   ② **AI 只整理、不编造**：见 `lib/ai/prompts.ts` 的回录模板（看不清就说看不清）。
 *   ③ **不碰等级 / 复习结果 / 题目类型**：这一步只生成一条日积月累，别的什么都不做。
 *
 * ⚠️ 定位方案（他已拍板，别自创）：二维码内容 = **裸题号**；**不做几何切分**
 *    （那些 0.3mm 浅灰虚线手机拍必断）；先解出题号、拿题干当"地图"再让 AI 读手写。
 *
 * ⚠️ 不用 `useSearchParams`（只在挂载时读一次用 `window.location` 即可）——
 *    避免踩本项目"漏包 Suspense ⇒ next build 中断"那个老坑（见 next-build-conventions.test.ts）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import jsQR from "jsqr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
import { ScanInboxBar } from "@/components/scan-inbox-bar";
import { DocScanner, type DocScannerHandle } from "@/components/doc-scanner";
import { ImageCropper } from "@/components/image-cropper";
import { ImageLightbox, type LightboxItem } from "@/components/image-lightbox";
import { StitchComposer } from "@/components/stitch-composer";
import { MdEditor } from "@/components/md-editor";
import { apiClient, ApiError } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import { dayKey } from "@/lib/calendar-grid";
import {
    resolveScannedLookup,
    type ScanBlockedReason,
    type ScanLookupResult,
} from "@/lib/recover-analysis";
import {
    classifyRecoveryCode,
    applyReadingToRows,
    planRecoveryWrites,
    type RecoveredMark,
    type RecoveryBlockedReason,
    type RecoveryRow,
} from "@/lib/review-recover";
import { nextReviewOutcomes } from "@/lib/scan-marking";
import {
    Camera,
    CameraOff,
    CheckCircle2,
    Loader2,
    RotateCcw,
    ScanText,
    SkipForward,
    Sparkles,
    Images,
    PlayCircle,
    Trash2,
    Check,
    Crop,
    Layers,
} from "lucide-react";

/**
 * 【2026-10-05】采集层：一次最多收多少张（与批量上传页的 30 张一致）。
 * 不设上限的话，几十张原图同时挂着会把手机浏览器的内存吃光。
 */
const MAX_SHOTS = 30;

/** `/api/scan` 的返回（只取判定要用的字段） */
interface ErrorItemLite {
    id: string;
    source?: string | null;
    questionText?: string | null;
    notebook?: { displayName?: string | null; subject?: string | null } | null;
}
interface ScanResponse {
    found: boolean;
    source: "main" | "trash" | null;
    item: ErrorItemLite | null;
}

/** 一段照片的工作阶段 */
type WorkStep = "compressing" | "decoding" | "looking-up" | "analyzing";

/** 一张照片卡片的状态机 */
type CardState =
    | { k: "queued" }
    | { k: "working"; step: WorkStep }
    | { k: "ready" }
    | { k: "blocked"; reason: ScanBlockedReason | "ai-error" | "build-page"; detail: string | null; message: string | null }
    | { k: "saved"; replaced: boolean; insightCode: string | null }
    | { k: "skipped" };

interface RecoverCard {
    id: string;
    fileName: string;
    file: File;
    /** 压缩后的 data URL（既是缩略图，也是要存进日积月累的原图） */
    photo: string | null;
    qr: string | null;
    no: string | null;
    item: ErrorItemLite | null;
    content: string;
    unclear: string;
    /** 手动输入的题号（二维码认不出来时的兜底） */
    manual: string;
    saving: boolean;
    state: CardState;
}

/* ================= 复练纸（第二步）：一张页照片的状态机 ================= */

/** 复练纸照片的工作阶段 */
type ReviewStep = "reading";

type ReviewCardState =
    | { k: "queued" }
    | { k: "working"; step: ReviewStep }
    | { k: "ready" }
    | {
          k: "blocked";
          /**
           * ⚠️ 含 `build-page`：本页在分流时已经把积累纸的码挡在前面，
           *    但 `/api/recover/review` 自己也回 `{reason:'build-page'}`（防御性第二道）——
           *    类型里补上它，免得将来上游一改就掉进"AI 分析失败"这个错文案。
           */
          reason: RecoveryBlockedReason | "ai-error" | "not-review" | "build-page";
          detail: string | null;
          message: string | null;
      }
    | { k: "saved"; written: number; /** 这一页里"没标 / 看不清"因而**没被写入**的格数 */ skipped: number }
    | { k: "skipped" };

/** 校对表格里的一行 —— 就是这一页的一格（卷行）+ 她标的记号 */
interface ReviewRowState extends RecoveryRow {
    slot: string;
    mark: RecoveredMark;
}

interface ReviewCard {
    id: string;
    fileName: string;
    /** 压缩后的原图（既是缩略图，也是交给 AI 的那张照片） */
    photo: string | null;
    qr: string | null;
    pageCode: string | null;
    volumeId: string | null;
    volumeNo: string | null;
    pageNo: number | null;
    /** 这一页每一格（校对表格的数据） */
    rows: ReviewRowState[];
    /** AI 交代的"哪里看不清" */
    unclear: string;
    saving: boolean;
    state: ReviewCardState;
}

let seq = 0;
function uid(): string {
    seq += 1;
    return `rc-${Date.now()}-${seq}`;
}

/* =================== 这一场（同一屏会话内）保留 ===================
 *
 * 【2026-10-05 他报的问题，原话】"可能其他分析都结束了，还没有保存到日积月累中，
 * 就因为点击了一个去察看，其他刚刚送 AI 分析的内容就全丢了……风险特别大。"
 *
 * 为什么会丢：他一跳去「日积月累」，这个页面的 React 组件就被卸载了，
 * 里面的 `useState` 全部归零 —— 再回来是一张白纸。
 *
 * 解法：把"这一场"的四份数据放到**模块作用域**。
 * 客户端路由跳转（点链接、点返回）不会重新加载 JS 模块，所以模块里的东西还在；
 * 回到这一页时用它们做初始值，看起来就跟"从没离开过"一样。
 *
 * ⚠️ 三条边界，别越：
 *   ① **绝不写盘、绝不进 localStorage** —— 里面是她的作业照片，不该留在浏览器里；
 *      整页刷新（F5）就没了，这是**有意**的。
 *   ② 只存"这一场的数据"，**不存浮层**（正在加工哪张、拼接窗口、看图窗口）——
 *      回来时不该自动弹出一个窗口。
 *   ③ 一定要有办法**清空**（下面顶栏那个「清空」按钮）：否则卡片只进不出，
 *      一场接一场攒下去。这也是为什么这个按钮是必需的，不是装饰。
 */
interface RecoverSession {
    pendingShots: QueuedShot[];
    readyShots: QueuedShot[];
    cards: RecoverCard[];
    reviewCards: ReviewCard[];
    burstCount: number;
}
const session: RecoverSession = {
    pendingShots: [],
    readyShots: [],
    cards: [],
    reviewCards: [],
    burstCount: 0,
};

/** 把图片 data URL 解成二维码文本（jsQR，纯 JS，任何浏览器可跑） */async function decodeQrFromDataUrl(dataUrl: string): Promise<string | null> {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // 照片可能反光/倒置，attemptBoth 比默认更容易扫出来（摄像头实时扫才用 dontInvert 省电）
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
    return code?.data ?? null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片加载失败"));
        img.src = src;
    });
}

/**
 * 「去查看」这条积累 —— 跳去哪。
 *
 * ⚠️ 三个参数缺一不可，缺一个他就得自己找（这是他 2026-10-05 报的第 1 条）：
 *   · `pick=<编号>`   ⇒ 日积月累页打开就**选中刚存的这一条**（不用在一长串里翻）；
 *   · `noleft=1`      ⇒ 隐掉左栏，直接落在右边那一栏（他原话："在右边框显示"）；
 *   · `back=/recover` ⇒ 那边的**返回键回到本页** —— 原来返回直接回主页，
 *                       而他手上还有几张"分析好了没保存"的卡。
 *
 * 光有 `back=` 还不够：回来这一屏的内容也**不能丢**，靠的是模块里的 `session`
 * （见文件上方"这一场保留"那段说明）。
 */
function insightViewHref(code: string | null): string {
    const q = new URLSearchParams();
    if (code) q.set("pick", code);
    q.set("noleft", "1");
    q.set("back", "/recover");
    return `/insights?${q.toString()}`;
}

/**
 * 分流结果里"没法在深挖这条路上继续"的 → 深挖卡的"卡住"状态。
 * ⚠️ 复练页（RE…）不会走到这里（它会转交给复练流程）；只有积累页（BU…）会带 `build-page`。
 */
function blockedFromRoute(route: ReturnType<typeof classifyRecoveryCode>): CardState {
    if (route.route === "empty") return { k: "blocked", reason: "empty", detail: null, message: null };
    if (route.route === "build-page") {
        return { k: "blocked", reason: "build-page", detail: route.pageCode, message: null };
    }
    if (route.route === "review-page") {
        // 理论上不会到这（上面已拦），兜底当成"卷里那一支还没接上"
        return { k: "blocked", reason: "build-page", detail: route.pageCode, message: null };
    }
    return { k: "blocked", reason: "unknown", detail: route.route === "unknown" ? route.value : null, message: null };
}

/** 把各种异常翻译成一句人话 */
function humanizeError(err: unknown): string {
    if (err instanceof ApiError) {
        const data = err.data as { message?: string } | undefined;
        const code = data?.message;
        if (code === "AI_RESPONSE_ERROR") return "AI 没返回能用的内容，可以重试或手填";
        if (code === "AI_TIMEOUT_ERROR" || err.status === 408) return "AI 等太久了（超时），可以重试";
        return code || err.statusText || `HTTP ${err.status}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
}

/** 复练校对表格里的三态按钮（`unclear` 不在这里 —— 它是 AI 的读数，等她改） */
const MARK_CHOICES: { value: RecoveredMark; zh: string; en: string }[] = [
    { value: "right", zh: "对", en: "Right" },
    { value: "wrong", zh: "错", en: "Wrong" },
    { value: "none", zh: "没标", en: "None" },
];

/** `/api/recover/review` 的返回形状 */
interface ReviewApiResponse {
    volumeId: string;
    volumeNo: string;
    pageNo: number;
    rows: RecoveryRow[];
    reading: { marksBySlot: Record<string, RecoveredMark>; unclear: string };
}

/**
 * 【2026-10-05 采集层】一张「还没开始分析的纸」。
 *
 * 三条通道（相册多选 / 页内相机连拍 / NAS 收件箱批量拉取）收上来的都长这样，
 * 落到「待处理」；加工（透视拉正 + 漂白/黑白）之后挪到「预处理」，最后一起送分析。
 *
 * ⚠️ 只存 **File + objectURL**，**不存 data URL** —— 缩略图用 objectURL 画（几乎不占内存），
 *    加工与送分析都直接用 File；整页最多也就一份原图在内存里。
 * ⚠️ objectURL 用完必须 `revokeObjectURL`（删除 / 送分析 / 离开页面），否则内存一直涨。
 */
interface QueuedShot {
    id: string;
    /** 原始图（收件箱拉来的、相册选的、相机拍的）或加工后的图 */
    file: File;
    /** 给 `<img src>` 用的临时地址 */
    url: string;
}

/**
 * 【2026-10-05】"点开看清是哪张"时，看的是**哪一组**图。
 * 三组各自独立成册（互相之间不跨组翻页）—— 因为他翻图时的心理是
 * "这一格里的图挨着看一遍"，混在一起反而找不到自己在哪儿。
 *
 * ⚠️ 「待处理」**不在这里**：那一格点图 = 加工（他定的），
 *    而加工页本来就是大图，不存在"看不清是哪张"的问题。
 */
type LightboxKind = "ready" | "cards" | "review";

export default function RecoverPage() {
    const { language } = useLanguage();
    const zh = language === "zh";
    /** 双语助手（与 /scan 页同一写法） */
    const L = useCallback((a: string, b: string) => (zh ? a : b), [zh]);

    /* 下面四份数据都从 `session` 起手（见文件里"这一场保留"那段说明）：
     * 从日积月累页返回、或误点主页再回来，这一场还在。 */
    const [cards, setCards] = useState<RecoverCard[]>(session.cards);
    /** ⚠️ 与 cards 同步的**可变副本**：异步流程里每一步都要读"最新那张卡"，不能等 React 重渲染 */
    const cardsRef = useRef<RecoverCard[]>(session.cards);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    /* ========== 采集层（2026-10-05）：待处理 / 预处理 / 页内相机 ==========
     * 为什么要有这一层：原来这里是「选照片 → 立刻直送 AI」，中间没有任何可干预的环节；
     * 而日常拍照得到的原图（背景、透视、偏暗）直接喂 AI 会让它读不准二维码和手写。
     * 现在改成：**先收进「待处理」 → 逐张加工（剪裁 / 橡皮擦 / 框选 / 旋转 / 拉伸）→ 进「预处理」 → 一起分析**，
     * 与录题目时那套（BatchPipeline）是同一个思路，只是这里的出口是「回录分析」而不是「录错题」。
     */

    /** 待处理：刚收进来、还没加工的纸 */
    const [pendingShots, setPendingShots] = useState<QueuedShot[]>(session.pendingShots);
    const pendingShotsRef = useRef<QueuedShot[]>(session.pendingShots);
    /** 预处理：加工好了、等着一起送分析的纸 */
    const [readyShots, setReadyShots] = useState<QueuedShot[]>(session.readyShots);
    const readyShotsRef = useRef<QueuedShot[]>(session.readyShots);
    /** 页内相机（连拍）的实例句柄 */
    const cameraScannerRef = useRef<DocScannerHandle | null>(null);
    /**
     * 正在加工的那张 —— 非 null 就开着**图片剪裁页**（`ImageCropper`：
     * 剪裁 / 橡皮擦 / 框选 / 旋转 / 拉伸，与录题目时点待处理图片进的是**同一个页面**）。
     */
    const [editingShot, setEditingShot] = useState<QueuedShot | null>(null);
    /** 与 editingShot 同步的副本：出图回调里要读"最新那张"，不能等 React 重渲染 */
    const editingShotRef = useRef<QueuedShot | null>(null);
    /** 连拍已拍张数（显示在按钮旁，给人一个数） */
    const [burstCount, setBurstCount] = useState(session.burstCount);
    /**
     * 【2026-10-05】正在拼的那张（从「待处理」点【拼接】带进去的第一张图）。
     * 非 null = 拼接窗口开着。【2026-10-09 第 3 条】拼好之后结果进**「待处理」**
     * （不是预处理，理由见 handleStitched），**原来那张待处理的不动**。
     */
    const [stitchSeed, setStitchSeed] = useState<File | null>(null);
    /** 收不下时的一句提示（比如一次选了 40 张，只收前 30 张） */
    const [shotNotice, setShotNotice] = useState<string | null>(null);

    /**
     * 【2026-10-05】看图窗口开着没有、看的是哪一组、第几张。
     * 他反馈："图片进了待处理 / 预处理 / 已分析之后都只有一小格，完全不知道是哪张图"。
     */
    const [lightbox, setLightbox] = useState<{ kind: LightboxKind; index: number } | null>(null);

    /** 改一张卡：ref 与 state 同步更新（见上面 ref 的说明） */
    const patch = useCallback((id: string, updater: (c: RecoverCard) => RecoverCard) => {
        cardsRef.current = cardsRef.current.map((c) => (c.id === id ? updater(c) : c));
        // ⚠️ 顺手落进"这一场"：**AI 分析是异步的**，他可能在中途跳去日积月累页，
        //    回来后这个组件已经是**新实例**了。只靠"每次渲染同步"会漏掉这一步
        //    （旧实例卸载后不再渲染）⇒ 回来会看到一张永远卡在"AI 正在读…"的卡。
        session.cards = cardsRef.current;
        setCards(cardsRef.current);
    }, []);

    /* ================== 复练纸（第二步）：状态与流程 ================== */

    const [reviewCards, setReviewCards] = useState<ReviewCard[]>(session.reviewCards);
    /** ⚠️ 与 reviewCards 同步的**可变副本**（同 cardsRef 的道理） */
    const reviewRef = useRef<ReviewCard[]>(session.reviewCards);

    const patchReview = useCallback((id: string, updater: (c: ReviewCard) => ReviewCard) => {
        reviewRef.current = reviewRef.current.map((c) => (c.id === id ? updater(c) : c));
        // 同上：异步结果要能穿过"跳走又回来"（他离开时这个组件已经卸载）
        session.reviewCards = reviewRef.current;
        setReviewCards(reviewRef.current);
    }, []);

    /**
     * 把"这一场"同步进模块里的 `session`（每次渲染后都跑一次）。
     *
     * 为什么用"每次渲染都同步"，而不是在每个 setState 旁边手写一句：
     * 这个页面有二十多处改这几份数据的地方，**漏一处就是"回来以后少一张"** ——
     * 而这种 bug 只在他跳走再回来时出现，平时根本看不出来。
     * 每次渲染同步一遍，就不存在"漏改某处"的可能（代价是一次赋值，可忽略）。
     */
    useEffect(() => {
        session.pendingShots = pendingShots;
        session.readyShots = readyShots;
        session.cards = cards;
        session.reviewCards = reviewCards;
        session.burstCount = burstCount;
    });

    /**
     * 清空这一屏（顶栏那个按钮）。
     *
     * 为什么**必需**：卡片一旦进了 `session`，就不再随刷新消失 ⇒
     * 没有这个按钮，旧的"已分析 / 已保存"卡会一直挂在页面上、越攒越多。
     * ⚠️ 只清**界面**：已经保存进日积月累的条目、已经写进卷与复习史的记录**都不动**（那是落过库的）。
     * ⚠️ 待处理 / 预处理里的 objectURL 要还回去（不然内存一直涨）。
     */
    const clearSession = useCallback(() => {
        if (
            !confirm(
                L(
                    "清空这一屏？还没保存的分析结果会从界面上消失（已经存进日积月累的不受影响）。",
                    "Clear this screen? Unsaved analyses will be dropped (saved takeaways are untouched).",
                ),
            )
        ) {
            return;
        }
        for (const s of [...pendingShotsRef.current, ...readyShotsRef.current]) {
            URL.revokeObjectURL(s.url);
        }
        pendingShotsRef.current = [];
        readyShotsRef.current = [];
        cardsRef.current = [];
        reviewRef.current = [];
        session.pendingShots = [];
        session.readyShots = [];
        session.cards = [];
        session.reviewCards = [];
        session.burstCount = 0;
        setPendingShots([]);
        setReadyShots([]);
        setCards([]);
        setReviewCards([]);
        setBurstCount(0);
        setShotNotice(null);
    }, [L]);

    /* ================== 看图窗口（2026-10-05）==================
     * 只解决一件事：这三组图在小格子里都看不清是哪张，点开能看大图、能翻页。
     * 用的 `ImageLightbox` 与收件箱预览是**同一个组件**（缩放/翻页手感一致）。
     *
     * ⚠️ 索引口径必须与下面 `lightboxItems` **一模一样**（都是"过滤掉没有图的"之后再数），
     *    否则点第 3 张会打开第 2 张 —— 这种错很隐蔽，改了这边的过滤条件就要一起改那边。
     */
    const openReadyLightbox = useCallback((id: string) => {
        const i = readyShotsRef.current.findIndex((s) => s.id === id);
        if (i >= 0) setLightbox({ kind: "ready", index: i });
    }, []);
    const openCardLightbox = useCallback((id: string) => {
        const i = cardsRef.current.filter((c) => c.photo).findIndex((c) => c.id === id);
        if (i >= 0) setLightbox({ kind: "cards", index: i });
    }, []);
    const openReviewLightbox = useCallback((id: string) => {
        const i = reviewRef.current.filter((c) => c.photo).findIndex((c) => c.id === id);
        if (i >= 0) setLightbox({ kind: "review", index: i });
    }, []);

    /** 交给看图窗口的清单（与上面索引同口径） */
    const lightboxItems: LightboxItem[] = useMemo(() => {
        if (!lightbox) return [];
        if (lightbox.kind === "ready") {
            return readyShots.map((s) => ({ src: s.url, label: s.file.name }));
        }
        if (lightbox.kind === "cards") {
            return cards
                .filter((c) => c.photo)
                .map((c) => ({ src: c.photo as string, label: c.no ?? c.fileName }));
        }
        return reviewCards
            .filter((c) => c.photo)
            .map((c) => ({ src: c.photo as string, label: c.pageCode ?? c.fileName }));
    }, [lightbox, readyShots, cards, reviewCards]);

    /**
     * 把接口的 400 变成"具体原因 + 一句人话"。
     * ⚠️ 必须把服务端的 `details.detail`（volume-miss 时是**卷号**、empty-page 时是**页码**）
     *    一起带出来 —— 界面文案里 `${...}` 插的就是它。
     *    2026-10-04 审理前的写法只取了 `reason`，`detail` 被丢掉后由调用方拿 `card.pageCode`
     *    （整串 `RE…-02`）顶替 ⇒ 提示变成"按卷号 RE20260926001-02 没找到这一卷"、"第 RE…-02 页是空的"。
     */
    const reviewBlockedOf = useCallback(
        (
            err: unknown,
        ): { reason: RecoveryBlockedReason | "ai-error" | "not-review" | "build-page"; detail: string | null; message: string } => {
            if (err instanceof ApiError) {
                const data = err.data as
                    | { message?: string; details?: { reason?: string; detail?: string } }
                    | undefined;
                const reason = data?.details?.reason;
                if (
                    reason === "volume-miss" ||
                    reason === "wrong-volume" ||
                    reason === "empty-page" ||
                    reason === "not-review" ||
                    reason === "build-page"
                ) {
                    return { reason, detail: data?.details?.detail ?? null, message: "" };
                }
                return { reason: "ai-error", detail: null, message: humanizeError(err) };
            }
            return { reason: "ai-error", detail: null, message: humanizeError(err) };
        },
        [],
    );

    /**
     * 复练卡的"查卷 + 拼版面地图 + 让 AI 只读她标的记号"这一步（已存在的卡就地刷新）。
     * 起手（`startReviewCard`）与重试（`retryReview`）共用这一段，免得两处各写一遍。
     */
    const loadReviewInto = useCallback(
        async (id: string) => {
            const card = reviewRef.current.find((c) => c.id === id);
            if (!card?.photo || !card.pageCode) return;
            patchReview(id, (c) => ({ ...c, state: { k: "working", step: "reading" } }));
            try {
                const res = await apiClient.post<ReviewApiResponse>(
                    "/api/recover/review",
                    { imageBase64: card.photo, pageCode: card.pageCode, language },
                    { timeout: 180000 },
                );
                const rows: ReviewRowState[] = applyReadingToRows(res.rows, res.reading).map(
                    ({ row, slot, mark }) => ({ ...row, slot, mark }),
                );
                patchReview(id, (c) => ({
                    ...c,
                    volumeId: res.volumeId,
                    volumeNo: res.volumeNo,
                    pageNo: res.pageNo,
                    rows,
                    unclear: res.reading.unclear || "",
                    state: { k: "ready" },
                }));
            } catch (err) {
                const { reason, detail, message } = reviewBlockedOf(err);
                // 服务端给了具体 detail（卷号 / 页码）就用它；没给（如 AI 调用失败）才退回这张纸的页号，便于她对照
                patchReview(id, (c) => ({
                    ...c,
                    state: { k: "blocked", reason, detail: detail ?? card.pageCode, message },
                }));
            }
        },
        [language, patchReview, reviewBlockedOf],
    );

    /**
     * 复练流程起点（照片已压缩、页二维码已解出）：
     *   建一张复练卡，然后交给 `loadReviewInto` 查卷 + 拼地图 + 让 AI **只读她标的记号**。
     */
    const startReviewCard = useCallback(
        async (photo: string, fileName: string, pageCode: string, volumeNo: string | null, pageNo: number | null) => {
            const id = uid();
            const card: ReviewCard = {
                id,
                fileName,
                photo,
                qr: pageCode,
                pageCode,
                volumeId: null,
                volumeNo,
                pageNo,
                rows: [],
                unclear: "",
                saving: false,
                state: { k: "working", step: "reading" },
            };
            reviewRef.current = [...reviewRef.current, card];
            setReviewCards(reviewRef.current);
            await loadReviewInto(id);
        },
        [loadReviewInto],
    );

    /** 复练卡重试：已解出页码码且照片还在 ⇒ 就地重跑那一步 */
    const retryReview = useCallback(
        (id: string) => {
            void loadReviewInto(id);
        },
        [loadReviewInto],
    );

    /** 复练卡：改某一格她标的记号（校对表格里点对/错/没标） */
    const setReviewMark = useCallback(
        (id: string, rowId: string, mark: RecoveredMark) => {
            patchReview(id, (c) => ({
                ...c,
                rows: c.rows.map((r) => (r.rowId === rowId ? { ...r, mark } : r)),
            }));
        },
        [patchReview],
    );

    /**
     * 保存复练卡：**只写"她标了"的那些题**（对/错），写两处：
     *   ① 卷行 `markState`（"这张纸上我标了什么"，按卷）—— `PATCH /api/review-volumes/[id]`；
     *   ② 题目的 `reviewOutcomes`（"这道题复习史"，跨卷）—— `PUT /api/error-items/[id]`。
     * ⚠️ `none` / `unclear` 一律跳过（不静默清空、不替她做主）；题被删了只写①。
     */
    const saveReviewCard = useCallback(
        async (id: string) => {
            const card = reviewRef.current.find((c) => c.id === id);
            if (!card || card.saving) return;
            if (!card.volumeId) return;
            const marksByRowId: Record<string, RecoveredMark> = {};
            for (const r of card.rows) marksByRowId[r.rowId] = r.mark;
            const writes = planRecoveryWrites(card.rows, marksByRowId);
            if (writes.length === 0) {
                alert(L("这一页还没标任何一道题：先在校对表格里点一下对 / 错，再保存。", "No questions marked yet."));
                return;
            }
            /**
             * 这一页里"她没标 / 看不清"因而**没有写入**的格数。
             * ⚠️ 必须回给用户看：`planRecoveryWrites` 故意跳过 none/unclear（不替她做主），
             *    但保存成功时只说"已保存 N 道题"会让人以为整页都存了。
             */
            const skipped = card.rows.length - writes.length;
            patchReview(id, (c) => ({ ...c, saving: true }));
            try {
                for (const w of writes) {
                    // ① 卷行标记（"这张纸上我标了什么"）
                    await apiClient.patch(`/api/review-volumes/${card.volumeId}`, {
                        markItemId: w.rowId,
                        markState: w.markState,
                    });
                    // ② 这道题的复习史（口径与扫码页完全一致）
                    if (w.writesOutcome && w.errorItemId) {
                        const row = card.rows.find((r) => r.rowId === w.rowId);
                        const { outcomes } = nextReviewOutcomes(row?.reviewOutcomes ?? null, w.markState);
                        await apiClient.put(`/api/error-items/${w.errorItemId}`, { reviewOutcomes: outcomes });
                    }
                }
                patchReview(id, (c) => ({ ...c, saving: false, state: { k: "saved", written: writes.length, skipped } }));
            } catch (err) {
                patchReview(id, (c) => ({ ...c, saving: false }));
                alert(L("保存失败，请重试。", "Save failed, please retry."));
                console.error(err);
            }
        },
        [L, patchReview],
    );

    const skipReview = useCallback(
        (id: string) => patchReview(id, (c) => ({ ...c, state: { k: "skipped" } })),
        [patchReview],
    );

    /** 查题 + 送 AI（假定"题号已知、照片已在卡里"） */
    const lookupAndAnalyze = useCallback(
        async (id: string, no: string) => {
            patch(id, (c) => ({ ...c, no, state: { k: "working", step: "looking-up" } }));

            let lookup: ScanLookupResult<ErrorItemLite> | null = null;
            try {
                lookup = await apiClient.get<ScanResponse>(`/api/scan?no=${encodeURIComponent(no)}`);
            } catch (err) {
                patch(id, (c) => ({
                    ...c,
                    state: { k: "blocked", reason: "ai-error", detail: no, message: humanizeError(err) },
                }));
                return;
            }

            const resolved = resolveScannedLookup<ErrorItemLite>({ kind: "question", value: no }, lookup);
            if (resolved.status !== "ready") {
                patch(id, (c) => ({
                    ...c,
                    state: { k: "blocked", reason: resolved.reason, detail: resolved.detail, message: null },
                }));
                return;
            }

            patch(id, (c) => ({ ...c, item: resolved.item, state: { k: "working", step: "analyzing" } }));

            const photo = cardsRef.current.find((c) => c.id === id)?.photo;
            if (!photo) {
                patch(id, (c) => ({
                    ...c,
                    state: { k: "blocked", reason: "ai-error", detail: no, message: L("图片丢了，请重试", "Image lost") },
                }));
                return;
            }

            try {
                const res = await apiClient.post<{
                    content: string;
                    reading?: { unclear?: string };
                    questionNo: string;
                }>(
                    "/api/recover",
                    { imageBase64: photo, errorItemNo: no, language },
                    { timeout: 180000 },
                );
                patch(id, (c) => ({
                    ...c,
                    content: res.content || "",
                    unclear: res.reading?.unclear || "",
                    state: { k: "ready" },
                }));
            } catch (err) {
                patch(id, (c) => ({
                    ...c,
                    state: { k: "blocked", reason: "ai-error", detail: no, message: humanizeError(err) },
                }));
            }
        },
        [L, language, patch],
    );

    /**
     * 一张照片的完整流程：压缩 → 解二维码 → **按二维码类型分流**。
     *   · 裸题号 ⇒ 深挖流程（`lookupAndAnalyze`，第一步，一字未改）；
     *   · 复练页二维码（RE…）⇒ **转交复练流程**（把这张深挖卡换成一张复练卡）；
     *   · 积累页二维码（BU…）/ 空 / 认不出 ⇒ 深挖卡进"卡住"态，给理由 + 三出口。
     */
    const processCard = useCallback(
        async (id: string) => {
            const card = cardsRef.current.find((c) => c.id === id);
            if (!card) return;
            try {
                patch(id, (c) => ({ ...c, state: { k: "working", step: "compressing" } }));
                const photo = await processImageFile(card.file);
                patch(id, (c) => ({ ...c, photo }));

                patch(id, (c) => ({ ...c, state: { k: "working", step: "decoding" } }));
                const qr = await decodeQrFromDataUrl(photo);
                const route = classifyRecoveryCode(qr);

                if (route.route === "question") {
                    patch(id, (c) => ({ ...c, qr, no: route.value }));
                    await lookupAndAnalyze(id, route.value);
                    return;
                }

                if (route.route === "review-page") {
                    // 这张其实是复练纸：把深挖卡换成一张复练卡，走第二步那套
                    cardsRef.current = cardsRef.current.filter((c) => c.id !== id);
                    setCards(cardsRef.current);
                    await startReviewCard(photo, card.fileName, route.pageCode, route.volumeNo, route.pageNo);
                    return;
                }

                patch(id, (c) => ({ ...c, qr, no: null, state: blockedFromRoute(route) }));
            } catch (err) {
                patch(id, (c) => ({
                    ...c,
                    state: { k: "blocked", reason: "ai-error", detail: null, message: humanizeError(err) },
                }));
            }
        },
        [lookupAndAnalyze, patch, startReviewCard],
    );

    /** 选/拍了一组照片：逐张**串行**处理（一张失败不影响别的） */
    const handleFiles = useCallback(
        // 【2026-10-05】参数放宽成 `File[] | FileList`：采集层送进来的是一组 File 对象
        //（不再是 `<input>` 的 FileList），两条入口共用同一段处理逻辑
        async (input: File[] | FileList | null) => {
            if (!input || input.length === 0) return;
            const files = Array.from(input);
            const newCards: RecoverCard[] = files.map((file) => ({
                id: uid(),
                fileName: file.name || "photo.jpg",
                file,
                photo: null,
                qr: null,
                no: null,
                item: null,
                content: "",
                unclear: "",
                manual: "",
                saving: false,
                state: { k: "queued" },
            }));
            cardsRef.current = [...cardsRef.current, ...newCards];
            setCards(cardsRef.current);

            for (const c of newCards) {
                await processCard(c.id);
            }
        },
        [processCard],
    );

    /* ============ 采集层：收图 / 加工 / 送分析（2026-10-05） ============ */

    /** 把一批 File 收进「待处理」（超过上限的截掉，并给一句提示） */
    const addShots = useCallback(
        (files: File[]): string[] => {
            const used = pendingShotsRef.current.length + readyShotsRef.current.length;
            const room = Math.max(0, MAX_SHOTS - used);
            const take = files.slice(0, room);
            if (take.length < files.length) {
                setShotNotice(
                    L(
                        `一次最多收 ${MAX_SHOTS} 张，这次只收了前 ${take.length} 张 —— 剩下的分下一批吧。`,
                        `At most ${MAX_SHOTS} at a time; took the first ${take.length} only.`,
                    ),
                );
            } else {
                setShotNotice(null);
            }
            const shots: QueuedShot[] = take.map((file) => ({
                id: uid(),
                file,
                url: URL.createObjectURL(file),
            }));
            pendingShotsRef.current = [...pendingShotsRef.current, ...shots];
            setPendingShots(pendingShotsRef.current);
            return take.map((f) => f.name);
        },
        [L],
    );

    /** 从「待处理」或「预处理」里丢掉一张（记得把 objectURL 还回去，否则内存一直涨） */
    const dropShot = useCallback((id: string, from: "pending" | "ready") => {
        const list = from === "pending" ? pendingShotsRef.current : readyShotsRef.current;
        const target = list.find((s) => s.id === id);
        if (target) URL.revokeObjectURL(target.url);
        const next = list.filter((s) => s.id !== id);
        if (from === "pending") {
            pendingShotsRef.current = next;
            setPendingShots(next);
        } else {
            readyShotsRef.current = next;
            setReadyShots(next);
        }
    }, []);

    /**
     * 点「加工」：打开**图片剪裁页**（`ImageCropper`）—— 剪裁 / 橡皮擦 / 框选 / 旋转 / 拉伸。
     * 与录题目时"点待处理的那张图"进的是**同一个页面**（`batch-pipeline.tsx` 里也是它），
     * 所以拉伸（透视）等功能自然都在，不另造轮子。
     */
    const startEditShot = useCallback((id: string) => {
        const shot = pendingShotsRef.current.find((s) => s.id === id);
        if (!shot) return;
        editingShotRef.current = shot;
        setEditingShot(shot);
    }, []);

    /** 关掉剪裁页（没点「确定」= 这次加工作废，原图仍在「待处理」里） */
    const closeEditShot = useCallback(() => {
        editingShotRef.current = null;
        setEditingShot(null);
    }, []);

    /** 剪裁页点了「确定」⇒ 用出图替换原图，并挪进「预处理」 */
    const handleShotCropped = useCallback((blob: Blob) => {
        const target = editingShotRef.current;
        editingShotRef.current = null;
        setEditingShot(null);
        if (!target) return;
        const file = new File([blob], target.file.name || "shot.jpg", {
            type: blob.type || "image/jpeg",
        });
        pendingShotsRef.current = pendingShotsRef.current.filter((s) => s.id !== target.id);
        setPendingShots(pendingShotsRef.current);
        URL.revokeObjectURL(target.url);
        const shot: QueuedShot = { id: target.id, file, url: URL.createObjectURL(file) };
        readyShotsRef.current = [...readyShotsRef.current, shot];
        setReadyShots(readyShotsRef.current);
    }, []);

    /** 不想加工、直接用原图 ⇒ 从「待处理」挪进「预处理」 */
    const promoteShot = useCallback((id: string) => {
        const shot = pendingShotsRef.current.find((s) => s.id === id);
        if (!shot) return;
        pendingShotsRef.current = pendingShotsRef.current.filter((s) => s.id !== id);
        setPendingShots(pendingShotsRef.current);
        readyShotsRef.current = [...readyShotsRef.current, shot];
        setReadyShots(readyShotsRef.current);
    }, []);

    /** 待处理**全部**挪进预处理 —— 一次收了几十张又不想逐张点的时候用（不然手要废） */
    const promoteAllShots = useCallback(() => {
        if (pendingShotsRef.current.length === 0) return;
        readyShotsRef.current = [...readyShotsRef.current, ...pendingShotsRef.current];
        pendingShotsRef.current = [];
        setPendingShots([]);
        setReadyShots(readyShotsRef.current);
    }, []);

    /** 点【拼接】：把这张图带进拼接窗口（跨页材料题：再取一张，各框一段，接成一张） */
    const startStitch = useCallback((id: string) => {
        const shot = pendingShotsRef.current.find((s) => s.id === id);
        if (!shot) return;
        setStitchSeed(shot.file);
    }, []);

    /**
     * 【2026-10-09 第 3 条 · 改去向】拼接完成 ⇒ 结果进「待处理」（原来是进「预处理」）。
     *
     * 他实机用下来的原话："拼接后的图片不应该显示在预处理范围内，而是应该留在待处理范围，
     * 因为拼接好的内容很可能并未处理，虽然到预处理后也能框选等动作，但容易忘记。"
     * ⇒ 拼出来的通常还只是一张"接好的原图"，直接进预处理会被当成"可以送分析了"，加工那步最容易漏。
     *
     * ⚠️ **原来那张「待处理」的图一动不动**（他 10-05 特意要求）：
     *    "拼接方式生成的题只生成题，不从待处理消失 —— 这样原图上其它题还能继续提取"。
     *    所以这里只往 pending 里加一条，**不做** dropShot / promoteShot。
     */
    const handleStitched = useCallback((blob: Blob) => {
        const file = new File([blob], `stitch-${Date.now()}.jpg`, { type: "image/jpeg" });
        setStitchSeed(null);
        const shot: QueuedShot = { id: uid(), file, url: URL.createObjectURL(file) };
        pendingShotsRef.current = [...pendingShotsRef.current, shot];
        setPendingShots(pendingShotsRef.current);
    }, []);

    /** 页内相机（连拍）拍了一张 —— 直接进「待处理」，不绕收件箱那一圈 */
    const handleBurstShot = useCallback(
        (blob: Blob, action: "again" | "done") => {
            const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
            addShots([file]);
            if (action === "again") {
                setBurstCount((c) => c + 1);
                return;
            }
            setBurstCount(0);
        },
        [addShots],
    );

    /** 收件箱拉来一批（NAS 上别的 App 扫进来的照片）—— 收进「待处理」，并回报真正收下的名字 */
    const handleInboxImport = useCallback((files: File[]) => addShots(files), [addShots]);

    /**
     * 兜底：相机那个实例**理论上**永远走 `onBurstShot`（burstMode 下），不会走这里；
     * 但 `DocScannerProps.onScanComplete` 是必填项，且"万一"走到也不能丢图 ——
     * 所以让它同样收进「待处理」（等价于"拍完就收工"那一张）。
     */
    const handleScanCompleteFallback = useCallback(
        (blob: Blob) => handleBurstShot(blob, "done"),
        [handleBurstShot],
    );

    /**
     * 【开始分析】把「预处理」里的图**一起**交给既有的分流流程
     * —— 深挖纸走 `/api/recover`、复练纸走 `/api/recover/review`，由二维码自动判定。
     */
    const analyzeReady = useCallback(async () => {
        const shots = readyShotsRef.current;
        if (shots.length === 0) return;
        readyShotsRef.current = [];
        setReadyShots([]);
        const files = shots.map((s) => s.file);
        // 图已经交给 handleFiles（它会把 File 留在卡片里），这两个临时地址可以还回去了
        shots.forEach((s) => URL.revokeObjectURL(s.url));
        await handleFiles(files);
    }, [handleFiles]);

    /** 重试：已经认出题号且拿到图 ⇒ 只重跑"查题 + 送 AI"；否则整条重来 */
    const retry = useCallback(
        (id: string) => {
            const card = cardsRef.current.find((c) => c.id === id);
            if (!card) return;
            if (card.no && card.photo) {
                void lookupAndAnalyze(id, card.no);
            } else {
                void processCard(id);
            }
        },
        [lookupAndAnalyze, processCard],
    );

    /** 二维码认不出时，用手输的内容兜底（题号或页二维码都收） */
    const submitManual = useCallback(
        (id: string, raw: string) => {
            const route = classifyRecoveryCode(raw);
            if (route.route === "question") {
                void lookupAndAnalyze(id, route.value);
                return;
            }
            if (route.route === "review-page") {
                const card = cardsRef.current.find((c) => c.id === id);
                if (!card?.photo) {
                    patch(id, (c) => ({
                        ...c,
                        state: { k: "blocked", reason: "ai-error", detail: route.pageCode, message: L("图片丢了，请重试", "Image lost") },
                    }));
                    return;
                }
                cardsRef.current = cardsRef.current.filter((c) => c.id !== id);
                setCards(cardsRef.current);
                void startReviewCard(card.photo, card.fileName, route.pageCode, route.volumeNo, route.pageNo);
                return;
            }
            patch(id, (c) => ({ ...c, state: blockedFromRoute(route) }));
        },
        [L, lookupAndAnalyze, patch, startReviewCard],
    );

    const skip = useCallback(
        (id: string) => patch(id, (c) => ({ ...c, state: { k: "skipped" } })),
        [patch],
    );

    /** 保存：写进日积月累，**关联这道题 + 带上这张原图** */
    const saveCard = useCallback(
        async (id: string) => {
            const card = cardsRef.current.find((c) => c.id === id);
            if (!card || card.saving) return;
            const content = card.content.trim();
            if (!content) {
                alert(L("正文是空的：先写上内容再保存。", "Content is empty."));
                return;
            }
            patch(id, (c) => ({ ...c, saving: true }));
            try {
                const created = await apiClient.post<{ replaced?: boolean; code?: string }>("/api/insights", {
                    dateKey: dayKey(new Date()),
                    content,
                    // ★ 原图（压缩后）一并存进日积月累的配图 —— AI 认手写会错，原图是唯一真相
                    photo: card.photo,
                    errorItemNo: card.no,
                    source: "recover",
                    /**
                     * ⚠️【2026-10-04 审查发现并修正】这里必须传**学科 code**（`math`），不能传中文名。
                     * 依据：`lib/notebook-fields.ts` 文件头写明"**subject 存的是 subjectKey**
                     * （math / chinese / ...）"，且日积月累页的筛选参数就是 `?subjects=math,physics`。
                     * 原来写的是 `subjectLabel(card.item.notebook.subject)`（转成"数学"）
                     * ⇒ 这条日积月累在日积月累页**按学科筛会筛不出来**（两套口径对不上）。
                     */
                    subject: card.item?.notebook?.subject || null,
                });
                patch(id, (c) => ({
                    ...c,
                    saving: false,
                    /** 记下编号：下面「去查看」要**直接跳到这一条**（`/insights?pick=<编号>`） */
                    state: { k: "saved", replaced: !!created?.replaced, insightCode: created?.code ?? null },
                }));
            } catch (err) {
                patch(id, (c) => ({ ...c, saving: false }));
                alert(L("保存失败，请重试。", "Save failed, please retry."));
                console.error(err);
            }
        },
        [L, patch],
    );

    /** 卡片"卡住"时的一句人话（理由 + 原样信息，绝不静默） */
    const blockedText = useCallback(
        (state: Extract<CardState, { k: "blocked" }>): string => {
            switch (state.reason) {
                case "empty":
                    return L(
                        "这张没扫到二维码（可能没拍全、反光或拍糊了）。重拍一张，或在下面手输题号。",
                        "No QR code found. Retake the photo or type the code below.",
                    );
                case "page-code":
                    return L(
                        `读出来的是卷的页码码（${state.detail ?? ""}），不是深挖纸上的题号。`,
                        `That is a volume page code (${state.detail ?? ""}), not a question code.`,
                    );
                case "build-page":
                    return L(
                        `这是积累纸的码（${state.detail ?? ""}），这一屏还处理不了。请用积累纸那一屏回录。`,
                        `This is a build-up sheet code (${state.detail ?? ""}); this screen can't handle it yet.`,
                    );
                case "unknown":
                    return L(
                        `读出来的内容「${state.detail ?? ""}」不像题号。`,
                        `Scanned text "${state.detail ?? ""}" is not a question code.`,
                    );
                case "lookup-miss":
                    return L(
                        `按题号 ${state.detail ?? ""} 在题库里没找到这道题（可能已被删除）。可以在下面改号重试。`,
                        `Question ${state.detail ?? ""} was not found.`,
                    );
                default:
                    return L(
                        `AI 没读出来：${state.message ?? "未知错误"}。可以重试或跳过。`,
                        `AI failed: ${state.message ?? "unknown error"}. Retry or skip.`,
                    );
            }
        },
        [L],
    );

    /** 复练卡"卡住"时的一句人话（原因 + 原样信息，绝不静默） */
    const reviewBlockedText = useCallback(
        (state: Extract<ReviewCardState, { k: "blocked" }>): string => {
            switch (state.reason) {
                case "volume-miss":
                    return L(
                        `按页二维码里的卷号 ${state.detail ?? ""} 没找到这一卷（可能卷被删了）。`,
                        `Volume ${state.detail ?? ""} was not found.`,
                    );
                case "wrong-volume":
                    return L(
                        `查到的卷（${state.detail ?? ""}）不是这张纸上印的那一卷。`,
                        `The looked-up volume (${state.detail ?? ""}) does not match this sheet.`,
                    );
                case "empty-page":
                    return L(
                        `这一卷的第 ${state.detail ?? ""} 页在库里是空的（可能扫到了超出范围的页码）。`,
                        `Page ${state.detail ?? ""} has no items in this volume.`,
                    );
                case "not-review":
                    return L(
                        "这不是复练纸的页二维码（应为 RE…-NN）。",
                        "Not a review-sheet page code (expects RE…-NN).",
                    );
                case "build-page":
                    // 分流时已经拦下积累纸，这里是接口层的第二道（防御）—— 也给人话
                    return L(
                        `这是积累纸的码（${state.detail ?? ""}），这一屏处理不了它。`,
                        `This is a build-up sheet code (${state.detail ?? ""}); this screen can't handle it.`,
                    );
                default:
                    return L(
                        `AI 没读出来：${state.message ?? "未知错误"}。可以重试或跳过。`,
                        `AI failed: ${state.message ?? "unknown error"}. Retry or skip.`,
                    );
            }
        },
        [L],
    );

    const stepText = (step: WorkStep) =>
        ({
            compressing: L("压图…", "Compressing…"),
            decoding: L("读二维码…", "Reading QR…"),
            "looking-up": L("查这道题…", "Looking up…"),
            analyzing: L("AI 正在读她的手写…", "AI is reading her notes…"),
        })[step];

    const total = cards.length + reviewCards.length;
    const savedCount =
        cards.filter((c) => c.state.k === "saved").length +
        reviewCards.filter((c) => c.state.k === "saved").length;

    return (
        <main className="min-h-screen bg-background p-4 md:p-8">
            <div className="mx-auto max-w-3xl space-y-6">
                <div className="flex items-start gap-4">
                    <BackButton fallbackUrl="/" />
                    <div className="flex-1 space-y-1">
                        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
                            <ScanText className="h-6 w-6" />
                            {L("回录分析", "Recover")}
                        </h1>
                        <p className="text-sm text-muted-foreground sm:text-base">
                            {L(
                                "拍纸面照片，按二维码自动分流：深挖纸（裸题号）读她手写的分析整理成日积月累；复练纸（RE 页码码）在已知版面上读她标的对/错，校对后写进卷与复习史。",
                                "Photograph the sheet; we route by QR: deep-dive sheets (question code) become takeaways; review sheets (RE page code) have her right/wrong marks read at known positions and saved after review.",
                            )}
                        </p>
                    </div>
                    {/* 【2026-10-05】清空这一屏 —— 卡片会跨页面保留（见 session 的说明），
                        所以必须给一个"重新开始"的出口，不然旧的卡会一直挂着。 */}
                    {pendingShots.length + readyShots.length + total > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 text-muted-foreground"
                            onClick={clearSession}
                        >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            {L("清空", "Clear")}
                        </Button>
                    )}
                </div>

                {/* ===== 采集：三条通道 + 待处理 / 预处理（2026-10-05 改版） ===== */}
                <div className="space-y-3 rounded-lg border p-4">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            // 【2026-10-05】这里**故意不加 `capture`** ——
                            // 加了以后手机会直接弹系统摄像头，而那条路拍出来的照片回不到软件里（实测）；
                            // 不加就正常走相册 / 文件选择（全项目其它入口也都是这么做的）。
                            addShots(Array.from(e.target.files || []));
                            e.target.value = "";
                        }}
                    />

                    {/* 三条通道：电脑端用前两条，手机端三条都能用 */}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                            <Images className="mr-1.5 h-4 w-4" />
                            {L("从相册 / 文件夹选（可多选）", "Pick photos (multiple)")}
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setShotNotice(null);
                                cameraScannerRef.current?.openCamera();
                            }}
                        >
                            <Camera className="mr-1.5 h-4 w-4" />
                            {L("页内相机（可连拍）", "In-app camera (burst)")}
                        </Button>
                        {burstCount > 0 && (
                            <span className="text-sm text-muted-foreground">
                                {L(`本轮已拍 ${burstCount} 张`, `${burstCount} shot(s) this round`)}
                            </span>
                        )}
                    </div>

                    {/* 收件箱：手机上用别的 App 扫完丢进 NAS 目录，在这里一键拉进来。
                        【2026-10-05】传 `subPath` ⇒ 用**回录分析专用**的那个子目录
                        （`scan2recover`），与"录错题"默认用的 `scan2wrong` **分开管理**。
                        NAS 上的实际路径 = 挂载根 + 子目录 = `/vol2/1000/scan-inbox/scan2recover`。
                        目录没挂载时它自己整条不渲染 —— 电脑上不会多出点了没反应的按钮。 */}
                    <ScanInboxBar
                        subPath="scan2recover"
                        existingNames={[...pendingShots, ...readyShots].map((s) => s.file.name)}
                        onImport={handleInboxImport}
                        busy={
                            cards.some((c) => c.state.k === "working" || c.saving) ||
                            reviewCards.some((c) => c.state.k === "working" || c.saving)
                        }
                    />

                    {shotNotice && (
                        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                            {shotNotice}
                        </p>
                    )}

                    <p className="text-xs text-muted-foreground">
                        {L(
                            "三条路都行：① 手机 App 扫完丢进「回录专用收件箱」（NAS 上的 scan2recover 文件夹，跟录错题那个是分开的）批量拉；② 从相册 / 文件夹多选；③ 当场用页内相机连拍。图片先进下面的「待处理」，加工好再一起分析。",
                            "Three ways in: the recover-only inbox folder (scan2recover on the NAS, separate from the one used for entering questions), your photo album, or the in-app burst camera. Shots land in Pending; process them, then analyze together.",
                        )}
                    </p>

                    {/* ---- 待处理：刚收进来、还没加工 ---- */}
                    {pendingShots.length > 0 && (
                        <div className="space-y-2 border-t pt-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-sm font-medium">
                                    {L(`待处理 ${pendingShots.length} 张`, `Pending ${pendingShots.length}`)}
                                </span>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs text-muted-foreground">
                                        {L(
                                            "「加工」= 拉正四个角 + 漂白 / 黑白；不想加工就直接进预处理",
                                            "Process = straighten corners + whiten; or move on as-is",
                                        )}
                                    </span>
                                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={promoteAllShots}>
                                        {L("全部进预处理", "All → Ready")}
                                    </Button>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {pendingShots.map((s) => (
                                    <div key={s.id} className="relative overflow-hidden rounded-lg border">
                                        {/* 点图的**其他位置** = 加工（与右下角那个按钮同一个动作） */}
                                        <button
                                            type="button"
                                            className="block w-full"
                                            onClick={() => startEditShot(s.id)}
                                            title={L("点这里加工", "Tap to process")}
                                        >
                                            <img src={s.url} alt={s.file.name} className="h-24 w-full bg-muted object-cover" />
                                        </button>

                                        {/* 【2026-10-05】四个角（他指定的位置）。都做成小图标按钮：
                                            不挡图、也不会像文字按钮那样把缩略图挤变形。 */}
                                        {/* 左上 = 进预处理 */}
                                        <button
                                            type="button"
                                            className="absolute left-1 top-1 rounded bg-black/60 p-1 text-white hover:bg-black/80"
                                            onClick={() => promoteShot(s.id)}
                                            title={L("进预处理", "Mark as ready")}
                                        >
                                            <Check className="h-3 w-3" />
                                        </button>
                                        {/* 右上 = 移除 */}
                                        <button
                                            type="button"
                                            className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white hover:bg-black/80"
                                            onClick={() => dropShot(s.id, "pending")}
                                            title={L("移除", "Remove")}
                                        >
                                            <Trash2 className="h-3 w-3" />
                                        </button>
                                        {/* 左下 = 拼接（跨页材料题：这一张只是一部分，再接一张） */}
                                        <button
                                            type="button"
                                            className="absolute bottom-1 left-1 rounded bg-black/60 p-1 text-white hover:bg-black/80"
                                            onClick={() => startStitch(s.id)}
                                            title={L("拼接（跨页材料）", "Stitch pages")}
                                        >
                                            <Layers className="h-3 w-3" />
                                        </button>
                                        {/* 右下 = 加工 */}
                                        <button
                                            type="button"
                                            className="absolute bottom-1 right-1 rounded bg-black/60 p-1 text-white hover:bg-black/80"
                                            onClick={() => startEditShot(s.id)}
                                            title={L("加工（剪裁 / 拉伸）", "Process (crop)")}
                                        >
                                            <Crop className="h-3 w-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ---- 预处理：加工好了、等着一起分析 ---- */}
                    {readyShots.length > 0 && (
                        <div className="space-y-2 border-t pt-3">
                            <span className="text-sm font-medium">
                                {L(`预处理 ${readyShots.length} 张（就绪）`, `Ready ${readyShots.length}`)}
                            </span>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {readyShots.map((s) => (
                                    <div key={s.id} className="relative overflow-hidden rounded-lg border border-emerald-300">
                                        {/* 点图 = 看大图（这一格里的图是小格子，认不出是哪张就白等了） */}
                                        <button
                                            type="button"
                                            className="block w-full"
                                            onClick={() => openReadyLightbox(s.id)}
                                            title={L("点开看大图", "Tap to view")}
                                        >
                                            <img src={s.url} alt={s.file.name} className="h-24 w-full bg-muted object-cover" />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => dropShot(s.id, "ready")}
                                            className="absolute right-1 top-1 rounded bg-background/80 p-1 text-muted-foreground hover:text-foreground"
                                            aria-label={L("移除", "Remove")}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* 【开始分析】把预处理里的图**一起**送进去 —— 按二维码自动分流深挖纸 / 复练纸 */}
                {readyShots.length > 0 && (
                    <Button className="w-full" onClick={() => void analyzeReady()}>
                        <PlayCircle className="mr-1.5 h-4 w-4" />
                        {L(`开始分析这 ${readyShots.length} 张`, `Analyze these ${readyShots.length}`)}
                    </Button>
                )}

                {total > 0 && (
                    <p className="text-sm text-muted-foreground">
                        {L(`已分析 ${total} 张，已保存 ${savedCount} 张`, `${total} analyzed, ${savedCount} saved`)}
                    </p>
                )}

                {/* ===== 回录卡片 ===== */}
                {total === 0 ? (
                    <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
                        <CameraOff className="mx-auto mb-2 h-8 w-8" />
                        {L("还没有照片。点上面的按钮开始。", "No photos yet.")}
                    </div>
                ) : (
                    <div className="space-y-4">
                        {cards.map((card) => (
                            <div key={card.id} className="overflow-hidden rounded-lg border">
                                <div className="flex flex-col gap-4 p-4 sm:flex-row">
                                    {/* 缩略图（原图就在这儿，别只存 AI 的话） */}
                                    <div className="shrink-0">
                                        {card.photo ? (
                                            /* 点图 = 看大图（分析完就只剩这一小格，认不出是哪张卷子） */
                                            <button
                                                type="button"
                                                onClick={() => openCardLightbox(card.id)}
                                                title={L("点开看大图", "Tap to view")}
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                    src={card.photo}
                                                    alt={card.fileName}
                                                    className="h-36 w-auto max-w-full rounded border object-contain"
                                                />
                                            </button>
                                        ) : (
                                            <div className="flex h-36 w-28 items-center justify-center rounded border bg-muted text-muted-foreground">
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                            </div>
                                        )}
                                    </div>

                                    <div className="min-w-0 flex-1 space-y-3">
                                        {/* 认到的题号 + 题干摘要 */}
                                        <div className="flex flex-wrap items-center gap-2 text-sm">
                                            {card.no ? (
                                                <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{card.no}</span>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">{card.fileName}</span>
                                            )}
                                            {card.item?.questionText && (
                                                <span className="truncate text-muted-foreground">
                                                    {card.item.questionText.slice(0, 60)}
                                                </span>
                                            )}
                                        </div>

                                        {/* ---- 状态 ---- */}
                                        {card.state.k === "queued" && (
                                            <p className="text-sm text-muted-foreground">{L("排队中…", "Queued…")}</p>
                                        )}
                                        {card.state.k === "working" && (
                                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                {stepText(card.state.step)}
                                            </p>
                                        )}

                                        {card.state.k === "ready" && (
                                            <div className="space-y-2">
                                                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                                    <Sparkles className="h-3.5 w-3.5" />
                                                    {L(
                                                        "AI 已整理（斜体是 AI 的话，前面是她写的原话）。可直接改，确认后保存。",
                                                        "AI formatted it (italic = AI). Edit, then save.",
                                                    )}
                                                </p>
                                                <MdEditor
                                                    value={card.content}
                                                    onChange={(md) => patch(card.id, (c) => ({ ...c, content: md }))}
                                                    minHeightPx={140}
                                                />
                                                {card.unclear && (
                                                    <p className="text-xs text-amber-600">
                                                        {L(`AI 看不清：${card.unclear}`, `Unclear: ${card.unclear}`)}
                                                    </p>
                                                )}
                                                <div className="flex flex-wrap gap-2">
                                                    <Button onClick={() => void saveCard(card.id)} disabled={card.saving}>
                                                        {card.saving ? (
                                                            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <CheckCircle2 className="mr-1.5 h-4 w-4" />
                                                        )}
                                                        {L("保存积累", "Save takeaway")}
                                                    </Button>
                                                    <Button variant="ghost" onClick={() => skip(card.id)}>
                                                        {L("跳过", "Skip")}
                                                    </Button>
                                                </div>
                                            </div>
                                        )}

                                        {card.state.k === "blocked" && (
                                            <div className="space-y-2">
                                                <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                                                    {blockedText(card.state)}
                                                </p>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Button variant="outline" onClick={() => retry(card.id)}>
                                                        <RotateCcw className="mr-1.5 h-4 w-4" />
                                                        {L("重试", "Retry")}
                                                    </Button>
                                                    <Input
                                                        className="w-44 font-mono"
                                                        placeholder={L("手输题号", "Type code")}
                                                        value={card.manual}
                                                        onChange={(e) => patch(card.id, (c) => ({ ...c, manual: e.target.value }))}
                                                        onKeyDown={(e) => {
                                                            if (e.key === "Enter" && card.manual.trim()) {
                                                                submitManual(card.id, card.manual);
                                                            }
                                                        }}
                                                    />
                                                    <Button
                                                        variant="secondary"
                                                        disabled={!card.manual.trim()}
                                                        onClick={() => submitManual(card.id, card.manual)}
                                                    >
                                                        {L("用这个题号", "Use code")}
                                                    </Button>
                                                    <Button variant="ghost" onClick={() => skip(card.id)}>
                                                        {L("跳过", "Skip")}
                                                    </Button>
                                                </div>
                                            </div>
                                        )}

                                        {card.state.k === "saved" && (
                                            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-emerald-600">
                                                <CheckCircle2 className="h-4 w-4 shrink-0" />
                                                {card.state.replaced
                                                    ? L("已更新这道题的积累（编号不变）。", "Updated this question's takeaway.")
                                                    : L("已存进日积月累。", "Saved as a takeaway.")}
                                                {card.state.insightCode && (
                                                    <span className="font-mono text-xs text-muted-foreground">
                                                        {card.state.insightCode}
                                                    </span>
                                                )}
                                                {/* 带 pick / noleft / back 三个参数（见 insightViewHref 的说明）——
                                                    日积月累页的「后退」会回到本页，而本页这一场**还在**。 */}
                                                <Link href={insightViewHref(card.state.insightCode)} className="underline">
                                                    {L("去查看", "View")}
                                                </Link>
                                            </p>
                                        )}

                                        {card.state.k === "skipped" && (
                                            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                                                <SkipForward className="h-4 w-4" />
                                                {L("已跳过（这张没写进库）。", "Skipped (not saved).")}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}

                        {/* ===== 复练纸卡片（第二步）===== */}
                        {reviewCards.map((card) => (
                            <div key={card.id} className="overflow-hidden rounded-lg border">
                                <div className="flex flex-col gap-4 p-4 sm:flex-row">
                                    <div className="shrink-0">
                                        {card.photo ? (
                                            /* 点图 = 看大图（同上：分析完只剩一小格） */
                                            <button
                                                type="button"
                                                onClick={() => openReviewLightbox(card.id)}
                                                title={L("点开看大图", "Tap to view")}
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                    src={card.photo}
                                                    alt={card.fileName}
                                                    className="h-36 w-auto max-w-full rounded border object-contain"
                                                />
                                            </button>
                                        ) : (
                                            <div className="flex h-36 w-28 items-center justify-center rounded border bg-muted text-muted-foreground">
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                            </div>
                                        )}
                                    </div>

                                    <div className="min-w-0 flex-1 space-y-3">
                                        <div className="flex flex-wrap items-center gap-2 text-sm">
                                            {card.pageCode ? (
                                                <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{card.pageCode}</span>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">{card.fileName}</span>
                                            )}
                                            {card.volumeNo && card.pageNo != null && (
                                                <span className="text-muted-foreground">
                                                    {L(`复练卷 ${card.volumeNo} 第 ${card.pageNo} 页`, `${card.volumeNo} p.${card.pageNo}`)}
                                                </span>
                                            )}
                                        </div>

                                        {card.state.k === "queued" && (
                                            <p className="text-sm text-muted-foreground">{L("排队中…", "Queued…")}</p>
                                        )}
                                        {card.state.k === "working" && (
                                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                {L("看这一页、读她标的记号…", "Reading her marks…")}
                                            </p>
                                        )}

                                        {card.state.k === "ready" && (
                                            <div className="space-y-3">
                                                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                                    <Sparkles className="h-3.5 w-3.5" />
                                                    {L(
                                                        "AI 只读了她标的记号（不判卷）。下表可改，确认后保存。",
                                                        "AI only read her marks (no grading). Edit below, then save.",
                                                    )}
                                                </p>
                                                <div className="overflow-x-auto">
                                                    <table className="w-full min-w-[30rem] text-sm">
                                                        <thead>
                                                            <tr className="text-left text-xs text-muted-foreground">
                                                                <th className="py-1 pr-2">{L("位置", "Slot")}</th>
                                                                <th className="py-1 pr-2">{L("题号 / 题干", "No. / Question")}</th>
                                                                <th className="py-1 pr-2">{L("她标的", "Her mark")}</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {card.rows.map((r) => (
                                                                <tr key={r.rowId} className="border-t align-top">
                                                                    <td className="py-2 pr-2 font-mono text-xs">{r.slot}</td>
                                                                    <td className="py-2 pr-2">
                                                                        <div className="font-mono text-xs">{r.itemNo || "—"}</div>
                                                                        <div className="max-w-[16rem] truncate text-muted-foreground">
                                                                            {r.errorItemId
                                                                                ? r.questionText || L("（无题干）", "(no text)")
                                                                                : L("（题已从题库删除，只记纸面标记）", "(deleted; on-paper mark only)")}
                                                                        </div>
                                                                    </td>
                                                                    <td className="py-2 pr-2">
                                                                        <div className="flex flex-wrap gap-1">
                                                                            {MARK_CHOICES.map((choice) => (
                                                                                <Button
                                                                                    key={choice.value}
                                                                                    size="sm"
                                                                                    variant={r.mark === choice.value ? "default" : "outline"}
                                                                                    className="h-7 px-2"
                                                                                    onClick={() => setReviewMark(card.id, r.rowId, choice.value)}
                                                                                >
                                                                                    {L(choice.zh, choice.en)}
                                                                                </Button>
                                                                            ))}
                                                                        </div>
                                                                        {r.mark === "unclear" && (
                                                                            <span className="text-xs text-amber-600">
                                                                                {L("AI 看不清这一格，请选一个", "Unclear — please pick one")}
                                                                            </span>
                                                                        )}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                                {card.unclear && (
                                                    <p className="text-xs text-amber-600">
                                                        {L(`AI 看不清：${card.unclear}`, `Unclear: ${card.unclear}`)}
                                                    </p>
                                                )}
                                                <div className="flex flex-wrap gap-2">
                                                    <Button onClick={() => void saveReviewCard(card.id)} disabled={card.saving}>
                                                        {card.saving ? (
                                                            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <CheckCircle2 className="mr-1.5 h-4 w-4" />
                                                        )}
                                                        {L("保存（写卷与复习史）", "Save")}
                                                    </Button>
                                                    <Button variant="ghost" onClick={() => skipReview(card.id)}>
                                                        {L("跳过", "Skip")}
                                                    </Button>
                                                </div>
                                            </div>
                                        )}

                                        {card.state.k === "blocked" && (
                                            <div className="space-y-2">
                                                <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                                                    {reviewBlockedText(card.state)}
                                                </p>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Button variant="outline" onClick={() => retryReview(card.id)}>
                                                        <RotateCcw className="mr-1.5 h-4 w-4" />
                                                        {L("重试", "Retry")}
                                                    </Button>
                                                    <Button variant="ghost" onClick={() => skipReview(card.id)}>
                                                        {L("跳过", "Skip")}
                                                    </Button>
                                                </div>
                                            </div>
                                        )}

                                        {card.state.k === "saved" && (
                                            <div className="space-y-1">
                                                <p className="flex items-center gap-1.5 text-sm text-emerald-600">
                                                    <CheckCircle2 className="h-4 w-4" />
                                                    {L(
                                                        `已保存：${card.state.written} 道题（卷标记 + 复习史）。`,
                                                        `Saved: ${card.state.written} question(s).`,
                                                    )}
                                                </p>
                                                {card.state.skipped > 0 && (
                                                    <p className="text-xs text-muted-foreground">
                                                        {L(
                                                            `另有 ${card.state.skipped} 格没标或看不清，按规矩没有写入 —— 想记的话在校对表格里点一下，再保存一次。`,
                                                            `${card.state.skipped} unmarked/unclear cell(s) were intentionally not saved.`,
                                                        )}
                                                    </p>
                                                )}
                                            </div>
                                        )}

                                        {card.state.k === "skipped" && (
                                            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                                                <SkipForward className="h-4 w-4" />
                                                {L("已跳过（这张没写进库）。", "Skipped (not saved).")}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ===== 页内相机（连拍）：拍完直接进「待处理」，不绕收件箱 ===== */}
            <DocScanner
                ref={cameraScannerRef}
                burstMode
                burstCount={burstCount}
                onBurstShot={handleBurstShot}
                onScanComplete={handleScanCompleteFallback}
                onClose={() => setBurstCount(0)}
            />

            {/* ===== 加工用的图片剪裁页（2026-10-05 按他的要求换掉）=====
                与录题目时"点待处理的那张图"进的是**同一个组件**（`batch-pipeline.tsx` 也是它）：
                剪裁 / 橡皮擦 / 框选 / 旋转 / 拉伸（透视），所以"拉伸"自然就在里面。
                ⚠️ 只接必需的四个 prop：不传绿框（`onCropBatch`）与坐标那几条通道 ——
                   回录不需要净版/题图坐标，传了反而会写出一堆没用的数据。 */}
            {editingShot && (
                <ImageCropper
                    imageSrc={editingShot.url}
                    open
                    onClose={closeEditShot}
                    onCropComplete={handleShotCropped}
                />
            )}

            {/* ===== 拼接窗口（2026-10-05）=====
                跨页材料题：第一张（从「待处理」带进来）+ 再取一张（本机 / 相机 / 收件箱），
                各自框出有用的段，竖着接成一张。
                【2026-10-09 第 3 条】结果放进**「待处理」**（原先进预处理 —— 他说
                "拼好的内容很可能并未处理，进预处理容易忘记加工"）。
                ⚠️ 独立窗口，**没碰**裁剪页那个四页共用的编辑器。 */}
            {stitchSeed && (
                <StitchComposer
                    open
                    seeds={[stitchSeed]}
                    /* 【2026-10-05】回录分析页用**它自己**那个收件箱（`scan2recover`）；
                       批量上传页不传这个参数 ⇒ 那边用的是录错题那个（`scan2wrong`）。 */
                    inboxSubPath="scan2recover"
                    knownNames={[...pendingShots, ...readyShots].map((s) => s.file.name)}
                    onCancel={() => setStitchSeed(null)}
                    onDone={handleStitched}
                />
            )}

            {/* ===== 看图窗口（2026-10-05）=====
                与收件箱预览**同一个组件**（`ImageLightbox`）：滚轮/双指缩放、拖动平移、
                双击放大、手机横扫翻页、左右按钮翻页。
                ⚠️ 传 `items` 而不是"一张图 + 列表"：翻页要在**同一组**里进行
                   （预处理那组翻预处理，已分析那组翻已分析），不跨组。 */}
            <ImageLightbox
                open={lightbox !== null}
                items={lightboxItems}
                index={lightbox?.index ?? 0}
                onIndexChange={(i) => setLightbox((prev) => (prev ? { ...prev, index: i } : prev))}
                onClose={() => setLightbox(null)}
            />
        </main>
    );
}
