import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { calculateGrade } from "@/lib/grade-calculator";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { normalizeMistakeCategory } from "@/lib/mistake-category";
import {
    MANAGE_TYPE_DEFAULT,
    normalizeManageType,
    normalizeManageTypeSource,
    suggestManageType,
} from "@/lib/manage-type";
import { subjectKeyToCode, formatDateStamp, formatQuestionNo, startOfToday } from "@/lib/question-no";
import { initialLevelForManageType } from "@/lib/level-linkage";
// 【2026-10-10】可选的"新建时直接挂到某道题下面"（他原稿："拍照新增一道题并关联到题 A"）
import { rootOf, type LinkNode } from "@/lib/item-link";
import { loadLinkNodes, resolveOwnedItem } from "@/lib/item-link-store";

const logger = createLogger('api:error-items');

export async function POST(req: Request) {
    logger.info('POST /api/error-items called');

    const session = await getServerSession(authOptions);

    try {
        const body = await req.json();
        const {
            questionText,
            answerText,
            analysis,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            knowledgePoints,
            originalImageUrl,
            notebookId,
            gradeSemester,
            paperLevel,
            source,
            inputMethod,
            cropRegions,
            // 【2026-09-28】错题等级 + 错因受控枚举
            mistakeCategory,
            manageType,
            manageTypeSource,
            /**
             * 【2026-10-10】可选：新题**直接挂到哪道题下面**（他在"扫到的这道题"页
             * 点【关联别的题】→【拍照新增并关联】时带上）。id 或题号都收。
             */
            parentId,
        } = body;

        /**
         * 【M1】框坐标（净版涂白 / 题图裁切的依据）。
         *
         * 这里**只做形状校验，不做几何校验** —— 坐标合不合理（框是不是在图片范围内、
         * 有没有互相包含）由 `lib/crop-regions.ts` 的读取端判定，那是唯一真源；
         * 在这里重写一遍判断，早晚会和那边跑偏。
         *
         * 校验目的很窄：别让一个坏字符串进出数据库，害得打印端每次读都要 try/catch。
         * 非法值一律当"没提供"（undefined）处理，而不是报错拒存 ——
         * 用户题干已经编辑好了，不该因为一张附加的坐标而整道题存不下去。
         */
        let finalCropRegions: string | null | undefined;
        if (typeof cropRegions === 'string' && cropRegions.trim()) {
            try {
                const parsed = JSON.parse(cropRegions);
                const okShape =
                    parsed && typeof parsed === 'object' &&
                    Array.isArray(parsed.boxes) &&
                    parsed.base && typeof parsed.base === 'object' &&
                    Number.isFinite(parsed.base.w) && Number.isFinite(parsed.base.h);
                if (okShape) {
                    finalCropRegions = cropRegions;
                } else {
                    logger.warn({ parsed: typeof parsed }, 'cropRegions shape invalid, ignored');
                }
            } catch {
                logger.warn('cropRegions not valid JSON, ignored');
            }
        }

        // 记录请求参数（不记录完整图片数据）
        logger.debug({
            hasQuestionText: !!questionText,
            questionTextLength: questionText?.length || 0,
            hasAnswerText: !!answerText,
            hasAnalysis: !!analysis,
            hasWrongAnswerText: !!wrongAnswerText,
            hasMistakeAnalysis: !!mistakeAnalysis,
            mistakeStatus,
            knowledgePointsCount: Array.isArray(knowledgePoints) ? knowledgePoints.length : 0,
            hasImage: !!originalImageUrl,
            imageSize: originalImageUrl?.length || 0,
            notebookId,
            gradeSemester,
            paperLevel,
            source,
            inputMethod,
            cropRegionsLength: typeof cropRegions === 'string' ? cropRegions.length : 0,
        }, 'Request parameters received');

        // 查找用户
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
            logger.debug({ userId: user?.id, email: session.user.email }, 'User lookup result');
        } else {
            logger.warn('No session email found');
        }

        if (!user) {
            logger.warn({ sessionEmail: session?.user?.email }, 'User not found in DB');
            return unauthorized("No user found in DB");
        }

        // ========== 去重检查：2秒内同一用户提交相同题目视为重复 ==========
        const DEDUP_WINDOW_MS = 2000; // 2秒去重窗口
        const questionTextPrefix = questionText?.substring(0, 100) || ''; // 取前100字符比较

        if (questionTextPrefix) {
            const recentDuplicate = await prisma.errorItem.findFirst({
                where: {
                    userId: user.id,
                    questionText: {
                        startsWith: questionTextPrefix,
                    },
                    createdAt: {
                        gte: new Date(Date.now() - DEDUP_WINDOW_MS),
                    },
                },
                include: {
                    tags: true,
                },
            });

            if (recentDuplicate) {
                logger.info({
                    existingId: recentDuplicate.id,
                    userId: user.id,
                    timeDiff: Date.now() - recentDuplicate.createdAt.getTime()
                }, 'Duplicate submission detected within dedup window, returning existing record');

                return NextResponse.json({
                    ...recentDuplicate,
                    duplicate: true, // 标记为重复提交
                }, { status: 200 }); // 返回 200 而非 201
            }
        }

        // 计算年级
        let finalGradeSemester = gradeSemester;
        if (!finalGradeSemester && user.educationStage && user.enrollmentYear) {
            finalGradeSemester = calculateGrade(user.educationStage, user.enrollmentYear);
            logger.debug({ finalGradeSemester, educationStage: user.educationStage, enrollmentYear: user.enrollmentYear }, 'Grade calculated');
        }

        // 处理知识点标签
        const tagNames: string[] = Array.isArray(knowledgePoints) ? knowledgePoints : [];
        const tagConnections: { id: string }[] = [];

        // 学科：直接读 Notebook.subject（5.5）——不再从显示名反推
        const notebook = await prisma.notebook.findUnique({ where: { id: notebookId || '' } });
        const subjectKey = notebook?.subject || 'other';
        logger.debug({ notebookId, notebookName: notebook?.displayName, subjectKey }, 'Subject resolved from Notebook');

        // 处理每个标签
        for (const tagName of tagNames) {
            try {
                let tag = await prisma.knowledgeTag.findFirst({
                    where: {
                        name: tagName,
                        OR: [
                            { isSystem: true },
                            { userId: user.id },
                        ],
                    },
                });

                if (!tag) {
                    const parentId = await findParentTagIdForGrade(finalGradeSemester, subjectKey);
                    logger.debug({ tagName, parentId, subjectKey }, 'Creating new custom tag');

                    tag = await prisma.knowledgeTag.create({
                        data: {
                            name: tagName,
                            subject: subjectKey,
                            isSystem: false,
                            userId: user.id,
                            parentId: parentId,
                        },
                    });
                    logger.debug({ tagId: tag.id, tagName }, 'Custom tag created');
                } else {
                    logger.debug({ tagId: tag.id, tagName, isSystem: tag.isSystem }, 'Existing tag found');
                }

                tagConnections.push({ id: tag.id });
            } catch (tagError) {
                logger.error({ tagName, error: tagError }, 'Error processing tag');
                throw tagError;
            }
        }

        logger.info({ tagNames, tagConnectionsCount: tagConnections.length }, 'Creating ErrorItem with tags');

        // 生成题号（source）：若客户端未提供，则自动生成
        // 格式：<学科2字简拼> + <8位日期 YYYYMMDD> + <3位当日流水>
        let finalSource = typeof source === 'string' && source.trim() ? source.trim() : '';
        if (!finalSource) {
            const code = subjectKeyToCode(subjectKey);
            const dateStamp = formatDateStamp(new Date());
            const todayCount = await prisma.errorItem.count({
                where: {
                    userId: user.id,
                    createdAt: { gte: startOfToday() },
                },
            });
            finalSource = formatQuestionNo(code, dateStamp, todayCount + 1);
            logger.debug({ finalSource, code, dateStamp, todayCount }, 'Auto-generated question number (source)');
        }

        /**
         * 【2026-09-28】错题等级的**定级**（「默认复练 + 按错因派生」）。
         *
         * 优先级：人显式传的 > 按错因派生 > 录入默认（复练）。
         * ⚠️ 默认是 **review（复练）**，不是 deep —— "全默认深挖 = 平均用力"。
         * source 决定这颗等级以后还能不能被自动派生改写：
         *   manual / ai（人定过的）> derived（已派过一次，已落定）> default（还只是默认）
         * 见 `lib/manage-type.ts` 与二次设计《阅读入口》§6.2 / §6.3。
         */
        const category = normalizeMistakeCategory(mistakeCategory);
        /**
         * 【2026-10-03 修】**"未定"是个明确的选择，不能和"没传"混为一谈。**
         *
         * 原来写的是 `explicitType ?? suggestion?.type ?? MANAGE_TYPE_DEFAULT`，
         * 而 `normalizeManageType(null)` 的结果就是 `null` ⇒ 从校对页把下拉设成"未定"
         * （传 `null`）会被 `??` 当成"没传"，掉进兜底变成**复练** ——
         * 表现是"选了未定，存进去却是复练"。
         * 判据改成"**这个键到底传没传**"：传了就以它为准（含 `null` = 未定），
         * 没传才按"错因派生 → 录入默认"走（那是 L0/L1 的既有规则，不动）。
         */
        const hasExplicitType = Object.prototype.hasOwnProperty.call(body ?? {}, "manageType");
        const explicitType = hasExplicitType ? normalizeManageType(manageType) : undefined;
        const suggestion = category ? suggestManageType(category) : null;
        const finalManageType = hasExplicitType
            ? (explicitType ?? null) // 明确选了"未定"⇒ 落 null
            : (suggestion?.type ?? MANAGE_TYPE_DEFAULT);
        const finalManageSource = hasExplicitType
            ? (normalizeManageTypeSource(manageTypeSource) === 'ai' ? 'ai' : 'manual')
            : suggestion?.type
                ? 'derived'
                : 'default';

        // 创建错题记录
        try {
            /**
             * 【2026-10-10】新题要不要**直接挂到某道题下面**（他原稿里"拍照新增一道题并关联到题 A"）。
             *
             * ⚠️ 一律**挂到"主题"上**：传进来的若是**附题**，先往上追到它所属的主题 ——
             *    不变量是"深度只许一层"，不这么做库里就会出现"附题的附题"。
             * ⚠️ 认不出 / 不属于本人 / 已进回收箱 ⇒ **当没给**（既不报错、也不挡保存）——
             *    跟已经定好的 `cropRegions` 同一条原则：题都录好了，不该因为一个附加关系存不下去。
             */
            let parentIdForCreate: string | null = null;
            if (typeof parentId === "string" && parentId.trim()) {
                try {
                    const anchor = await resolveOwnedItem(user.id, parentId);
                    if (anchor) {
                        const nodes: LinkNode[] = await loadLinkNodes(user.id, [anchor.id]);
                        const root = rootOf(nodes, anchor.id);
                        parentIdForCreate = root ? root.id : anchor.id;
                    }
                } catch (error) {
                    logger.error({ error }, 'Failed to resolve link parent on create');
                }
            }

            const errorItem = await prisma.errorItem.create({
                data: {
                    userId: user.id,
                    notebookId: notebookId || undefined,
                    originalImageUrl,
                    questionText,
                    answerText,
                    analysis,
                    // ⚠️ Q4/G6：错误解答原文已弃用，保留列但**停止写入**（错答看原图）
                    mistakeAnalysis: mistakeAnalysis || null,
                    mistakeStatus: normalizeMistakeStatusForSave(mistakeStatus, wrongAnswerText),
                    knowledgePoints: JSON.stringify(tagNames),
                    gradeSemester: finalGradeSemester,
                    paperLevel: paperLevel,
                    // 【2026-09-28】错因（受控枚举）+ 错题等级 + 来源
                    mistakeCategory: category,
                    manageType: finalManageType,
                    manageTypeSource: finalManageSource,
                    /**
                     * 【2026-10-03】**初定级**（一次性）：深挖 ⇒ 白银(2)、复练 ⇒ 青铜(1)。
                     * 他拍板："初定只是一次性行为，之后靠调整既可。"
                     * ⚠️ 只在这里定一次 —— 之后的升降全靠 `lib/level-linkage.ts`
                     *    （类型切换 ±1、复习结果按规则加减），别在别处再"按类型重算等级"。
                     */
                    attention: initialLevelForManageType(finalManageType),
                    source: finalSource,
                    inputMethod: inputMethod || null,
                    // 【M1】框坐标：undefined（没传/形状不对）时**不写这一列**，
                    // 保持 Prisma 的"未涉及字段不改"语义 —— 详情页改题干重存时不会把原坐标抹掉。
                    cropRegions: finalCropRegions,
                    masteryLevel: 0,
                    /** 【2026-10-10】建的时候就挂上去（不传 = 孤题，与以前一样） */
                    parentId: parentIdForCreate,
                    tags: {
                        connect: tagConnections,
                    },
                },
                include: {
                    tags: true,
                },
            });

            logger.info({ errorItemId: errorItem.id, tagsCount: errorItem.tags?.length || 0 }, 'ErrorItem created successfully');

            // 注：按用户要求，保存错题时**不再自动导出**到 Obsidian（避免每次保存都写盘）。
            //     需要导出时走错题详情页的「导出到 ob」按钮，即 /api/error-items/[id]/export-obsidian。

            return NextResponse.json(errorItem, { status: 201 });
        } catch (dbError) {
            logger.error({
                error: dbError,
                userId: user.id,
                notebookId,
                tagConnectionsCount: tagConnections.length
            }, 'Database error creating ErrorItem');
            throw dbError;
        }
    } catch (error) {
        logger.error({
            error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined
        }, 'Error saving item');
        return internalError("Failed to save error item");
    }
}
