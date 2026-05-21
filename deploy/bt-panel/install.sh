#!/usr/bin/env bash
# by-wave-calendar 一键部署脚本（宝塔面板用，无反代模式）
# 用法：在解压目录里跑：
#   bash deploy/bt-panel/install.sh
# 可选环境变量：
#   ADMIN_EMAIL / ADMIN_PASSWORD —— 跳过交互式提示，直接创建管理员
#   SKIP_DEPS=1 —— 跳过 npm ci
#   SKIP_MIGRATE=1 —— 跳过数据库迁移
#   SKIP_ADMIN=1 —— 跳过管理员创建
#   SKIP_SETCAP=1 —— 跳过 setcap（如果你以 root 跑 PM2 就不需要）
#   PM2_NAME —— PM2 进程名（默认 by-wave-calendar）

set -euo pipefail

PM2_NAME="${PM2_NAME:-by-wave-calendar}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"

log()  { printf '\033[36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[install] WARN:\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

log "工作目录: $APP_DIR"

# ---------- 1. 工具链检查 ----------
log "检查 Node / npm / PM2 / Postgres 客户端..."
command -v node >/dev/null || fail "未找到 node。请在宝塔软件商店装 Node.js (>=20)。"
command -v npm  >/dev/null || fail "未找到 npm。"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || fail "Node 版本太老 (当前: $(node -v))，需要 >= 20。"

if ! command -v pm2 >/dev/null; then
  log "未找到 pm2，全局安装中..."
  npm install -g pm2
fi
command -v psql >/dev/null || warn "未找到 psql 客户端（不影响运行，仅提示）"

# ---------- 2. .env ----------
if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then fail "缺少 .env 和 .env.example"; fi
  log ".env 不存在，从 .env.example 复制..."
  cp .env.example .env
  SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
  if sed --version >/dev/null 2>&1; then
    sed -i "s|SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
  else
    sed -i '' "s|SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
  fi
  log "已生成随机 SESSION_SECRET。"
  warn ".env 已创建，请编辑以下变量再重新执行本脚本："
  echo "    DATABASE_URL"
  echo "    PUBLIC_BASE_URL=https://rl.lz-ss.com"
  echo "    USE_HTTPS=true"
  echo "    HTTPS_CERT_PATH=/www/server/panel/vhost/cert/rl.lz-ss.com/fullchain.pem"
  echo "    HTTPS_KEY_PATH=/www/server/panel/vhost/cert/rl.lz-ss.com/privkey.pem"
  echo "    ACME_WEBROOT=/www/wwwroot/rl.lz-ss.com   （让宝塔续证不被打断）"
  exit 0
fi
log ".env 已存在。"

set -a; . ./.env; set +a
[ -n "${DATABASE_URL:-}" ] || fail ".env 里没有 DATABASE_URL"
[ -n "${PUBLIC_BASE_URL:-}" ] || fail ".env 里没有 PUBLIC_BASE_URL"

# ---------- 3. 依赖 ----------
if [ "${SKIP_DEPS:-0}" = "1" ]; then
  log "SKIP_DEPS=1，跳过依赖安装。"
else
  log "安装生产依赖（npm ci --omit=dev）..."
  npm ci --omit=dev
fi

# ---------- 4. dist 检查 ----------
[ -f dist/src/server.js ] || fail "dist/src/server.js 不存在。请在本地 'npm run release' 后上传 tarball。"

# ---------- 5. 数据库迁移 ----------
if [ "${SKIP_MIGRATE:-0}" = "1" ]; then
  log "SKIP_MIGRATE=1，跳过迁移。"
else
  log "运行数据库迁移..."
  node dist/scripts/migrate.js
fi

# ---------- 6. setcap (let Node bind 80/443 without root) ----------
if [ "${USE_HTTPS:-false}" = "true" ] && [ "${SKIP_SETCAP:-0}" != "1" ]; then
  NODE_BIN=$(readlink -f "$(command -v node)")
  if command -v setcap >/dev/null && [ -w "$NODE_BIN" -o "$(id -u)" = "0" ]; then
    log "给 Node 二进制加 cap_net_bind_service 权限（绑定 80/443）：$NODE_BIN"
    if [ "$(id -u)" = "0" ]; then
      setcap 'cap_net_bind_service=+ep' "$NODE_BIN" || warn "setcap 失败，可能需要手动 sudo setcap"
    else
      sudo setcap 'cap_net_bind_service=+ep' "$NODE_BIN" || warn "sudo setcap 失败"
    fi
  else
    warn "找不到 setcap 或没权限。如果 PM2 不是 root 跑的，Node 无法绑 80/443"
    warn "  以 root 跑 PM2：sudo pm2 start ... ；或手动执行 sudo setcap 'cap_net_bind_service=+ep' $NODE_BIN"
  fi
fi

# ---------- 7. 管理员 ----------
if [ "${SKIP_ADMIN:-0}" = "1" ]; then
  log "SKIP_ADMIN=1，跳过管理员创建。"
else
  log "创建/更新管理员..."
  node dist/scripts/create-admin.js
fi

# ---------- 8. PM2 启动 ----------
mkdir -p logs
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  log "PM2 进程 '$PM2_NAME' 已存在，执行 reload..."
  pm2 reload "$PM2_NAME" --update-env
else
  log "PM2 启动 '$PM2_NAME'..."
  pm2 start deploy/bt-panel/ecosystem.config.cjs
fi

pm2 save >/dev/null
log "若想开机自启，请用 root 执行（一次性）: pm2 startup"

log "完成！"
echo
echo "下一步："
if [ "${USE_HTTPS:-false}" = "true" ]; then
  echo "  Node 直接监听 ${HTTPS_PORT:-443} (HTTPS) 和 ${HTTP_REDIRECT_PORT:-80} (重定向)"
  echo "  请确认宝塔里的 rl.lz-ss.com 站点 **不要**让 nginx 占用 80/443"
  echo "  (在 网站 → rl.lz-ss.com → 设置 → 停止 nginx 监听该站点；保留宝塔 SSL 自动续证)"
  echo "  访问 https://rl.lz-ss.com 测试"
else
  echo "  服务在 127.0.0.1:${PORT:-3000}，外网访问需要宝塔反代或 USE_HTTPS=true"
fi
echo "  查看日志: pm2 logs $PM2_NAME"
echo "  查看状态: pm2 status"
