// 文档扫描核心：四角检测 + 透视拉正 + 画质增强。
//
// 【为什么自己写而不依赖 jscanify】
// custom-v8 用的是 jscanify，它会自动拖入 node-canvas 依赖，导致 Dockerfile 必须装一堆
// C/C++ 编译库（python3/make/g++/cairo/pango...），构建从 1 分钟涨到十几分钟。
// 而 jscanify 本质只是「Canny + findContours + approxPolyDP + warpPerspective」几步 OpenCV 调用，
// 自己写只需一百行，能省掉整个编译依赖链。
//
// 【custom-v8 画质的三个病根，这里全部修正】
// 1. 模糊：v8 的 getUserMedia 没要分辨率，浏览器默认给 480p（实拍仅 461×562）。
//    → 相机约束在 doc-scanner.tsx 里修（要 1920+ 且连续对焦），本文件负责不二次缩图。
// 2. 黑白全噪点：v8 用 adaptiveThreshold(blockSize=11, C=2)，参数太小，把纸张纹理也二值化了。
//    → 改为 blockSize=41、C=12，并且在二值化**之前**先做光照归一化。
// 3. 原色/灰度"没效果"：v8 缺光照归一化（漂白）和锐化这两步——而它们才是扫描 app 的核心。
//    → whiteBalance() 与 sharpen() 补上。

export type Corner = { x: number; y: number };
export type Corners = {
  topLeftCorner: Corner;
  topRightCorner: Corner;
  bottomRightCorner: Corner;
  bottomLeftCorner: Corner;
};

/** 增强模式：原色(仅拉正+轻锐化) / 漂白(光照归一化+锐化) / 黑白(漂白后自适应二值化) */
export type EnhanceMode = "original" | "white" | "bw";

/** 拉正后输出的最大边长：太小丢细节，太大拖慢 AI 传输。2500 足够 OCR 与识别。 */
const MAX_OUTPUT_EDGE = 2500;

/** 检测时先把图缩到这个宽度再找边缘，兼顾速度与稳定 */
const DETECT_WIDTH = 800;

function quadSize(pts: Corners) {
  const d = (a: Corner, b: Corner) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = Math.max(
    d(pts.topLeftCorner, pts.topRightCorner),
    d(pts.bottomLeftCorner, pts.bottomRightCorner)
  );
  const h = Math.max(
    d(pts.topLeftCorner, pts.bottomLeftCorner),
    d(pts.topRightCorner, pts.bottomRightCorner)
  );
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** 把 approxPolyDP 得到的 4 个点按几何位置归位到 左上/右上/右下/左下 */
function sortCorners(pts: Corner[]): Corners | null {
  if (pts.length !== 4) return null;
  const sorted = [...pts];
  // x+y 最小=左上，最大=右下；y-x 最小=右上，最大=左下
  let tl = sorted[0], br = sorted[0], tr = sorted[0], bl = sorted[0];
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const p of sorted) {
    const sum = p.x + p.y;
    const diff = p.y - p.x;
    if (sum < minSum) { minSum = sum; tl = p; }
    if (sum > maxSum) { maxSum = sum; br = p; }
    if (diff < minDiff) { minDiff = diff; tr = p; }
    if (diff > maxDiff) { maxDiff = diff; bl = p; }
  }
  return {
    topLeftCorner: tl,
    topRightCorner: tr,
    bottomRightCorner: br,
    bottomLeftCorner: bl,
  };
}

/**
 * 找纸张四角。替代 jscanify 的 findPaperContour + getCornerPoints。
 * @returns 原图坐标系下的四角，找不到返回 null
 */
export function findPaperCorners(
  cv: any,
  img: HTMLImageElement
): Corners | null {
  const src = cv.imread(img);
  const scale = Math.min(1, DETECT_WIDTH / src.cols);
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let result: Corners | null = null;

  try {
    cv.resize(src, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    // 先轻度模糊再去边缘，避免纸张纹理产生碎轮廓
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 50, 150);
    // 膨胀把断开的边缘连起来，这是能否找到完整四边形的关键
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 1);

    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    const imgArea = small.cols * small.rows;
    let bestArea = 0;
    let bestPts: Corner[] | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      // 太小的轮廓是噪声，直接跳过
      if (area < imgArea * 0.05) {
        c.delete();
        continue;
      }
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * peri, true);
      // 必须是凸四边形才认为是纸张
      if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
        bestArea = area;
        bestPts = [
          { x: approx.data32S[0], y: approx.data32S[1] },
          { x: approx.data32S[2], y: approx.data32S[3] },
          { x: approx.data32S[4], y: approx.data32S[5] },
          { x: approx.data32S[6], y: approx.data32S[7] },
        ];
      }
      approx.delete();
      c.delete();
    }

    if (bestPts) {
      // 检测是在缩略图上做的，坐标要映射回原图
      const inv = 1 / scale;
      const mapped = bestPts.map((p) => ({ x: p.x * inv, y: p.y * inv }));
      result = sortCorners(mapped);
    }
  } catch (e) {
    console.warn("[doc-scan] 四角检测失败:", e);
  } finally {
    src.delete();
    small.delete();
    gray.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
  return result;
}

