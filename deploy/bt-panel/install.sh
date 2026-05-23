#!/usr/bin/env bash
# by-wave-calendar 一键部署脚本（宝塔面板用，无反代模式）
#
# 用法：
#   首次安装（交互式引导）：bash deploy/bt-panel/install.sh
#   更新已有部署（跳过引导）：bash deploy/bt-panel/install.sh
#
# 可选环境变量：
#   ADMIN_EMAIL / ADMIN_PASSWORD —— 跳过交互式提示，直接创建管理员
#   SKIP_DEPS=1                  —— 跳过 npm ci
#   SKIP_MIGRATE=1               —— 跳过数据库迁移
#   SKIP_ADMIN=1                 —— 跳过管理员创建
#   SKIP_SETCAP=1                —— 跳过 setcap（如果你以 root 跑 PM2 就不需要）
#   SKIP_SMOKE=1                 —— 跳过最后的 HTTP smoke 测试
#   NONINTERACTIVE=1             —— 完全不弹任何 prompt，缺啥就 fail（用于自动化）
#   PM2_NAME                     —— PM2 进程名（默认 by-wave-calendar）

set -euo pipefail

PM2_NAME="${PM2_NAME:-by-wave-calendar}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"

# ---------- 输出辅助 ----------
log()  { printf '\033[36m[install]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[install] WARN:\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
hint() { printf '         \033[90m└─ %s\033[0m\n' "$*"; }

step() {
  printf '\n\033[1;36m▶ %s\033[0m\n' "$*"
}

# Read a single line from the user, with a default value. Skips when
# NONINTERACTIVE=1 is set. Usage: `var=$(ask "prompt" "default")`
ask() {
  local prompt="$1" default="${2:-}"
  if [ "${NONINTERACTIVE:-0}" = "1" ]; then
    echo "$default"
    return
  fi
  local reply
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " reply </dev/tty || true
    echo "${reply:-$default}"
  else
    read -r -p "$prompt: " reply </dev/tty || true
    echo "$reply"
  fi
}

# Yes/no prompt. Returns 0 for yes, 1 for no. Default is "Y".
confirm() {
  local prompt="$1" default="${2:-y}"
  if [ "${NONINTERACTIVE:-0}" = "1" ]; then
    [ "$default" = "y" ]
    return
  fi
  local reply
  read -r -p "$prompt [Y/n]: " reply </dev/tty || true
  reply="${reply:-$default}"
  [ "${reply,,}" = "y" ] || [ "${reply,,}" = "yes" ]
}

log "工作目录: $APP_DIR"

# ========== 1. 工具链检查 ==========
step "1/8 工具链检查"

command -v node >/dev/null || {
  warn "未找到 node。请在宝塔软件商店装 Node.js (>=20)。"
  hint "宝塔 → 软件商店 → 搜 Node.js → 安装 → 设置全局 v20.x"
  exit 1
}
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node 版本太老 (当前: $(node -v))，需要 >= 20。"
  hint "宝塔 → 软件商店 → Node.js → 设置 → 切换全局版本 → v20.x"
  exit 1
fi
ok "Node $(node -v)"

command -v npm >/dev/null || fail "未找到 npm。"

if ! command -v pm2 >/dev/null; then
  log "未找到 pm2，全局安装中..."
  npm install -g pm2 >/dev/null 2>&1 || fail "pm2 安装失败"
fi
ok "PM2 $(pm2 -v)"

if ! command -v psql >/dev/null; then
  warn "未找到 psql 客户端（仅影响诊断，不影响运行）"
  hint "若 DB 在本机：宝塔 → 数据库 → PostgreSQL 16+ → 安装"
fi

# ========== 2. .env 引导 ==========
step "2/8 .env 配置"

if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then fail "缺少 .env 和 .env.example"; fi
  log ".env 不存在，启动交互式向导..."

  SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")

  if [ "${NONINTERACTIVE:-0}" = "1" ]; then
    log "NONINTERACTIVE=1，从 .env.example 原样复制（你需要稍后手动编辑）"
    cp .env.example .env
    if sed --version >/dev/null 2>&1; then
      sed -i "s|SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
    else
      sed -i '' "s|SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
    fi
    warn ".env 已创建，请编辑后重新执行本脚本：DATABASE_URL / PUBLIC_BASE_URL / USE_HTTPS / HTTPS_CERT_PATH"
    exit 0
  fi

  echo
  echo "  接下来会问 4 个问题，回车接受默认值。"
  echo "  之后所有配置都能在管理员后台 /admin 修改，不用手动改 .env。"
  echo

  # 域名
  DOMAIN=$(ask "1) 你的域名（不带 https://，例如 calendar.example.com）" "")
  if [ -z "$DOMAIN" ]; then
    fail "域名是必填的。如果只是本地试用，请填 127.0.0.1:3000 并按提示选 USE_HTTPS=false。"
  fi

  # HTTPS？
  if confirm "2) 用 HTTPS 直接监听 443/80？（推荐生产环境用，本机试用建议 No）" "y"; then
    USE_HTTPS="true"
    PUBLIC_BASE_URL="https://$DOMAIN"

    # 自动发现宝塔证书路径
    BT_CERT_DIR="/www/server/panel/vhost/cert/$DOMAIN"
    if [ -f "$BT_CERT_DIR/fullchain.pem" ] && [ -f "$BT_CERT_DIR/privkey.pem" ]; then
      ok "自动发现宝塔证书：$BT_CERT_DIR"
      HTTPS_CERT_PATH="$BT_CERT_DIR/fullchain.pem"
      HTTPS_KEY_PATH="$BT_CERT_DIR/privkey.pem"
    else
      warn "$BT_CERT_DIR 下没找到证书。先去宝塔申请 Let's Encrypt 证书。"
      HTTPS_CERT_PATH=$(ask "  证书 fullchain.pem 路径" "$BT_CERT_DIR/fullchain.pem")
      HTTPS_KEY_PATH=$(ask "  证书 privkey.pem 路径" "$BT_CERT_DIR/privkey.pem")
    fi
  else
    USE_HTTPS="false"
    PUBLIC_BASE_URL="http://$DOMAIN"
    HTTPS_CERT_PATH=""
    HTTPS_KEY_PATH=""
  fi

  # 数据库
  echo
  echo "3) 数据库连接（PostgreSQL 16+）"
  if command -v psql >/dev/null && PGPASSWORD="" psql -U postgres -h 127.0.0.1 -lqt 2>/dev/null | head -1 >/dev/null 2>&1; then
    ok "检测到本机 PostgreSQL"
    DB_DEFAULT="postgres://bywave:bywave_dev@127.0.0.1:5432/bywave"
  else
    DB_DEFAULT="postgres://用户名:密码@127.0.0.1:5432/数据库名"
  fi
  DATABASE_URL=$(ask "   DATABASE_URL" "$DB_DEFAULT")
  if [ "$DATABASE_URL" = "$DB_DEFAULT" ] && [[ "$DB_DEFAULT" == *"用户名"* ]]; then
    fail "请先在宝塔 → 数据库 创建 PostgreSQL 库，再填实际连接串。"
  fi

  # ICP（中国大陆用户）
  echo
  ICP_NUMBER=$(ask "4) 中国大陆 ICP 备案号（无备案直接回车跳过，例如：沪ICP备2021023412号-2）" "")

  # 原生 APP 同步（iOS / Android / 桌面）
  echo
  if confirm "5) 启用原生 APP 同步？（iOS / Android / 桌面 APP 扫码登录用，关闭则只能用网页 + CalDAV）" "y"; then
    APPS_ENABLED="true"
  else
    APPS_ENABLED="false"
  fi

  cp .env.example .env
  apply_kv() {
    local key="$1" val="$2"
    if [ -z "$val" ]; then return; fi
    # Escape | and & for sed safety
    val=$(printf '%s' "$val" | sed -e 's/[&|\\]/\\&/g')
    if sed --version >/dev/null 2>&1; then
      sed -i "s|^${key}=.*|${key}=${val}|" .env
    else
      sed -i '' "s|^${key}=.*|${key}=${val}|" .env
    fi
  }
  apply_kv "SESSION_SECRET" "$SECRET"
  apply_kv "PUBLIC_BASE_URL" "$PUBLIC_BASE_URL"
  apply_kv "DATABASE_URL" "$DATABASE_URL"
  apply_kv "USE_HTTPS" "$USE_HTTPS"
  apply_kv "NODE_ENV" "production"
  if [ -n "$HTTPS_CERT_PATH" ]; then
    apply_kv "HTTPS_CERT_PATH" "$HTTPS_CERT_PATH"
    apply_kv "HTTPS_KEY_PATH" "$HTTPS_KEY_PATH"
  fi
  if [ -n "$ICP_NUMBER" ]; then
    # The .env.example has these commented; un-comment + fill
    if grep -q "^# ICP_NUMBER=" .env; then
      apply_kv "# ICP_NUMBER" "ICP_NUMBER=$ICP_NUMBER"
      apply_kv "# ICP_URL" "ICP_URL=https://beian.miit.gov.cn/"
      # apply_kv above set the literal key; fix that
      sed -i "s|^# ICP_NUMBER=.*|ICP_NUMBER=$ICP_NUMBER|" .env 2>/dev/null || sed -i '' "s|^# ICP_NUMBER=.*|ICP_NUMBER=$ICP_NUMBER|" .env
      sed -i "s|^# ICP_URL=.*|ICP_URL=https://beian.miit.gov.cn/|" .env 2>/dev/null || sed -i '' "s|^# ICP_URL=.*|ICP_URL=https://beian.miit.gov.cn/|" .env
    fi
  fi
  ok ".env 写入完成"
fi

# Load env to verify
set -a; . ./.env; set +a
[ -n "${DATABASE_URL:-}" ] || fail ".env 里没有 DATABASE_URL"
[ -n "${PUBLIC_BASE_URL:-}" ] || fail ".env 里没有 PUBLIC_BASE_URL"
[ -n "${SESSION_SECRET:-}" ] || fail ".env 里没有 SESSION_SECRET"
if [ "${SESSION_SECRET}" = "change-me-in-production-please-this-must-be-long-enough" ]; then
  fail ".env 里 SESSION_SECRET 还是默认占位值，必须先改成随机字符串再启动。"
fi
ok ".env 校验通过"

# ========== 3. 数据库连通性预检 ==========
step "3/8 数据库连通性"
if command -v psql >/dev/null; then
  if psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1; then
    ok "数据库连通"
  else
    warn "数据库 ping 不通：$DATABASE_URL"
    hint "常见原因：① 库还没建 ② 用户密码不对 ③ pg_hba.conf 限制 ④ PG 没启动"
    hint "宝塔 → 数据库 → PostgreSQL → 看状态是否运行；点「修改」可以重置密码"
    if ! confirm "依然继续？（迁移步骤会再试一次）" "n"; then
      exit 1
    fi
  fi
else
  warn "未装 psql 客户端，跳过预检"
fi

# ========== 4. 依赖 + 编译 ==========
step "4/8 安装依赖 + 编译"
if [ -f dist/src/server.js ]; then
  log "检测到 dist/，使用 tarball 模式"
  if [ "${SKIP_DEPS:-0}" = "1" ]; then
    log "SKIP_DEPS=1，跳过依赖安装"
  else
    log "安装生产依赖（npm ci --omit=dev）..."
    npm ci --omit=dev || fail "npm ci 失败，常见原因：网络不通 / package-lock 损坏"
  fi
else
  log "未检测到 dist/，使用源码模式（git clone）"
  if [ "${SKIP_DEPS:-0}" = "1" ]; then
    log "SKIP_DEPS=1，跳过依赖安装（但 build 还会跑）"
  else
    log "安装全部依赖（含 devDeps，用于 build）..."
    npm ci --include=dev || fail "npm ci 失败"
  fi
  log "编译 TypeScript..."
  npm run build || fail "npm run build 失败，看上面的报错"
  log "Prune devDeps..."
  npm prune --omit=dev || warn "prune 失败，不致命，继续"
fi
[ -f dist/src/server.js ] || fail "dist/src/server.js 仍不存在，编译失败"
ok "编译产物已就绪"

# ========== 5. 数据库迁移 ==========
step "5/8 数据库迁移"
if [ "${SKIP_MIGRATE:-0}" = "1" ]; then
  log "SKIP_MIGRATE=1，跳过"
else
  if ! node dist/scripts/migrate.js; then
    fail "迁移失败，看上面的错。常见：DATABASE_URL 不对 / 库还没建 / 权限不够"
  fi
  ok "迁移完成"
fi

# Apply the APP-sync choice from the .env wizard. Only run on a fresh
# install (when APPS_ENABLED is set above). Upgrades preserve whatever
# the admin previously chose via /admin/api.
if [ -n "${APPS_ENABLED:-}" ]; then
  if node dist/scripts/set-site-flag.js apps_enabled "$APPS_ENABLED" >/dev/null 2>&1; then
    if [ "$APPS_ENABLED" = "true" ]; then
      ok "已启用原生 APP 同步"
    else
      ok "未启用原生 APP 同步（仅 Web + CalDAV）"
    fi
  else
    warn "保存 APP 同步开关失败，可稍后到 /admin/api 手动改"
  fi
fi

# ========== 6. setcap ==========
step "6/8 端口绑定权限"
if [ "${USE_HTTPS:-false}" = "true" ] && [ "${SKIP_SETCAP:-0}" != "1" ]; then
  NODE_BIN=$(readlink -f "$(command -v node)")
  if command -v setcap >/dev/null; then
    log "给 Node 加 cap_net_bind_service 权限：$NODE_BIN"
    if [ "$(id -u)" = "0" ]; then
      setcap 'cap_net_bind_service=+ep' "$NODE_BIN" || warn "setcap 失败"
    else
      sudo setcap 'cap_net_bind_service=+ep' "$NODE_BIN" || warn "sudo setcap 失败"
    fi
    ok "端口权限已配置"
  else
    warn "找不到 setcap 命令"
    hint "或者以 root 跑 PM2：sudo pm2 start ..."
  fi
else
  log "USE_HTTPS=false，跳过 setcap"
fi

# ========== 7. 管理员 ==========
step "7/8 创建/更新管理员"
if [ "${SKIP_ADMIN:-0}" = "1" ]; then
  log "SKIP_ADMIN=1，跳过"
else
  node dist/scripts/create-admin.js || warn "create-admin 失败，可稍后手动跑：node dist/scripts/create-admin.js"
fi

# ========== 8. PM2 启动 ==========
step "8/8 启动服务"
mkdir -p logs
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  log "PM2 进程 '$PM2_NAME' 已存在，reload..."
  pm2 reload "$PM2_NAME" --update-env >/dev/null
else
  log "PM2 启动 '$PM2_NAME'..."
  pm2 start deploy/bt-panel/ecosystem.config.cjs >/dev/null
fi
pm2 save >/dev/null
ok "PM2 已启动"

# ========== Smoke test ==========
if [ "${SKIP_SMOKE:-0}" != "1" ]; then
  step "Smoke test（验证服务真的活着）"
  PROBE_PORT="${PORT:-3000}"
  if [ "${USE_HTTPS:-false}" = "true" ]; then
    PROBE_PORT="${HTTPS_PORT:-443}"
    PROBE_URL="https://127.0.0.1:${PROBE_PORT}/health"
    CURL_FLAGS="-sk"
  else
    PROBE_URL="http://127.0.0.1:${PROBE_PORT}/health"
    CURL_FLAGS="-s"
  fi
  log "等待服务起来（最多 15 秒）..."
  HEALTH_OK=0
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl $CURL_FLAGS --max-time 1 "$PROBE_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      ok "服务健康 ✓ ($PROBE_URL)"
      HEALTH_OK=1
      break
    fi
    sleep 1
  done
  if [ "$HEALTH_OK" = "0" ]; then
    warn "服务起来了但 /health 检测失败"
    hint "查日志：pm2 logs $PM2_NAME --lines 50"
    hint "看进程：pm2 list"
  fi

  # CalDAV PROPFIND smoke test — proves the server (and any reverse
  # proxy in front of it) actually accepts WebDAV methods. We send
  # an unauthenticated PROPFIND and expect a 401 reply with a
  # WWW-Authenticate header. If we get 405 / 502 / 400 instead, the
  # reverse proxy is filtering out PROPFIND and iPhone's "添加帐户"
  # will fail with no useful error.
  if [ "$HEALTH_OK" = "1" ]; then
    CALDAV_URL="${PROBE_URL%/health}/caldav/"
    PF_RESPONSE=$(curl $CURL_FLAGS --max-time 3 -X PROPFIND -i \
      -H "Depth: 0" -H "Content-Type: application/xml" \
      --data '<?xml version="1.0"?><propfind xmlns="DAV:"><prop/></propfind>' \
      "$CALDAV_URL" 2>/dev/null | head -5 || true)
    if echo "$PF_RESPONSE" | grep -qi "401 "; then
      ok "CalDAV PROPFIND 通了（返回 401，鉴权流程正常）"
    elif echo "$PF_RESPONSE" | grep -qiE "405 |Method Not Allowed"; then
      warn "CalDAV PROPFIND 被 nginx 反代拒绝（405 Method Not Allowed）"
      hint "如果你走宝塔反代，编辑站点 nginx 配置加上 PROPFIND/REPORT 支持"
      hint "参考 deploy/bt-panel/nginx.conf.example"
      hint "或者改用 USE_HTTPS=true 让 Node 直接监听 443（推荐）"
    elif echo "$PF_RESPONSE" | grep -qiE "502 |Bad Gateway"; then
      warn "CalDAV PROPFIND 502 —— 反代到 Node 失败"
      hint "查 nginx 错误日志：tail -100 /www/wwwlogs/yourdomain.error.log"
    elif [ -z "$PF_RESPONSE" ]; then
      warn "CalDAV PROPFIND 无响应（可能 curl 没 -X PROPFIND 支持？跳过）"
    else
      warn "CalDAV PROPFIND 返回了意外的响应："
      echo "$PF_RESPONSE" | head -3 | sed 's/^/         /'
    fi
  fi
fi

# ========== 完成 ==========
echo
printf '\033[1;32m✓ 部署完成！\033[0m\n\n'
if [ "${USE_HTTPS:-false}" = "true" ]; then
  echo "  📅 访问: $PUBLIC_BASE_URL"
  echo "  ⚙️  Node 直接监听 ${HTTPS_PORT:-443} (HTTPS) 和 ${HTTP_REDIRECT_PORT:-80} (重定向)"
  echo "  ⚠️  请确认宝塔里 ${PUBLIC_BASE_URL##*://} 站点【不要】让 nginx 占用 80/443"
  echo "     宝塔 → 网站 → 站点设置 → 关闭 nginx 监听"
else
  echo "  📅 访问: $PUBLIC_BASE_URL"
  echo "  ⚙️  服务在 127.0.0.1:${PORT:-3000}"
  if [ "${PUBLIC_BASE_URL}" != "http://127.0.0.1:${PORT:-3000}" ]; then
    echo "  ⚠️  外网访问需要宝塔反代或 USE_HTTPS=true"
  fi
fi
echo
echo "  💡 常用命令："
echo "     pm2 logs $PM2_NAME       # 看实时日志"
echo "     pm2 restart $PM2_NAME    # 改了 .env 后重启"
echo "     pm2 list                 # 看进程状态"
if [ -n "${APPS_ENABLED:-}" ]; then
  if [ "$APPS_ENABLED" = "true" ]; then
    echo
    echo "  📱 原生 APP 同步：已启用 —— 用户可在「设置 → 我的设备」绑定 iOS / Android APP"
  else
    echo
    echo "  📱 原生 APP 同步：未启用 —— 仅支持 Web + CalDAV；要打开就去 /admin/api"
  fi
fi
echo
echo "  开机自启（一次性，需要 root）: pm2 startup"
