#!/bin/sh
# =====================================================================
# docker-restore.sh 的模拟测试
#
# 为什么要有它：`docker-restore.sh` 是整个系统里唯一会动库文件的代码，
# 而它既不在 tsc 里、也不在 vitest 里。entrypoint 那一百多行没法单独跑，
# 但这段可以 —— 给它一个临时目录、几个环境变量就行。
#
#   用法：sh scripts/test-docker-restore.sh
# =====================================================================
set -u

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$REPO_ROOT/docker-restore.sh"

pass=0
fail=0

ok() { pass=$((pass + 1)); echo "  PASS  $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL  $1"; }
check() {
    # $1 名字  $2 实际  $3 期望
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实际 [$2]）"; fi
}
check_absent() {
    if [ ! -e "$2" ]; then ok "$1"; else bad "$1（$2 不该存在）"; fi
}

CASE_DIR=""

new_case() {
    # 用 POSIX 路径（/tmp/...）而不是 Windows 的 C:\... ：
    # 本机的删除保护会拦下"C: 前缀 + 正斜杠"的混合路径，导致 rm 失效、
    # 测试里看起来像"文件没被消耗"，其实是删不掉。
    CASE_DIR=$(mktemp -d "/tmp/wn-restore-$$-XXXXXX" 2>/dev/null || mktemp -d)
    export DATA_DIR="$CASE_DIR/data"
    export CONFIG_DIR="$CASE_DIR/config"
    export RESTORE_DIR="$DATA_DIR/.restore"
    export TARGET_DB="$DATA_DIR/dev.db"
    export CONFIG_FILE="$CONFIG_DIR/app-config.json"
    # 本地没有 nextjs 用户，用当前用户；chown 失败会被脚本里的 || true 兜住
    export APP_OWNER="$(id -un 2>/dev/null || echo root)"
    mkdir -p "$RESTORE_DIR" "$CONFIG_DIR"
}

drop_case() {
    [ -n "$CASE_DIR" ] && rm -rf "$CASE_DIR"
    CASE_DIR=""
}

# 在子 shell 里 source 并调用，把结果写到文件（子 shell 的变量回不来）
run_restore() {
    (
        . "$SCRIPT"
        restore_if_pending
        echo "$RESTORED_THIS_BOOT" > "$CASE_DIR/flag"
    )
}

echo "=== 场景 A：正常恢复（旧库 + 旧日志 + 新的库和配置）==="
new_case
printf 'OLD' > "$TARGET_DB"
printf 'OLDWAL' > "$TARGET_DB-wal"
printf 'OLDSHM' > "$TARGET_DB-shm"
printf 'NEW' > "$RESTORE_DIR/pending.db"
mkdir -p "$RESTORE_DIR/pending-config"
printf 'NEWCFG' > "$RESTORE_DIR/pending-config/app-config.json"
printf 'NEWSTATE' > "$RESTORE_DIR/pending-config/scan-inbox-state.json"
printf 'META' > "$RESTORE_DIR/pending.meta.json"
printf 'OLDCFG' > "$CONFIG_FILE"
printf 'OLDSTATE' > "$CONFIG_DIR/scan-inbox-state.json"

run_restore
check "标记为已恢复" "$(cat "$CASE_DIR/flag")" "1"
check "主库换成新的" "$(cat "$TARGET_DB")" "NEW"
check_absent "旧的 -wal 已清掉" "$TARGET_DB-wal"
check_absent "旧的 -shm 已清掉" "$TARGET_DB-shm"
check "旧库留了一份" "$(cat "$RESTORE_DIR/before-restore.db")" "OLD"
check "旧日志跟着旧库一起留" "$(cat "$RESTORE_DIR/before-restore.db-wal")" "OLDWAL"
check "配置换成了新的" "$(cat "$CONFIG_FILE")" "NEWCFG"
check "收件箱台账也恢复了" "$(cat "$CONFIG_DIR/scan-inbox-state.json")" "NEWSTATE"
check_absent "pending 已消耗" "$RESTORE_DIR/pending.db"
check_absent "pending 配置目录已消耗" "$RESTORE_DIR/pending-config"
if [ -f "$RESTORE_DIR/last-restore.json" ]; then
    ok "留了恢复记录"
else
    bad "没留恢复记录"
fi
drop_case

echo
echo "=== 场景 B：没有待恢复的包（普通重启）==="
new_case
printf 'KEEP' > "$TARGET_DB"
printf 'KEEPWAL' > "$TARGET_DB-wal"

run_restore
check "不给恢复标记" "$(cat "$CASE_DIR/flag")" "0"
check "库一个字节没动" "$(cat "$TARGET_DB")" "KEEP"
check "-wal 也没动" "$(cat "$TARGET_DB-wal")" "KEEPWAL"
check_absent "没有产生 before-restore" "$RESTORE_DIR/before-restore.db"
drop_case

echo
echo "=== 场景 C：只恢复数据，不动设置 ==="
new_case
printf 'OLD' > "$TARGET_DB"
printf 'NEW' > "$RESTORE_DIR/pending.db"
printf 'KEEP-CFG' > "$CONFIG_FILE"

run_restore
check "库换掉了" "$(cat "$TARGET_DB")" "NEW"
check "设置保持原样" "$(cat "$CONFIG_FILE")" "KEEP-CFG"
drop_case

echo
echo "=== 场景 D：机器上还没有库（首次安装就恢复）==="
new_case
# 故意不放 dev.db
printf 'FROM-BACKUP' > "$RESTORE_DIR/pending.db"

run_restore
check "标记为已恢复" "$(cat "$CASE_DIR/flag")" "1"
check "库直接从备份来" "$(cat "$TARGET_DB")" "FROM-BACKUP"
drop_case

echo
echo "======================================"
echo "通过 $pass 项，失败 $fail 项"
[ "$fail" -eq 0 ] || exit 1
