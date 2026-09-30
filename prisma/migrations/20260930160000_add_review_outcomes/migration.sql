-- 【2026-09-30】复习结果四圆点 + 错因枚举换代（6 值 → 8 值）
--
-- 他这一轮提了两件改数据结构的事，合在一个迁移里：
--
-- ① `ErrorItem.reviewOutcomes`（新列，可空）
--    错题卡底部四个圆圈的原材料：前三个 = 第 1/7/21 天三次**计划**复习的结果，
--    第四个 = **最近一次**复习的结果（计划内、计划外都算）。
--    形状是 JSON 字符串：{"planned":["right",null,null],"last":"wrong"}
--    可空 ⇒ 老题读出来就是"还没有任何结果"（四个灰圈），零风险。
--
-- ② `mistakeCategory` 的值域换代：旧的 6 个受控值 → 新的 8 个（分三组）
--    旧：concept / blank / no_method / missed_condition / computation / other
--    新：concept_vague / knowledge_gap / memory_weak / misread / calc_slip /
--        fixed_mindset / just_record / unknown_reason
--    这不是重新分类，是**同一件事换了个说法**，所以下面按语义一对一搬过去：
--      concept（概念不清）→ concept_vague（概念模糊）
--      blank（完全不会）  → knowledge_gap（知识盲区）
--      no_method（方法没想到）→ knowledge_gap（都是"不知道该用哪个知识点"）
--      missed_condition（看漏条件）→ misread（审题不清）
--      computation（算错写错）→ calc_slip（计算失误）
--      other（其他）      → unknown_reason（未知错因）
--    ⚠️ 转换放在迁移里、而不是靠代码兜底：库里留着旧值的话，
--       任何**按错因聚合**的查询（统计、导出）都会把同一件事算成两类。

ALTER TABLE "ErrorItem" ADD COLUMN "reviewOutcomes" TEXT;

UPDATE "ErrorItem"
SET "mistakeCategory" = CASE "mistakeCategory"
    WHEN 'concept' THEN 'concept_vague'
    WHEN 'blank' THEN 'knowledge_gap'
    WHEN 'no_method' THEN 'knowledge_gap'
    WHEN 'missed_condition' THEN 'misread'
    WHEN 'computation' THEN 'calc_slip'
    WHEN 'other' THEN 'unknown_reason'
    ELSE "mistakeCategory"
END
WHERE "mistakeCategory" IN (
    'concept', 'blank', 'no_method', 'missed_condition', 'computation', 'other'
);
