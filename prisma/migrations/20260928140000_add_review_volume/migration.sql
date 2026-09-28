-- 【T2/T3 · 2026-09-28】卷（复练卷 RE… / 积累卷 BU…）
--
-- 保守迁移：**只新建两张表**，不碰任何老表、不改任何老列。
-- 因此对现网数据是零风险：即使这一版镜像回滚，多出来的两张空表也无害。
--
-- 设计要点（详见 prisma/schema.prisma 里的注释）：
--   · ReviewVolume      = 一张卷（卷号 / 类型 / 学期 / 页数 / 默认留白行数）
--   · ReviewVolumeItem  = 卷里的一道题，**几乎全是快照**
--     （题号 / 题干 / 题图 / 等级 / 留白行数），这样题被删被改都不会
--     把"印出去的那张卷"改得面目全非；errorItemId 只是软链接，可空。

-- CreateTable
CREATE TABLE "ReviewVolume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "volumeNo" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "semester" TEXT NOT NULL,
    "gradeSemester" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "defaultBlankLines" INTEGER NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReviewVolumeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "volumeId" TEXT NOT NULL,
    "seqInVolume" INTEGER NOT NULL,
    "pageIndex" INTEGER NOT NULL,
    "columnIndex" INTEGER NOT NULL DEFAULT 0,
    "seqInColumn" INTEGER NOT NULL DEFAULT 1,
    "errorItemId" TEXT,
    "itemNo" TEXT,
    "questionText" TEXT,
    "figureUrls" TEXT,
    "manageType" TEXT,
    "blankLines" INTEGER NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewVolumeItem_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "ReviewVolume" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewVolumeItem_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewVolume_volumeNo_key" ON "ReviewVolume"("volumeNo");

-- CreateIndex
CREATE INDEX "ReviewVolume_kind_createdAt_idx" ON "ReviewVolume"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewVolume_semester_idx" ON "ReviewVolume"("semester");

-- CreateIndex
CREATE INDEX "ReviewVolumeItem_volumeId_idx" ON "ReviewVolumeItem"("volumeId");

-- CreateIndex
CREATE INDEX "ReviewVolumeItem_errorItemId_idx" ON "ReviewVolumeItem"("errorItemId");
