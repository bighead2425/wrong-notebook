/**
 * PDF 测量（零依赖）
 *
 * 【为什么不用库】仓库是 Node 项目，引 pdf-lib / pdfjs 会给打样脚本增加依赖；
 * 引 Python + PyMuPDF 更糟（要在两台机器上各装一套，CI 里也跑不了）。
 * PDF 的页面对象在 Chromium 产物里是**未压缩字典**，直接读字节即可数出来。
 *
 * 【可靠性】2026-09-24 用 PyMuPDF 逐份对照过 4 个既有产物，页数与尺寸**全部一致**：
 *   A_noduplex.pdf 2/2 ✅  B_duplex.pdf 2/2 ✅  real0.pdf 3/3 ✅  real1.pdf 4/4 ✅
 * （其中 real1 尤其值得一提：目录里只有 3 张渲染 PNG，一度让人以为是 3 页，
 *   两个独立信号——/Type /Page 计数与页树 /Count——都说 4，PyMuPDF 亦判 4。
 *   结论：**当时只导出了前 3 页**，PDF 本身是 4 页。不要拿"PNG 张数"当页数。）
 *
 * ⚠️ 前提：PDF 由 Chromium（Playwright page.pdf）生成。若将来换成别的生成器
 *    并启用了对象流压缩，这里的正则可能数不到页面对象——届时改回解析库。
 */

const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;

const PAGE_RE = /\/Type\s*\/Page(?![s])/g; // 排除页树节点 /Type /Pages
const COUNT_RE = /\/Count\s+(\d+)/g;
const MEDIABOX_RE = /\/MediaBox\s*\[\s*([\d.\- ]+)\]/g;

/** pt → mm，保留 1 位小数 */
export function pt2mm(pt) {
  return +((pt / PT_PER_INCH) * MM_PER_INCH).toFixed(1);
}

/**
 * 读 PDF 字节，返回 { pages, countHint, sizes, bytes }
 * @param {Buffer} buf
 */
export function measurePdf(buf) {
  const raw = buf.toString('latin1');

  const pages = (raw.match(PAGE_RE) || []).length;
  // 页树里的 /Count 是独立信号，用于交叉验证（两者不等说明解析有问题）
  const countHint = [...raw.matchAll(COUNT_RE)].map((m) => Number(m[1]));

  const boxes = [...raw.matchAll(MEDIABOX_RE)].map((m) =>
    m[1].trim().split(/\s+/).map(Number)
  );
  const sizes = [
    ...new Set(
      boxes.map(([x0, y0, x1, y1]) => ({
        w: pt2mm(Math.abs(x1 - x0)),
        h: pt2mm(Math.abs(y1 - y0)),
      }))
    ),
  ].map((s) => `${s.w.toFixed(1)}x${s.h.toFixed(1)}mm`);

  return { pages, countHint, sizes, bytes: buf.length };
}

/**
 * B5 判据。国内市售 B5 = 182mm × 257mm（JIS）。参见 src/app/globals.css 的 @page 注释：
 * CSS 的 `size: B5` 是 ISO B5 = 176×250mm，比国产纸每边小 6mm，满页排版会跑版，
 * 所以实现里必须写明确毫米数，不能用 B5 简写。
 */
export const EXPECTED = { w: 182, h: 257, tolMM: 0.6 };

/** 尺寸是否符合 B5（同时兼任"CSS 是否真的加载了"的探针：CSS 没生效会退回 A4 = 210×297） */
export function checkSize(sizes) {
  return sizes.map((s) => {
    const [w, h] = s.replace('mm', '').split('x').map(Number);
    const ok = Math.abs(w - EXPECTED.w) <= EXPECTED.tolMM && Math.abs(h - EXPECTED.h) <= EXPECTED.tolMM;
    return { size: s, ok };
  });
}
