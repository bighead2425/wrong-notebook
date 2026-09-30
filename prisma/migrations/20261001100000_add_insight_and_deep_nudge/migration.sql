-- 【2026-10-01】两件事合一个迁移：
--   ① `ErrorItem.deepNudgeDismissed`（「深挖了还没印」提醒的手动按掉标记）
--   ② 新表 `Insight`（日积月累）
--
-- ① 保守迁移：**只加一列**、带默认值 false ⇒ 老题读出来就是"没按掉过"。
--    提醒条件（类型=deep 且 printCount=0 且 本列为 false）由 `lib/manage-type.ts`
--    的 `needsDeepPrintNudge()` 一处判定，界面两边共用。
--
-- ② 新表：日积月累自成一类内容（积累点背后可以没有错题行），
--    所以是**新表**而不是往 ErrorItem 上加字段。
--    编号 JLyyyymmddxxx：日期段由客户端算（容器跑 UTC）、当日流水号服务端发。
--    `errorItemId` 用 ON DELETE SET NULL —— 题被彻底删掉时**条目要留着**，
--    只把链断掉（积累是"从这道题攒下的话"，话本身不该跟着题一起消失）。
--    `insights` 表名照 Prisma 默认（模型名即表名）。

ALTER TABLE "ErrorItem" ADD COLUMN "deepNudgeDismissed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Insight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "gradeSemester" TEXT,
    "subject" TEXT,
    "content" TEXT,
    "photoUrl" TEXT,
    "errorItemId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Insight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Insight_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Insight_userId_code_key" ON "Insight"("userId", "code");
CREATE UNIQUE INDEX "Insight_userId_dateKey_seq_key" ON "Insight"("userId", "dateKey", "seq");
CREATE INDEX "Insight_userId_createdAt_idx" ON "Insight"("userId", "createdAt");
CREATE INDEX "Insight_errorItemId_idx" ON "Insight"("errorItemId");
