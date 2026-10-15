import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { normalizeMistakeCategory } from "@/lib/mistake-category";
import { normalizeReviewOutcomes, serializeReviewOutcomes } from "@/lib/review-outcomes";
// 【2026-10-14】复习事件流水（第一步：双写）—— 唯一写入口在 lib/review-events.ts
import { parseReviewEventInput, recordReviewEvent } from "@/lib/review-events";
/**
 * 【2026-10-15】**等级完全交给系统** —— 规则在 `lib/level-settle.ts`（纯函数），
 * 结算在 `lib/daily-settle.ts`。本文件只用两个纯函数：
 *   · `planAfterReview`  —— 记下复习结果时，把「倒数天数 + 等级」一起写对；
 *   · `shouldAutoMaster` —— 连对 4 次 ⇒ 直接已掌握。
 *
 * ⚠️ 本文件**不再 import** `lib/level-linkage.ts` 的任何东西：
 *   `clampLevel` / `levelDeltaForTypeSwitch` / `computeLevelLinkage` / `serializeLevelEntry`
 *   均已不再调用（四处人工入口收回 + 类型切换脱钩）。
 *   函数体与单测都还留在那个文件里（那是当年规则的唯一记录，**别删**）。
 */
import { planAfterReview, shouldAutoMaster } from '@/lib/level-settle';
// 【2026-10-10】"已掌握"要过一遍题间从属关系规则（人工标记才断开关联、主题向下传播）
import type { LinkOp } from "@/lib/item-link";
import { applyLinkOps, applyMastery, loadLinkView, planMasteryChange } from "@/lib/item-link-store";
import {
    canAutoRewrite,
    normalizeManageType,
    normalizeManageTypeSource,
    suggestManageType,
} from "@/lib/manage-type";

const logger = createLogger('api:error-items:id');

