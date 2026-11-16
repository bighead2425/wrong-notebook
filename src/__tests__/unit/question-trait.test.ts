import { describe, expect, it } from "vitest";
import { isCountingQuestion } from "@/lib/question-trait";

/**
 * 【2026-11-16】**计数题的识别规则，钉住两件事：**
 *
 * 1. 真正的计数题要认出来（漏判就失去提醒的意义）
 * 2. **普通应用题不能误判**（误判会让提示失去可信度）
 *
 * 第 2 条比第 1 条更重要 —— 满屏黄条等于没有提示。
 */
describe("isCountingQuestion", () => {
    it("方格纸估算面积（真实题面）→ true", () => {
        const text =
            "王芳在写字时，不小心将墨水瓶碰倒了，墨水洒在了方格纸上（如图）。" +
            "选择你喜欢的方法估算墨水覆盖区域的面积，写出估算过程。（每个小方格的边长表示 1 cm）";
        expect(isCountingQuestion(text)).toBe(true);
    });

    it("数一数图中有几个三角形 → true", () => {
        expect(isCountingQuestion("数一数图中有几个三角形。")).toBe(true);
    });

    it("普通应用题「还剩几个」→ false（宽泛词不能匹配）", () => {
        expect(isCountingQuestion("小明买了 3 个苹果，吃了 1 个，还剩几个？")).toBe(false);
    });

    it("普通计算题 → false", () => {
        expect(isCountingQuestion("计算 26.73 − 12.5 的值。")).toBe(false);
    });

    it("空题干 → false（没做过 AI 分析的题不该弹提示）", () => {
        expect(isCountingQuestion(null)).toBe(false);
        expect(isCountingQuestion("")).toBe(false);
        expect(isCountingQuestion(undefined)).toBe(false);
    });
});
