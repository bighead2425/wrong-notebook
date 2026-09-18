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

/* ────────────────────────────────────────────────────────────────────────────
 * 【custom-v21】四角检测从"成 / 败"二态改为「四级降级链 + 置信分档」
 *
 * 背景（实测反馈）：同一张纸、同样条件，四角识别"时好时坏"；深色背景更容易认出来。
 * 根因是**固定 Canny 双阈值卡在临界点**：手机每张照片的自动曝光 / 白平衡都在浮动，
 * 纸与背景的对比度跟着变；对比度一低，纸边那条线就断，外轮廓闭合不了 → 找不到四边形。
 * 深色背景反差大、边界是连续强边，所以更容易闭合。它的表现是「全有或全无」，
 * 而不是"认得不那么准" —— 这正是当年觉得像抽签的原因。
 *
 * 旧实现的第二个毛病：`approxPolyDP` 出来的点**不是正好 4 个就整条轮廓丢掉**，
 * 前面找边、连边、找轮廓的功夫全白费。而"差一点"（3 点 / 5 点）恰恰是最常见的情况。
 *
 * 新版按「由紧到松」排队，取第一个通过合理性校验的结果，并标注置信档：
 *   rank 0  严格档 + eps 0.02 + 4 点凸     → 高置信（沿用旧版取值，成功路径行为不变）
 *   rank 1  严格档 + eps 0.03~0.05         → 低置信
 *   rank 2  宽松档 + eps 0.02 + 4 点凸     → 低置信
 *   rank 3  宽松档 + eps 0.03~0.05         → 低置信
 *   rank 4  严格档 + 点数补救(3/5/6→4)     → 低置信
 *   rank 5  宽松档 + 点数补救              → 低置信
 *   rank 6  最大轮廓的 minAreaRect         → 低置信（最后兜底，永远给得出 4 点）
 * 排序原则：**"干净四边形"一律排在"补救出来的四边形"前面** —— 前者更可信。
 *
 * 性能：严格档里只要出现 rank ≤ 1 的合格候选就直接返回，不跑宽松档；
 * 所以"本来就能认出来"的图，耗时与旧版一致，只有"本来就认不出来"的图才多花一遍。
 * 检测每张图只跑一次（在 loadImgAndReview 里），不是每帧，多出的几百毫秒可接受。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 四角检测的置信档 */
export type CornerConfidence = "high" | "low" | "none";

/** 检测结果。stage 仅供日志与验收排查，界面不展示 */
export type DetectResult = {
  corners: Corners | null;
  confidence: CornerConfidence;
  stage: string;
};

/** 严格档 Canny 双阈值（沿用 custom-v8 以来的取值，rank 0 行为不变） */
const CANNY_STRICT_LO = 50;
const CANNY_STRICT_HI = 150;

/**
 * 宽松档 Canny 双阈值。
 * 目标是把"对比度卡在临界点"的那批图捞回来：阈值降到 30/100，弱一些的纸边也能判成边缘。
 * 代价是噪声边缘变多 —— 靠后面的合理性校验兜住，宁可判"无候选"也不给错的。
 */
const CANNY_LOOSE_LO = 30;
const CANNY_LOOSE_HI = 100;

/** 膨胀核边长：严格档 3（沿用旧值），宽松档 5（更强的连边能力，把纸边的断口接上） */
const DILATE_STRICT = 3;
const DILATE_LOOSE = 5;

/** 轮廓最小面积比：低于图片面积这个比例的一律当噪声丢弃（沿用旧值） */
const MIN_CONTOUR_AREA_RATIO = 0.05;

/** 四边形近似精度序列（× 轮廓周长），由紧到松；rank 0 用第一个，其余依次放宽 */
const APPROX_EPS_SEQ = [0.02, 0.03, 0.04, 0.05];

/**
 * 合理性校验门槛。
 *
 * ⚠️ 这道闸是本方案里真正压住风险的地方：低置信档**默认就参与拉正**（不再等用户拖），
 * 所以必须先把"荒唐的候选"挡在门外。宁可不给（回落到整张原图），也不给错的。
 */
const SANITY = {
  /** 面积占整图比例下限：太小的"四边形"多半是噪点凑出来的 */
  minAreaRatio: 0.06,
  /** 上限：占满整张图说明它认的是画面边框而不是纸 —— 此时"保持整张原图"反而更安全 */
  maxAreaRatio: 0.98,
  /** 最短边 / 图片短边：防止退化成细条 */
  minEdgeRatio: 0.06,
  /** 内角允许范围：纸张在强透视下最尖的角约 40°，再离谱就不是同一张纸了 */
  minAngleDeg: 35,
  maxAngleDeg: 145,
  /** 对边长度比下限（取倒数得上限）：强透视会把远边压短，但 4 倍以上就是两个东西了 */
  minOppositeRatio: 0.25,
};

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