/**
 * 按四角做透视拉正（替代 jscanify 的 extractPaper）。
 * @returns RGBA Mat，调用方负责 delete()
 */
export function warpPerspective(
  cv: any,
  img: HTMLImageElement,
  corners: Corners
): { mat: any; width: number; height: number } {
  const { w, h } = quadSize(corners);
  // 不放大，只在超过上限时等比缩小——避免 v8 那样为了速度把图压小导致模糊
  const scale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));

  const src = cv.imread(img);
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners.topLeftCorner.x, corners.topLeftCorner.y,
    corners.topRightCorner.x, corners.topRightCorner.y,
    corners.bottomRightCorner.x, corners.bottomRightCorner.y,
    corners.bottomLeftCorner.x, corners.bottomLeftCorner.y,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    dw, 0,
    dw, dh,
    0, dh,
  ]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const out = new cv.Mat();
  cv.warpPerspective(src, out, M, new cv.Size(dw, dh), cv.INTER_CUBIC);

  src.delete();
  srcPts.delete();
  dstPts.delete();
  M.delete();
  return { mat: out, width: dw, height: dh };
}

/**
 * 光照归一化（底色漂白）——扫描 app 最核心的一步，custom-v8 完全没做。
 * 原理：把图重度模糊得到"背景光照图"，再用原图除以它，阴影/黄斑被抵消，纸变白、字保留。
 * @param mat 输入 RGBA Mat，本函数不销毁它
 * @returns 新 Mat，调用方负责 delete()
 */
function whiteBalance(cv: any, mat: any): any {
  const bg = new cv.Mat();
  const out = new cv.Mat();
  // 核必须足够大，大到只剩光照变化、不含文字笔画
  cv.GaussianBlur(mat, bg, new cv.Size(51, 51), 0);
  // dst = saturate(src * 255 / bg)。除以前景保留、阴影被提亮
  cv.divide(mat, bg, out, 255);
  bg.delete();
  return out;
}

/** 锐化（unsharp mask）：原图 + (原图 - 模糊) × 量 */
function sharpen(cv: any, mat: any, amount = 0.8): any {
  const blurred = new cv.Mat();
  const out = new cv.Mat();
  cv.GaussianBlur(mat, blurred, new cv.Size(0, 0), 2.0);
  cv.addWeighted(mat, 1 + amount, blurred, -amount, 0, out);
  blurred.delete();
  return out;
}

/**
 * 画质增强主入口。
 * - original：拉正 + 轻度锐化（保留原色，适合有彩色批改痕的题）
 * - white：  **漂白** + 锐化（默认档，底色干净省墨，AI 识别率也最高）
 * - bw：     漂白 + 自适应二值化（blockSize=41/C=12，修正 v8 的 11/2 噪点问题）
 *
 * @param mat 输入 RGBA Mat（会被本函数内部产生的中间量替换，调用方仍需 delete 返回的 Mat）
 * @returns 新 Mat，调用方负责 delete()
 */
export function enhanceMat(cv: any, mat: any, mode: EnhanceMode): any {
  if (mode === "original") {
    return sharpen(cv, mat, 0.5);
  }

  if (mode === "bw") {
    // 先漂白再二值化，比直接对原图二值化干净得多（阴影不会再变成噪点）
    const norm = whiteBalance(cv, mat);
    const gray = new cv.Mat();
    const bw = new cv.Mat();
    const out = new cv.Mat();
    cv.cvtColor(norm, gray, cv.COLOR_RGBA2GRAY);
    cv.adaptiveThreshold(
      gray,
      bw,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      41, // v8 用 11 → 太小，纸纹全被当成字
      12  // v8 用 2  → 太小，抗噪不足
    );
    cv.cvtColor(bw, out, cv.COLOR_GRAY2RGBA);
    norm.delete();
    gray.delete();
    bw.delete();
    return out;
  }

  // white：漂白 + 锐化
  const norm = whiteBalance(cv, mat);
  const sharp = sharpen(cv, norm, 0.8);
  norm.delete();
  return sharp;
}
