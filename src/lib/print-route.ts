/**
 * 打印出口 —— **一台机器两个出口**：本机浏览器打印 / 家庭共享打印机（NAS 上的 EasyPrinter）。
 *
 * ── 为什么按"设备"分别设 ────────────────────────────────────────────────
 * 电脑上有完整的浏览器打印对话框（选纸盒、预览、页码）；手机浏览器**没有**打印机发现
 * 能力，点"打印"只能得到一个 PDF 或者什么都不给。
 * 所以同一个"本地"，在电脑上叫"浏览器打印"，在手机上目前只能落成"存成 PDF"。
 * 空空 2026-10-28 的决定：**手机上仍然留这三个值**（本地/共享/询问），
 * 因为"以后手机能直连打印机"这件事不该被今天的实现堵死 —— 到时候只改实现，不改界面。
 *
 * ── 为什么这台机器的地址不放在前端 ─────────────────────────────────────
 * 真正把文件递给 EasyPrinter 的是**服务端**（`/api/print/submit`），前端只负责生成 PDF。
 * 好处：① 手机不在家（走 FN Connect）也能打，因为发请求的是 NAS 自己；
 *       ② EasyPrinter 的地址不出现在手机浏览器的网络请求里。
 */

/** 三个出口 */
export type PrintRoute = 'local' | 'shared' | 'ask';

/** 两类设备 */
export type PrintDevice = 'desktop' | 'mobile';

/** 配置里 `print` 的形状（缺项一律走默认，老配置原样能用） */
export interface PrintSettings {
    desktop?: PrintRoute;
    mobile?: PrintRoute;
    /** 共享打印服务地址（EasyPrinter）。**只有管理员能改** —— 它是服务端会去 POST 的地址 */
    serverUrl?: string;
}

/**
 * 家里那台 EasyPrinter 的默认地址。
 * 端口 6310 是它自己的 Web/接口端口（631 是 CUPS，别混）。
 */
export const DEFAULT_PRINT_SERVER = 'http://192.168.1.10:6310';

/**
 * 缺省出口：**电脑走本地、手机走共享**。
 *
 * 理由不是偏好，是能力：电脑上浏览器打印最稳（能选纸盒、能预览）；
 * 手机上不预设共享，等于"点了打印什么也不会发生"。
 */
export const DEFAULT_PRINT_ROUTE: Record<PrintDevice, PrintRoute> = {
    desktop: 'local',
    mobile: 'shared',
};

const ROUTES: readonly PrintRoute[] = ['local', 'shared', 'ask'];

export function isPrintRoute(v: unknown): v is PrintRoute {
    return typeof v === 'string' && (ROUTES as readonly string[]).includes(v);
}

/**
 * 取某台设备该走哪个出口。
 * ⚠️ **脏数据一律退回默认**：这个值决定"点打印会发生什么"，
 *    宁可走缺省，也不要因为配置里写了个没见过的字符串就让按钮失灵。
 */
export function routeFor(device: PrintDevice, settings?: PrintSettings | null): PrintRoute {
    const raw = settings?.[device];
    return isPrintRoute(raw) ? raw : DEFAULT_PRINT_ROUTE[device];
}

/**
 * 判断当前是手机/平板。
 *
 * ⚠️ iPadOS 13 起 UA 伪装成 Macintosh（`Macintosh; Intel Mac OS X`），
 *    只认 UA 会把 iPad 当电脑 ⇒ 必须允许调用方补一个"有触摸"的事实。
 *    这也是为什么这个函数收两个参数、而不是自己去读 navigator（那样没法测）。
 */
export function detectDevice(userAgent: string, hasTouch = false): PrintDevice {
    const ua = userAgent || '';
    if (/Android|iPhone|iPod|Windows Phone|HarmonyOS|Mobile/i.test(ua)) return 'mobile';
    // iPad 老 UA
    if (/iPad/i.test(ua)) return 'mobile';
    // iPadOS 13+：UA 是 Macintosh，但支持多点触摸
    if (/Macintosh/i.test(ua) && hasTouch) return 'mobile';
    return 'desktop';
}

/**
 * 规范化共享打印地址：去空白、去尾部斜杠、只收 http/https。
 * 非法一律回落到默认值 —— 这个字符串会被服务端拿去做 fetch，不能让脏值溜进去。
 */
