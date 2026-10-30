/**
 * 难度推断 —— 「这题她本来就不会 / 会但费劲 / 轻松」
 *
 * 【2026-10-30】为什么要有这一层、以及为什么**不让她填**：
 *
 *   「本来就不会」和「会了只是错了」是两件完全不同的事——
 *   前者要讲，后者练熟就行。系统现在分不出，所以经常拿"该讲的题"去"练"。
 *
 *   但让一个五年级孩子回想"当时轻松还是吃力"，是二次判断：
 *   记忆已经模糊，而且她还要额外承担系统管理的负担（空空的明确要求）。
 *
 *   ⇒ **从行为里推，不问她。** 她自己都不知道的事，不必逼她回答。
 *
 * ⚠️ 红线：推断结果**只给系统看**。
 *    不给她看、不上纸、不进任何界面文案——一旦她知道"系统判定我不会"，
 *    就会变成自我实现的标签。
 */

import { prisma } from '@/lib/prisma';

/** 三档。含义是"这件事对她有多难"，不是题目的客观难度。 */
export type InferredDifficulty = 'easy' | 'hard' | 'fail';

export type InferenceConfidence = 'high' | 'medium';

export interface DifficultyInference {
    level: InferredDifficulty;
    confidence: InferenceConfidence;
    /** 判断依据（一句话），用于排查"凭什么这么判" */
    evidence: string[];
}

/**
 * 纯函数：只看结果序列（**按时间倒序**：最新在前）。
 *
 * 抽出来是为了能单测——查库那层只负责把数据按顺序喂进来。
 */
export function inferFromOutcomes(outcomes: string[]): DifficultyInference | null {
    if (outcomes.length === 0) return null;

    // ① 连续错 ≥2 ⇒ 不会（高置信）
    let streakWrong = 0;
    for (const o of outcomes) {
        if (o === 'wrong') streakWrong += 1;
        else break;
    }
    if (streakWrong >= 2) {
        return { level: 'fail', confidence: 'high', evidence: [`连续错 ${streakWrong} 次`] };
    }

    const last = outcomes[0];
    const hadWrong = outcomes.includes('wrong');

    // ② 错过之后做对了 ⇒ 吃力（高置信）
    if (last === 'right' && hadWrong) {
        return { level: 'hard', confidence: 'high', evidence: ['错过之后做对了'] };
    }

    // ③ 一次就做对 ⇒ 轻松（中置信；也可能是题简单）
    if (last === 'right' && !hadWrong) {
        return { level: 'easy', confidence: 'medium', evidence: ['第一次就做对'] };
    }

    // ④ 最近一次错、但还没连着错两次 ⇒ 吃力（中置信，不下"不会"的结论）
    return { level: 'hard', confidence: 'medium', evidence: ['最近一次错，还没再次做对'] };
}

/**
 * 查库版本：取该题最近 10 次复习结果，交给纯函数判断。
 *
 * 没有任何复习记录时返回 null —— **不猜**。
 * 「刚录进来还没做过」和「不会」是两件事，混为一谈会让新题全被判成不会。
 */
export async function inferDifficulty(errorItemId: string): Promise<DifficultyInference | null> {
    const events = await prisma.reviewEvent.findMany({
        where: { errorItemId },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        take: 10,
        select: { outcome: true },
    });

    return inferFromOutcomes(events.map((e) => e.outcome));
}
