/**
 * 打印出口 —— **服务端**那一半（读配置、算地址）。
 *
 * ⚠️ 这个文件只能被服务端代码 import（它碰 `fs`）。
 *    纯逻辑（三个出口、四格设置、设备判断）都在 `lib/print-route.ts`，
 *    那一份是前后端共用的，别往这里搬。
 */

import { getAppConfig } from './config';
import {
    DEFAULT_PRINT_ROUTE,
    normalizePrintServer,
    routeFor,
    type PrintRoute,
    type PrintSettings,
} from './print-route';

export interface ResolvedPrintSettings {
    desktop: PrintRoute;
    mobile: PrintRoute;
    /** 已经规范化过的 EasyPrinter 地址（没有尾部斜杠、一定是 http/https） */
    serverUrl: string;
}

/** 把配置里的 `print` 段收敛成可以直接用的形状（缺项走默认，脏值回退） */
export function normalizedPrintSettings(raw?: PrintSettings | null): ResolvedPrintSettings {
    return {
        desktop: routeFor('desktop', raw),
        mobile: routeFor('mobile', raw),
        serverUrl: normalizePrintServer(raw?.serverUrl),
    };
}

/** 从当前配置文件读 —— 提交打印时用 */
export function printServerUrl(): string {
    return normalizedPrintSettings(getAppConfig().print).serverUrl;
}

export { DEFAULT_PRINT_ROUTE };
