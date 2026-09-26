/**
 * 「派生图还没画完，先别打印」—— 一个极小的就绪门。
 *
 * ── 为什么需要它（2026-09-26 三修）──────────────────────────────────
 * 题图（橙框那块）**不是**接口给的 URL，而是打印时在浏览器里现裁的：
 * `useFigureImages` 建一个 `Image`，`onload` 之后才 `canvas.toDataURL()`，
 * 再把 dataURL 挂到 `<img>` 上。也就是说 —— **图是异步出现的**。
 *
 * 而 `handlePrint` 原先只 `setTimeout(…, 120)` 就去 `window.print()`。
 * 120ms 对大多数图够用（dataURL 不走网络），但原图稍大一点、
 * 或者这次要打十几道（十几个 `Image` 同时在解码）时就不够：
 * 打印那一刻 `<img>` 还没进 DOM ⇒ **纸面上没有题图**。
 *
 * 症状与用户报的"橙框不起作用"**长得一模一样**，只是成因不同 ——
 * 这类"概率性少一块"最难查，所以用一个门把它堵死，而不是把 120 调大碰运气。
 *
 * ── 怎么用 ──────────────────────────────────────────────────────
 *   生产者：`const done = beginImageWork()`，然后**无论成功、失败还是组件卸载**，
 *           都调一次 `done()`（图标就绪时调不了第二次，见下）。
 *   消费者：`await whenImagesSettled()` 之后再 `window.print()`。
 *
 * ⚠️ 为什么 `beginImageWork()` 返回一个函数，而不是配一个 `finishImageWork()`：
 *    一个 worker 的"完工"会在**三个**地方被触发（onload / onerror / effect 清理），
 *    写成两个函数就必须让每个调用点自己记得"我是不是已经报过完工了"。
 *    漏一次就会多扣一次计数 ⇒ 门提前打开 ⇒ 又回到"打印时图没就绪"。
 *    返回**幂等**的函数，误用就不可能发生（这类"计数型"代码最怕手工配对）。
 *
 * ⚠️ 超时兜底**必须有**：一旦哪天有人在某条路径上漏了完工，
 *    没有超时就是"点了打印永远没反应"，那比缺一张图严重得多。
 *    宁可超时后照常打印（退回今天的行为），也不能把打印卡死。
 */

let pending = 0;
const waiters = new Set<() => void>();

/**
 * 开工：声明"有一张图正在解析"。
 * @returns 幂等的完工回调 —— 调几次都只算一次。
 */
export function beginImageWork(): () => void {
    pending += 1;
    let settled = false;
    return () => {
        if (settled) return;
        settled = true;
        pending = Math.max(0, pending - 1);
        if (pending === 0) {
            const list = [...waiters];
            waiters.clear();
            for (const resolve of list) resolve();
        }
    };
}

/** 当前还有几张没出结果（测试与调试用）。 */
export function pendingImageWork(): number {
    return pending;
}

/**
 * 等到"当前所有正在解析的图都出结果"，或超时。
 *
 * @param timeoutMs 上限。到点就放行，宁可少一张图也不把打印卡住。
 */
export function whenImagesSettled(timeoutMs = 1500): Promise<void> {
    if (pending === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
        function onSettled() {
            clearTimeout(timer);
            waiters.delete(onSettled);
            resolve();
        }
        const timer = setTimeout(() => {
            waiters.delete(onSettled);
            resolve();
        }, timeoutMs);
        waiters.add(onSettled);
    });
}

/** 等浏览器画出下一帧（让 React 提交 + 布局落地）。优先 rAF，环境没有就退回定时器。 */
function nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
        } else {
            setTimeout(resolve, 16);
        }
    });
}

/**
 * 等到**打印范围内所有 `<img>` 都解码完成**，或超时。
 *
 * ── 为什么还要这一道（2026-09-26 四修）─────────────────────────────
 * 打印页上的图有**三个**异步来源，一个都不能少等：
 *   ① 正面原题照片 —— `originalImageUrl`（dataURL）
 *   ② 反面的题图 —— 现裁出来的 dataURL（`whenImagesSettled` 只管到"生成完"）
 *   ③ **二维码** —— `makeQrDataUrl()` 异步生成后才塞进 `qrMap`
 *
 * 而题图比另外两个还多绕一道：**生成完 → 进 DOM → 解码**。
 * 用户实测的现象正好对上：**选 1 道能打，选 4 道时背面的题图没了**
 * （4 张卡时 React 重新提交整张纸要花的时间，早超过原来硬等的那 120ms）。
 *
 * ── 为什么要**多轮复查** ────────────────────────────────────────
 * 等第一轮的时候，别的卡片可能刚好把新图提交进来；
 * 只查一次就会漏掉"等图期间新出现的图"。所以查完一帧再查一遍（最多 3 轮）。
 *
 * ⚠️ `decode()` 对破图 / 空 src 会 reject，必须吞掉：
 *    一张图坏了不该让整次打印卡住（那是"整页打不出来"，比少一张图严重得多）。
 *
 * @returns 一共等过几张（便于排查；0 = 没有什么可等的）
 */
export async function whenImagesDecoded(
    root: ParentNode | null | undefined,
    timeoutMs = 3000,
): Promise<number> {
    if (!root) return 0;
    const deadline = Date.now() + timeoutMs;
    let waited = 0;

    for (let round = 0; round < 3; round += 1) {
        const pending = Array.from(root.querySelectorAll('img')).filter(
            (img) => !(img.complete && img.naturalWidth > 0),
        );
        if (pending.length === 0) break;
        waited = Math.max(waited, pending.length);

        const left = deadline - Date.now();
        if (left <= 0) break;

        await Promise.race([
            Promise.all(pending.map(decodeOne)),
            new Promise<void>((resolve) => setTimeout(resolve, left)),
        ]);

        // 等一帧再复查：期间 React 可能刚把新图提交进 DOM
        if (Date.now() < deadline) await nextFrame();
    }
    return waited;
}

/** 单张图等"可绘制"。优先 `decode()`；没有就退回 load/error 事件。 */
function decodeOne(img: HTMLImageElement): Promise<void> {
    if (typeof img.decode === 'function') {
        return img.decode().catch(() => undefined);
    }
    if (img.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
    });
}

/**
 * 测试专用：把计数与等待者清空（单测之间互不影响）。
 * 不改它也不会污染生产逻辑 —— 只在测试里用。
 */
export function __resetImageWorkForTest(): void {
    pending = 0;
    waiters.clear();
}