/** 四边形面积（鞋带公式）。纯算术，不碰 OpenCV */
function polyArea(pts: Corner[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 凸包（Andrew monotone chain）。approxPolyDP 的点序不可靠，先包一层再谈"四边形"。【导出仅供单元测试】 */
export function convexHull(pts: Corner[]): Corner[] {
  if (pts.length < 3) return [...pts];
  const p = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Corner, a: Corner, b: Corner) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Corner[] = [];
  for (const q of p) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0
    ) {
      lower.pop();
    }
    lower.push(q);
  }
  const upper: Corner[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0
    ) {
      upper.pop();
    }
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * 三角形补成四边形 —— 四个角里少了一个时，轮廓就成了三角形。
 *
 * 缺失的角一定夹在**最长边**的两个端点外侧，所以用平行四边形补全：
 * `M = P + Q − R`（P、Q 为最长边端点，R 为对角顶点）。
 * 验算：真值 (0,0)(10,0)(10,10)(0,10) 缺了左上角，剩下 TR(10,0) BR(10,10) BL(0,10)，
 * 最长边是 TR–BL，R = BR → M = (10,0)+(0,10)−(10,10) = (0,0) ✓
 */
function expandTriToQuad(tri: Corner[]): Corner[] | null {
  if (tri.length !== 3) return null;
  let li = 0;
  let far = -1;
  for (let i = 0; i < 3; i++) {
    const a = tri[i];
    const b = tri[(i + 1) % 3];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > far) {
      far = d;
      li = i;
    }
  }
  const p = tri[li];
  const q = tri[(li + 1) % 3];
  const r = tri[(li + 2) % 3];
  return [p, q, r, { x: p.x + q.x - r.x, y: p.y + q.y - r.y }];
}

/** 顶点多于 4：反复丢掉"贡献最小"的那个（它与前后两点围出的三角形面积最小） */
function reduceToQuad(poly: Corner[]): Corner[] | null {
  const p = [...poly];
  while (p.length > 4) {
    let di = 0;
    let least = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length];
      const b = p[i];
      const c = p[(i + 1) % p.length];
      const t = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
      if (t < least) {
        least = t;
        di = i;
      }
    }
    p.splice(di, 1);
  }
  return p.length === 4 ? p : null;
}

/**
 * 【custom-v21 新增】点数补救：把 3~6 个点的多边形压成 4 个点的四边形。
 * 旧版到这一步就直接判失败了，而"3 点 / 5 点"恰恰是最常见的差一点的情况。
 */
export function repairToQuad(pts: Corner[]): Corner[] | null {
  const hull = convexHull(pts);
  if (hull.length === 4) return hull;
  if (hull.length === 3) return expandTriToQuad(hull);
  if (hull.length > 4) return reduceToQuad(hull);
  return null;
}

/**
 * 合理性校验：判断一个候选四边形"像不像一张纸"。
 *
 * 低置信档会默认参与拉正，所以这里不是可有可无的打磨 —— 它是把"错得像对的"
 * 那份风险压回可接受范围的闸门。任一条不过就弃用该候选（继续往下降级，最终可能
 * 回落到"无候选 → 保持整张原图"）。坐标用检测缩略图坐标系，比例与绝对值无关。
 */
export function quadSanity(pts: Corner[], imgW: number, imgH: number): boolean {
  if (pts.length !== 4) return false;

  // ① 面积占比
  const ratio = polyArea(pts) / (imgW * imgH);
  if (ratio < SANITY.minAreaRatio || ratio > SANITY.maxAreaRatio) return false;

  // ② 顶点不得跑到图外（留 8% 余量，容忍边界处的一点点越界）
  const mx = imgW * 0.08;
  const my = imgH * 0.08;
  for (const p of pts) {
    if (p.x < -mx || p.x > imgW + mx || p.y < -my || p.y > imgH + my) return false;
  }

  // ③ 边长：每条边都不能太短（相对图片短边）
  const minEdge = Math.min(imgW, imgH) * SANITY.minEdgeRatio;
  const edges: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < minEdge) return false;
    edges.push(d);
  }

  // ④ 对边长度不能太悬殊（强透视会拉大差距，故放到 4 倍）
  const ratioOk = (x: number, y: number) => {
    const r = x / y;
    return r >= SANITY.minOppositeRatio && r <= 1 / SANITY.minOppositeRatio;
  };
  if (!ratioOk(edges[0], edges[2])) return false;
  if (!ratioOk(edges[1], edges[3])) return false;

  // ⑤ 内角必须像纸张：太尖或太钝都不是
  for (let i = 0; i < 4; i++) {
    const prev = pts[(i + 3) % 4];
    const cur = pts[i];
    const next = pts[(i + 1) % 4];
    const v1x = prev.x - cur.x;
    const v1y = prev.y - cur.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;
    const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (m === 0) return false;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / m));
    const deg = (Math.acos(cos) * 180) / Math.PI;
    if (deg < SANITY.minAngleDeg || deg > SANITY.maxAngleDeg) return false;
  }
  return true;
}

