/**
 * 【2026-10-15 新】**每日等级结算** —— 把"时间"这件事推进一步。
 *
 * 设计原文：`docs\14_等级语义改造v2_完整设计_20261015.md` 第五节。
 * 规则本身在 `lib/level-settle.ts`（纯函数）；**本文件只负责"读库 / 加锁 / 写库"**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一、为什么需要"结算"这件事
 *   等级要**随时间自动升档**（剩 7 天⇒4 档、剩 1 天⇒5 档），而"时间自己走"
 *   没有任何用户操作来触发 ⇒ 必须有人定期把倒数天数往下推。
 *
 * 二、**触发方式是"惰性"的**（不做定时任务）
 *   每次有人打开错题本 ⇒ 调一次 `maybeSettleDaily()`，它自己判断"今天结算过没有"。
 *   空空 2026-10-15 定的理由：**可移植性优先** —— 宿主 crontab / 调度容器都绑在 NAS 上，
 *   换 NAS 就得重配。惰性触发全在应用里，换到哪都能跑。
 *
 * 三、**幂等靠"减数"，不靠"减 1"**
 *   `减数 = 今天 − lastSettledOn`，再用它去减每题的倒数
 *   ⇒ **漏跑 3 天，减数就是 3，一次补上**；"每天减 1"漏一天就永久错且不自愈。
 *
 * 四、**五条硬要求**（docs\14 §5.4，逐条落在下面）
 *   ① "算减数 + 扣减 + 写结算日"**在同一个事务里** —— 否则断电会出现"等级更新了但
 *      日期没写" ⇒ 下次重复扣；
 *   ② **一个事务批量提交**（不许逐条提交）—— 实测：逐条在 NAS 上要 30~100 秒，
 *      批量不到 1 秒。**这是能不能用的分界线**；
 *   ③ **跳过三类冻结题** —— 已掌握 / 预掌握 / **归档本里的题**；
 *   ④ **加一把锁**（`runningSince`）—— 防"同时打开两个页面触发两次"；
 *   ⑤ **不阻塞用户打开页面** —— 结算很快（见 ②），调用方 await 即可，
 *      但要**吞掉异常**：结算失败绝不能让"打开错题本"失败。
 */

import { dayKey, parseDayKey } from './calendar-grid';
import { planSettlement } from './level-settle';
import { createLogger } from './logger';
import { prisma } from './prisma';

const logger = createLogger('lib:daily-settle');

/**
 * **陈锁阈值**：`runningSince` 早于"现在 − 这个时长"就视为**失效锁**，允许后来者接管。
 *
 * ⚠️ 为什么必须有：进程被杀 / 容器重启时 `finally` 不会执行 ⇒ 锁会**永久留在库里**，
 *    那样谁也结算不了，而且**不会有任何报错**（正是本项目最怕的"静默失效"）。
 */
const STALE_LOCK_MS = 10 * 60 * 1000;

export interface SettleResult {
    /** 这次真的跑了结算吗 */
    ran: boolean;
    /** 没跑的原因（跑成功了就没有） */
    reason?: 'already-settled-today' | 'locked' | 'error';
    /** 这次初始化了几道老数据（`levelCountdown` 从 NULL 补上） */
    initialized: number;
    /** 这次倒数往前推了几道 */
    advanced: number;
}

