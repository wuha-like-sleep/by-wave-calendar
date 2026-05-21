#!/usr/bin/env bash
# 在本机打 release tarball，产物在 release/ 下。
# 上传到服务器解压后跑 deploy/bt-panel/install.sh 即可。

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NAME="by-wave-calendar-v${VERSION}"
OUT_DIR="release"
STAGE="${OUT_DIR}/${NAME}"

echo "[release] cleaning..."
rm -rf "$OUT_DIR"
mkdir -p "$STAGE"

echo "[release] installing deps (full, for build)..."
npm ci

echo "[release] building..."
npm run build

echo "[release] copying files into $STAGE..."
cp -R dist             "$STAGE/dist"
cp -R drizzle          "$STAGE/drizzle"
cp -R deploy           "$STAGE/deploy"
mkdir -p "$STAGE/src"
cp -R src/views        "$STAGE/src/views"
cp -R src/public       "$STAGE/src/public"
cp    package.json     "$STAGE/package.json"
cp    package-lock.json "$STAGE/package-lock.json"
cp    .env.example     "$STAGE/.env.example"
cp    README.md        "$STAGE/README.md"

# Strip macOS metadata files
find "$STAGE" -name ".DS_Store" -delete

# 包不带 node_modules（让服务器跑 npm ci --omit=dev 自己装生产依赖）
echo "[release] taring..."
tar -czf "${OUT_DIR}/${NAME}.tar.gz" -C "$OUT_DIR" "$NAME"
rm -rf "$STAGE"

echo
echo "[release] done -> ${OUT_DIR}/${NAME}.tar.gz"
ls -lh "${OUT_DIR}/${NAME}.tar.gz"
