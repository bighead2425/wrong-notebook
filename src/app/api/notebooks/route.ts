import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, conflict, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:notebooks');

/**
 * GET /api/notebooks
 * 获取用户所有错题本（Subjects）
 */
export async function GET() {
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }

        if (!user) {
            return unauthorized("Authentication required");
        }

        let notebooks = await prisma.notebook.findMany({
            where: {
                userId: user.id,
            },
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        });

        // If no notebooks exist, create default ones (教科书级：学科 × 学期)
        if (notebooks.length === 0) {
            const defaults = [
                { displayName: "数学", subject: "math" },
                { displayName: "语文", subject: "chinese" },
            ];

            await Promise.all(defaults.map(d =>
                prisma.notebook.create({
                    data: {
                        displayName: d.displayName,
                        subject: d.subject,
                        gradeStage: user.educationStage || "primary",
                        grade: "",
                        semester: "上",
                        userId: user!.id,
                    }
                })
            ));

            // Fetch again
            notebooks = await prisma.notebook.findMany({
                where: {
                    userId: user.id,
                },
                include: {
                    _count: {
                        select: {
                            errorItems: true,
                        },
                    },
                },
                orderBy: {
                    createdAt: 'desc',
                },
            });
        }

        return NextResponse.json(notebooks);
    } catch (error) {
        logger.error({ error }, 'Error fetching notebooks');
        return internalError("Failed to fetch notebooks");
    }
}

/**
 * POST /api/notebooks
 * 创建新错题本
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }

        if (!user) {
            return unauthorized("Authentication required");
        }

        const body = await req.json();
        // 新模型：教科书级四字段 + 显示名（B14）；兼容旧调用方只传 name
        const {
            displayName,
            name,
            gradeStage,
            grade,
            semester,
            subject,
        } = body;

        const finalDisplayName = String(displayName ?? name ?? "").trim();
        const finalSubject = String(subject ?? "other").trim() || "other";

        if (!finalDisplayName) {
            return badRequest("Notebook name is required");
        }

        // 检查是否已存在同名错题本
        const existing = await prisma.notebook.findUnique({
            where: {
                displayName_userId: {
                    displayName: finalDisplayName,
                    userId: user.id,
                },
            },
        });

        if (existing) {
            return conflict("Notebook with this name already exists");
        }

        const notebook = await prisma.notebook.create({
            data: {
                displayName: finalDisplayName,
                gradeStage: String(gradeStage ?? user.educationStage ?? "primary"),
                grade: String(grade ?? ""),
                semester: String(semester ?? "上"),
                subject: finalSubject,
                userId: user.id,
            },
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
        });

        return NextResponse.json(notebook, { status: 201 });
    } catch (error) {
        logger.error({ error }, 'Error creating notebook');
        return internalError("Failed to create notebook");
    }
}