export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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

        const errorItem = await prisma.errorItem.findUnique({
            where: {
                id: id,
            },
            include: {
                notebook: true,
                tags: true, // 包含标签关联
            },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        // Ensure the user owns this item
        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to access this item");
        }

        /**
         * 【2026-10-10】把"这道题在从属关系里的样子"一起带回去（主题 / 附题 / 可否恢复）。
         * 在这里读而不是让页面再发一次请求：详情页一打开就要它，两次往返纯属浪费；
         * 而且**角色是这道题的属性**，跟这条记录一起给最不容易对不上。
         */
        const link = await loadLinkView(user.id, errorItem.id);

        return NextResponse.json({ ...errorItem, link });
    } catch (error) {
        logger.error({ error }, 'Error fetching item');
        return internalError("Failed to fetch error item");
    }
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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
        const {
            knowledgePoints, gradeSemester, paperLevel, questionText, answerText, analysis,
            notebookId, wrongAnswerText, mistakeAnalysis, mistakeStatus,
            // 【custom-v28】批量里「重新分析已录入的题」时会带上新图（很可能重新裁过）。
            // 旧实现不收这个字段 —— 于是题目文本换成新的、原图还是旧的，图文对不上。
            // 注意：这里**不接受 source（题号）**，题号必须保持不变，见下方 updateData。
            originalImageUrl,
            // 【M1】框坐标。与 POST 同一套规矩：**形状不对当没提供**，不拒存整条更新。
            cropRegions,
            // ===== 状态字段（5.3 单一事实来源）=====
            attention,        // ⚠️【2026-10-15】已**不再写入**，收到只记一条 warn 日志（等级归系统管）
            masteryLevel,     // 0 New / 1 Reviewing / 2 Mastered（=2 即四分法「已掌握」）
            userNotes,        // 备注（扫码「跳转原题备注」用）
            // 【2026-09-28】错题等级（deep/review）与错因受控枚举。
            // manageType 由人直接改 ⇒ 记 source = 'manual'（落定，之后自动派生不再碰它）；
            // 传 manageTypeSource='ai' 表示"采纳了 AI 建议"，同样算落定。
            manageType,
            manageTypeSource,
            mistakeCategory,
            /**
             * 【2026-09-30】复习结果四圆点（详情页直接改，改即存）。
             * 收 JSON 字符串或对象，一律**过一遍 `normalizeReviewOutcomes` 再落库** ——
             * 结构不乱、也不留非法值（"right"/"wrong"/null 三态，别的一律当没结果）。
             */
            reviewOutcomes,
            /**
             * 【2026-10-14】复习事件流水（**第一步：双写**）。
             *
             * ⚠️ 为什么必须**显式传**、不从 `reviewOutcomes` 的前后差分推：
             *    `planned` + `last` 两个字段**没有时间戳** ⇒ "三格满了之后又对一次"
             *    与"三格全对（就是三次）"在数据上长得一模一样，差分**认不出来**
             *    （见 `review-status.ts` 文件头那段 ⚠️⚠️）。
             *    ⇒ 写入侧必须自己声明"这是一次复习"，本字段就是那个声明。
             *
             * 形状：`{ occurredOn: 'YYYY-MM-DD', outcome: 'right'|'wrong',
             *          plannedIndex?: 0|1|2|3, volumeId?: string }`
             * 形状不对 ⇒ **当没传**（与本文件其他可选字段同一条规矩）。
             */
            reviewEvent,
            /**
             * 【2026-10-01】「深挖了还没印」提醒**手动按掉**（详情页双击那个计数）。
             * 只接受布尔值；非布尔当没传（改属性接口不替调用方做主）。
             */
            deepNudgeDismissed,
        } = body;

        const errorItem = await prisma.errorItem.findUnique({
            where: { id },
            include: { notebook: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to update this item");
        }

        // 构建更新数据
        const updateData: Prisma.ErrorItemUpdateInput = {};
        if (gradeSemester !== undefined) updateData.gradeSemester = gradeSemester;
        if (paperLevel !== undefined) updateData.paperLevel = paperLevel;
        if (questionText !== undefined) updateData.questionText = questionText;
        // 【custom-v28】重新分析时确实换过图（重新裁 / 重新擦）才更新原图；
        // 空串视为「不动」，免得手滑把原图清掉。
        // 题号 source 不在可更新字段里 —— 重新分析永远不改题号、不新增记录。
        if (originalImageUrl !== undefined && originalImageUrl !== '') {
            updateData.originalImageUrl = originalImageUrl;
        }
        /**
         * 【M1】框坐标。只有**形状像一份坐标**才写；否则当成"没提到这个字段"。
         * 与原图同理：不能让它把库里已有的坐标冲成空 ——
         * 详情页改个备注不该顺手把净版弄没。
         */
        if (typeof cropRegions === 'string' && cropRegions.trim()) {
            try {
                const parsed = JSON.parse(cropRegions);
                const okShape =
                    parsed && typeof parsed === 'object' &&
                    Array.isArray(parsed.boxes) &&
                    parsed.base && typeof parsed.base === 'object' &&
                    Number.isFinite(parsed.base.w) && Number.isFinite(parsed.base.h);
                if (okShape) updateData.cropRegions = cropRegions;
            } catch {
                // 坏 JSON 当没传，不动库里的旧值
            }
        }
        if (answerText !== undefined) updateData.answerText = answerText;
        if (analysis !== undefined) updateData.analysis = analysis;
        // ⚠️ Q4/G6：wrongAnswerText 已弃用，保留列但**不再写入**（仅接收用于推算 mistakeStatus）
        if (mistakeAnalysis !== undefined) updateData.mistakeAnalysis = mistakeAnalysis || null;
        if (userNotes !== undefined) updateData.userNotes = userNotes || null;

        /**
         * 【2026-09-30】复习结果：**整包覆盖**（它的形状本身就是"这四个位置各是什么"）。
         * 空值（null / 空串）当"没提供"，不把已有的结果抹掉 —— 与 cropRegions 同一条规矩：
         * 详情页改个备注，不该顺手把她的复习记录清空。
         */
        if (reviewOutcomes !== undefined && reviewOutcomes !== null && reviewOutcomes !== '') {
            updateData.reviewOutcomes = serializeReviewOutcomes(normalizeReviewOutcomes(reviewOutcomes));
        }

        /**
         * 【2026-10-15 新】记下复习结果 ⇒ **同时把「倒数天数」与「等级」写对**。
         *
         * ── 为什么在"录入这一刻"就要写等级，而不是等每日结算 ────────────────
         *   规则是"**等级 = 由倒数 + 连对次数决定**"（`lib/level-settle.ts`）。
         *   若录入只写倒数、不改等级，库里就会出现"**倒数是 7 但等级还是 5**"
         *   这种自相矛盾的状态。⇒ 录入时把两者**一起**写对，结算只负责"时间往前推"。
         *
         * ⚠️ 形状不对 / 空值**不进这段**（上面已经过滤），所以这里只看 `updateData`。
         * ⚠️ 幂等：同一份表单重复提交 ⇒ 算出来的值一模一样，不会漂。
         */
        let autoMastered = false;
        if (typeof updateData.reviewOutcomes === 'string') {
            const next = planAfterReview(updateData.reviewOutcomes);
            updateData.levelCountdown = next.levelCountdown;
            updateData.attention = next.attention;
            // 连对 4 次 ⇒ 直接已掌握（下面再落，见"等级 1 的出口"那段注释）
            autoMastered = shouldAutoMaster(updateData.reviewOutcomes);
        }

        /**
         * ⚠️⚠️【2026-10-15 **停止接受**】`attention`（等级）不再允许由调用方写入。
         *
         * 空空 2026-10-15 定：**等级完全交给系统，用户不再干涉**。
         *   原来的规矩是"传了合法值 ⇒ 人工直接定级，自动加减让位"（人工 > 自动）。
         *   现在**四处 UI 入口全部收回**（错题卡图标 / 详情页下拉 / 扫码面板 / 分析页）
         *   ⇒ 这个入参留着只会变成"后门"，索性一起关掉。
         *
         * ⚠️ **调用方仍传 `attention` 不报错，但会被忽略** —— 故意不报错：
         *    万一有没改到的老调用方，不该因此让"改题"整个失败（与 `reviewEvent` 同一条规矩）。
         *    但**会打一条 warn 日志**：日志里若出现 `Ignored attention`，说明还有调用方没清干净。
         *
         * 📌 等级的唯一来源 = **每日结算**（见 `docs\14_等级语义改造v2_完整设计_20261015.md` 第五节，待落地）。
         * 📌 恢复办法：`git revert` 这个提交。
         */
        if (attention !== undefined && attention !== null) {
            logger.warn(
                { errorItemId: id, attention },
                'Ignored attention from request — level is system-managed since 2026-10-15',
            );
        }

        // 掌握状态：0=New / 1=Reviewing / 2=Mastered（=2 即四分法「已掌握」，扫码「已会」写此位）
        if (masteryLevel !== undefined) {
            const m = Number(masteryLevel);
            if (Number.isFinite(m) && m >= 0 && m <= 2) {
                updateData.masteryLevel = Math.round(m);
            }
        }

        /**
         * 【2026-10-10】点"已掌握"要**过一遍从属关系规则**（`lib/item-link.ts`）。
         *
         * ── 为什么必须走规则，而不是直接改这个数字 ──────────────────────────
         * 他定的两条（2026-10-10 拍板）：
         *   · **人工**把**附题**标已掌握 ⇒ 它**断开**与主题的关联（变孤题），但**能一键恢复**；
         *   · **主题**标已掌握 ⇒ 名下所有附题**跟着标已掌握**，而**关系一动不动**
         *     （他原稿里"附题已掌握就断开"与"主题传播"会打架，讨论后定案：
         *      **只有人工标记才断开**，传播来的不算 —— 否则点一次主题就把整棵树拆了）。
         * 这个接口正是"人点的那个地方"（界面上的已掌握按钮打的就是它），所以 `manual: true`。
         *
         * ⚠️ 只有**值真的变了**才算一次：同一份表单重复提交不该反复触发断开。
         * ⚠️ 断开/传播都不是"顺手"的事：留痕在 `applyLinkOps` / `applyMastery` 里写。
         */
        let linkOps: LinkOp[] = [];
        let masteryPropagate: string[] = [];
        let linkNote = '';
        if (typeof updateData.masteryLevel === 'number') {
            try {
                /**
                 * ⚠️ 这段**抽到 `planMasteryChange` 里了**，与 `PATCH .../mastery`
                 * （卡片与详情页那个按钮打的路由）共用同一份 —— 两处各写一遍迟早不一致。
                 * 它内部自己会判"值没变就什么都不做"。
                 */
                const plan = await planMasteryChange(user.id, id, updateData.masteryLevel === 2);
                linkOps = plan.ops;
                masteryPropagate = plan.propagateIds;
                linkNote = plan.message;
            } catch (error) {
                // 关系规则出问题**不该让"改掌握状态"整个失败**，但必须被看见
                logger.error({ error, itemId: id }, 'Failed to plan item link on mastery change');
            }
        }

        /**
         * 【2026-09-28】错题等级 + 错因 —— 「派生 + 落定快照」的落点。
         *
         * 规矩（详见 `lib/manage-type.ts` 与二次设计《阅读入口》§6.3）：
         *   ① 人**显式**传了 manageType ⇒ 落定为 manual（传 manageTypeSource='ai' 则记 ai）；
         *      **落定之后自动派生不再碰它**。
         *   ② 只传了错因（mistakeCategory）⇒ 若这道题的等级**还没落定**
         *      （source 为空 / 只是录入默认），按映射表派生一次并标 derived；
         *      已落定的保持不动 —— 错因以后变了，**已定类型不变**（要改走手动）。
         *   ③ 每次真改动都写 StateChangeLog（谁改的、从什么改成什么）。
         */
        const stateLogs: Prisma.StateChangeLogCreateManyInput[] = [];

        /**
         * 【2026-10-15 新】**连对 4 次 ⇒ 直接已掌握**（等级 1 的出口之一）。
         *
         * 空空 2026-10-15 原话：*"等级 1 期间又练对了一次（连对 4 次），直接已掌握，
         *   我们的目的就是 4 次已掌握，如果连做 4 次连对 4 次，那就是已掌握，没问题。"*
         *
         * ⚠️ **故意不走 `planMasteryChange`** —— 那条路是"**人工**标记"的规则
         *    （硬编码 `manual: true`，会把**附题与主题断开**）。自动判定**不是人工动作**，
         *    不该拆关系。所以这里**只改掌握位，关系一动不动**。
         *    ⇒ 代价：主题被自动标已掌握时，名下附题**不会跟着标**。
         *      这是有意的（每道题按自己的复习史判），将来若要传播再单独议。
         *
         * ⚠️ **位置有讲究**：必须在"从属关系规则"那段**之后**（否则会被它当人工标记处理），
         *    也必须在 `stateLogs` 声明**之后**（否则 TDZ 报错）。
         * ⚠️ 只在"现在还不是已掌握"时才写（避免无谓的状态变更日志）。
         */
        if (autoMastered && Number(errorItem.masteryLevel) < 2) {
            updateData.masteryLevel = 2;
            stateLogs.push({
                errorItemId: id,
                field: 'masteryLevel',
                fromValue: String(errorItem.masteryLevel ?? 0),
                toValue: '2',
                actor: 'system',
                actorUserId: user.id,
                note: '连对 4 次 ⇒ 系统判定已掌握',
            });
        }

        if (mistakeCategory !== undefined) {
            const nextCategory = normalizeMistakeCategory(mistakeCategory);
            if ((errorItem.mistakeCategory ?? null) !== nextCategory) {
                updateData.mistakeCategory = nextCategory;
                stateLogs.push({
                    errorItemId: id,
                    field: 'mistakeCategory',
                    fromValue: errorItem.mistakeCategory ?? null,
                    toValue: nextCategory,
                    actor: 'user',
                    actorUserId: user.id,
                    note: '详情页修改错因',
                });
            }

            // ② 还没落定 ⇒ 派生一次
            const locked = !canAutoRewrite(errorItem.manageTypeSource);
            if (!locked && nextCategory !== null) {
                const suggestion = suggestManageType(nextCategory);
                if (suggestion.type && suggestion.type !== errorItem.manageType) {
                    updateData.manageType = suggestion.type;
                    updateData.manageTypeSource = 'derived';
                    stateLogs.push({
                        errorItemId: id,
                        field: 'manageType',
                        fromValue: errorItem.manageType ?? null,
                        toValue: suggestion.type,
                        actor: 'system',
                        actorUserId: user.id,
                        note: `按错因自动定：${suggestion.reason}`,
                    });
                }
            }
        }

        // 人显式改「类型」（深挖/复练/未定）⇒ 落定（手动 / 采纳 AI 建议）
        // ⚠️【2026-10-15】这里**不再牵动等级** —— 原来改类型会 ±1 级，现已脱钩。
        if (manageType !== undefined) {
            const nextType = normalizeManageType(manageType);
            const fromAi = normalizeManageTypeSource(manageTypeSource) === 'ai';
            if ((errorItem.manageType ?? null) !== nextType) {
                updateData.manageType = nextType;
                // 清成"未定"时来源也一并清空（避免"未定但来源写着手动"这种自相矛盾）
                updateData.manageTypeSource = nextType ? (fromAi ? 'ai' : 'manual') : null;
                /**
                 * 【2026-10-01】类型一变，把「深挖了还没印」的**按掉标记复位**。
                 * 理由：按掉表示"这次提醒我知道了"；类型又动过（比如 深挖→复练→深挖）
                 * 就是新一轮了，该提醒还是要提醒 —— 否则"我按掉过一次"就永久失效。
                 */
                updateData.deepNudgeDismissed = false;
                stateLogs.push({
                    errorItemId: id,
                    field: 'manageType',
                    fromValue: errorItem.manageType ?? null,
                    toValue: nextType,
                    actor: fromAi ? 'ai' : 'user',
                    actorUserId: user.id,
                    note: fromAi ? '采纳 AI 建议' : '手动定级',
                });
            }
        }

        /**
         * 【2026-10-01】手动按掉提醒。**放在类型处理之后**：
         * 若同一次请求里既改了类型又传了这个标记，以调用方显式给的为准
         * （列表页"点一下变深挖"只传类型 ⇒ 走上面的复位；详情页双击只传本标记 ⇒ 走这里）。
         */
        if (typeof deepNudgeDismissed === 'boolean') {
            updateData.deepNudgeDismissed = deepNudgeDismissed;
        }

        /**
         * ⚠️⚠️【2026-10-15 **整段停用**】等级不再由"事件记账"改动。
         *
         * ── 这一段的来历（三步走，都记在这儿免得后人不解）──
         *   2026-10-03 立：等级 = "人工定级 + 类型切换 ±1 + 复习结果按组合加减"（事件记账）。
         *   2026-10-15 缩：**复习结果联动**整段删掉（规则缺第 4 档、语义还是反的、还会顺手清账本）。
         *   2026-10-15 再缩（**本次**）：**类型切换 ±1 也停掉**。
         *
         * ── 为什么连"类型切换 ±1"也停 ──
         *   空空 2026-10-15 定：**等级完全交给系统，用户不再干涉**。
         *   而"复练 ⇄ 深挖 ⇒ ±1"也是**人动的手在改等级** ⇒ 留着它，"收回系统管理"就是半拉子。
         *   同时他给了理由：*"复练、深挖是对一道题怎么练习、用什么纸的记录项……
         *   纸型和紧迫程度联系不是那么紧密。"* ⇒ **等级与纸型脱钩**。
         *
         * ── 于是"等级"现在有几个来源？**一个都没有** ──
         *   ① 录入初定级：已改成**一律 5**（见 `api/error-items/route.ts`）；
         *   ② 类型切换 ±1：**本次停用**（就是这里）；
         *   ③ 人工点图标 / 详情页下拉 / 扫码面板 / 分析页：**四处 UI 入口已全部收回**；
         *   ④ API 的 `attention` 入参：**本次停用**（见下面 `hasExplicitAttention` 那段）。
         *   ⇒ **等级的唯一来源 = 每日结算**（`docs\14` 第五节，待落地）。
         *
         * ── 被保留的（都不改等级）──
         *   · `manageType`（深挖/复练）本身照旧能改 —— 只是**不再牵动等级**；
         *   · `stateLogs` 照旧记 manageType 等字段的变化。
         *
         * 📌 `clampLevel` / `levelDeltaForTypeSwitch` / `computeLevelLinkage` 与它们的单测
         *    **一个字没删** —— 那是他当年定的规则的**唯一记录**，将来一起决定去留。
         *    要临时恢复：`git revert` 这个提交即可。
         *
         * ⚠️ 与 `lib/review-status.ts` 的关系：那个模块算的**紧迫度 1-5** 才是等级的正确来源
         *    （"题上只记事实，'会不会'每次现算"）。本次不动它，只把"人工入口"关掉。
         */

        if (notebookId !== undefined) {
            if (notebookId === "") {
                updateData.notebook = { disconnect: true };
            } else {
                // 验证目标错题本存在且属于该用户
                const targetNotebook = await prisma.notebook.findUnique({ where: { id: notebookId } });
                if (!targetNotebook || targetNotebook.userId !== user.id) {
                    return forbidden("Not authorized to move to this notebook");
                }
                updateData.notebook = { connect: { id: notebookId } };
            }
        }
        if (mistakeStatus !== undefined || wrongAnswerText !== undefined || mistakeAnalysis !== undefined) {
            const nextWrongAnswerText = wrongAnswerText !== undefined ? wrongAnswerText : errorItem.wrongAnswerText;
            const nextMistakeAnalysis = mistakeAnalysis !== undefined ? mistakeAnalysis : errorItem.mistakeAnalysis;
            updateData.mistakeStatus = normalizeMistakeStatusForSave(
                mistakeStatus,
                nextWrongAnswerText
            );
        }

        // 处理 knowledgePoints (标签)
        if (knowledgePoints !== undefined) {
            const tagNames: string[] = Array.isArray(knowledgePoints)
                ? knowledgePoints
                : typeof knowledgePoints === 'string'
                    ? JSON.parse(knowledgePoints)
                    : [];

            // 学科：直接读 Notebook.subject（5.5），不再从名字猜
            // 若本次请求同时换了本，则以新本为准；否则用原题所属本
            let subjectKey = errorItem.notebook?.subject || 'other';
            if (notebookId !== undefined && notebookId !== '') {
                const nb = await prisma.notebook.findUnique({ where: { id: notebookId } });
                if (nb?.subject) subjectKey = nb.subject;
            } else if (notebookId === '') {
                subjectKey = 'other';
            }

            const tagConnections: { id: string }[] = [];
            for (const tagName of tagNames) {
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
                    // Determine grade context for the new tag
                    // Use the incoming gradeSemester (priority) or the existing one on the item
                    const contextGrade = gradeSemester !== undefined ? gradeSemester : errorItem.gradeSemester;

                    const parentId = await findParentTagIdForGrade(contextGrade, subjectKey);

                    tag = await prisma.knowledgeTag.create({
                        data: {
                            name: tagName,
                            subject: subjectKey,
                            isSystem: false,
                            userId: user.id,
                            parentId: parentId, // Link to Grade node
                        },
                    });
                }
                tagConnections.push({ id: tag.id });
            }

            // 更新标签关联: 先断开所有，再连接新的
            updateData.tags = {
                set: [], // 先清空
                connect: tagConnections,
            };

            // 保留旧字段兼容
            updateData.knowledgePoints = JSON.stringify(tagNames);
        }

        logger.info({ id }, 'Updating error item');

        const updated = await prisma.errorItem.update({
            where: { id },
            data: updateData,
            include: { tags: true, notebook: true },
        });

        /**
         * 【2026-10-14】复习事件流水（**第一步：双写**）。
         *
         * ⚠️ **失败不影响主更新** —— 与下面 `stateLogs` 同一条规矩：
         *    这一步只是"开始攒带时间戳的数据"，攒不上不该让"改题"失败
         *    （主更新已经把 `reviewOutcomes` 写进去了，读侧行为一切照旧）。
         */
        if (reviewEvent !== undefined && reviewEvent !== null) {
            const ev = parseReviewEventInput(reviewEvent);
            if (ev) {
                try {
                    await recordReviewEvent({
                        userId: user.id,
                        errorItemId: id,
                        occurredOn: ev.occurredOn,
                        outcome: ev.outcome,
                        plannedIndex: ev.plannedIndex ?? null,
                        volumeId: ev.volumeId ?? null,
                    });
                } catch (error) {
                    logger.error({ error, id }, 'Failed to record review event');
                }
            }
        }

        // 【2026-09-28】等级/错因的变更留痕（「派生 + 落定快照」要求可追溯）
        if (stateLogs.length > 0) {
            try {
                await prisma.stateChangeLog.createMany({ data: stateLogs });
            } catch (error) {
                // 留痕失败不该让整次保存失败 —— 但它必须被看见
                logger.error({ error, itemId: id }, 'Failed to write state change logs');
            }
        }

        /**
         * 【2026-10-10】把上一步算好的从属关系改动落地（断开 / 向附题传播）。
         * 放在主更新**之后**：主字段先写成功，再动关系 —— 关系那步失败也不会让
         * "已掌握"这个主操作回滚（它会记 error 日志，界面上的字段仍然是对的）。
         */
        if (linkOps.length > 0) {
            try {
                await applyLinkOps(user.id, linkOps);
            } catch (error) {
                logger.error({ error, itemId: id }, 'Failed to apply link ops on mastery change');
            }
        }
        if (masteryPropagate.length > 0) {
            try {
                await applyMastery(user.id, masteryPropagate, updateData.masteryLevel === 2);
            } catch (error) {
                logger.error({ error, itemId: id }, 'Failed to propagate mastery to children');
            }
        }

        // 注：按用户要求，保存错题时**不再自动导出**到 Obsidian。
        //     需要导出时走错题详情页的「导出到 ob」按钮（本文件的 export-obsidian 路由）。

        /** `linkNote` 只是"这次顺带发生了什么"的一句人话，界面可选地弹一下；没有就不加这个键 */
        return NextResponse.json(linkNote ? { ...updated, linkNote } : updated);
    } catch (error) {
        logger.error({ error }, 'Error updating item');
        return internalError("Failed to update error item");
    }
}

