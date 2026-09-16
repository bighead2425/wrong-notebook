/*
  Warnings:

  - You are about to drop the `Subject` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `subjectId` on the `ErrorItem` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Subject_name_userId_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Subject";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Notebook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gradeStage" TEXT NOT NULL DEFAULT 'primary',
    "grade" TEXT NOT NULL DEFAULT '',
    "semester" TEXT NOT NULL DEFAULT '上',
    "subject" TEXT NOT NULL DEFAULT 'math',
    "displayName" TEXT NOT NULL,
    "archiveStatus" TEXT NOT NULL DEFAULT 'active',
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Notebook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ErrorItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "notebookId" TEXT,
    "originalImageUrl" TEXT NOT NULL,
    "ocrText" TEXT,
    "questionText" TEXT,
    "answerText" TEXT,
    "analysis" TEXT,
    "wrongAnswerText" TEXT,
    "mistakeAnalysis" TEXT,
    "mistakeStatus" TEXT,
    "knowledgePoints" TEXT,
    "source" TEXT,
    "errorType" TEXT,
    "userNotes" TEXT,
    "masteryLevel" INTEGER NOT NULL DEFAULT 0,
    "gradeSemester" TEXT,
    "paperLevel" TEXT,
    "printCount" INTEGER NOT NULL DEFAULT 0,
    "attention" INTEGER NOT NULL DEFAULT 1,
    "redoCount" INTEGER NOT NULL DEFAULT 0,
    "mergeSource" TEXT,
    "deletedAt" DATETIME,
    "lastPrintedAt" DATETIME,
    "inputMethod" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ErrorItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ErrorItem_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ErrorItem" ("analysis", "answerText", "createdAt", "errorType", "gradeSemester", "id", "knowledgePoints", "masteryLevel", "mistakeAnalysis", "mistakeStatus", "ocrText", "originalImageUrl", "paperLevel", "questionText", "source", "updatedAt", "userId", "userNotes", "wrongAnswerText") SELECT "analysis", "answerText", "createdAt", "errorType", "gradeSemester", "id", "knowledgePoints", "masteryLevel", "mistakeAnalysis", "mistakeStatus", "ocrText", "originalImageUrl", "paperLevel", "questionText", "source", "updatedAt", "userId", "userNotes", "wrongAnswerText" FROM "ErrorItem";
DROP TABLE "ErrorItem";
ALTER TABLE "new_ErrorItem" RENAME TO "ErrorItem";
CREATE INDEX "ErrorItem_notebookId_idx" ON "ErrorItem"("notebookId");
CREATE INDEX "ErrorItem_deletedAt_idx" ON "ErrorItem"("deletedAt");
CREATE INDEX "ErrorItem_userId_createdAt_idx" ON "ErrorItem"("userId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Notebook_userId_idx" ON "Notebook"("userId");

-- CreateIndex
CREATE INDEX "Notebook_subject_idx" ON "Notebook"("subject");

-- CreateIndex
CREATE INDEX "Notebook_archiveStatus_idx" ON "Notebook"("archiveStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Notebook_displayName_userId_key" ON "Notebook"("displayName", "userId");
