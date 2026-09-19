import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, conflict, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:notebooks');

/**
 * GET /api/notebooks
 * 获取用户的错题本。
 *
 * 【custom-v25 两处口径修正】
 *
 * ① **默认不返回已归档的本**（`?archived=1` 才只要归档的）。
 *    归档本只会随学期越积越多，而日常几乎只在动当前学期的本；
 *    每次打开「我的错题本」都把归档那批连同 each 本的行数统计一起捞出来，
 *    是白白拖慢首屏。展开「已归档 ▾」时前端再单独来一次。
 *
 * ② **行数统计排除回收箱里的题**（`errorItems: { where: { deletedAt: null } }`）。
 *    原来统计的是**全部关联题**，而删除是软删（进回收箱）——
 *    于是"本里有 3 道、删掉 1 道、退回来还显示 3 道"，用户以为删了个寂寞。
 *    ⚠️ 注意与 DELETE 的保护口径不同：那里必须算**含回收箱**的全部题，
 *    因为 notebook 一删是级联删除，回收箱里的题也跟着没了（见 [id]/route.ts）。
 */
export async function GET(req: Request) {
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

        const onlyArchived = new URL(req.url).searchParams.get("archived") === "1";

        const countSelect = {
            select: {
                errorItems: { where: { deletedAt: null } },
            },
        };

        if (onlyArchived) {
            const archived = await prisma.notebook.findMany({
                where: { userId: user.id, archiveStatus: "archived" },
                include: { _count: countSelect },
                orderBy: { createdAt: 'desc' },
            });
            return NextResponse.json(archived);
        }

        let notebooks = await prisma.notebook.findMany({
            where: {
                userId: user.id,
                archiveStatus: { not: "archived" },
            },
            include: {
                _count: countSelect,
            },
            orderBy: {
                createdAt: 'desc',
            },
        });

        // If no notebooks exist, create default ones (教科书级：学科 × 学期)
        // ⚠️ 「一个都没有」必须按**全部本**（含归档）判断：只看非归档的话，
        //   把每个本都归档了的用户一进页面就会被凭空塞回两个默认本。
        if (notebooks.length === 0) {
            const total = await prisma.notebook.count({ where: { userId: user.id } });
            if (total === 0) {
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

                notebooks = await prisma.notebook.findMany({
                    where: { userId: user.id, archiveStatus: { not: "archived" } },
                    include: { _count: countSelect },
                    orderBy: { createdAt: 'desc' },
                });
            }
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
