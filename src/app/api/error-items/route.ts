import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { calculateGrade } from "@/lib/grade-calculator";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { pickRandomEmoji } from "@/lib/emoji-mark";
/* 【2026-10-31】标签改成"按坐标解析"，不再按名字反查（见 lib/tag-resolve.ts） */
import { buildResolverIndex, resolveTagRefs, type ResolvedTag } from "@/lib/tag-resolve";
import type { TagRef } from "@/lib/ai/tag-ref";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { getAppConfig } from "@/lib/config";
import { enqueueRelocate } from "@/lib/ai/relocate-service";
import { normalizeMistakeCategory } from "@/lib/mistake-category";
import {
    MANAGE_TYPE_DEFAULT,
    normalizeManageType,
    normalizeManageTypeSource,
    suggestManageType,
} from "@/lib/manage-type";
import { subjectKeyToCode, formatDateStamp, formatQuestionNo, startOfToday } from "@/lib/question-no";
import { NEW_ITEM_ATTENTION } from "@/lib/attention-level";
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
            /**
             * 【2026-10-31】AI 交回的标签坐标（册/章/节/名）与偏离判据。
             * 没有这两个字段时退回旧行为（只按名字，唯一同名才认）。
             */
            knowledgeRefs,
            bookReason,
            /** 【2026-11-01 两段式】第一段给的 3 个考点短语（开关打开时才有） */
            keywords,
            /**
             * 【2026-11-01 两段式】第一段认出的**学科**（中文，如"数学"）。
             *
             * 为什么非要存它：库里 20% 的题**没挂本子**，而学科只从本子上取，
             * 于是第二段拿不到候选、归位必然失败。第一段本来就算出了学科，
             * 顺手记下来，归位时就能兜住。
             * 不落成独立列 —— 按用户要求"临时数据用完即清"，跟 keywords 放同一个 JSON。
             */
            subject,
            originalImageUrl,
            notebookId,
            gradeSemester,
            paperLevel,
            source,
            inputMethod,
            cropRegions,
            // 【2026-09-28】错题等级 + 错因受控枚举
            mistakeCategory,
            /** 【2026-10-30】'ai' | 'human'，缺省视为人确认 */
            mistakeCategorySource,
            manageType,
            manageTypeSource,
            /**
             * 【2026-10-10】可选：新题**直接挂到哪道题下面**（他在"扫到的这道题"页
             * 点【关联别的题】→【拍照新增并关联】时带上）。id 或题号都收。
             */
            parentId,
        } = body;

        /** 【2026-11-01 两段式】开关关着时，本文件的所有新增逻辑都不生效 */
        const twoStageEnabled = getAppConfig().twoStage?.enabled === true;

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
        /**
         * 【2026-10-30】**归类不了就放手，不要硬建一个爹都没有的标签。**
         *
         * 原来找不到父节点时 `parentId` 传 null，于是 `create` 出一个**根节点标签**——
         * 2026-10-30 查库：60 个自建标签**全部**是根节点，AI 标出来的"单位换算"
         * 和系统预设的"五年级"平级，树从此是平的。
         * 现在的规矩：解析不到父单元 ⇒ 不建，记进 unmatchedTags 回给前端。
         */
        const unmatchedTags: string[] = [];
        /** 每个标签是怎么命中的（path / book-name / legacy / none），落库供事后核算 */
        const tagResolution: ResolvedTag[] = [];

        // 学科：直接读 Notebook.subject（5.5）——不再从显示名反推
        const notebook = await prisma.notebook.findUnique({ where: { id: notebookId || '' } });
        const subjectKey = notebook?.subject || 'other';
        logger.debug({ notebookId, notebookName: notebook?.displayName, subjectKey }, 'Subject resolved from Notebook');

        /**
         * 【2026-10-31】**按坐标解析，不再按名字反查。**
         *
         * 名字不是唯一键（数学里 38 个知识点跨册重名），拿它 `findFirst` 必然撞车。
         * AI 现在会交回 `<kp book chapter section name/>`，这里按
         * 册+节+名 → 册+名 → 唯一同名 三级降级，每级记 matchedBy。
         *
         * ⚠️ 解析不到就**不建新节点**（连自定义标签也不建）——
         *    宁可进「待归类」由人补一次，也不要往册底下塞野节点。
         */
        const refs: TagRef[] = Array.isArray(knowledgeRefs) && knowledgeRefs.length > 0
            ? (knowledgeRefs as TagRef[])
            : tagNames.map((name) => ({ name, legacy: true } as TagRef));

        if (refs.length > 0) {
            const allTags = await prisma.knowledgeTag.findMany({
                where: {
                    subject: subjectKey,
                    OR: [
                        { isSystem: true },
                        { userId: user.id },
                    ],
                },
                select: { id: true, name: true, parentId: true },
            });

            const index = buildResolverIndex(allTags);
            for (const r of resolveTagRefs(refs, index, allTags)) {
                tagResolution.push(r);
                if (r.tagId) {
                    tagConnections.push({ id: r.tagId });
                } else {
                    unmatchedTags.push(r.name);
                }
            }

            if (unmatchedTags.length > 0) {
                logger.warn(
                    { unmatchedTags, subjectKey, bookReason },
                    'Some knowledge points could not be located; kept for manual confirm',
                );
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
        /** 只认这两个值；其余一律 null（不猜） */
        const categorySource: 'ai' | 'human' | null =
            mistakeCategorySource === 'ai' || mistakeCategorySource === 'human'
                ? mistakeCategorySource
                : category
                    ? 'human'
                    : null;
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
                    /* 【2026-10-31】标签怎么命中的、凭什么换册 —— 没有这两列，两周后无法核算 */
                    tagResolution: tagResolution.length ? JSON.stringify(tagResolution) : null,
                    tagDeviation:
                        typeof bookReason === 'string' && bookReason.trim()
                            ? bookReason.trim()
                            : null,
                    /**
                     * 【2026-11-01 两段式】开关打开时：
                     *   · 先把状态标成 pending（前端据此显示"正在归位…"）；
                     *   · 关键词暂存一列，第二段跑完立刻清空（中间数据，不积累）；
                     *   · 标签先不写（第一段本来就没选），等第二段落。
                     * 开关关着时，这两列都是 undefined，行为与以前完全一致。
                     *
                     * ⚠️ **用户在审核页自己选过标签 ⇒ 直接 done，不再归位。**
                     *    两段式下第一段不给标签，所以 `tagConnections` 非空基本就等于
                     *    "人已经动手了"。这时候再让第二段跑一遍，会用机器的结果覆盖人的选择 ——
                     *    人比机器可靠，这种覆盖是倒退。
                     */
                    ...(twoStageEnabled
                        ? tagConnections.length > 0
                            ? { tagStatus: 'done' }
                            : {
                                tagStatus: 'pending',
                                /**
                                 * 中间数据（第二段跑完立刻置 null）：
                                 *   · keywords —— 检索候选用
                                 *   · subject  —— 没挂本子时用来定学科（否则归位必失败）
                                 * 存成一个 JSON 而不是两个列：都是临时的，一起清。
                                 */
                                stage1Keywords: (() => {
                                    const kw = Array.isArray(keywords) ? keywords.slice(0, 3) : [];
                                    const sub = typeof subject === 'string' && subject.trim() ? subject.trim() : null;
                                    if (kw.length === 0 && !sub) return null;
                                    return JSON.stringify({ keywords: kw, subject: sub });
                                })(),
                            }
                        : {}),
                    gradeSemester: finalGradeSemester,
                    paperLevel: paperLevel,
                    // 【2026-09-28】错因（受控枚举）+ 错题等级 + 来源
                    mistakeCategory: category,
                    mistakeCategorySource: categorySource,
                    manageType: finalManageType,
                    manageTypeSource: finalManageSource,
                    /**
                     * 【2026-10-15 **改了**】新录入的题**一律 = 等级 5（🥗 S 此刻）**。
                     *
                     * ── 为什么改 ──
                     *   以前是"初定级：深挖 ⇒ 白银(2)、复练 ⇒ 青铜(1)"（`initialLevelForManageType`）。
                     *   但等级的含义已经变成"**紧迫度**"（越大越急），而**没练过的题当然最急**
                     *   ⇒ 初定级给 1 或 2 与模型直接打架。
                     *   同时空空 2026-10-15 定：**等级与"用哪张纸"脱钩**（"纸型和紧迫程度联系不是那么紧密"）。
                     *
                     * ⚠️ 深挖 / 复练 的初判**仍然照旧**（`finalManageType`，来自 AI 判作答过程或人工选），
                     *    只是**不再影响等级**。
                     * ⚠️ 常量从 `lib/attention-level.ts` 取，**不写死数字**（教训 #15）。
                     */
                    attention: NEW_ITEM_ATTENTION,
                    source: finalSource,
                    /**
                     * 【2026-10-20 空空第 2 条】**录入时就给 emoji**，与"发一个题号"同一个时刻。
                     *
                     * 他原话："不再是在生成深挖纸的时候才给一个 emoji 了，现在调整成只要有题录入，
                     *          就给一个 emoji，这个逻辑和每道题录入的时候都给一个题号一样。"
                     *
                     * 为什么：`emojiMark` 原来是**打开打印预览时惰性生成**的，
                     * ⇒ 没印过的题永远是空的，回录页/列表里全是 📄 兜底。
                     * 存量题仍有惰性兜底（`ensureErrorItemEmojiMarks`），新题从这里就有值。
                     */
                    emojiMark: pickRandomEmoji(),
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

            /**
             * 【2026-11-01 两段式】保存之后才跑第二段 —— 用户定的顺序：
             *   第一段全跑完 → 审核页 → 保存 → 这道题的第二段才开始。
             *
             *   · **串行**：按用户要求"一个一个来"，服务端同一时刻只跑一道（见 lib/ai/relocate-queue.ts）。
             *     批量保存 20 道不会同时打 20 个请求 —— 那只会一起撞限流。
             *   · 不 await、不阻塞响应：第二段要几十秒，等它的话点保存要转圈。
             *     失败会自己把 tagStatus 写成 'failed'，详情页给"重新归位"按钮。
             */
            /**
             * 【2026-11-01 两段式】串行队列的状态，回给前端。
             *
             * 批量保存时这条信息很要紧：他要知道"还有几道在排队"、
             * 以及**能不能关掉页面**（能 —— 队列在服务端跑，不在浏览器里）。
             */
            let relocate: { queued: boolean; position: number } | null = null;

            if (twoStageEnabled && tagConnections.length === 0) {
                const q = enqueueRelocate(errorItem.id);
                relocate = { queued: q.queued, position: q.position };
            }

            // 注：按用户要求，保存错题时**不再自动导出**到 Obsidian（避免每次保存都写盘）。
            //     需要导出时走错题详情页的「导出到 ob」按钮，即 /api/error-items/[id]/export-obsidian。

            /* 把"没能归类"的标签回给前端：他看得见，才知道词表缺哪块 */
            return NextResponse.json({ ...errorItem, unmatchedTags, relocate }, { status: 201 });
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
