/**
 * 屏幕截图（2026-10-19 空空第 3 条：把「屏幕截图」提到主页当独立按钮）
 *
 * 这段逻辑原来长在 `components/upload-zone.tsx` 里，和上传区绑在一起。
 * 他要把它变成主页上一个**并列的入口**（批量上传 / 屏幕截图 / 标签管理 / 扫二维码），
 * 所以抽成独立函数：**只有取图这一段**，界面与提示由调用方决定。
 *
 * ── 为什么这么写（都是踩过的）────────────────────────────────────────
 *  ① **必须 `getDisplayMedia`**，不是 `getUserMedia` —— 前者才能抓屏幕/标签页，
 *     后者只会开摄像头（浏览器会把它当成"拍照"处理）。
 *  ② **`CaptureController` + `no-focus-change`**：不设的话，用户选了别的标签页，
 *     浏览器会**把焦点切过去**，截到的就是切换后的画面（我们的页面自己跑了）。
 *  ③ **必须等一帧**（本实现 `setTimeout 500ms`）：`video.play()` 之后立刻 draw
 *     有概率画到黑帧，表现是"截出来一张全黑"。
 *  ④ **截完立刻 stop 所有 track**：不 stop 的话浏览器那条"正在共享屏幕"的横幅
 *     会一直挂着，用户以为程序挂了。
 *
 * ⚠️ 只在 **https / localhost** 下可用（`isSecureContext`）；NAS 上走的是 https，OK。
 */

export function isScreenshotSupported(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        'mediaDevices' in navigator &&
        typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    );
}

export class ScreenshotError extends Error {
    constructor(
        message: string,
        /** 被用户取消（选了"取消"或直接关了那个选择框）—— 调用方通常**不该报错** */
        readonly cancelled = false,
    ) {
        super(message);
        this.name = 'ScreenshotError';
    }
}

/** 抓一屏，返回一个 PNG File（文件名带时间戳，便于排查"这是哪次截的"） */
export async function captureScreen(): Promise<File> {
    if (!isScreenshotSupported()) {
        throw new ScreenshotError('当前浏览器不支持屏幕截图（需要 getDisplayMedia）');
    }

    let stream: MediaStream | null = null;
    try {
        const options: DisplayMediaStreamOptions & {
            preferCurrentTab?: boolean;
            controller?: unknown;
        } = {
            video: true,
            audio: false,
            // 让「此标签页」排在选项里靠前（Chrome 支持；不支持的浏览器会忽略）
            preferCurrentTab: false,
        };

        type FocusController = { setFocusBehavior?: (v: string) => void };
        let controller: FocusController | null = null;
        if (typeof window !== 'undefined' && 'CaptureController' in window) {
            const Ctor = (window as unknown as { CaptureController: new () => FocusController }).CaptureController;
            controller = new Ctor();
            if (controller) options.controller = controller;
        }

        stream = await navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions);

        const [videoTrack] = stream.getVideoTracks();
        const displaySurface = (videoTrack?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
        if (controller && (displaySurface === 'browser' || displaySurface === 'window')) {
            try {
                controller.setFocusBehavior?.('no-focus-change');
            } catch {
                // 老浏览器没有这个方法：忽略即可，只影响"会不会切走焦点"
            }
        }

        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;

        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => {
                video.play().then(resolve).catch(reject);
            };
            video.onerror = () => reject(new Error('视频加载失败'));
        });

        // 等一帧稳定下来，否则有概率画到黑帧（见文件头 ③）
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (video.videoWidth === 0 || video.videoHeight === 0) {
            throw new Error('截图尺寸为 0（可能是浏览器拒绝了共享）');
        }

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建画布');
        ctx.drawImage(video, 0, 0);

        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png', 1.0));
        if (!blob) throw new Error('截图转换失败');

        return new File([blob], `screenshot-${Date.now()}.png`, { type: 'image/png' });
    } catch (error) {
        /**
         * 用户点了「取消」→ 浏览器抛 `NotAllowedError`，`message` 是 "Permission denied"。
         * 这不是故障，调用方不该弹红字（她只是改主意了）。
         */
        if (error instanceof Error && error.name === 'NotAllowedError') {
            throw new ScreenshotError('已取消截图', true);
        }
        throw error;
    } finally {
        // ④ 无论成败都要停掉共享，否则"正在共享屏幕"的横幅会一直挂着
        stream?.getTracks().forEach((t) => t.stop());
    }
}
