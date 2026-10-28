import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { requireAdmin } from "@/lib/auth-utils"
import { forbidden, badRequest, internalError } from "@/lib/api-errors"
import { createLogger } from "@/lib/logger"

const logger = createLogger('api:admin:users:id');

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions)

    if (!requireAdmin(session)) {
        return forbidden("Admin access required")
    }

    try {
        const body = await req.json()
        const { isActive } = body

        // Prevent disabling self
        if (id === session?.user.id) {
            return badRequest("Cannot disable your own account")
        }

        // Prevent disabling super admin
        const targetUser = await prisma.user.findUnique({
            where: { id }
        })

        if (targetUser?.email === 'admin@localhost') {
            return badRequest("Cannot disable super admin")
        }

        const user = await prisma.user.update({
            where: {
                id
            },
            data: {
                isActive
            },
            /**
             * 【2026-10-29 审计修复】原来 `update` 不带 `select`，返回的是**整行**，
             * 包括 `password`（bcrypt 哈希）—— 它就这么进了响应体，
             * 在浏览器的网络面板、任何抓包的代理里都能看到。
             * 只回界面上真正要用的四个字段。
             */
            select: { id: true, name: true, email: true, role: true, isActive: true },
        })

        return NextResponse.json(user)
    } catch (error) {
        logger.error({ error }, 'Error updating user');
        return internalError("Failed to update user")
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions)

    if (!requireAdmin(session)) {
        return forbidden("Admin access required")
    }

    try {
        // Prevent deleting self
        if (id === session?.user.id) {
            return badRequest("Cannot delete your own account")
        }

        // Prevent deleting super admin
        const targetUser = await prisma.user.findUnique({
            where: { id }
        })

        if (targetUser?.role === 'admin') {
            if (targetUser.email === 'admin@localhost') {
                return badRequest("Cannot delete super admin")
            }
        }

        const user = await prisma.user.delete({
            where: {
                id
            },
            /* 同上：删完也不该把密码哈希回给前端 */
            select: { id: true, name: true, email: true, role: true, isActive: true },
        })

        return NextResponse.json(user)
    } catch (error) {
        logger.error({ error }, 'Error deleting user');
        return internalError("Failed to delete user")
    }
}
