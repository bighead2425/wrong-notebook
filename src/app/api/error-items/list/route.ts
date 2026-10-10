import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isManageType } from "@/lib/manage-type";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MIN_PAGE_SIZE } from "@/lib/constants/pagination";

const logger = createLogger('api:error-items:list');

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    const { searchParams } = new URL(req.url);
    // 旧参数名 subjectId 仍兼容，新参数名 notebookId
    const notebookId = searchParams.get("notebookId") ?? searchParams.get("subjectId");
    const query = searchParams.get("query");
    const mastery = searchParams.get("mastery");
    const timeRange = searchParams.get("timeRange");
    const tag = searchParams.get("tag");
    // 四分法（H2 / 5.3）：
    //   scope=main(默认) 主库：deletedAt=null 且 masteryLevel<2 且 所属本 archiveStatus != archived
    //   scope=archived   学期归档：deletedAt=null 且 所属本 archiveStatus = archived
    //   scope=all        全部未软删（不分归档）
    //   trash=1          回收箱，优先级最高：回收箱 > 已掌握 > 归档 > 主库
    const trash = searchParams.get("trash");
    const scope = searchParams.get("scope");

    // 未打印筛选（#10 / T4 三级打印按钮）
    const unprinted = searchParams.get("unprinted");

    // 指定 ID 列表（单题打印跳转用）
    const idsParam = searchParams.get("ids");

    /**
     * 【2026-09-30 改语义】等级筛选 = **多选**：`attention=1,3,5`（逗号分隔的等级列表）。
     *
     * 改之前是 `attention=N` ⇒ `gte N`（"至少该档"）。现在界面是**勾选若干档**，
     * "勾了青铜+王者"意思就是只要这两档 —— 用 `in` 才对得上，`gte` 会把中间几档塞进来。
     * 老链接（单个值）仍然能用，只是语义从"≥N"变成"=N"；本参数只有错题本页在用，
     * 与界面同时改，没有别处依赖。
     */
    const attentionParam = searchParams.get("attention");

    // 分页参数
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10)));

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

        const whereClause: Prisma.ErrorItemWhereInput = {
            userId: user.id,
        };

        // 需要同时满足的附加条件，最终并入 whereClause.AND。
        // ⚠️ 这类条件必须走 AND 累加，不能写顶层同名字段 —— 顶层键（OR / masteryLevel 等）
        //    会被后面的筛选逻辑整段覆盖，条件会静默丢失（gradeSemester 就踩过这个坑）。
        const andConditions: Prisma.ErrorItemWhereInput[] = [];

        if (notebookId) {
            whereClause.notebookId = notebookId;
        }

        // 指定 ID 列表优先（单题打印 / 扫码后跳单题打印）
        if (idsParam) {
            const idList = idsParam.split(",").map(s => s.trim()).filter(Boolean);
            whereClause.id = { in: idList };
            // 单题打印需要能拿到回收箱里的题，故此处不强制 deletedAt
        } else {
            // 回收箱优先级最高；否则按 scope 决定归档范围
            if (trash === "1") {
                whereClause.deletedAt = { not: null };
            } else {
                whereClause.deletedAt = null;
                if (scope === "archived") {
                    whereClause.notebook = { is: { archiveStatus: "archived" } };
                } else if (scope === "main" || !scope) {
                    // 主库：本未归档（无本的题视作在主库，避免旧测试数据凭空消失）
                    whereClause.OR = [
                        { notebookId: null },
                        { notebook: { is: { archiveStatus: { not: "archived" } } } },
                    ];
                    // 【四分法对齐 · 蓝图 5.3】主库 = deletedAt=null 且 masteryLevel<2 且 本在用。
                    // 原实现漏了 masteryLevel<2，「已掌握」的题一直混在主库里，四分法名不副实。
                    // 但要留一个出口：界面上的「已掌握」筛选项正是靠 mastery=1 来看这一分区的，
                    // 若无条件排除，该筛选会查出空集。故只在调用方**未显式传 mastery** 时排除。
                    if (mastery === null) {
                        andConditions.push({ masteryLevel: { lt: 2 } });
                    }
                }
                // scope=all 不加额外限制
            }
        }

        // 未打印筛选：只取从没打印过的题
        if (unprinted === "1") {
            whereClause.printCount = 0;
        }

        // 等级筛选（多选）：1,3,5 ⇒ in
        if (attentionParam) {
            const levels = attentionParam
                .split(",")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5)
                .map((n) => Math.round(n));
            if (levels.length > 0) {
                whereClause.attention = { in: levels };
            }
        }

        // 搜索条件需要使用 AND 包装，避免与其他 OR 条件冲突
        // 最终的 whereClause.AND 会包含所有需要同时满足的条件（声明已提前到函数开头）
        if (query) {
            /**
             * 搜索条件：任一字段命中即可。
             * ⚠️【2026-10-10 补】原来**不含 `source`（题号）** —— 于是他"搜题号"永远搜不到
             *    （列表页的搜索框、以及"关联别的题"里的查找都受影响）。
             *    题号是他在纸上唯一能看见的编号，必须能搜；`contains` 让"只记得尾号"也能命中。
             */
            andConditions.push({
                OR: [
                    { source: { contains: query } },
                    { questionText: { contains: query } },
                    { analysis: { contains: query } },
                    { wrongAnswerText: { contains: query } },
                    { mistakeAnalysis: { contains: query } },
                    { knowledgePoints: { contains: query } },
                ]
            });
        }

        // Mastery filter
        if (mastery !== null) {
            whereClause.masteryLevel = mastery === "1" ? { gt: 0 } : 0;
        }

        // Time range filter
        // 【2026-09-30 扩档】近一周 / 近两周 / 近三周 / 近一个月 / 近两个月 / 近三个月 / 其他日期
        if (timeRange && timeRange !== "all") {
            const now = new Date();
            const DAY_RANGES: Record<string, number> = { week: 7, "2weeks": 14, "3weeks": 21 };
            const MONTH_RANGES: Record<string, number> = { month: 1, "2months": 2, "3months": 3 };

            if (timeRange === "other") {
                /**
                 * 日历选的"某几天"或"某一段"。
                 * ⚠️ 客户端传的是**绝对时刻**（它按浏览器本地时区把日界换算好），不是 "2026-09-30"
                 *    这种"日子"—— 容器跑在 UTC，服务端自己算"这一天"会偏 8 小时。
                 *    这里只做 gte/lt 比较，时区在链路上不参与任何判断。
                 */
                const points = (searchParams.get("points") || "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s && !Number.isNaN(new Date(s).getTime()));
                const fromParam = searchParams.get("from");
                const toParam = searchParams.get("to");
                const fromOk = fromParam && !Number.isNaN(new Date(fromParam).getTime());
                const toOk = toParam && !Number.isNaN(new Date(toParam).getTime());

                if (points.length > 0) {
                    // 多个整天：每个点查 [当天, 次日)
                    andConditions.push({
                        OR: points.map((p) => {
                            const start = new Date(p);
                            const end = new Date(start.getTime() + 24 * 3600 * 1000);
                            return { createdAt: { gte: start, lt: end } };
                        }),
                    });
                } else if (fromOk && toOk) {
                    whereClause.createdAt = { gte: new Date(fromParam as string), lt: new Date(toParam as string) };
                }
                // 选了"其他日期"却什么都没给 ⇒ **不筛**（而不是筛出空集，让人以为题没了）
            } else if (DAY_RANGES[timeRange]) {
                const startDate = new Date(now);
                startDate.setDate(now.getDate() - DAY_RANGES[timeRange]);
                whereClause.createdAt = { gte: startDate };
            } else if (MONTH_RANGES[timeRange]) {
                const startDate = new Date(now);
                startDate.setMonth(now.getMonth() - MONTH_RANGES[timeRange]);
                whereClause.createdAt = { gte: startDate };
            }
        }

        // Chapter filter (第二级筛选：章节)
        // 如果指定了 chapter，需要找到该章节下所有子标签的 ID，然后过滤错题
        const chapter = searchParams.get("chapter");
        if (chapter) {
            // 查找该章节标签及其所有后代的ID
            const chapterTagIds = await findChapterDescendantTagIds(chapter, user.id);
            if (chapterTagIds.length > 0) {
                whereClause.tags = {
                    some: {
                        id: { in: chapterTagIds }
                    }
                };
            } else {
                // 章节不存在或没有子标签，应返回空结果
                // 但为了不破坏其他条件，我们添加一个必然为假的条件
                whereClause.id = "__IMPOSSIBLE_ID__";
            }
        }

        // Tag filter (第三级筛选：具体知识点)
        if (tag && !chapter) {
            // 只有在没有 chapter 筛选时才按 tag 过滤
            // 因为 chapter 筛选已经更精确了
            whereClause.knowledgePoints = {
                contains: tag,
            };
        } else if (tag && chapter) {
            // 如果同时有 chapter 和 tag，优先用 tag 进一步过滤
            // 覆盖 chapter 的条件
            whereClause.tags = {
                some: {
                    name: tag
                }
            };
        }

        // Grade/Semester filter
        // ⚠️ 用 AND 追加，不能 Object.assign 到顶层 —— buildGradeFilter 返回的是 { OR: [...] }，
        //    直接覆盖会把上面主库/归档范围的 OR 条件挤掉（四分法失效）。
        const gradeSemester = searchParams.get("gradeSemester");
        if (gradeSemester) {
            const gradeFilter = buildGradeFilter(gradeSemester);
            if (gradeFilter) {
                andConditions.push(gradeFilter);
            }
        }

        // Paper Level filter（[2026-09-28 起界面不再用：被错题等级取代] 保留以兼容老链接）
        const paperLevel = searchParams.get("paperLevel");
        if (paperLevel && paperLevel !== "all") {
            whereClause.paperLevel = paperLevel;
        }

        /**
         * 【2026-09-28】**错题等级**过滤：deep / review / undecided（未定 = 这一列为空）。
         * 认不出的值**忽略**（保持"全部"），不猜 —— 免得筛出个空列表让人以为数据没了。
         */
        const manageType = searchParams.get("manageType");
        if (manageType && manageType !== "all") {
            if (manageType === "undecided") {
                whereClause.manageType = null;
            } else if (isManageType(manageType)) {
                whereClause.manageType = manageType;
            }
        }

        // 将所有 AND 条件合并到 whereClause
        if (andConditions.length > 0) {
            whereClause.AND = andConditions;
        }

        /**
         * 【2026-09-30】两个**轻量模式**（复用同一套 where，不另写一份筛选逻辑 ——
         * 本项目规矩：同一件事只允许一处实现）：
         *   mode=ids   → 只回 id 列表：多选「全选」要选中**当前筛选下的全部题**（跨页）
         *   mode=dates → 只回录入时刻：日历要按天标出"哪几天有错题"
         *                  ⚠️ 回的是**原始时刻**，由浏览器按本地时区分"天"——
         *                     容器是 UTC，服务端分天会偏 8 小时。
         */
        const mode = searchParams.get("mode");
        if (mode === "ids") {
            const idRows = await prisma.errorItem.findMany({
                where: whereClause,
                orderBy: { createdAt: "desc" },
                select: { id: true },
            });
            return NextResponse.json({ ids: idRows.map((r) => r.id), total: idRows.length });
        }
        if (mode === "dates") {
            const dateRows = await prisma.errorItem.findMany({
                where: whereClause,
                select: { createdAt: true },
            });
            return NextResponse.json({
                stamps: dateRows.map((r) => r.createdAt.toISOString()),
                total: dateRows.length,
            });
        }

        // 获取总数（= 当前筛选下有多少道）
        const total = await prisma.errorItem.count({
            where: whereClause,
        });

        /**
         * 【2026-09-30】这本的**总错题量**（不带任何筛选）—— 给页脚那句
         * 「共 XX 道错题，当前选中 YY 道题」里的 XX 用。
         *
         * ⚠️ 只在**进了某个错题本**（传了 notebookId）时算：全局列表页没有"这本"可言。
         *    口径 = 该本下、未进回收箱的题（不套 masteryLevel<2 那条主库规则 ——
         *    他说的是"整个错题本的总错题量"，把已掌握的排除掉就不是"整个"了）。
         */
        let notebookTotal: number | null = null;
        if (notebookId) {
            notebookTotal = await prisma.errorItem.count({
                where: { userId: user.id, notebookId, deletedAt: null },
            });
        }

        // 分页查询
        const errorItems = await prisma.errorItem.findMany({
            where: whereClause,
            orderBy: { createdAt: "desc" },
            include: {
                notebook: true,
                tags: true,
            },
            skip: (page - 1) * pageSize,
            take: pageSize,
        });

        const totalPages = Math.ceil(total / pageSize);

        /**
         * 【2026-10-10】每道题在从属关系里的角色 —— 让**列表页的错题卡也能画角标**。
         *
         * 为什么在这里算而不是让前端自己判：
         *   · 附题好判（`parentId != null`），但**主题判不出来** —— 得知道"有没有人挂我名下"；
         *   · 一次 `parentId IN (这一页的 id)` 就够了（只查一页、只取一列），
         *     比前端逐题再问一次便宜得多。
         * ⚠️ 口径与详情页的 `loadLinkView` 严格一致：有主题 ⇒ child；没主题但名下有附题 ⇒ root；
         *    都没有 ⇒ lone。**只认未删的**（回收箱里的题不参与从属判定）。
         */
        const pageIds = errorItems.map((it) => it.id);
        const kidRows = pageIds.length
            ? await prisma.errorItem.findMany({
                  where: { userId: user.id, parentId: { in: pageIds }, deletedAt: null },
                  select: { parentId: true },
              })
            : [];
        const hasChildren = new Set(kidRows.map((r) => r.parentId as string));

        return NextResponse.json({
            items: errorItems.map((it) => ({
                ...it,
                linkRole: it.parentId ? "child" : hasChildren.has(it.id) ? "root" : "lone",
            })),
            total,
            page,
            pageSize,
            totalPages,
            /** 本子总错题量（不带筛选）；没传 notebookId 时为 null */
            notebookTotal,
        });
    } catch (error) {
        logger.error({ error }, 'Error fetching items');
        return internalError("Failed to fetch error items");
    }
}

