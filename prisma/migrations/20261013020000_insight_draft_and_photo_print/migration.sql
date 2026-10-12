-- 【2026-10-13】日积月累录入页要的两样东西
--
-- ① `Insight.status` —— **暂存 / 正式**。他第 4 条原话：
--    "点击暂存后目前这一条日积月累直接暂存入数据库，
--     在日积月累·管理页中用标识标出等待后续整理（或删除）。"
--    ⇒ 默认 `'final'`（**老数据全是正式内容**，语义正好），
--      列表 / 打印 / 内阁默认都**不收草稿**，只有管理页带 `?drafts=1` 才看得到。
--
-- ② `InsightPhoto.includedInPrint` —— **"入版"开关**（他第 6 条）：
--    组成积累纸时这张图跟不跟着进去。默认 `1`（true）= 跟；
--    关掉 ⇒ 这条只留文字，图仍在库里（不是删除）。
--
-- ⚠️ 纯 ADD COLUMN（本项目迁移惯例）：SQLite 重建整张表风险远大于收益。
ALTER TABLE "Insight" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'final';

ALTER TABLE "InsightPhoto" ADD COLUMN "includedInPrint" BOOLEAN NOT NULL DEFAULT 1;

-- 列表默认按 (userId, status) 过滤
CREATE INDEX "Insight_userId_status_idx" ON "Insight"("userId", "status");
