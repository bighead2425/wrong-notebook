-- 两段式：标签归位状态 + 第一段的关键词（中间数据，第二段跑完置 null）
ALTER TABLE "ErrorItem" ADD COLUMN "tagStatus" TEXT;
ALTER TABLE "ErrorItem" ADD COLUMN "stage1Keywords" TEXT;
