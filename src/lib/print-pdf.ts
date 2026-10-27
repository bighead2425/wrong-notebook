"use client";

/**
 * 把纸面拍成 PDF —— **只在"共享打印"这条路上用**（本机打印仍然走 `window.print()`）。
 *
 * ── 为什么不直接 `window.print()` ──────────────────────────────────────
 * 手机上浏览器没有打印机发现能力，"打印"对话框里根本没有那台 Brother；
 * 所以得由我们**自己把纸面变成文件**，再交给 NAS 上的 EasyPrinter。
 *
 * ── 为什么把每一面克隆到"固定页盒"里再拍 ─────────────────────────────
 * 屏幕上的纸面是"带纸边"的演示样式（padding 15mm、负外边距、打孔位尺寸也和外边不同），
 * 直接拍屏会把 194mm 宽的东西放进 182mm 的纸里 —— 整版缩一圈。
 * 所以这里克隆一份、套上 `.print-capture-page`（见 globals.css），
 * 强制成**打印时的那套几何**：152mm 内容 + 打孔位，再放进 182×257 的页盒。
 * 拍出来的就是纸，不是屏幕。
 *
 * ⚠️ 两个库都是**动态 import**：只有点"共享打印"时才下载，
 *    平时打开错题本一点都不加载（首页体积不受影响）。
 */

import type { PrintPaper } from "./print-route";

export interface PageGeometry {
    /** 整纸宽高（mm） */
    wMm: number;
    hMm: number;
    /** @page 的四边页边距（mm） */
    padTop: number;
    padRight: number;
    padBottom: number;
    padLeft: number;
    /** 每一面实际占的高度（= 内容区 − 2mm 松量，见 lib/paper.ts） */
    contentHMm: number;
}

/**
 * 与 `lib/paper.ts` 的 `PAPERS` 一一对应。
 * ⚠️ 这里是**客户端**的一份拷贝：`lib/paper.ts` 是纯数据，但为了不让截图这条链
 *    依赖服务端模块的导入顺序，几何值就在这里显式写一遍。
 *    改纸张尺寸时**两处都要改**（globals.css 的 @page 也要改）。
 */
export const PAGE_GEOMETRY: Record<PrintPaper, PageGeometry> = {
    B5: { wMm: 182, hMm: 257, padTop: 14, padRight: 15, padBottom: 16, padLeft: 15, contentHMm: 225 },
    A4: { wMm: 210, hMm: 297, padTop: 14, padRight: 15, padBottom: 16, padLeft: 15, contentHMm: 265 },
};

/** 每一面在 DOM 里的选择器 —— 一张卡 = 一页 */
const PAGE_SELECTORS = [
    '.print-deep-side',
    '.print-review-sheet',
    '.print-imitate-sheet',
].join(',');

/**
 * 找出这次要拍的"页"。
 * 顺序即页序（深挖纸：正面 → 反面；卷：按生成顺序）。
 */
export function captureTargets(root: ParentNode = document): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(PAGE_SELECTORS));
}

/** 目标分辨率：300dpi 太吃手机内存，200dpi 印中文足够且快一倍 */
const TARGET_DPI = 200;

async function nextFrame(): Promise<void> {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

/**
 * 生成 PDF。会**临时往页面里插一个屏外页盒**，结束后一定拆掉。
 *
 * @param pages     `captureTargets()` 的结果
 * @param paper     当前幅面（决定页盒尺寸）
 * @param onProgress 逐页回调（1 起），用于"正在生成第 2/3 页…"
 */
export async function buildPrintPdf(
    pages: HTMLElement[],
    paper: PrintPaper,
    onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
    if (!pages.length) throw new Error('这页上没有可打印的纸面');

    const geo = PAGE_GEOMETRY[paper];
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas-pro'),
        import('jspdf'),
    ]);

    /* 字体与图片就位再拍：中文缺字体、二维码没解码，拍出来就是空白 */
    if (document.fonts?.ready) {
        try {
            await document.fonts.ready;
        } catch {
            /* 字体加载失败不该拦住打印 */
        }
    }

    const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: [geo.wMm, geo.hMm],
        compress: true,
    });

    /* 1 CSS px = 1/96 in ⇒ 想拍到 200dpi，放大 200/96 ≈ 2.08 倍即可（纸宽 688px → 1433px） */
    const scale = TARGET_DPI / 96;

    let host: HTMLDivElement | null = null;
    try {
        for (let i = 0; i < pages.length; i++) {
            const el = pages[i];
            host = document.createElement('div');
            host.className = 'print-capture-page';
            host.style.width = `${geo.wMm}mm`;
            host.style.height = `${geo.hMm}mm`;
            host.style.paddingTop = `${geo.padTop}mm`;
            host.style.paddingRight = `${geo.padRight}mm`;
            host.style.paddingBottom = `${geo.padBottom}mm`;
            host.style.paddingLeft = `${geo.padLeft}mm`;
            host.style.setProperty('--capture-content-h', `${geo.contentHMm}mm`);

            /* 克隆而不是搬走：原页面还要留着给"本机打印"用，
               而且搬走会让 React 的 ref/reconciliation 指向空节点。 */
            const clone = el.cloneNode(true) as HTMLElement;
            clone.removeAttribute('id');
            /* 屏幕上"适应宽度"的缩放绝不能带进截图：那会让整页变小 */
            clone.style.zoom = '1';
            host.appendChild(clone);
            document.body.appendChild(host);

            await nextFrame();
            const canvas = await html2canvas(host, {
                scale,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false,
                /* 纸面比例固定，不让它自己裁 */
                width: host.offsetWidth,
                height: host.offsetHeight,
            });
            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

            if (i > 0) pdf.addPage([geo.wMm, geo.hMm], 'portrait');
            pdf.addImage(dataUrl, 'JPEG', 0, 0, geo.wMm, geo.hMm);

            /* 拍完立刻放掉画布，手机上连着拍 4 页很吃内存 */
            canvas.width = 0;
            canvas.height = 0;
            host.remove();
            host = null;
            onProgress?.(i + 1, pages.length);
            await nextFrame();
        }
        return pdf.output('blob');
    } finally {
        host?.remove();
    }
}