export function normalizePrintServer(raw?: string | null): string {
    const v = (raw || '').trim().replace(/\/+$/, '');
    if (!v) return DEFAULT_PRINT_SERVER;
    if (!/^https?:\/\//i.test(v)) return DEFAULT_PRINT_SERVER;
    return v;
}

/* ============================================================================
 * 「共享打印」那四格设置
 *
 * 为什么只要四项：一张纸打错就是废纸，而**双面/纸型**错了是整摞都废。
 * 所以这四项必须能看见、能改；其余（色彩、送纸盒）交给打印机自己的默认值，
 * 我们不假装比驱动更懂那台机器。
 * ==========================================================================*/

/** 纸型只收这两种 —— 与 `lib/paper.ts` 的 `PaperId` 一致（这里不 import，避免把服务端模块带进客户端） */
export type PrintPaper = 'B5' | 'A4';

export interface PrintOptions {
    copies: number;
    /** long = 长边翻转（像翻书）；none = 单面 */
    duplex: 'long' | 'none';
    paper: PrintPaper;
    /** all = 全部页；current = 只印当前这道题/这一卷 */
    range: 'all' | 'current';
}

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
    copies: 1,
    duplex: 'long',
    paper: 'B5',
    range: 'all',
};

/**
 * 「记住上次选择」的键。
 * ⚠️ 存在 **localStorage**（每台设备各记各的），不是写进服务端配置：
 *    打印选项是"这台设备上一次怎么打的"，不是"这个家怎么打"。
 */
export const PRINT_OPTIONS_STORAGE_KEY = 'wn:print-options';

/**
 * 把任何来源（localStorage / 用户手滑）的值收敛成合法的四项。
 * 非法值逐项回落到默认，**不整块丢弃** —— 用户改对了三项、错了一项时，
 * 不该把另外三项也变回默认。
 */
export function normalizePrintOptions(v: unknown, paper: PrintPaper = 'B5'): PrintOptions {
    const o = (v && typeof v === 'object' ? v : {}) as Partial<PrintOptions>;
    const copies = Math.min(99, Math.max(1, Math.round(Number(o.copies)) || DEFAULT_PRINT_OPTIONS.copies));
    const duplex: PrintOptions['duplex'] = o.duplex === 'none' ? 'none' : 'long';
    const p: PrintPaper = o.paper === 'A4' || o.paper === 'B5' ? o.paper : paper;
    const range: PrintOptions['range'] = o.range === 'current' ? 'current' : 'all';
    return { copies, duplex, paper: p, range };
}

/* ============================================================================
 * 「每次询问」+「以后这台设备都这样」
 *
 * 为什么"记住"不写进服务端配置：那句话说的是**这台设备**以后怎么打
 * （手机和电脑本来就不一样），写进全局配置会让两台机器互相覆盖。
 * ==========================================================================*/

export const REMEMBERED_ROUTE_STORAGE_KEY = 'wn:print-route';

/**
 * 算出这次到底走哪条路。
 *
 * 配置说 `ask` 时，才去看这台设备"上次记住的选择"；
 * 配置说 `local`/`shared` 时，配置优先 —— 否则用户在设置里改回"本机"，
 * 却被以前记住的"共享"顶掉，会以为设置没生效。
 */
export function resolveRoute(
    device: PrintDevice,
    settings?: PrintSettings | null,
    remembered?: PrintRoute | null,
): PrintRoute {
    const configured = routeFor(device, settings);
    if (configured === 'ask' && (remembered === 'local' || remembered === 'shared')) {
        return remembered;
    }
    return configured;
}

export function readRememberedRoute(): PrintRoute | null {
    if (typeof window === 'undefined') return null;
    try {
        const v = window.localStorage.getItem(REMEMBERED_ROUTE_STORAGE_KEY);
        return v === 'local' || v === 'shared' ? v : null;
    } catch {
        return null;
    }
}

export function storeRememberedRoute(route: PrintRoute | null): void {
    if (typeof window === 'undefined') return;
    try {
        if (route === null) window.localStorage.removeItem(REMEMBERED_ROUTE_STORAGE_KEY);
        else window.localStorage.setItem(REMEMBERED_ROUTE_STORAGE_KEY, route);
    } catch {
        /* 隐私模式写不进去，不影响这次打印 */
    }
}


