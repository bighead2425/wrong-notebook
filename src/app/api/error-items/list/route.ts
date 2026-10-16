import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isManageType } from "@/lib/manage-type";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
// 【2026-10-15】「掌握 / 等级」合并筛选的键（唯一实现在 lib/attention-level.ts）
import {
    MASTERED_FILTER_KEY,
    filterKeyToLevel,
    isFilterUnfiltered,
    parseFilterKeys,
} from "@/lib/attention-level";
// 【2026-10-15】每日等级结算的惰性触发（见下方 GET 里的注释）
import { maybeSettleDaily, normalizeTodayKey } from "@/lib/daily-settle";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MIN_PAGE_SIZE } from "@/lib/constants/pagination";
// 【2026-10-16】列表返回哪些标量字段（唯一出处；默认不含题图）—— 见该文件头的性能说明
import { LIST_ITEM_SCALARS } from "@/lib/constants/error-item-list-fields";

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

    /**
     * ⭐【2026-10-15 **新**】「掌握 / 等级」**合并筛选**：`levelFilter=mastered,1,3`。
     *
     * 空空 2026-10-15 定（`docs\14` §7.5）：原【筛选】里的「掌握状态」整组挪出来，
     * 与原【等级】下拉合并成一个 —— 选项为
     * **已掌握 / 🍜D稳了 / 🥘C还行 / 🥐B该练 / 🥥A抓紧 / 🥗S此刻**（6 个）。
     *
     * ⚠️ **"已掌握优先于等级"**（他明确要求）：一道题即使等级是 🥗S此刻，
     *    只要它已掌握，就**不出现在 🥗S此刻 的结果里**。
     *    ⇒ 实现就是把选中项拼成 `OR`，并给**等级分支**加上 `masteryLevel < 2`：
     *        · 选了"已掌握"      ⇒ 命中 `masteryLevel >= 2`（只看已掌握）
     *        · 选了某一档等级    ⇒ 命中 `masteryLevel < 2 且 attention = 该档`
     *    ⇒ 已掌握的题只可能从"已掌握"那个分支出来 —— 优先级天然成立，不需要额外排序。
     *
     * ⚠️ 旧参数 `attention=` / `mastery=` **保留**（老链接与测试仍在用）；
     *    两者与 `levelFilter` 是**并列的 AND 条件**，正常界面只会传 `levelFilter`。
     */
    const levelFilterKeys = parseFilterKeys(searchParams.get("levelFilter"));

    /**
     * ⚠️【2026-10-16 新】**要不要带题图**（`originalImageUrl`）。
     *
     * 默认**不带** —— 题图是 base64、单张最大约 1.37MB，而列表的 6 个调用方里
     * **只有打印预览需要它**（详见下面 `findMany` 上方那段完整说明）。
     * ⇒ 只有 `?withImages=1` 时才把题图带回来。
     */
    const withImages = searchParams.get("withImages") === "1";

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

        /**
         * 【2026-10-15 新】**每日等级结算的惰性触发点（之二）**。
         *
         * 内阁页（`api/cabinet`）是主入口，但"打开错题本"也可能**直接从错题本页进来**
         * ⇒ 这里也挂一个，两条路都覆盖到。
         *
         * ⚠️ 绝大多数请求只花**一次查询**（`lastSettledOn === 今天` 直接返回）；
         *    没结算过才真的干活。`maybeSettleDaily` 自己保证**不抛异常**。
         * ⚠️ `?today=YYYY-MM-DD` 由客户端带（浏览器知道用户在哪个时区）；
         *    不带 / 不合理 ⇒ 退回服务器日期（见 `normalizeTodayKey`）。
         */
        await maybeSettleDaily(user.id, normalizeTodayKey(searchParams.get("today")));

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
                /**
                 * 【2026-10-12 需求第 11 条】**点名要某一本时，不按归档与否过滤。**
                 *
                 * 他原话："已归档的错题本卡片是能打开的，但打开后里面存的错题卡是看不见的…
                 *          但如果打开了已归档，点开了已归档错题本详情，那么其应具备的功能还是要有的。"
                 *
                 * 原来这里不看 `notebookId`：只要 scope 是 main（默认），就套上
                 * "本未归档"的过滤 ⇒ 打开一本已归档的本，它**每一道题都被过滤掉**，
                 * 页面空空如也（这正是他看到的）。而"按本查看"这个动作本身已经说清了范围，
                 * 再叠一层归档过滤只会把内容拦掉，不会拦出任何他想要的效果。
                 *
                 * ⚠️ 只跳过**归档那一层**：`deletedAt = null` 与"已掌握不进主库"这两条照旧，
                 *    这样已归档本的详情页与在用本的详情页**行为完全一致**，不会多出第二套规矩。
                 */
                /**
                 * ⚠️⚠️【2026-10-15 **改了**】默认**不再排除"已掌握"的题**。
                 *
                 * 空空 2026-10-15 原话：*"默认列表里，已掌握的题是不显示的。这样不好，
                 *   我还是需要将已掌握能够显示出来才比较有掌控力，所以错题本中要将
                 *   '已掌握'显示出来，这个改正吧。"*
                 * 并且他明确了语义：*"这道题虽然'已掌握'，但我还是要能够看得见。"*
                 *
                 * ── 改之前是什么样 ──
                 *   默认（调用方没传 `mastery`）时会主动排除 `masteryLevel >= 2`
                 *   ⇒ **已掌握的题在错题本里彻底看不见**，只有一个"筛选→已掌握"的后门能看到。
                 *   那是照"四分法（蓝图 5.3）：主库 = masteryLevel < 2"实现的。
                 *
                 * ── 现在为什么可以改 ──
                 *   ① 前端**从不传 `scope`**（一律走默认），所以改这里 = 改"错题本列表看到什么"；
                 *   ② 内阁（`/api/cabinet`）**本来就不按 masteryLevel 过滤**（它要算"掌握构成"），
                 *      任务卡里的"该练/该复查"由 `lib/cabinet.ts` 内部自己排除已掌握 ⇒ 不受影响；
                 *   ③ 已掌握的题**不进任何任务**这条没变（见 `cabinet.ts`），
                 *      只是"能在错题本里被看见"了 —— 这正是他要的。
                 *
                 * ⚠️ 于是"主库"这个词在本文件里只剩"**本在用 + 未进回收箱**"的意思，
                 *    **不再含 `masteryLevel < 2`**。要只看未掌握 ⇒ 传 `mastery=0`。
                 */
                if (notebookId) {
                    // 点名了某一本 ⇒ **归不归档都照给**（见上面那段），也不按掌握与否排除
                } else if (scope === "archived") {
                    whereClause.notebook = { is: { archiveStatus: "archived" } };
                } else if (scope === "main" || !scope) {
                    // 主库：本未归档（无本的题视作在主库，避免旧测试数据凭空消失）
                    whereClause.OR = [
                        { notebookId: null },
                        { notebook: { is: { archiveStatus: { not: "archived" } } } },
                    ];
                }
                // scope=all 不加额外限制
            }
        }

        // 未打印筛选：只取从没打印过的题
        if (unprinted === "1") {
            whereClause.printCount = 0;
        }

        /**
         * ⭐【2026-10-15 新】「掌握 / 等级」合并筛选（见上面 `levelFilterKeys` 那段注释）。
         *
         * ⚠️ 必须走 `andConditions`（= 最终 `whereClause.AND`），**不能写顶层 OR** ——
         *    顶层 `OR` 已经被"主库/归档范围"那段占了，再写一次会把它整段覆盖掉
         *    （本文件里 `gradeSemester` 踩过这个坑，注释里写着）。
         */
        if (levelFilterKeys.length > 0 && !isFilterUnfiltered(levelFilterKeys)) {
            const wantsMastered = levelFilterKeys.includes(MASTERED_FILTER_KEY);
            const levels = levelFilterKeys
                .map((k) => filterKeyToLevel(k))
                .filter((n): n is number => n !== null);

            const branches: Prisma.ErrorItemWhereInput[] = [];
            if (wantsMastered) branches.push({ masteryLevel: { gte: 2 } });
            if (levels.length > 0) {
                // ⚠️ `masteryLevel: { lt: 2 }` 就是"已掌握优先于等级"的落点：
                //    已掌握的题**永远不会**从等级分支里出来。
                branches.push({ masteryLevel: { lt: 2 }, attention: { in: levels } });
            }
            if (branches.length > 0) andConditions.push({ OR: branches });
        }

        // 等级筛选（多选）：1,3,5 ⇒ in（**旧参数**，新界面走 levelFilter；保留兼容）
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

        /**
         * 掌握状态筛选（`mastery`）。
         *
         * ⚠️⚠️【2026-10-15 **修正了口径**】原来是 `mastery=1 ⇒ masteryLevel > 0`，
         *    也就是把 **`1`（复习中）也算成"已掌握"** —— 名不副实。
         *
         * 空空 2026-10-15 明确了模型：*"题按照掌握与否的分类分为'已掌握'和'未掌握'，
         *   其中'未掌握'下分为 5 个等级。"*
         * ⇒ **二分**：`masteryLevel = 2` 才是已掌握；`0` 与 `1` **都算未掌握**。
         *   （`1` 这个值在业务上从未被写入过 —— 真真 2026-10-15 全仓查实，是个预留档。）
         *
         * | 传什么 | 查什么 |
         * |---|---|
         * | `mastery=0`（未掌握） | `masteryLevel < 2` |
         * | `mastery=1`（已掌握） | `masteryLevel = 2` |
         * | 不传 | 不按掌握与否筛（**已掌握默认可见**，见上面那段注释） |
         */
        if (mastery !== null) {
            whereClause.masteryLevel = mastery === "1" ? { equals: 2 } : { lt: 2 };
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
            /**
             * ⚠️⚠️【2026-10-16 真真】**性能修复：默认不返回题图。**
             *
             * ── 问题（空空实测）────────────────────────────────────────────
             * 局域网打开"小五上数学大库"（**才 66 道题**），错题卡出来要 **10 秒**。
             *
             * ── 根因 ───────────────────────────────────────────────────
             * 这里原来只有 `include`、**没有 `select`** ⇒ Prisma 返回 `ErrorItem`
             * 的**全部 38 个标量字段**，其中 `originalImageUrl` 是**题图 base64**：
             *   · 上传时 `compressImage(maxSizeMB = 1)`（`lib/image-utils.ts`）⇒ **单张最大约 1.37MB**；
             *   · 默认每页 **18 条** ⇒ 一次请求最多 **≈ 24MB**；
             *   · 打印预览与回收箱是 `pageSize=200` ⇒ 最多 **≈ 274MB**。
             * NAS 实测吞吐约 3.6MB/s ⇒ 光传 24MB 就要好几秒，再叠加"弱 CPU 读库 + 序列化"⇒ 10 秒对得上。
             *
             * ── 实测（真 Prisma + 真 SQLite，18 题 × 每张 400KB 图）─────────
             *   原样（带图）：响应 **9.40 MB**，查库 148ms，序列化 98ms
             *   不读图      ：响应 **23.9 KB**，查库 **23ms**，序列化 1ms
             *   ⇒ 响应体缩小 **400 倍**，且**连库都不用读那 9MB**。
             *
             * ⚠️ **为什么可以安全地不返回**：列表接口的 6 个调用方逐个查过
             *    （`error-list` / `scan-volume-view` / `review-volumes` / `trash` / `print-preview` / 详情页 `mode=ids`），
             *    **只有打印预览需要题图**（它要印题图）⇒ 它传 `?withImages=1`；
             *    其余 5 个连 `originalImageUrl` 这个名字都没出现过。
             *
             * ⚠️ **不用 Prisma 的 `omit`** —— 实测本仓这个版本（5.22）**不支持**，
             *    会直接报 `Unknown argument 'omit'`（要开 `omitApi` 预览标志才行）。
             *    ⇒ 用显式 `select`；字段清单抽在 `lib/constants/error-item-list-fields.ts`，
             *      并有 `list-fields-sync.test.ts` 拿 schema 逐字段比对（加字段漏改会红）。
             */
            select: {
                ...Object.fromEntries(LIST_ITEM_SCALARS.map((f) => [f, true])),
                // ⚠️ 题图**默认不给**；只有 `?withImages=1`（打印预览）才带回来
                ...(withImages ? { originalImageUrl: true } : {}),
                notebook: true,
                tags: true,
            } as Prisma.ErrorItemSelect,
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
