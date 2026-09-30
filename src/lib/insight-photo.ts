/**
 * 【2026-10-01】日积月累配图的**读写**只在这里（一处实现）。
 *
 * 为什么图片单独一张表（存储改正，他拍板的）：正文是几 KB 的文字、图片是几百 KB 的 data URL，
 * 挤在同一行里 = "字典每一页都贴照片" —— 列表每次都被迫把所有照片搬进内存。
 * 分表之后主表查询完全不碰它。
 *
 * ⚠️ 一条积累**最多一张图**（他定的规则）⇒ `@@unique([insightId])`，写入就是"建或换"。
 */
import { prisma } from "@/lib/prisma";

/** null = 删图；字符串 = 建或换（data URL） */
export async function writePhoto(insightId: string, photo: string | null): Promise<void> {
    if (photo === null) {
        await prisma.insightPhoto.deleteMany({ where: { insightId } });
        return;
    }
    const existing = await prisma.insightPhoto.findUnique({ where: { insightId } });
    if (existing) {
        await prisma.insightPhoto.update({ where: { insightId }, data: { data: photo } });
    } else {
        await prisma.insightPhoto.create({ data: { insightId, data: photo } });
    }
}

/** 取一条积累的图片（没有就 null）。列表**不要**用它 —— 那会把照片全搬回来 */
export async function readPhoto(insightId: string): Promise<string | null> {
    const row = await prisma.insightPhoto.findUnique({
        where: { insightId },
        select: { data: true },
    });
    return row?.data ?? null;
}
