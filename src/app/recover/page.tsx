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
    parseScannedCode,
    resolveScannedLookup,
    type ScannedCode,
    type ScanBlockedReason,
    type ScanLookupResult,
} from "@/lib/recover-analysis";
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
    | { k: "blocked"; reason: ScanBlockedReason | "ai-error"; detail: string | null; message: string | null }
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

/** 扫描分类结果 → 卡片的"卡住"状态（题号那一支不该走这里） */
function blockedFromScanned(scanned: ScannedCode): CardState {
    if (scanned.kind === "empty") return { k: "blocked", reason: "empty", detail: null, message: null };
    if (scanned.kind === "page-code") {
        return { k: "blocked", reason: "page-code", detail: scanned.value, message: null };
    }
    return { k: "blocked", reason: "unknown", detail: scanned.value || null, message: null };
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

    /** 一张照片的完整流程：压缩 → 解二维码 → 查题 → 送 AI */
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
                const scanned = parseScannedCode(qr);
                if (scanned.kind !== "question") {
                    patch(id, (c) => ({ ...c, qr, no: null, state: blockedFromScanned(scanned) }));
                    return;
                }
                patch(id, (c) => ({ ...c, qr, no: scanned.value }));
                await lookupAndAnalyze(id, scanned.value);
            } catch (err) {
                patch(id, (c) => ({
                    ...c,
                    state: { k: "blocked", reason: "ai-error", detail: null, message: humanizeError(err) },
                }));
            }
        },
        [lookupAndAnalyze, patch],
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

    /** 二维码认不出时，用手输的题号兜底 */
    const submitManual = useCallback(
        (id: string, raw: string) => {
            const parsed = parseScannedCode(raw);
            if (parsed.kind !== "question") {
                patch(id, (c) => ({
                    ...c,
                    state: {
                        k: "blocked",
                        reason: parsed.kind === "empty" ? "empty" : parsed.kind === "page-code" ? "page-code" : "unknown",
                        detail: parsed.value || null,
                        message: null,
                    },
                }));
                return;
            }
            void lookupAndAnalyze(id, parsed.value);
        },
        [lookupAndAnalyze, patch],
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

    const stepText = (step: WorkStep) =>
        ({
            compressing: L("压图…", "Compressing…"),
            decoding: L("读二维码…", "Reading QR…"),
            "looking-up": L("查这道题…", "Looking up…"),
            analyzing: L("AI 正在读她的手写…", "AI is reading her notes…"),
        })[step];

    const total = cards.length;
    const savedCount = cards.filter((c) => c.state.k === "saved").length;

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
                                "拍深挖纸正面下半部分她手写的分析。系统读二维码认出题号，再让 AI 把她的手写整理成一条日积月累（原图一起存下）。",
                                "Photograph the handwritten reflection on the deep-dive sheet. We read the QR to find the question, then let AI turn her notes into a takeaway — keeping the photo.",
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
                    </div>
                )}
            </div>
        </main>
    );
}