function buildGradeFilter(gradeSemester: string): Prisma.ErrorItemWhereInput {
    // 1. 恢复别名映射表 (Support aliases like 初一 for 七年级)
    const gradeMap: Record<string, string[]> = {
        "七年级": ["七年级", "初一", "7年级", "七"],
        "八年级": ["八年级", "初二", "8年级", "八"],
        "九年级": ["九年级", "初三", "9年级", "九"],
        "高一": ["高一", "10年级"],
        "高二": ["高二", "11年级"],
        "高三": ["高三", "12年级"],
    };

    // 2. 解析输入
    let targetGrades: string[] = [gradeSemester]; // Default fallback
    let targetSemester = "";

    // 提取年级关键字
    let foundKey = "";
    if (gradeSemester.includes("七年级") || gradeSemester.includes("初一")) foundKey = "七年级";
    else if (gradeSemester.includes("八年级") || gradeSemester.includes("初二")) foundKey = "八年级";
    else if (gradeSemester.includes("九年级") || gradeSemester.includes("初三")) foundKey = "九年级";
    else if (gradeSemester.includes("高一")) foundKey = "高一";
    else if (gradeSemester.includes("高二")) foundKey = "高二";
    else if (gradeSemester.includes("高三")) foundKey = "高三";
    else {
        // 如果无法识别标准年级，尝试直接解析前缀 (e.g. "一年级")
        const match = gradeSemester.match(/^(.+?)[上下]/);
        if (match) {
            targetGrades = [match[1]]; // e.g. "一年级"
        } else {
            // 完全完全无法解析，直接模糊匹配原字符串
            return { gradeSemester: { contains: gradeSemester } };
        }
    }

    if (foundKey) {
        targetGrades = gradeMap[foundKey];
    }

    // 提取学期
    if (gradeSemester.includes("上")) targetSemester = "上";
    else if (gradeSemester.includes("下")) targetSemester = "下";

    // 3. 构建多重组合查询条件
    // 对每一个可能的别名，生成多种格式变体
    const orConditions: Prisma.ErrorItemWhereInput[] = [];

    targetGrades.forEach(grade => {
        // 变体 1: 仅年级 (如果没有学期限制)
        if (!targetSemester) {
            orConditions.push({ gradeSemester: { contains: grade } });
        } else {
            // 变体 2: 年级 + 学期 (包含多种连接符)
            // 紧凑型: "初一上"
            orConditions.push({ gradeSemester: { contains: `${grade}${targetSemester}` } });
            // 逗号型: "初一，上" 或 "初一，上期"
            // 由于 contains 的特性，我们不需要穷举 "上期"/"上学期"，只要包含 "grade" 和 "学期关键字" 即可
            // 但 Prisma 的 AND 逻辑更适合处理这种情况
            // Let's use specific composed strings for precision if possible, or broad AND

            // 下面的逻辑能匹配 "初一，上期" (因为包含 "初一" 和 "，"?? 不，contains 是子串)
            // 这种组合 "grade + 任意字符 + semester" 很难用一个 contains 表达。
            // 简单粗暴点：
            orConditions.push({ gradeSemester: { contains: `${grade}，${targetSemester}` } }); // 中文逗号
            orConditions.push({ gradeSemester: { contains: `${grade},${targetSemester}` } }); // 英文逗号
            orConditions.push({ gradeSemester: { contains: `${grade} ${targetSemester}` } }); // 空格

            // 针对 "上期" 的特殊处理 (旧数据的 "高一，上期")
            const semesterTerm = targetSemester === '上' ? '上期' : '下期';
            orConditions.push({ gradeSemester: { contains: `${grade}，${semesterTerm}` } });
        }
    });

    if (orConditions.length === 0) {
        return { gradeSemester: { contains: gradeSemester } };
    }

    return { OR: orConditions };
}

// 查找章节标签及其所有后代标签的 ID
async function findChapterDescendantTagIds(chapterName: string, userId: string): Promise<string[]> {
    // 1. 找到章节标签本身 (系统标签或用户自定义标签)
    const chapterTag = await prisma.knowledgeTag.findFirst({
        where: {
            name: chapterName,
            OR: [
                { isSystem: true },
                { userId: userId },
            ],
        },
        select: { id: true }
    });

    if (!chapterTag) return [];

    // 2. 递归查找所有后代标签
    const descendantIds: string[] = [chapterTag.id];
    const queue: string[] = [chapterTag.id];

    while (queue.length > 0) {
        const parentId = queue.shift()!;
        const children = await prisma.knowledgeTag.findMany({
            where: { parentId: parentId },
            select: { id: true }
        });
        for (const child of children) {
            descendantIds.push(child.id);
            queue.push(child.id);
        }
    }

    return descendantIds;
}
