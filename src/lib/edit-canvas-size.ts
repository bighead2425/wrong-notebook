/**
 * 【custom-v36】裁剪窗工作画布的尺寸上限。
 *
 * 为什么要给"编辑用画布"设上限（原先是原图多大画布就多大）：
 * v35 实测，一张 12MP 级手机照片（约 4000×3000）进了裁剪窗，点一次「🔄转」，
 * 画面被切成竖向几条、各条内容方向/比例还不一致，橡皮擦也跟着"擦哪儿乱哪儿"。
 * 排查结论：转置矩阵的数学没有错（image-rotation 有单测钉着），乱的是
 * **超大画布在浏览器里的呈现路径** —— 全分辨率画布放在 CSS scale 变换下显示，
 * Chromium 会把画布拆成纹理分块上传 GPU，某些驱动/软件光栅组合下，
 * 改内容后只有部分分块被重传，画面就成了"新内容 + 旧内容碎片"的拼凑。
 * 橡皮擦"乱"也是同一个病：用户照着屏幕上（错的）画面下笔，真实画布里并没有那些东西。
 *
 * 两道闸，都在这一处收口：
 *   ① 长边超过 MAX_EDIT_EDGE 的图，加载时等比缩小 —— 3200 已远高于下游实际用图
 *      （AI 分析压缩到 1920、扫描出图 MAX_OUTPUT_EDGE=1920），画质不吃亏，
 *      但画布面积被压回 8MP 以内，绕开大纹理分块的整类毛病，顺带省一半内存；
 *   ② 画布上下文一律走 ctx2d()（willReadFrequently: true），让 Chromium 用
 *      软件光栅维护这些画布，不走 GPU 分块纹理，改一处重传整张。
 *
 * 注意：缩放只影响"裁剪窗里的工作副本"，原始文件不动；「原图」键恢复的
 * firstImageRef 就是从缩放后的基准图克隆的，天然同尺寸，不会出现两套坐标系。
 */

/** 编辑画布长边上限。3200 < 4096（GPU 单块纹理的常见门槛），且远高于下游 1920 的实际用量。 */
export const MAX_EDIT_EDGE = 3200;

/**
 * 等比收缩到长边不超过 maxEdge；本身不超限的图原样返回（**只缩小、不放大**）。
 * 结果向上取整并至少 1px，避免 0 尺寸画布。
 */
export function fitEditSize(
    w: number,
    h: number,
    maxEdge: number = MAX_EDIT_EDGE,
): { w: number; h: number; scaled: boolean } {
    const iw = Number.isFinite(w) ? Math.max(1, Math.round(w)) : 1;
    const ih = Number.isFinite(h) ? Math.max(1, Math.round(h)) : 1;
    const edge = Number.isFinite(maxEdge) && maxEdge >= 1 ? maxEdge : 1;
    const longest = Math.max(iw, ih);
    if (longest <= edge) return { w: iw, h: ih, scaled: false };
    const k = edge / longest;
    return {
        w: Math.max(1, Math.round(iw * k)),
        h: Math.max(1, Math.round(ih * k)),
        scaled: true,
    };
}
