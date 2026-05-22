#!/usr/bin/env bash
# 一键 bootstrap：从零到能跑。
# 用法（任选其一）：
#   curl -fsSL https://raw.githubusercontent.com/wuha-like-sleep/by-wave-calendar/main/scripts/bootstrap.sh | bash
#   curl -fsSL https://gitee.com/zhaorunsen/by-wave-calendar/raw/main/scripts/bootstrap.sh | bash
#
# 会做的事：
#   1. 检查 git / node / npm
#   2. clone 仓库到 $TARGET（默认 /www/wwwroot/$DOMAIN，宝塔的标准位置）
#   3. 跳到目录里执行 deploy/bt-panel/install.sh 走交互式向导
#
# 可选环境变量：
#   TARGET       目标目录，默认 /www/wwwroot 下用域名命名
#   REPO_URL     仓库地址（默认 gitee 镜像，国内更快）
#   BRANCH       默认 main

set -euo pipefail

REPO_URL="${REPO_URL:-https://gitee.com/zhaorunsen/by-wave-calendar.git}"
BRANCH="${BRANCH:-main}"

c_cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

c_cyan "▶ ByWave Calendar bootstrap"
c_cyan "  仓库: $REPO_URL ($BRANCH)"

# 1. 工具链
command -v git >/dev/null || c_red "需要 git。CentOS: yum install -y git"
command -v node >/dev/null || c_red "需要 Node.js >= 20。宝塔 → 软件商店 → Node.js"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || c_red "Node 版本太老（当前 $(node -v)），需要 >= 20"

# 2. 目标目录
if [ -z "${TARGET:-}" ]; then
  echo -n "  目录（默认 /www/wwwroot/bywave-calendar）: "
  read -r TARGET </dev/tty || true
  TARGET="${TARGET:-/www/wwwroot/bywave-calendar}"
fi
c_cyan "  目标: $TARGET"

# 3. clone / pull
if [ -d "$TARGET/.git" ]; then
  c_cyan "  目录存在，拉最新代码..."
  cd "$TARGET"
  git fetch origin "$BRANCH" --depth 1
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  c_cyan "  clone..."
  mkdir -p "$(dirname "$TARGET")"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$TARGET"
  cd "$TARGET"
fi

# 4. 跑安装器
c_green "✓ 仓库已就绪，进入交互式安装..."
echo
bash deploy/bt-panel/install.sh
