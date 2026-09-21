import { describe, it, expect } from "vitest";
import {
    createBurstSession,
    noteBurstShot,
    noteBurstResult,
    burstDone,
} from "@/lib/burst-session";

/** 造一个假的「照片」当 File 用（这一层只关心"哪几张失败了"） */
function fakeFile(name: string): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
}

describe("burst-session · 连拍转存的一轮账", () => {
    /**
     * 【回归测试】custom-v31 的实测 bug：拍 1 张点「完成」，提示「已转存 0 张」。
     *
     * 根因是最后一张的记账被 `closed` 挡住了。这里把「按下快门 → 收工 → 出账」
     * 的真实顺序原样走一遍，锁死这个数必须是 1。
     */
    it("最后一张（收工那一张）照样要记账：拍 1 张就该是 1 张", () => {
        const s = createBurstSession();
        noteBurstShot(s);          // 按下快门
        s.closed = true;           // 用户紧接着点了「完成」
        const touchUi = noteBurstResult(s, true, fakeFile("a.jpg"));

        expect(s.saved).toBe(1);
        expect(burstDone(s)).toBe(1);
        // 已收尾的一轮不必再刷进度界面，交给结算那一步统一交代
        expect(touchUi).toBe(false);
    });

    it("拍 2 张点完成 → 2 张（不是 1 张）", () => {
        const s = createBurstSession();
        noteBurstShot(s);
        expect(noteBurstResult(s, true, fakeFile("a.jpg"))).toBe(true);
        noteBurstShot(s);
        s.closed = true;
        noteBurstResult(s, true, fakeFile("b.jpg"));

        expect(s.saved).toBe(2);
        expect(s.total).toBe(2);
    });

    it("收工后那张上传失败 → 必须进 failed（否则照片会凭空消失）", () => {
        const s = createBurstSession();
        noteBurstShot(s);
        s.closed = true;
        noteBurstResult(s, false, fakeFile("bad.jpg"));

        expect(s.saved).toBe(0);
        expect(s.failed.map(f => f.name)).toEqual(["bad.jpg"]);
        expect(burstDone(s)).toBe(1);
    });

    it("没收工时：正常记账并允许刷新界面", () => {
        const s = createBurstSession();
        noteBurstShot(s);
        expect(noteBurstResult(s, true, fakeFile("a.jpg"))).toBe(true);
        noteBurstShot(s);
        expect(noteBurstResult(s, false, fakeFile("b.jpg"))).toBe(true);

        expect(s.saved).toBe(1);
        expect(s.failed.map(f => f.name)).toEqual(["b.jpg"]);
        expect(burstDone(s)).toBe(2);
        expect(burstDone(s)).toBe(s.total);
    });
});