/**
 * 把 4 个点按几何位置归位到 左上 / 右上 / 右下 / 左下。
 *
 * 【custom-v21 加固】旧版四个极值**各自独立**去求，导致同一个点可能被选中两次、
 * 另一个点被整个丢掉。实测菱形输入（正方形转 45°）(0,10)(10,0)(20,10)(10,20)：
 * TL 与 BL 都算出 (0,10)，而 (10,20) 直接消失 → 拉正结果是退化四边形。
 * 低置信档会大量喂进这类畸形 / 强透视四边形，所以改成**逐个摘除**：
 * 先定 TL 并摘掉，再从剩下的里定 BR 并摘掉，最后两点按 y−x 分给 TR / BL。
 */
export function sortCorners(pts: Corner[]): Corners | null {
  if (pts.length !== 4) return null;
  const rest = [...pts];
  const takeBy = (score: (p: Corner) => number, mode: "min" | "max"): Corner => {
    let idx = 0;
    let best = score(rest[0]);
    for (let i = 1; i < rest.length; i++) {
      const v = score(rest[i]);
      if (mode === "min" ? v < best : v > best) {
        best = v;
        idx = i;
      }
    }
    return rest.splice(idx, 1)[0];
  };
  // x+y 最小 = 左上，最大 = 右下
  const topLeftCorner = takeBy((p) => p.x + p.y, "min");
  const bottomRightCorner = takeBy((p) => p.x + p.y, "max");
  // 剩下两个：y−x 小的是右上，大的是左下
  const topRightCorner = takeBy((p) => p.y - p.x, "min");
  const bottomLeftCorner = rest[0];
  return { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner };
}

/** 从 approxPolyDP 的结果 Mat 取点（data32S 排布为 [x0,y0,x1,y1,…]） */
function readApproxPts(approx: any): Corner[] {
  const out: Corner[] = [];
  const d = approx.data32S;
  for (let i = 0; i + 1 < d.length; i += 2) out.push({ x: d[i], y: d[i + 1] });
  return out;
}

/** 降级链里的一个候选（rank 越小越优先，同 rank 取面积最大） */
type Candidate = {
  pts: Corner[];
  confidence: CornerConfidence;
  stage: string;
  area: number;
  rank: number;
};

/**
 * 找纸张四角。替代 jscanify 的 findPaperContour + getCornerPoints。
 *
 * 【custom-v21】从"成 / 败"二态改为四级降级链 + 置信分档，档位与 rank 见文件头注释。
 * 调用方（doc-scanner）按 `confidence` 决定配色与是否默认参与拉正：
 * `high` → 青色实线、直接拉正；`low` → 琥珀虚线、过校验即默认拉正；`none` → 维持旧行为。
 *
 * @param srcMat 已读好的源图 RGBA Mat（由 imageToMat 产出，函数内不销毁）
 * @returns 原图坐标系下的四角 + 置信档；彻底找不到时 corners 为 null
 */
