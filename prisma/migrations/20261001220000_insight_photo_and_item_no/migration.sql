-- 【2026-10-01】日积月累的"存储改正"（他拍板的三项之一）
--
-- 背景一句话：**条数不是问题，图片才是**。
--   上一版把拍照的图片（data URL，几百 KB）直接存进了 Insight 行里 ——
--   等于"字典每一页都贴了照片"：每次列表查询都被迫把所有照片一起搬进内存。
--   这一版把图片分到独立的 `InsightPhoto` 表，主表查询完全不碰它。
--
-- 同时把"相关错题"的钥匙从内部 id 换成**题号**：
--   ① 扫码/回录链路手里只有题号，按题号反查才能做到 **送两次不重复建**
--      （他在设计答复 20261001 第四节拍板：一题一条，题号当钥匙）；
--   ② 将来导出 Obsidian 双链，认的也是题号。
--
-- ⚠️ 老列（errorItemId / photoUrl）**保留不删**（SQLite 对带外键的列做 DROP 要重建整表，
--    风险大于收益；本项目对弃用列的惯例是"保留列、停止写入"，见 ErrorItem.wrongAnswerText）。
--    老数据先回填/搬家，之后新代码只写新列。

-- ① 图片搬家：Insight.photoUrl → InsightPhoto.data（有图的行才搬）
CREATE TABLE "InsightPhoto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "insightId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InsightPhoto_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "Insight" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "InsightPhoto" ("id", "insightId", "data", "createdAt")
SELECT lower(hex(randomblob(16))), "id", "photoUrl", "createdAt"
FROM "Insight"
WHERE "photoUrl" IS NOT NULL AND "photoUrl" != '';

CREATE UNIQUE INDEX "InsightPhoto_insightId_key" ON "InsightPhoto"("insightId");

-- ② 钥匙换成题号：先从老列回填（有依据 —— 题号就在它指的那道题上，不猜）
ALTER TABLE "Insight" ADD COLUMN "errorItemNo" TEXT;

UPDATE "Insight"
SET "errorItemNo" = (
    SELECT e."source" FROM "ErrorItem" e WHERE e."id" = "Insight"."errorItemId"
)
WHERE "errorItemId" IS NOT NULL;

-- ②b 保险：**万一**老数据里同一人同一题号已经有了多条（v58 的 Insight 没有这道约束，理论上可能），
--     直接建唯一索引会失败 ⇒ **迁移失败 ⇒ 容器起不来**。后果太大，先兜住：
--     只保留最新那条挂着题号，其余把题号**置空**（退化为"没关联错题"的普通条目），
--     **正文一条不删**（内容比关联重要）。cuid 的字典序≈时间序，用 MAX(id) 取最新那条。
UPDATE "Insight"
SET "errorItemNo" = NULL
WHERE "errorItemNo" IS NOT NULL
  AND "id" NOT IN (
      SELECT MAX("id") FROM "Insight"
      WHERE "errorItemNo" IS NOT NULL
      GROUP BY "userId", "errorItemNo"
  );

-- 一题一条（他定的规则）。
-- ⚠️ **不要用 SQLite 特有的部分索引（`WHERE "errorItemNo" IS NOT NULL`）**：
--    Prisma 的 schema 表达不了它 ⇒ 下次 `prisma migrate dev` 做 diff 时会把它当成"数据库里多余的索引"删掉。
--    普通复合唯一索引就够了 —— SQLite 在唯一索引里把 NULL 当成互不相同的值，
--    所以"没关联错题"的条目可以有很多条，"关联了某道题"的只能有一条（正是要的效果）。
--    必须带 userId：只按题号唯一的话，两个用户录到同一题号会互相撞。
-- 索引名与 Prisma 的约定保持一致（`<模型>_<字段1>_<字段2>_key`），否则会被判成 drift。
CREATE UNIQUE INDEX "Insight_userId_errorItemNo_key" ON "Insight"("userId", "errorItemNo");

-- ③ 来源标记（错题送 / 页面建 / 外部送）
ALTER TABLE "Insight" ADD COLUMN "source" TEXT;
