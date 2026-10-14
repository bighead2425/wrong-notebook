-- 【2026-10-14】复习事件流水表 —— 把"复习成绩卡片"换成"流水账"
--
-- 背景（详见 docs\09_review_events改造方案.md）：
--   老的 `ErrorItem.reviewOutcomes` 是"一张只有四个空格的卡片" ——
--   `{"planned":[3 格],"last":1 格}`，**只有结果、没有日期**。两个后遗症：
--     ① 不知道"上次复习是哪天" ⇒ "建议下次"只能按**今天**起算；
--     ② 三个格满了之后再来一次**认不出来** ⇒ `RETIRE_STREAK` 只能取 3（想要 4）。
--   本表一次复习一行、带日期 ⇒ 上面两条都能解决。
--
-- ⚠️ 第一步只做**双写**（老的 `reviewOutcomes` 照旧写）⇒ 读侧行为一字不变、随时可回滚。
--    切读源是第二步的事。
--
-- ⚠️ `occurredOn` 是 `YYYY-MM-DD` 字符串，**不是 DateTime** —— 遵守项目"时区铁律"：
--    容器跑 UTC，"哪一天"必须由**客户端**算好再传进来。
--
-- ⚠️ 建的是**新表**（不涉及重建现有表）⇒ 可以正常落 FOREIGN KEY；
--    与"给老表加列不落 FK"那条惯例不冲突（见 20261010190000_item_link 的注释）。
--
-- ⚠️ 刻意**不加** (errorItemId, occurredOn) 唯一约束：同一天可能因补录产生多条，
--    宁可多记一笔流水，也不要为了"唯一"而丢数据。
--
-- 老数据：**无需回填** —— 新表初始为空，从上线起开始积累（项目里还没有真实题库数据）。

CREATE TABLE "ReviewEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "errorItemId" TEXT NOT NULL,
    "occurredOn" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "plannedIndex" INTEGER,
    "volumeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewEvent_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 主查询：某道题的事件流（按日期排）—— 状态机与"建议下次"都要走它
CREATE INDEX "ReviewEvent_userId_errorItemId_occurredOn_idx" ON "ReviewEvent"("userId", "errorItemId", "occurredOn");

-- 反查：这道题有哪些事件（不带 userId 时的兜底）
CREATE INDEX "ReviewEvent_errorItemId_occurredOn_idx" ON "ReviewEvent"("errorItemId", "occurredOn");
