-- 【2026-10-19 真真】日积月累 · 扫码建立的"参见"链接（空空第 4 条）
--
-- 只做一件事：建 `InsightLink` 表。**不动任何已有表。**
--
-- ⚠️ 为什么是手写的，不是 `prisma migrate dev` 生成的：
--    `migrate diff` 会把 `ErrorItem` 整表重建、还删一个 `ReviewVolumeItem` 索引 ——
--    那是**仓库里早就存在的迁移漂移**（用 HEAD 的 schema 跑 diff 也一样），
--    不是这次改动引入的。拿它当迁移会把一堆无关的表重建塞进这一发，
--    风险和收益完全不成比例。⇒ 只取"建 InsightLink"这一段。
--    漂移本身已记进 `HANDOFF.md` §④，留给下一棒单独处理。
--
-- 语义见 `schema.prisma` 里 `InsightLink` 的注释：当前这条 → 被扫到的那条，
-- 一条可以链多条；**不是父子树**。

-- CreateTable
CREATE TABLE "InsightLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InsightLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Insight" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InsightLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Insight" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "InsightLink_fromId_idx" ON "InsightLink"("fromId");

-- CreateIndex
CREATE INDEX "InsightLink_toId_idx" ON "InsightLink"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "InsightLink_fromId_toId_key" ON "InsightLink"("fromId", "toId");
