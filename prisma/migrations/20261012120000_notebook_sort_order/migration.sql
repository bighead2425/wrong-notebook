-- 【2026-10-12】错题本卡片可以**手工拖动排序**了 —— 只加一列 sortOrder
--
-- 他 2026-10-12 需求第 6 / 12 条：
--   · 「我的错题本」里**在用的本**可以拖动排顺序；
--   · **已归档的本**先按年级分组（年级倒序的"文件夹"），**同年级组内**还能拖，
--     但不许跨年级拖（跨组 = 越权，见 `notebooks/page.tsx` 的落点判定）。
--
-- 形状：`sortOrder` = 手工排的位次（同一个用户、同一种归档状态、同一个年级组里比大小）。
--   · 默认 0 = "还没手工排过"。排序键是 `sortOrder ASC, createdAt DESC`：
--     全是 0 的老数据 ⇒ 完全退回今天的行为（新的在前），**老用户看不出任何变化**；
--   · 新建的本也是 0 ⇒ 排在最前（与今天"新建的在最前"一致）；
--   · 用户拖过一次之后，本组内的 sortOrder 被重写成 0..n-1（整组一起写，见
--     `POST /api/notebooks/reorder`）—— 不做"两两交换"，因为交换在**跨组**、
--     跨归档状态时会互相踩（同一个人可能有两组都从 0 开始）。
--
-- ⚠️ 纯 ADD COLUMN（不重建表）：本项目迁移惯例如此，SQLite 重建整张表风险远大于收益。
ALTER TABLE "Notebook" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- 列表查询就是"某个用户的某一类本，按 sortOrder 排" ⇒ 给它一个联合索引
CREATE INDEX "Notebook_userId_archiveStatus_sortOrder_idx" ON "Notebook"("userId", "archiveStatus", "sortOrder");
