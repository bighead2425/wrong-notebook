-- 错因来源：'ai'（分析时初判，只当靶子）| 'human'（人确认或改过）
-- 目的：一年后能回答"AI 给的错因有多少被人改掉了"，据此决定这块值不值得保留。
ALTER TABLE "ErrorItem" ADD COLUMN "mistakeCategorySource" TEXT;
