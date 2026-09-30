-- 【2026-10-01 第三轮：积累纸打印】卷内一行 → 指向某条日积月累（软链接）
--
-- 为什么不新开一张"积累卷表"：
--   他要的积累纸 = **两栏 + 中间灰竖线 + 每条下留白 1 行** —— 这**就是** 09-28 已经做好的
--   `kind='build'` 版面（VOLUME_VARIANTS.build：columns=2、defaultBlankLines=1）。
--   卷号/页码/页二维码/"印出去的凭证存快照"这套机制也全是现成的。
--   所以只差"卷内一行除了能挂题，还能挂一条积累" —— 加一列软链接即可，**零新表**。
--
-- ⚠️ 只加软链接，**纸面的一切仍走既有快照列**（itemNo / questionText / figureUrls）：
--    积累卷里它们分别装 JL 编号 / 正文 / 配图（语义一致：都是"这条印在纸上的东西"）。
--    这是当初定的定盘星 —— **印出去的凭证必须存快照**，删了原条目照样能重印这一卷。

-- 带 REFERENCES 的 ADD COLUMN：SQLite 允许（要求默认值为 NULL，本列正是 NULL），
-- 与 schema 里声明的关系保持一致，免得 `prisma migrate` 判成 drift。
ALTER TABLE "ReviewVolumeItem" ADD COLUMN "insightId" TEXT
    REFERENCES "Insight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 索引名与 Prisma 约定一致（`<模型>_<字段>_idx`）
CREATE INDEX "ReviewVolumeItem_insightId_idx" ON "ReviewVolumeItem"("insightId");
