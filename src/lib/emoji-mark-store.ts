import { prisma } from './prisma';
import { pickRandomEmoji } from './emoji-mark';

/**
 * 【2026-10-03 需求第 10 条】**惰性生成并写回**纸张的随机 emoji 标识。
 *
 * 为什么单独一个文件：卷（复练/积累）与深挖题两条链都要"为空则补一个"，
 * 逻辑一模一样 —— 各写一遍迟早分叉（一边写回、一边只返回不落库这种最难查）。
 *
 * 规则（他定的）：只在**为空**时随机一个并写库；已有值**直接用**。
 * 这正是"同一份纸的符号相对不变、不同纸可以用同一个"。
 */

/** 拿到卷的 emoji：为空就随机一个写回，返回最终值 */
export async function ensureVolumeEmojiMark(volume: {
    id: string;
    emojiMark: string | null;
}): Promise<string> {
    if (volume.emojiMark) return volume.emojiMark;
    const mark = pickRandomEmoji();
    await prisma.reviewVolume.update({ where: { id: volume.id }, data: { emojiMark: mark } });
    return mark;
}

/**
 * 拿到一批题的深挖纸 emoji：为空就各自补一个，返回 `题 id → 符号`。
 * ⚠️ 只动**属于这个用户**的题（与 mark-printed 同一道闸）。
 */
export async function ensureErrorItemEmojiMarks(
    userId: string,
    ids: string[],
): Promise<Record<string, string>> {
    if (ids.length === 0) return {};

    const items = await prisma.errorItem.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true, emojiMark: true },
    });

    const result: Record<string, string> = {};
    await Promise.all(
        items.map(async (item) => {
            if (item.emojiMark) {
                result[item.id] = item.emojiMark;
                return;
            }
            const mark = pickRandomEmoji();
            await prisma.errorItem.update({ where: { id: item.id }, data: { emojiMark: mark } });
            result[item.id] = mark;
        }),
    );
    return result;
}
