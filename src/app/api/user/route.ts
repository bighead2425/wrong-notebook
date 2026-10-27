import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { hash } from "bcryptjs";
import { unauthorized, notFound, badRequest, validationError, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:user');

const userUpdateSchema = z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    password: z.string().optional(),
    educationStage: z.string().optional(),
    enrollmentYear: z.number().optional().nullable(),
    /** 【2026-10-27】主页「年级/学期」。传空串 = 清空（存 null）。 */
    gradeTerm: z.string().optional().nullable(),
});

export async function GET() {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        return unauthorized();
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: {
                name: true,
                email: true,
                educationStage: true,
                enrollmentYear: true,
                gradeTerm: true,
                // Do not return password
            }
        });

        if (!user) {
            return notFound("User not found");
        }

        logger.debug({ user }, 'Returning user profile');

        return NextResponse.json(user);
    } catch (error) {
        logger.error({ error }, 'Failed to fetch user profile');
        return internalError("Failed to fetch user profile");
    }
}

export async function PATCH(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        return unauthorized();
    }

    try {
        const body = await req.json();
        const { name, email, password, educationStage, enrollmentYear, gradeTerm } = userUpdateSchema.parse(body);

        const updateData: any = {};

        // 只有非空字符串才会触发更新
        if (name && name.trim()) updateData.name = name.trim();
        if (educationStage && educationStage.trim()) updateData.educationStage = educationStage.trim();
        /**
         * 【2026-10-27】年级/学期**允许清空**，所以不能套上面那个"非空才更新"的规矩
         * （那个规矩是为 name 这类"空 = 没改"设计的）。这里按"传了就算数"处理：
         * 空串 / null ⇒ 存 null。
         */
        if (gradeTerm !== undefined) {
            const v = (gradeTerm ?? '').trim();
            updateData.gradeTerm = v || null;
        }
        if (typeof enrollmentYear === 'number' && !isNaN(enrollmentYear)) {
            updateData.enrollmentYear = enrollmentYear;
        }

        // 验证邮箱格式（如果提供了邮箱）
        // 支持标准邮箱和本地邮箱（如 admin@localhost）
        if (email && email.trim()) {
            const emailRegex = /^[^\s@]+@[^\s@]+$/;
            if (!emailRegex.test(email.trim())) {
                return badRequest("Invalid email format");
            }
            updateData.email = email.trim();
        }

        // 验证密码长度（如果提供了密码）
        if (password && password.length > 0) {
            if (password.length < 6) {
                return badRequest("Password must be at least 6 characters");
            }
            updateData.password = await hash(password, 10);
        }

        const updatedUser = await prisma.user.update({
            where: { email: session.user.email },
            data: updateData,
            select: {
                name: true,
                email: true,
                educationStage: true,
                enrollmentYear: true,
                gradeTerm: true,
            }
        });

        return NextResponse.json(updatedUser);
    } catch (error) {
        logger.error({ error }, 'Failed to update user profile');
        if (error instanceof z.ZodError) {
            return validationError("Invalid input", error.issues);
        }
        return internalError("Failed to update user profile");
    }
}
