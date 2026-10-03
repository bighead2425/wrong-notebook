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

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import jsQR from "jsqr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
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
} from "lucide-react";

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
    | { k: "saved"; replaced: boolean }
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
          reason: RecoveryBlockedReason | "ai-error" | "not-review";
          detail: string | null;
          message: string | null;
      }
    | { k: "saved"; written: number }
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

/** 把图片 data URL 解成二维码文本（jsQR，纯 JS，任何浏览器可跑） */
async function decodeQrFromDataUrl(dataUrl: string): Promise<string | null> {
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

export default function RecoverPage() {
    const { language } = useLanguage();
    const zh = language === "zh";
    /** 双语助手（与 /scan 页同一写法） */
    const L = useCallback((a: string, b: string) => (zh ? a : b), [zh]);

    const [cards, setCards] = useState<RecoverCard[]>([]);
    /** ⚠️ 与 cards 同步的**可变副本**：异步流程里每一步都要读"最新那张卡"，不能等 React 重渲染 */
    const cardsRef = useRef<RecoverCard[]>([]);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    /** 改一张卡：ref 与 state 同步更新（见上面 ref 的说明） */
    const patch = useCallback((id: string, updater: (c: RecoverCard) => RecoverCard) => {
        cardsRef.current = cardsRef.current.map((c) => (c.id === id ? updater(c) : c));
        setCards(cardsRef.current);
    }, []);

    /* ================== 复练纸（第二步）：状态与流程 ================== */

    const [reviewCards, setReviewCards] = useState<ReviewCard[]>([]);
    /** ⚠️ 与 reviewCards 同步的**可变副本**（同 cardsRef 的道理） */
    const reviewRef = useRef<ReviewCard[]>([]);

    const patchReview = useCallback((id: string, updater: (c: ReviewCard) => ReviewCard) => {
        reviewRef.current = reviewRef.current.map((c) => (c.id === id ? updater(c) : c));
        setReviewCards(reviewRef.current);
    }, []);

    /** 把接口的 400 变成"具体原因 + 一句人话" */
    const reviewBlockedOf = useCallback((err: unknown): { reason: RecoveryBlockedReason | "ai-error" | "not-review"; message: string } => {
        if (err instanceof ApiError) {
            const data = err.data as { message?: string; details?: { reason?: string } } | undefined;
            const reason = data?.details?.reason;
            if (reason === "volume-miss" || reason === "wrong-volume" || reason === "empty-page" || reason === "not-review") {
                return { reason, message: "" };
            }
            return { reason: "ai-error", message: humanizeError(err) };
        }
        return { reason: "ai-error", message: humanizeError(err) };
    }, []);

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
                const { reason, message } = reviewBlockedOf(err);
                patchReview(id, (c) => ({ ...c, state: { k: "blocked", reason, detail: card.pageCode, message } }));
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
                patchReview(id, (c) => ({ ...c, saving: false, state: { k: "saved", written: writes.length } }));
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
        async (fileList: FileList | null) => {
            if (!fileList || fileList.length === 0) return;
            const files = Array.from(fileList);
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
                const created = await apiClient.post<{ replaced?: boolean }>("/api/insights", {
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
                patch(id, (c) => ({ ...c, saving: false, state: { k: "saved", replaced: !!created?.replaced } }));
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
                </div>

                {/* ===== 选照片 / 拍一张 ===== */}
                <div className="space-y-3 rounded-lg border p-4">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        capture="environment"
                        className="hidden"
                        onChange={(e) => {
                            void handleFiles(e.target.files);
                            e.target.value = "";
                        }}
                    />
                    <div className="flex flex-wrap items-center gap-3">
                        <Button onClick={() => fileInputRef.current?.click()}>
                            <Camera className="mr-1.5 h-4 w-4" />
                            {L("选照片 / 拍一张", "Pick photos / Take one")}
                        </Button>
                        {total > 0 && (
                            <span className="text-sm text-muted-foreground">
                                {L(`共 ${total} 张，已保存 ${savedCount} 张`, `${total} photo(s), ${savedCount} saved`)}
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {L(
                            "可一次选多张：每张单独处理，一张失败不影响别张。认不出二维码的卡会显示原因，可重试、手输题号或跳过。",
                            "You can select several: each is processed on its own; a failure won't affect the others.",
                        )}
                    </p>
                </div>

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
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={card.photo}
                                                alt={card.fileName}
                                                className="h-36 w-auto max-w-full rounded border object-contain"
                                            />
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
                                                        {L("保存进日积月累", "Save as takeaway")}
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
                                            <p className="flex items-center gap-1.5 text-sm text-emerald-600">
                                                <CheckCircle2 className="h-4 w-4" />
                                                {card.state.replaced
                                                    ? L("已更新这道题的日积月累（编号不变）。", "Updated this question's takeaway.")
                                                    : L("已保存进日积月累。", "Saved as a takeaway.")}
                                                <Link href="/insights" className="underline">
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
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={card.photo}
                                                alt={card.fileName}
                                                className="h-36 w-auto max-w-full rounded border object-contain"
                                            />
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
                                            <p className="flex items-center gap-1.5 text-sm text-emerald-600">
                                                <CheckCircle2 className="h-4 w-4" />
                                                {L(
                                                    `已保存：${card.state.written} 道题（卷标记 + 复习史）。`,
                                                    `Saved: ${card.state.written} question(s).`,
                                                )}
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
                    </div>
                )}
            </div>
        </main>
    );
}
