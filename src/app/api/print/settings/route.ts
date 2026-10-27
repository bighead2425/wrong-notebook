import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAppConfig } from "@/lib/config";
import { normalizedPrintSettings } from "@/lib/print-server";

export const dynamic = 'force-dynamic';

/**
 * 打印出口设置 —— 只回**前端需要的那两项**（电脑/手机各走哪个出口）。
 *
 * 为什么不直接让前端读 `/api/settings`：那个接口会连 AI 密钥一起返回
 * （管理员是明文），打印页没必要碰这些东西。
 * 服务地址也不回：真正把文件递出去的是服务端，前端知道了只会多一个泄密面。
 */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const print = normalizedPrintSettings(getAppConfig().print);
    return NextResponse.json({ desktop: print.desktop, mobile: print.mobile });
}
