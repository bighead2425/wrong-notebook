"use client";

import QRCode from "qrcode";

/**
 * 生成二维码 data URL（客户端）。
 *
 * 纸面二维码内容是**题号本身**（如 SX20260916001），扫码后由 /api/scan 反查题目。
 * 选纯题号而不是完整 URL 的理由：题号短 → 二维码稀疏 → 小尺寸也扫得动，
 * 且不把 NAS 地址写死在纸上（换域名 / 换端口都不失效）。
 *
 * 采用 dynamic import 的调用方请注意：本模块只在浏览器跑，勿在 Server Component 里 import。
 */
export async function makeQrDataUrl(
    text: string,
    options?: { width?: number; margin?: number }
): Promise<string> {
    const { width = 96, margin = 1 } = options || {};
    return QRCode.toDataURL(text, {
        width,
        margin,
        errorCorrectionLevel: "M",
        color: { dark: "#000000ff", light: "#ffffffff" },
    });
}
