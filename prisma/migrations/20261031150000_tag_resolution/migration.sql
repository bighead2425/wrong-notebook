-- 【2026-10-31】标签坐标化：把"AI 选了哪几个名字"升级成"它凭什么选的、挂到了哪"
--
-- tagResolution：每次分析/保存的解析结果（JSON 数组，含 matchedBy）
--   path      册+节+名 全中（最稳）
--   book-name 册+名 中（册锁住，节可能错）
--   legacy    旧格式只有名字，且全库唯一同名
--   none      解析不出，进了待归类
--
-- tagDeviation：AI 换了默认册时交的一句判据；人确认时也可以在这里写备注
ALTER TABLE "ErrorItem" ADD COLUMN "tagResolution" TEXT;
ALTER TABLE "ErrorItem" ADD COLUMN "tagDeviation" TEXT;