/**
 * PATCH /api/error-items/[id]
 * 动作型更新，不覆盖字段，只做自增/置位：
 *  - { action: "redo" }  复做计次 +1（H1 不闭环，仅计次 / T7）
 *  - { action: "restore" } 从回收箱还原（H2 / T2）
 */
export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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

        const errorItem = await prisma.errorItem.findUnique({
            where: { id },
            select: { id: true, userId: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to update this item");
        }

        const body = await req.json().catch(() => ({}));
        const action = String(body?.action || "");

        const updateData: Prisma.ErrorItemUpdateInput = {};
        if (action === "redo") {
            updateData.redoCount = { increment: 1 };
        } else if (action === "restore") {
            updateData.deletedAt = null;
        } else {
            return badRequest("Unknown action. Supported: redo | restore");
        }

        const updated = await prisma.errorItem.update({
            where: { id },
            data: updateData,
            include: { tags: true, notebook: true },
        });

        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error patching item');
        return internalError("Failed to patch error item");
    }
}

/**
 * DELETE /api/error-items/[id]
 * 软删进回收箱（H2 / T2）。带 ?hard=1 才彻底删除。
 * 回收箱内的题再删一次必须走 hard=1 —— 前端负责传，服务端不替用户决定。
 */
export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
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

        const { searchParams } = new URL(req.url);
        const hard = searchParams.get("hard") === "1";

        const errorItem = await prisma.errorItem.findUnique({
            where: { id },
            select: { id: true, userId: true, deletedAt: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to delete this item");
        }

        if (hard) {
            await prisma.errorItem.delete({ where: { id } });
            logger.info({ id }, 'Error item permanently deleted');
            return NextResponse.json({ id, permanent: true });
        }

        const updated = await prisma.errorItem.update({
            where: { id },
            data: { deletedAt: new Date() },
        });

        logger.info({ id, alreadyInTrash: !!errorItem.deletedAt }, 'Error item moved to trash');
        return NextResponse.json({ id, deletedAt: updated.deletedAt, permanent: false });
    } catch (error) {
        logger.error({ error }, 'Error deleting item');
        return internalError("Failed to delete error item");
    }
}