/** 两个"日键"之间差几天（本地日，遵守项目的时区铁律） */
export function daysBetween(fromKey: string, toKey: string): number {
    const a = parseDayKey(fromKey);
    const b = parseDayKey(toKey);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    // 用 Math.round 而不是整除：跨夏令时的"一天"可能是 23 或 25 小时
    return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** `YYYY-MM-DD` 且是**真日期**（挡掉 `2026-13-45` 这种形状对但不存在的东西） */
export function isValidDayKey(key: unknown): key is string {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
    const d = parseDayKey(key);
    if (Number.isNaN(d.getTime())) return false;
    // parseDayKey 会把 2026-13-45 归一成别的月份 ⇒ 回写一遍比对
    return dayKey(d) === key;
}

/**
 * **把客户端传来的"今天"变成可信的"今天"**（`docs\14` 第六节的时区方案）。
 *
 * 为什么要让客户端传：**浏览器天生知道用户在哪个时区**，不用问用户、也不用做设置项。
 * 服务端自己的时钟跟着**服务器**走（容器默认 UTC），跨时区就不对了。
 *
 * ⚠️ **保险**：客户端传的日键与**服务器日期相差超过 1 天**时，一律用服务器日期。
 *    理由：这是单机家用软件、没有对抗性，但**日期被传歪会让结算乱套**
 *    （比如传了个未来日期 ⇒ 减数变成几十天 ⇒ 等级集体跳档）。差 ≤1 天是正常时区差，
 *    超过就不是时区问题而是脏数据了。
 */
export function normalizeTodayKey(raw: unknown, now: Date = new Date()): string {
    const serverKey = dayKey(now);
    if (!isValidDayKey(raw)) return serverKey;
    if (Math.abs(daysBetween(serverKey, raw)) > 1) return serverKey;
    return raw;
}

/**
 * **结算入口**：如果"今天还没结算过"就跑一次，否则什么都不做。
 *
 * @param userId   结算哪个用户（`DailySettle` 是一个用户一行）
 * @param todayKey  "今天"的日键 `YYYY-MM-DD`。
 *                  ⚠️ **不传就用服务器时钟**（容器跑 UTC ⇒ 北京 00:00–08:00 会算成前一天）。
 *                  客户端能传就传（见 `docs\14` 第六节）—— 那是"时区铁律"的正解。
 *
 * ⚠️ **本函数从不抛异常** —— 结算失败绝不能让"打开错题本"失败（硬要求 ⑤）。
 */
export async function maybeSettleDaily(userId: string, todayKey?: string): Promise<SettleResult> {
    const today = todayKey ?? dayKey(new Date());
    let lockTaken = false;

    try {
        const state = await prisma.dailySettle.findUnique({ where: { userId } });

        // 上次结算日：没有记录 ⇒ 首次，把"今天"当基准（减数 = 0，只做初始化）
        const lastKey = state?.lastSettledOn ?? today;
        const daysElapsed = daysBetween(lastKey, today);

        // 今天已经结算过 ⇒ 直接返回（绝大多数请求走这条，开销只有一次查询）
        if (state && daysElapsed <= 0) {
            return { ran: false, reason: 'already-settled-today', initialized: 0, advanced: 0 };
        }

        // ---- 硬要求 ④：拿锁（原子操作，防止并发触发）----
        if (state) {
            const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
            const locked = await prisma.dailySettle.updateMany({
                where: {
                    userId,
                    OR: [{ runningSince: null }, { runningSince: { lt: staleBefore } }],
                },
                data: { runningSince: new Date() },
            });
            if (locked.count === 0) {
                logger.info({ userId }, 'Daily settle skipped — another run is in progress');
                return { ran: false, reason: 'locked', initialized: 0, advanced: 0 };
            }
        } else {
            // 首次：create 本身就带"主键唯一"这道锁，并发时只有一个能成功
            try {
                await prisma.dailySettle.create({
                    data: { userId, lastSettledOn: lastKey, runningSince: new Date() },
                });
            } catch {
                return { ran: false, reason: 'locked', initialized: 0, advanced: 0 };
            }
        }
        lockTaken = true;

        // ---- 硬要求 ③：只取"未掌握 + 本未归档"的题 ----
        // 已在 SQL 里排掉两类冻结（已掌握、归档本），`planSettlement` 内部再兜一层
        // （还挡"预掌握"）。两道防线是有意的：查询漏了不会静默改活冻结题。
        const items = await prisma.errorItem.findMany({
            where: {
                userId,
                deletedAt: null,
                masteryLevel: { lt: 2 },
                OR: [{ notebookId: null }, { notebook: { is: { archiveStatus: { not: 'archived' } } } }],
            },
            select: {
                id: true,
                reviewOutcomes: true,
                attention: true,
                levelCountdown: true,
                masteryLevel: true,
            },
        });

        const changes = planSettlement(items, daysElapsed);
        const initialized = changes.filter((c) => c.initialized).length;
        const advanced = changes.length - initialized;

        /**
         * ---- 硬要求 ① + ②：**一个事务、批量提交** ----
         *
         * ⚠️ 为什么必须批量：SQLite 每次提交都要 fsync 落盘。
         *    逐条提交 = N 次 fsync；批量 = 1 次。真真实测（5000 题）：
         *    逐条 41ms（内存库、无 fsync）⇒ 换成 NAS 的机械盘约 **30~100 秒**；
         *    批量 11ms ⇒ **不到 1 秒**。差 30~100 倍，是"能不能用"的分界线。
         *
         * ⚠️ 为什么"改等级"和"写结算日"必须在同一个事务：否则断电会出现
         *    "等级更新了但结算日没写" ⇒ 下次结算**重复扣**（等级莫名跳快）。
         *
         * ⚠️ 规模：这条 `$transaction([...])` 会把所有变更打包成一次提交。
         *    花生一个人的题量（几百道）毫无压力；真到 5000+ 且每天都跨档时，
         *    再考虑按批分片（那时要额外处理"分片间失败"的一致性，先不做）。
         */
        const settleRow = prisma.dailySettle.update({
            where: { userId },
            data: { lastSettledOn: today, runningSince: null },
        });

        if (changes.length > 0) {
            await prisma.$transaction([
                ...changes.map((c) =>
                    prisma.errorItem.update({
                        where: { id: c.id },
                        data: { levelCountdown: c.levelCountdown, attention: c.attention },
                    }),
                ),
                settleRow,
            ]);
        } else {
            await prisma.$transaction([settleRow]);
        }
        lockTaken = false; // 事务里已经把锁清了

        logger.info(
            { userId, today, daysElapsed, total: items.length, initialized, advanced },
            'Daily settle done',
        );
        return { ran: true, initialized, advanced };
    } catch (error) {
        logger.error({ error, userId, today }, 'Daily settle failed (ignored — must not break the page)');
        return { ran: false, reason: 'error', initialized: 0, advanced: 0 };
    } finally {
        // 兜底放锁：只有"拿了锁但没走到事务"才会走到这里（比如查询抛异常）
        if (lockTaken) {
            try {
                await prisma.dailySettle.update({ where: { userId }, data: { runningSince: null } });
            } catch (error) {
                logger.error({ error, userId }, 'Failed to release daily settle lock (will auto-expire)');
            }
        }
    }
}
