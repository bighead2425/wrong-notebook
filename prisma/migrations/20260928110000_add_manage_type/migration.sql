-- T2 复练纸前置：错题等级（manageType）+ 来源（manageTypeSource）。
--
-- 保守迁移：**只 ADD COLUMN，不重建表**（与 20260924230000_add_crop_regions 同一口径）。
-- SQLite 的 ADD COLUMN 不触碰既有数据；而 prisma migrate 按 schema 差异自动生成的版本会
-- DROP + RENAME 重建 ErrorItem，生产库里有真实错题数据，重建一旦中断就是数据丢失。
-- 这两列都是纯新增、无默认值、无约束，手写最稳。
--
-- 语义（见 src/lib/manage-type.ts 与 prisma/schema.prisma 的注释）：
--   manageType       = deep（深挖）/ review（复练）；NULL = 未定
--   manageTypeSource = default | derived | ai | manual | upgrade
--                      「派生 + 落定快照」只靠它判断哪些行还能被自动改写
--   ⚠️ 「积累」不在这一层（积累点背后可以没有错题，将来自立一张表）
--
-- 存量行留 NULL：界面显示"未定"，派生逻辑到下一轮才动它，不会报错。
ALTER TABLE "ErrorItem" ADD COLUMN "manageType" TEXT;
ALTER TABLE "ErrorItem" ADD COLUMN "manageTypeSource" TEXT;
