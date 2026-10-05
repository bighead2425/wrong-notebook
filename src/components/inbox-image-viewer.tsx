"use client";

/**
 * 【custom-v33】收件箱照片预览页 —— 「扫描收件箱」的子窗口。
 *
 * 起因：收件箱面板里照片一小格一小格，只能看个大概，认不出是哪张卷子；
 * 而"这张到底导没导过"也得点进去才知道。这个页面解决三件事：
 *
 *   ① **看清**：整屏看一张，滚轮/双指缩放、右键拖动平移；
 *   ② **校正**：拍歪了就地逆时针转 90°，转一次存一次 —— 以后再打开就是正的；
 *   ③ **归档**：在这里可以直接改"新照片 / 已录入"，也可以顺手删掉不要的。
 *
 * ── 【2026-10-05】"看图"那一层已抽成 `ImageLightbox` ──────────────
 *
 * 回录页也要"点开看清是哪张图"，而那套缩放/平移/翻页的手感必须两个窗口一模一样。
 * 所以缩放平移的数学、翻页手势、双击放大、适应大小**都不再写在这里**，
 * 而是复用 `components/image-lightbox`；这里只留下"业务"：
 * 选中 / 旋转（存台账）/ 改状态 / 下载 / 删除 / 关窗前等保存落地。
 *
 * ── 几个刻意的设计取舍（未变）────────────────────────────────
 *
 * · **旋转不改 NAS 上的文件**，只把"方向"记在台账里（见 lib/scan-inbox 的 InboxEntry）。
 *   理由：原始扫描件留原样，转错了还能转回来；而且每次旋转都重写一遍文件，
 *   会平白刷新修改时间，把"按拍照顺序排列"这个隐含约定搞乱。
 *
 * · **转一次就存一次**（而不是等切走/关闭才存）。用户的原话是"切走或关闭时保存"，
 *   立即存是它的超集：手机没电、浏览器被系统杀后台，都不至于把这几次旋转白转。
 *   为了防"连点三下、请求乱序到达导致存成错误角度"，保存走**串行链**：
 *   后一次一定等前一次落地再发。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageLightbox, type LightboxItem } from "@/components/image-lightbox";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { rotateCCW } from "@/lib/image-rotation";
import { Check, Download, Loader2, RotateCcw, Trash2 } from "lucide-react";

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

/** 工具栏图标按钮的统一长相（与 ImageLightbox 里那套一致） */
const iconBtn =
    "h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-background disabled:hover:text-muted-foreground";

const divider = <span className="w-px h-5 bg-border mx-1" />;

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

    const [busy, setBusy] = useState(false);

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

    /** 逆时针转 90° —— 转完立刻存（界面回到适应大小由 lightbox 自己处理：rotation 一变它就 refit） */
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
        const isTouch = typeof navigator !== "undefined"
            && (navigator.maxTouchPoints > 0 || (window.matchMedia?.("(hover: none)").matches ?? false));

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
             * 删的若是最后一张，索引会越界 —— 越界由环形取模收敛到第一张，
             * 语义正好也是"下一张"（从头开始）。
             */
        } finally {
            setBusy(false);
        }
    };

    /** 关窗前：等所有保存落地 → 让父窗口重读一遍（真正的 onClose 由 lightbox 负责调） */
    const beforeClose = async () => {
        await saveChainRef.current;
        if (persistFailedRef.current) {
            persistFailedRef.current = false;
            alert(s.viewerSaveFailed || "刚才的改动没能存到服务器，已重新读取收件箱");
        }
        await onReload();
    };

    /* 图片列表交给 lightbox（src 只在这里拼一次，注意编码文件名） */
    const items: LightboxItem[] = useMemo(
        () => files.map((f) => ({
            src: `/api/scan-inbox/file?name=${encodeURIComponent(f.name)}`,
            label: f.name,
            rotation: f.rotation,
        })),
        [files],
    );

    // 照片被删光了（可能是在别处删的）→ 自动收起，别留一个空窗口。
    //（lightbox 自己也有这条兜底；这里保留是为了"列表为空时本组件返回 null、
    //  lightbox 根本没挂载"的那种情况。）
    useEffect(() => {
        if (open && count === 0) onClose();
    }, [open, count, onClose]);

    if (!cur) return null;

    /* 【custom-v34】状态按钮上的字改成 New / Old（用户指定）：
       中文两个字、英文一个词，短且等长，按钮不会随状态换宽。
       网格缩略图角标上仍是「新 / 已导入」—— 那里空间小，中文更省地方。 */
    const statusText = isQueued
        ? (s.badgeQueued || "已在队列")
        : cur.imported
            ? (s.viewerStatusOld || "Old")
            : (s.viewerStatusNew || "New");

    return (
        <ImageLightbox
            open={open}
            items={items}
            index={index}
            onIndexChange={onIndexChange}
            busy={busy}
            onClose={onClose}
            onBeforeClose={beforeClose}
            title={s.viewerTitle || "照片预览"}
            toolbarLeft={
                /* 选中状态：**方框 + 文字做成一个按钮，宽度钉死**。
                   原先方框是按钮、文字是旁边的 span，两段文字长短不一
                   （"未选中" vs "已选中，导入时会带上这张"）—— 点一下就换行宽，
                   后面那一串按钮跟着左右跳。现在文字收进按钮里、宽度固定，怎么点都不动。 */
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
            }
            toolbarRight={
                <>
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

                    {divider}

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
                </>
            }
        />
    );
}
