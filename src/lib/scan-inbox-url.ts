/**
 * 【2026-10-09】收件箱图片的地址 —— **全项目只在这里拼**。
 *
 * ── 为什么值得单独一个文件 ─────────────────────────────────────────────
 * 这个地址原先在三个组件里各拼了一遍（收件箱面板、拼接窗口、照片预览页共 5 处），
 * 于是每加一个查询参数都要改 5 个地方 —— 而漏掉任何一处，症状是
 * **"图片换过了还显示旧的"** 或 **"回录页打开了另一个收件箱的图"**（见下面 dir 那条）。
 * 地址是"接口约定"，只应该有一份定义。
 *
 * ── `v`（版本号）为什么必须带 ──────────────────────────────────────────
 * 服务端对**带了 v** 的请求允许长期缓存（见 `app/api/scan-inbox/file/route.ts`），
 * 因为"文件名 + 修改时间"就唯一确定了一份内容。
 * 但手机 App 会把删掉的照片**用同一个名字再传一遍**（`IMG_0001.jpg` 这种），
 * 只按名字缓存就会拿旧图 ⇒ **版本号 = 文件修改时间**，一换文件地址就变，浏览器当新图取。
 *
 * ── `dir`（哪个收件箱）为什么必须带 ────────────────────────────────────
 * 收件箱有两套（录错题 `scan2wrong` / 回录分析 `scan2recover`），
 * 两个目录里出现**同名文件**是常态（手机相册导出都叫 `IMG_xxxx.jpg`）。
 * 不带 `dir` 就按默认那个目录找 ⇒ 回录页可能显示**另一套收件箱里的同名照片**，
 * 而且不报错、只是默默给错图 —— 所以每一处取图都必须带上它。
 *
 * ⚠️ 版本号只当**缓存键**用，服务端不校验它的值；`dir` 与 `name` 由服务端严格校验
 *    （见 `lib/scan-inbox.ts` 的路径解析），这里只负责拼对参数。
 */
export function inboxFileUrl(
    name: string,
    opts: {
        dir?: string | null;
        version?: number | string | null;
        /**
         * 【2026-10-09】`true` ⇒ 取**缩略图**（`<收件箱>/.thumbs/<名字>.thumb.jpg`）。
         * 没有缩略图时服务端回 404，前端要**退回原图**（那是第一次打开的正常路径）。
         */
        thumb?: boolean;
    } = {},
): string {
    const qs = new URLSearchParams({ name });
    if (opts.dir) qs.set("dir", opts.dir);
    if (opts.version !== undefined && opts.version !== null && opts.version !== "") {
        qs.set("v", String(opts.version));
    }
    if (opts.thumb) qs.set("thumb", "1");
    return `/api/scan-inbox/file?${qs.toString()}`;
}
