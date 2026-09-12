import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized } from "@/lib/api-errors";
import {
    subjectKeyToCode,
    subjectNameToCode,
    formatDateStamp,
    formatQuestionNo,
    startOfToday,
} from "@/lib/question-no";

/**
 * GET /api/error-items/next-question-no?subjectKey=math&subjectName=数学
 *
 * 返回该用户下一道题的题号预览（不落库）：
 *   <学科2字简拼> + <8位日期 YYYYMMDD> + <3位当日流水(已存在数+1)>
 * 前端在保存前用它自动填充“题号”输入框。
 *
 * 学科简拼优先级：subjectKey（math/english/...）> subjectName（中文/脏名）> 兜底 "ot"
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return unauthorized("No user found in session");
    }

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
    });
    if (!user) {
        return unauthorized("No user found in DB");
    }

    const url = new URL(req.url);
    const subjectKey = url.searchParams.get("subjectKey") || undefined;
    const subjectName = url.searchParams.get("subjectName") || undefined;

    const code = subjectKeyToCode(subjectKey) !== "ot"
        ? subjectKeyToCode(subjectKey)
        : subjectNameToCode(subjectName);

    const dateStamp = formatDateStamp(new Date());

    const todayCount = await prisma.errorItem.count({
        where: {
            userId: user.id,
            createdAt: { gte: startOfToday() },
        },
    });

    const questionNo = formatQuestionNo(code, dateStamp, todayCount + 1);

    return NextResponse.json({ questionNo, code, dateStamp, serial: todayCount + 1 });
}
