-- 【M0 · 2026-09-24】纸面回流链的数据底座（设计依据：打印版面结论 P19–P25）
--
-- 本次迁移**只增不改不删**：新增 4 张表 + 2 张表各加若干列，现有行一律不动。
--
-- ⚠️ 关于 ReviewSchedule：Prisma 默认生成的脚本会**重建整表**
-- （CREATE new_ → INSERT SELECT → DROP → RENAME）。语义上不丢数据，
-- 但生产库里是孩子真实的错题记录，重建表是不必要的风险。
-- SQLite 支持直接 ADD COLUMN（带非 NULL 默认值即可），故此处改写为三句 ALTER。
-- 迁移历史与 schema 的一致性已用 `prisma migrate diff --from-migrations` 复核通过。

-- 1. ErrorItem：AI 统一打标的错因分类（受控枚举；刻意与 errorType 分开存）
ALTER TABLE "ErrorItem" ADD COLUMN "mistakeCategory" TEXT;

-- 2. ReviewSchedule：轮次（R14 的第 0/7/21 天三次）+ 溯源到具体哪张纸
ALTER TABLE "ReviewSchedule" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ReviewSchedule" ADD COLUMN "printJobId" TEXT;
ALTER TABLE "ReviewSchedule" ADD COLUMN "scanReturnId" TEXT;

-- 3. PrintBatch：一次交付 = 一批（R4：hill 的动作永远可分批）
CREATE TABLE "PrintBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "hasReplyPage" BOOLEAN NOT NULL DEFAULT false,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "printedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrintBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 4. PrintJob：一道题每被打印一次一条（二维码里的"打印实例"层）
CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "errorItemId" TEXT NOT NULL,
    "questionNo" TEXT NOT NULL,
    "instanceNo" INTEGER NOT NULL,
    "paperType" TEXT NOT NULL DEFAULT 'T1',
    "stage" TEXT NOT NULL DEFAULT 'initial',
    "batchId" TEXT,
    "printedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'printed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PrintJob_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PrintJob_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PrintBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- 5. ScanReturn：扫描回来的一面纸（P25：两面各印一码，按面分别入库）
CREATE TABLE "ScanReturn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "printJobId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "ocrText" TEXT,
    "scannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aiVerdict" TEXT,
    "aiPayload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScanReturn_printJobId_fkey" FOREIGN KEY ("printJobId") REFERENCES "PrintJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 6. StateChangeLog：状态变更日志（R15：记状态变更，不记学习行为）
CREATE TABLE "StateChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "errorItemId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "actor" TEXT NOT NULL,
    "actorUserId" TEXT,
    "printJobId" TEXT,
    "scanReturnId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StateChangeLog_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 7. 索引
CREATE INDEX "ReviewSchedule_errorItemId_round_idx" ON "ReviewSchedule"("errorItemId", "round");
CREATE INDEX "ReviewSchedule_scheduledFor_idx" ON "ReviewSchedule"("scheduledFor");
CREATE INDEX "PrintBatch_userId_printedAt_idx" ON "PrintBatch"("userId", "printedAt");
CREATE INDEX "PrintJob_batchId_idx" ON "PrintJob"("batchId");
CREATE INDEX "PrintJob_status_idx" ON "PrintJob"("status");
-- 同一题的同一个实例号只能有一条：这道唯一约束正是"重印不会静默覆盖"的物理保证
CREATE UNIQUE INDEX "PrintJob_errorItemId_instanceNo_key" ON "PrintJob"("errorItemId", "instanceNo");
CREATE INDEX "ScanReturn_printJobId_idx" ON "ScanReturn"("printJobId");
-- 同一实例的同一面只能有一条：重复扫到同一面时撞约束报错，而不是静默覆盖（P25.5）
CREATE UNIQUE INDEX "ScanReturn_printJobId_side_key" ON "ScanReturn"("printJobId", "side");
CREATE INDEX "StateChangeLog_errorItemId_createdAt_idx" ON "StateChangeLog"("errorItemId", "createdAt");
CREATE INDEX "StateChangeLog_actor_createdAt_idx" ON "StateChangeLog"("actor", "createdAt");
