-- 用户名作为登录标识，必须唯一（登录页改为「用户名 + 密码」）
-- SQLite 允许多个 NULL，故 name 为 NULL 的旧账号不受影响
CREATE UNIQUE INDEX "User_name_key" ON "User"("name");
