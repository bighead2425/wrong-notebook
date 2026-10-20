-- 【2026-10-20 真真】「建议深挖」的决定记录（空空第 6 条）
--
-- 只做一件事：建 `UpgradeDecision` 表。**不动任何已有表。**
--
-- ⚠️ 为什么手写、不用 `prisma migrate diff` 的输出：
--    仓库的迁移历史与 schema 之间有**早已存在**的漂移（`DROP INDEX ReviewVolumeItem_insightId_idx`
--    + `ErrorItem` 整表重建，用 HEAD 的 schema 跑也一样）。拿它当迁移会把一堆无关表重建塞进这一发。
--    详见 `HANDOFF.md` §④。
--
-- ⚠️ 为什么 `errorItemId` **不建外键**：
--    删题之后这里留一条没人引用的记录无害（判据按 id 查，查不到自然不出现）。
--    建外键就得在删题时级联清理一张"决定表"，为一条废记录付这份复杂度不划算。
--    语义见 `schema.prisma` 里 `UpgradeDecision` 的注释。

-- CreateTable
CREATE TABLE "UpgradeDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "errorItemId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'kept',
    "wrongCountAtDecision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UpgradeDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UpgradeDecision_userId_errorItemId_key" ON "UpgradeDecision"("userId", "errorItemId");

-- CreateIndex
CREATE INDEX "UpgradeDecision_userId_decision_idx" ON "UpgradeDecision"("userId", "decision");
