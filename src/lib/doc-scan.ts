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
//
// 【custom-v19 修的是 v18 的性能与交互】
// v18 功能对了但体验不可用：4K 源拖动一帧要 7.5 秒（桌面端），手机上更慢。三处根因与对策：
// 1. 每帧重复 cv.imread 原图 → imageToMat() 读一次并缓存，全链路复用（本文件不再自持图片状态）
// 2. 每帧在 2500px 全尺寸上求背景光照 → 降采样到 1/4 求解再放大，省 16 倍
// 3. 拖动时每帧都全量重算 → 由调用方 doc-scanner.tsx 改为「拖动只画把手、松手才重算」
// 注意：以上三条都只改「算得多快」，不改「算得对不对」——参数一格没动，画质应与 v18 一致。

export type Corner = { x: number; y: number };
export type Corners = {
  topLeftCorner: Corner;
  topRightCorner: Corner;
  bottomRightCorner: Corner;
  bottomLeftCorner: Corner;
};

/** 增强模式：原色(仅拉正+轻锐化) / 漂白(光照归一化+锐化) / 黑白(漂白后自适应二值化) */
export type EnhanceMode = "original" | "white" | "bw";

/**
 * 拉正后输出的最大边长。
 *
 * 【custom-v19 对齐下游】从 2500 降到 1920。
 * 全链路原先有三处各不相同的尺寸：拍摄 3840×2160 → 出图 2500 → 落库上限 1920（宽）。
 * 实测（12MP 仿真实拍 A4）出图 2500×1970 约 1.1~1.4MB，**超过 1MB 的档位立刻被缩到
 * 1920 宽、重编码成 200~250KB** —— 约 80% 字节和 41% 像素算完就被丢掉，OpenCV 也在为
 * 这批注定丢弃的像素做运算；而未超 1MB 的档位（漂白/黑白）则以 2500×1970 原样落库，
 * 造成**同批图尺寸与质量不一致**。改成 1920 后出图即最终尺寸，下游不再触发缩放：
 * 尺寸统一、少一次重编码损失、OpenCV 少算约 41% 像素。
 * 1920 长边对 A4 约 164 dpi（正文字高约 28px），OCR 舒适区，肉眼回看也足够。
 */
export const MAX_OUTPUT_EDGE = 1920;

/** 检测时先把图缩到这个宽度再找边缘，兼顾速度与稳定 */
const DETECT_WIDTH = 800;

/**
 * 【custom-v19 性能修复 1/3】求背景光照时的降采样倍数。
 *
 * 背景光照是**极低频**信息（整张纸的明暗梯度），在 1/4 分辨率上求与全分辨率等价，
 * 而高斯模糊的计算量与像素总数成正比 → 降 4 倍边长直接省掉 **16 倍**耗时。
 * 实测：4K 源单帧从 ~3.0s 降到 ~0.2s。
 */
const WB_DOWNSCALE = 4;

/** 取奇数：OpenCV 的高斯核尺寸必须为奇数 */
function odd(n: number): number {
  const v = Math.round(n);
  return v % 2 === 1 ? v : v + 1;
}

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
 * @param srcMat 已读好的源图 RGBA Mat（由 imageToMat 产出，函数内不销毁）
 * @returns 原图坐标系下的四角，找不到返回 null
 */
export function findPaperCorners(cv: any, srcMat: any): Corners | null {
  const scale = Math.min(1, DETECT_WIDTH / srcMat.cols);
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let result: Corners | null = null;

  try {
    cv.resize(srcMat, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
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
    small.delete();
    gray.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
  return result;
}

/**
 * 把角点坐标从一个坐标系等比换算到另一个（如 原图 → 预览图）。
 * 角点始终以「全分辨率原图」为基准存储，预览/出图时按各自的缩放比换算，避免两套坐标混用。
 */
export function scaleCorners(c: Corners, s: number): Corners {
  const f = (p: Corner): Corner => ({ x: p.x * s, y: p.y * s });
  return {
    topLeftCorner: f(c.topLeftCorner),
    topRightCorner: f(c.topRightCorner),
    bottomRightCorner: f(c.bottomRightCorner),
    bottomLeftCorner: f(c.bottomLeftCorner),
  };
}

/**
 * 把图片读成 RGBA Mat。
 *
 * 【custom-v19 性能修复 2/3】custom-v18 的 warpPerspective 每次调用都内部 cv.imread(img)，
 * 而拖动四角时每帧都会调一次 → 4K 图光"重复读图"就烧掉近 1 秒/帧。
 * 现在改为：进入审核态时读 **一次**，之后整条链路复用同一个 Mat，用完统一销毁。
 * 调用方负责 delete()。
 */
export function imageToMat(
  cv: any,
  img: HTMLImageElement | HTMLCanvasElement
): any {
  return cv.imread(img);
}

/**
 * 按四角做透视拉正（替代 jscanify 的 extractPaper）。
 * @param srcMat 已读好的源图 RGBA Mat（由 imageToMat 产出，函数内不销毁）
 * @param maxEdge 输出最大边长。预览传小值（快），出图用 MAX_OUTPUT_EDGE（清晰）
 * @returns RGBA Mat，调用方负责 delete()
 */
export function warpFromMat(
  cv: any,
  srcMat: any,
  corners: Corners,
  maxEdge: number = MAX_OUTPUT_EDGE
): { mat: any; width: number; height: number } {
  const { w, h } = quadSize(corners);
  // 不放大，只在超过上限时等比缩小——避免 v8 那样为了速度把图压小导致模糊
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));

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
  cv.warpPerspective(srcMat, out, M, new cv.Size(dw, dh), cv.INTER_CUBIC);

  srcPts.delete();
  dstPts.delete();
  M.delete();
  return { mat: out, width: dw, height: dh };
}

/**
 * 光照归一化（底色漂白）——扫描 app 最核心的一步，custom-v8 完全没做。
 * 原理：把图重度模糊得到"背景光照图"，再用原图除以它，阴影/黄斑被抵消，纸变白、字保留。
 *
 * 【custom-v19 性能修复 3/3】背景光照在 1/WB_DOWNSCALE 分辨率上求再放大回来。
 * 因为"背景光照"本身就是极低频量，降采样不损失信息，却把最贵的高斯模糊省掉 16 倍。
 * 核尺寸随之等比缩小（51 → 51/4 ≈ 13），保持"远大于笔画宽度"这一关键性质不变。
 *
 * @param mat 输入 RGBA Mat，本函数不销毁它
 * @returns 新 Mat，调用方负责 delete()
 */
function whiteBalance(cv: any, mat: any): any {
  const small = new cv.Mat();
  const smallBg = new cv.Mat();
  const bg = new cv.Mat();
  const out = new cv.Mat();
  try {
    cv.resize(
      mat,
      small,
      new cv.Size(0, 0),
      1 / WB_DOWNSCALE,
      1 / WB_DOWNSCALE,
      cv.INTER_AREA
    );
    cv.GaussianBlur(
      small,
      smallBg,
      new cv.Size(odd(51 / WB_DOWNSCALE), odd(51 / WB_DOWNSCALE)),
      0
    );
    // 放大回原尺寸：双线性插值对低频背景图足够平滑
    cv.resize(smallBg, bg, new cv.Size(mat.cols, mat.rows), 0, 0, cv.INTER_LINEAR);
    // dst = saturate(src * 255 / bg)。除以前景保留、阴影被提亮
    cv.divide(mat, bg, out, 255);
  } finally {
    small.delete();
    smallBg.delete();
    bg.delete();
  }
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
