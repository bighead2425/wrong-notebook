import { describe, it, expect } from "vitest";
import { countWillBeLost, type QueueItemLike } from "@/lib/batch-queue";

/**
 * 【custom-v34】退出批量页的"会丢几张"判定。
 *
 * 这条规则被写错过一次，现场是这样：用户传 2 张照片、各裁出一道题，
 * 两道都成功入库后点「结束批量」，却仍然弹"还有 2 张没入库"——
 * 数进去的正是那 2 张"留着以便再拆一道"的待处理原图。
 * 下面第一条用例就是这次现场的原样复现。
 */

const pending = (treated = false): QueueItemLike => ({ processed: false, treated, status: "ready" });
const processedUnsaved = (treated = false): QueueItemLike => ({ processed: true, treated, status: "processed" });
const saved = (): QueueItemLike => ({ processed: true, status: "saved" });

describe("countWillBeLost", () => {
    it("【现场复现】2 张原图各裁一道、两道都入库 → 不该再报警", () => {
        const items: QueueItemLike[] = [
            pending(true),         // 原图 A，已被加工，留作备份
            pending(true),         // 原图 B，已被加工，留作备份
            saved(),               // A 裁出来的那道，已入库
            saved(),               // B 裁出来的那道，已入库
        ];
        expect(countWillBeLost(items)).toBe(0);
    });

    it("传了 2 张还没动的原图 → 就该报警（退出即丢）", () => {
        expect(countWillBeLost([pending(), pending()])).toBe(2);
    });

    it("原图加工过、但成品还没入库 → 报警的是成品那张，不是原图", () => {
        // 2 张：原图（备份，不算）+ 成品（没入库，算）
        expect(countWillBeLost([pending(true), processedUnsaved()])).toBe(1);
    });

    it("加工过但还没入库的成品，treated 标记不能把它放过", () => {
        // 预处理图编辑后也会被置 treated —— 只看 treated 会漏报，判据必须是 treated && !processed
        expect(countWillBeLost([processedUnsaved(true)])).toBe(1);
    });

    it("空队列不报警", () => {
        expect(countWillBeLost([])).toBe(0);
    });

    it("全部入库 → 不报警", () => {
        expect(countWillBeLost([saved(), saved()])).toBe(0);
    });
});
