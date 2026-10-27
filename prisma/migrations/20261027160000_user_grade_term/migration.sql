-- 【2026-10-27】主页「年级/学期」从浏览器 localStorage 挪到账号上（跟人走、跟部署走）。
ALTER TABLE "User" ADD COLUMN "gradeTerm" TEXT;
