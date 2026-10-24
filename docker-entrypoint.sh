#!/bin/sh
set -e

# Define paths
SOURCE_DB="/app/prisma/dev.db"
TARGET_DB="/app/data/dev.db"
SEED_MARKER="/app/data/.seed_completed"
VERSION_FILE="/app/data/.app_version"
# Use local Prisma CLI from node_modules
PRISMA_BIN="node /app/node_modules/prisma/build/index.js"
SEED_ADMIN_SCRIPT="/app/dist-scripts/scripts/seed-admin.js"
REBUILD_TAGS_SCRIPT="/app/dist-scripts/scripts/rebuild-system-tags.js"

# Get current app version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")

# Fix permissions for data and config directories
chown -R nextjs:nodejs /app/data /app/config

# ─────────────────────────────────────────────────────────────────────
# 恢复：换库（2026-10-24 空空）
#
# 应用自己换不掉自己的库 —— Prisma 正开着 dev.db。所以流程是：
# 应用校验完包、写到 pending.db、自己退出；容器被 restart:always 拉起，
# **这里在进程起来之前**把文件换好。
#
# 具体逻辑放在 docker-restore.sh 里，单独一个文件才测得了
# （这段 shell 不在 tsc / 单测的覆盖范围内，所以尽量少写、写清）。
# 调用完 RESTORED_THIS_BOOT=1 表示这次换过库，下面的 migrate 失败要回滚。
# ─────────────────────────────────────────────────────────────────────
. /app/docker-restore.sh
restore_if_pending

# Check if the persistent database exists
if [ ! -s "$TARGET_DB" ]; then
    echo "[Entrypoint] Initializing database..."
    if [ -f "$SOURCE_DB" ]; then
        echo "[Entrypoint] Copying pre-packaged database from $SOURCE_DB to $TARGET_DB"
        cp "$SOURCE_DB" "$TARGET_DB"
        # Ensure correct permissions
        chown nextjs:nodejs "$TARGET_DB"
        # Mark as seeded since pre-packaged DB includes seed data
        touch "$SEED_MARKER"
        # Record initial version
        echo "$CURRENT_VERSION" > "$VERSION_FILE"
    else
        echo "[Entrypoint] Source database not found at $SOURCE_DB. Initializing with migrations."
    fi
else
    echo "[Entrypoint] Database already exists at $TARGET_DB."
fi

# Check for version upgrade
PREVIOUS_VERSION=""
if [ -f "$VERSION_FILE" ]; then
    PREVIOUS_VERSION=$(cat "$VERSION_FILE")
fi

# Run migrations to ensure DB schema is available and up to date.
echo "[Entrypoint] Running database migrations to sync schema..."
cd /app
if $PRISMA_BIN migrate deploy --schema=./prisma/schema.prisma; then
    echo "[Entrypoint] Migrations completed successfully."
elif [ "$RESTORED_THIS_BOOT" = "1" ]; then
    # 刚换上的库迁移失败 ⇒ 它跟当前这个版本合不来（比如备份太旧）。
    # 带着一个不兼容的库启动，后面每个页面都是 500，比不恢复还糟。
    # 所以：先把坏库挪开，把恢复前的库换回去，然后按正常流程再走一遍。
    echo "[Entrypoint] !! 恢复后的库迁移失败，回滚到恢复前的库"
    mv "$TARGET_DB" "$RESTORE_DIR/failed-restore.db" 2>/dev/null || true
    rm -f "$TARGET_DB-wal" "$TARGET_DB-shm"
    if [ -f "$RESTORE_DIR/before-restore.db" ]; then
        mv "$RESTORE_DIR/before-restore.db" "$TARGET_DB" 2>/dev/null || true
        chown nextjs:nodejs "$TARGET_DB" 2>/dev/null || true
        echo "[Entrypoint] 已回滚为恢复前的库"
    fi
    echo '{"failed":true,"reason":"migration failed after restore"}' > "$RESTORE_DIR/last-restore.json"
    $PRISMA_BIN migrate deploy --schema=./prisma/schema.prisma \
        || echo "[Entrypoint] Migration failed or no pending migrations."
else
    echo "[Entrypoint] Migration failed or no pending migrations."
fi

# Always run seed after migrations to ensure admin user has correct role/isActive
# (migration may have reset role to default 'user' for existing installs)
echo "[Entrypoint] Ensuring admin user exists with correct role..."
cd /app && node "$SEED_ADMIN_SCRIPT" && {
    echo "[Entrypoint] Admin seed completed successfully."
} || echo "[Entrypoint] Admin seed failed (non-fatal, continuing...)."
touch "$SEED_MARKER" 2>/dev/null

# Check if version changed - rebuild system tags automatically
if [ "$PREVIOUS_VERSION" != "$CURRENT_VERSION" ]; then
    echo "[Entrypoint] Version upgrade detected: $PREVIOUS_VERSION -> $CURRENT_VERSION"
    echo "[Entrypoint] Rebuilding system tags to sync with new version..."
    cd /app && node "$REBUILD_TAGS_SCRIPT" && {
        echo "[Entrypoint] System tags rebuilt successfully."
    } || echo "[Entrypoint] Tag rebuild failed (non-fatal, continuing...)."
    # Update version marker
    echo "$CURRENT_VERSION" > "$VERSION_FILE"
fi

# HTTPS Setup
CERT_DIR="/app/certs"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [ "$HTTPS_ENABLED" = "true" ]; then
    echo "[Entrypoint] HTTPS enabled"
    
    # 确保证书目录存在
    mkdir -p "$CERT_DIR"
    chown nextjs:nodejs "$CERT_DIR"
    
    # 检查证书是否存在
    if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 证书不存在，自动生成自签名证书..."
        
        # 获取证书 CN（优先使用环境变量，否则使用 localhost）
        CERT_CN="${CERT_DOMAIN:-localhost}"
        
        # 生成自签名证书（有效期 10 年）
        openssl req -x509 -newkey rsa:2048 \
            -keyout "$KEY_FILE" \
            -out "$CERT_FILE" \
            -days 3650 \
            -nodes \
            -subj "/CN=$CERT_CN" \
            2>/dev/null
        
        if [ $? -eq 0 ]; then
            echo "[Entrypoint] 自签名证书生成成功: CN=$CERT_CN"
            chown nextjs:nodejs "$CERT_FILE" "$KEY_FILE"
        else
            echo "[Entrypoint] 警告: 证书生成失败，HTTPS 将不可用"
        fi
    else
        echo "[Entrypoint] 使用已有证书: $CERT_FILE"
    fi
    
    # 启动 HTTPS 代理
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 启动 HTTPS 代理 (端口 443)..."
        su-exec nextjs:nodejs node /app/https-server.js &
    fi
fi

# Execute the main container command as nextjs user
exec su-exec nextjs:nodejs "$@"
