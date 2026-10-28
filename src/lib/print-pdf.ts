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

/** 1mm 等于多少 CSS px（96dpi 下 = 96/25.4 ≈ 3.7795） */
const PX_PER_MM = 96 / 25.4;

async function nextFrame(): Promise<void> {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

/**
 * 打孔位（mm）—— 从元素**自己算出来的样式**上读 `--punch-l` / `--punch-r`。
 *
 * 为什么不用 CSS 里那句 `padding-left: var(--punch-l)`：
 * 【2026-10-28 手机真机打出来是坏的】截图库（html2canvas-pro）会把节点**重建一遍**
 * 再画，重建出来的树不在 `.print-capture-page` 那层约束里 —— 于是
 * 「宽度 152mm + 打孔位 12mm」这套几何整个失效：内容按 182mm 铺开、右端被纸边切掉。
 * 实测（他手机印出的 PDF）：版心 166.3mm 顶到纸边，而电脑导出的是 139.9mm。
 * ⇒ 几何**不能依赖样式表**，一律在这里算好、写成行内 `!important`。
 */
function punchOf(el: HTMLElement): { left: number; right: number } {
    const cs = getComputedStyle(el);
    const num = (raw: string) => {
        const n = parseFloat(raw);
        return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    return {
        left: num(cs.getPropertyValue('--punch-l')),
        right: num(cs.getPropertyValue('--punch-r')),
    };
}

/** 行内 + `!important`：样式表里的 `!important` 也压不住它 */
function pin(node: HTMLElement, prop: string, value: string): void {
    node.style.setProperty(prop, value, 'important');
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
    /** 版面自检没过的项目 —— 有一条就**不送印**（纸比字贵） */
    const issues: string[] = [];
    try {
        for (let i = 0; i < pages.length; i++) {
            const el = pages[i];

            /**
             * 【2026-10-28 真机事故】几何全部在这里**写死成行内 !important**。
             *
             * 起因：手机共享打印出来的纸，内容按整纸宽铺开、右侧被裁（见 `punchOf` 的注释）。
             * 同一个 DOM 在干净浏览器里量是好的（152 − 12 = 140），说明样式没错，
             * 是截图库重建节点后丢了那层约束。所以不再赌样式表 —— 算什么、写什么。
             *
             * 版心 = 整纸宽 − 左右页边距（B5：182 − 15 − 15 = 152）
             * 内容 = 版心 − 打孔位（正面左 12、反面右 12 ⇒ 140）
             */
            const punch = punchOf(el);
            const sheetW = geo.wMm - geo.padLeft - geo.padRight;
            const expectContentMm = sheetW - punch.left - punch.right;

            host = document.createElement('div');
            host.className = 'print-capture-page';
            pin(host, 'box-sizing', 'border-box');
            pin(host, 'width', `${geo.wMm}mm`);
            pin(host, 'height', `${geo.hMm}mm`);
            pin(host, 'padding', `${geo.padTop}mm ${geo.padRight}mm ${geo.padBottom}mm ${geo.padLeft}mm`);
            pin(host, 'margin', '0');
            host.style.setProperty('--capture-content-h', `${geo.contentHMm}mm`);

            /* 克隆而不是搬走：原页面还要留着给"本机打印"用，
               而且搬走会让 React 的 ref/reconciliation 指向空节点。 */
            const clone = el.cloneNode(true) as HTMLElement;
            clone.removeAttribute('id');
            pin(clone, 'box-sizing', 'border-box');
            pin(clone, 'width', `${sheetW}mm`);
            pin(clone, 'margin', '0');
            pin(clone, 'padding-top', '0');
            pin(clone, 'padding-bottom', '0');
            pin(clone, 'padding-left', `${punch.left}mm`);
            pin(clone, 'padding-right', `${punch.right}mm`);
            /* 屏幕上"适应宽度"的缩放绝不能带进截图：那会让整页变小 */
            pin(clone, 'zoom', '1');
            /* 只有深挖纸的一面是**定高版式**（页脚要钉在底部）。
               卷（复练/积累）的高度由内容决定，硬写 225mm 会把长卷裁掉。 */
            if (clone.classList.contains('print-deep-side')) {
                pin(clone, 'height', `${geo.contentHMm}mm`);
            }

            host.appendChild(clone);
            document.body.appendChild(host);

            await nextFrame();

            /**
             * 当场自检：量一遍真的内容宽。
             * 出事那次就是"没人量过" —— 打出来才发现，中间隔着一张纸。
             * 现在量不对就在控制台吼一声（E2E 会把它当失败）。
             */
            const cs = getComputedStyle(clone);
            const contentPx =
                clone.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            const contentMm = contentPx / PX_PER_MM;
            if (Math.abs(contentMm - expectContentMm) > 0.8) {
                console.warn(
                    `[print-capture] 第 ${i + 1} 页版心宽度不对：量到 ${contentMm.toFixed(1)}mm，应为 ${expectContentMm.toFixed(1)}mm`,
                );
                issues.push(
                    `第 ${i + 1} 页版心 ${contentMm.toFixed(1)}mm（应为 ${expectContentMm.toFixed(1)}mm）`,
                );
            }

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

            /**
             * 第二道自检：**直接看画出来的像素**。
             *
             * 第一道量的是 DOM，能抓住"样式没生效"；但手机那次是截图库**自己重排**后
             * 才铺到纸边去的 —— DOM 量着没问题，画布上却已经出血。
             * 所以再看画布最右侧 8mm：那里本该是"15mm 页边距 + 8mm 打孔位"的纯白，
             * 一旦有墨就说明内容溢到纸边了（真机事故就是这个样子）。
             *
             * 代价：63×2000 像素的取样，手机上大约几毫秒。
             */
            try {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    const stripPx = Math.max(1, Math.round(8 * (TARGET_DPI / 25.4)));
                    const strip = ctx.getImageData(canvas.width - stripPx, 0, stripPx, canvas.height).data;
                    let inked = 0;
                    for (let k = 0; k < strip.length; k += 4) {
                        /* 只当"明显有墨"才算：JPEG 压缩会让纯白轻微起伏 */
                        if (strip[k] < 235 || strip[k + 1] < 235 || strip[k + 2] < 235) inked += 1;
                    }
                    if (inked > 50) {
                        console.warn(
                            `[print-capture] 第 ${i + 1} 页右侧出血：最右 8mm 里有 ${inked} 个墨点，内容溢到纸边了`,
                        );
                        issues.push(`第 ${i + 1} 页右侧出血（最右 8mm 有 ${inked} 个墨点）`);
                    }
                }
            } catch {
                /* 取样失败不该拦住打印（跨域画布会抛，虽然这里不该发生） */
            }


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

        /**
         * 自检没过 ⇒ **不送印**。
         *
         * 【2026-10-28 手机真机】那一批纸废掉，是因为错位只在纸上才看得见。
         * 现在先量再送：宁可这次不印（他换了手机/改了设置还能再点一次），
         * 也别再让他拿着一叠废纸回来告诉我"版面没进来"。
         * 报错里带着实测数字，下次一眼就知道是宽了还是窄了。
         */
        if (issues.length > 0) {
            throw new Error(
                `版面自检没通过，已拦下、没有送印：${issues.join('；')}。` +
                    `（这三项说明"纸面几何"没按 B5 算，印出来会错位）`,
            );
        }

        return pdf.output('blob');
    } finally {
        host?.remove();
    }
}