export function findPaperCorners(cv: any, srcMat: any): DetectResult {
  const NONE: DetectResult = { corners: null, confidence: "none", stage: "none" };
  const scale = Math.min(1, DETECT_WIDTH / srcMat.cols);
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  let kernelS: any = null;
  let kernelL: any = null;
  /** 宽松档里面积最大的轮廓（克隆保存），留给 minAreaRect 兜底 */
  let largestLoose: any = null;
  let largestLooseArea = 0;

  const cands: Candidate[] = [];

  try {
    cv.resize(srcMat, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    // 先轻度模糊再去边缘，避免纸张纹理产生碎轮廓
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    const imgW = small.cols;
    const imgH = small.rows;
    const imgArea = imgW * imgH;

    kernelS = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(DILATE_STRICT, DILATE_STRICT));
    kernelL = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(DILATE_LOOSE, DILATE_LOOSE));

    /** 跑一遍「边缘 → 轮廓 → 候选」。strict=false 时用宽松档阈值与更大的膨胀核 */
    const runPass = (strict: boolean) => {
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      try {
        cv.Canny(
          gray,
          edges,
          strict ? CANNY_STRICT_LO : CANNY_LOOSE_LO,
          strict ? CANNY_STRICT_HI : CANNY_LOOSE_HI
        );
        // 膨胀把断开的边缘连起来 —— 这是能否找到完整四边形的关键
        cv.dilate(edges, edges, strict ? kernelS : kernelL, new cv.Point(-1, -1), 1);
        cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const area = cv.contourArea(c);
          // 太小的轮廓是噪声，直接跳过
          if (area < imgArea * MIN_CONTOUR_AREA_RATIO) {
            c.delete();
            continue;
          }
          if (!strict && area > largestLooseArea) {
            largestLooseArea = area;
            largestLoose?.delete?.();
            largestLoose = c.clone();
          }

          const peri = cv.arcLength(c, true);
          let done = false; // 这条轮廓已产出候选，不必再试更松的 eps
          for (let ei = 0; ei < APPROX_EPS_SEQ.length && !done; ei++) {
            const eps = APPROX_EPS_SEQ[ei];
            const approx = new cv.Mat();
            cv.approxPolyDP(c, approx, eps * peri, true);
            const n = approx.rows;
            let pts: Corner[] | null = null;
            let rank = -1;
            let tag = "";

            if (n === 4 && cv.isContourConvex(approx)) {
              // 干净四边形：严格档 eps 0.02 才配"高置信"，其余一律低置信
              pts = readApproxPts(approx);
              if (strict) rank = ei === 0 ? 0 : 1;
              else rank = ei === 0 ? 2 : 3;
              tag = `eps${eps}`;
            } else if (n >= 3 && n <= 6) {
              // 点数补救：旧版到这一步就丢了，而"3 点 / 5 点"是最常见的差一点
              const fixed = repairToQuad(readApproxPts(approx));
              if (fixed) {
                pts = fixed;
                rank = strict ? 4 : 5;
                tag = `repair${n}`;
              }
            }
            approx.delete();

            if (pts && rank >= 0) {
              cands.push({
                pts,
                confidence: rank === 0 ? "high" : "low",
                stage: `${strict ? "strict" : "loose"}:${tag}`,
                area,
                rank,
              });
              done = true;
            }
          }
          c.delete();
        }
      } finally {
        contours.delete();
        hierarchy.delete();
      }
    };

    /** 取候选：先过合理性校验，再按 rank 优先、同 rank 面积最大 */
    const pick = (maxRank = Infinity): Candidate | null => {
      const ok = cands
        .filter((x) => x.rank <= maxRank && quadSanity(x.pts, imgW, imgH))
        .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.area - a.area));
      return ok.length ? ok[0] : null;
    };

    runPass(true);
    let best = pick(1);
    if (!best) {
      // 严格档没能给出"干净四边形"才跑宽松档 —— 本来就能认出来的图，耗时与旧版一致
      runPass(false);
      if (largestLoose) {
        // rank 6：最大轮廓的旋转矩形。永远给得出 4 点，是最后一道兜底
        try {
          const rect = cv.minAreaRect(largestLoose);
          const raw = cv.RotatedRect.points(rect) as Corner[];
          const fixed = repairToQuad(raw.map((p) => ({ x: p.x, y: p.y })));
          if (fixed) {
            cands.push({
              pts: fixed,
              confidence: "low",
              stage: "loose:minAreaRect",
              area: largestLooseArea,
              rank: 6,
            });
          }
        } catch (e) {
          console.warn("[doc-scan] minAreaRect 兜底不可用:", e);
        }
      }
      best = pick();
    }

    if (best) {
      // 检测是在缩略图上做的，坐标要映射回原图
      const inv = 1 / scale;
      const mapped = best.pts.map((p) => ({ x: p.x * inv, y: p.y * inv }));
      const sorted = sortCorners(mapped);
      if (sorted) {
        return { corners: sorted, confidence: best.confidence, stage: best.stage };
      }
    }
  } catch (e) {
    console.warn("[doc-scan] 四角检测失败:", e);
  } finally {
    small.delete();
    gray.delete();
    edges.delete();
    kernelS?.delete?.();
    kernelL?.delete?.();
    largestLoose?.delete?.();
  }
  return NONE;
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
