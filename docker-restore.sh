#!/bin/sh
# =====================================================================
# 【2026-10-24 空空】恢复：换库
#
# 由 docker-entrypoint.sh 用 `.` 引入（同一个 shell），在启动主进程之前调用。
#
# 为什么要单独一个文件，而不是写在 entrypoint 里：
#   这段是整个系统里**唯一会动库文件**的地方，写错了就是数据没了。
#   放在这里，可以拿一个临时目录单独跑一遍验证（见 __tests__ 里的说明），
#   而不用真起一个容器。entrypoint 那 100 多行是没法单独测的。
#
# 三条铁律：
#   1. 旧库必须**先完整挪走**，再放新的。挪不走就放弃本次恢复，
#      绝不硬来 —— 硬来的结果是覆盖掉唯一的那一份旧数据。
#   2. -wal / -shm 必须一起清。只换主文件、留着旧日志，
#      SQLite 会把旧日志重放到新库上，轻则数据错乱，重则打不开。
#   3. 换完要改属主（应用以 nextjs/uid1001 跑）。
#
# 本脚本不用 `set -e`：它经常要"失败也算正常"（比如根本没东西可恢复）。
# 由调用方决定拿它的结果怎么办。
# =====================================================================

DATA_DIR="${DATA_DIR:-/app/data}"
CONFIG_DIR="${CONFIG_DIR:-/app/config}"
RESTORE_DIR="${RESTORE_DIR:-$DATA_DIR/.restore}"
TARGET_DB="${TARGET_DB:-$DATA_DIR/dev.db}"
CONFIG_FILE="${CONFIG_FILE:-$CONFIG_DIR/app-config.json}"
APP_OWNER="${APP_OWNER:-nextjs:nodejs}"

# 给调用方读：这次启动到底换没换库（migrate 失败时要不要回滚，就看它）
RESTORED_THIS_BOOT=0

_log() {
    echo "[Restore] $*"
}

# 尽力改属主；改不了也不中断（后面的 chown -R 还会兜一次）
_own() {
    chown "$APP_OWNER" "$1" 2>/dev/null || true
}

# 只在真的存在时才删。
# 为什么不直接 `rm -f`：某些环境里 rm 被包了一层（删除保护 / 回收站），
# 对"不存在的路径"会报错甚至挂住。先判断存在，就绕开了这种意外。
_drop() {
    [ -e "$1" ] || return 0
    command rm -f "$1" 2>/dev/null || true
}

# 能挪就挪走（留作后悔药），挪不动就删掉。源不存在时什么都不做。
_move_or_drop() {
    [ -f "$1" ] || return 0
    mv "$1" "$2" 2>/dev/null || _drop "$1"
}

# 失败时留一条记录，界面上要靠它说"上次恢复没成"
_fail() {
    echo "{\"failed\":true,\"reason\":\"$1\"}" > "$RESTORE_DIR/last-restore.json" 2>/dev/null || true
    _log "!! $1"
}

restore_if_pending() {
    _pending="$RESTORE_DIR/pending.db"
    [ -f "$_pending" ] || return 0

    _log "============================================"
    _log "检测到恢复请求，开始换库"
    _log "============================================"

    # ── 1. 旧库整体挪走（含日志）────────────────────────────────────
    if [ -s "$TARGET_DB" ]; then
        if mv "$TARGET_DB" "$RESTORE_DIR/before-restore.db"; then
            _log "旧库已保存为 .restore/before-restore.db"
        else
            # 挪不走就别继续：下一步的 mv 会把旧库直接覆盖掉，
            # 那是唯一的一份数据。宁可这次不恢复。
            mv "$_pending" "$RESTORE_DIR/pending.rejected.db" 2>/dev/null || true
            mv "$RESTORE_DIR/pending-app-config.json" \
               "$RESTORE_DIR/pending-app-config.rejected.json" 2>/dev/null || true
            _fail "cannot move current db, restore aborted"
            _log "============================================"
            return 0
        fi
        # 旧日志跟旧库是一体的，一起挪走（挪不动就直接删：它们对新库只有害处）
        _move_or_drop "$TARGET_DB-wal" "$RESTORE_DIR/before-restore.db-wal"
        _move_or_drop "$TARGET_DB-shm" "$RESTORE_DIR/before-restore.db-shm"
    fi

    # ── 2. 新库就位 ────────────────────────────────────────────────
    # 万一上面没走到（旧库本来不存在），这里的残留日志同样要先清
    _drop "$TARGET_DB-wal"
    _drop "$TARGET_DB-shm"

    if mv "$_pending" "$TARGET_DB"; then
        RESTORED_THIS_BOOT=1
        _own "$TARGET_DB"
        chmod 644 "$TARGET_DB" 2>/dev/null || true
        _log "新库已就位"
    else
        _fail "cannot move pending db, rolled back"
        if [ -f "$RESTORE_DIR/before-restore.db" ]; then
            mv "$RESTORE_DIR/before-restore.db" "$TARGET_DB" 2>/dev/null || true
            _own "$TARGET_DB"
            _log "已回滚为恢复前的库"
        fi
    fi

    # ── 3. 配置（可选）─────────────────────────────────────────────
    if [ -f "$RESTORE_DIR/pending-app-config.json" ]; then
        mkdir -p "$CONFIG_DIR" 2>/dev/null || true
        if cp "$RESTORE_DIR/pending-app-config.json" "$CONFIG_FILE"; then
            _own "$CONFIG_FILE"
            _log "设置文件已一并恢复"
        else
            _log "!! 设置文件恢复失败（数据不受影响）"
        fi
        _drop "$RESTORE_DIR/pending-app-config.json"
    fi

    # ── 4. 留痕 ────────────────────────────────────────────────────
    if [ -f "$RESTORE_DIR/pending.meta.json" ]; then
        cp "$RESTORE_DIR/pending.meta.json" "$RESTORE_DIR/last-restore.json" 2>/dev/null || true
        _drop "$RESTORE_DIR/pending.meta.json"
    fi

    _log "恢复完成（RESTORED_THIS_BOOT=$RESTORED_THIS_BOOT）"
    _log "============================================"
    return 0
}
