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

echo "[release] typecheck + unit tests (block release on failure)..."
npm run typecheck
npm test

echo "[release] building..."
# Verify the minified bundle actually got rewritten — older versions of
# minify-public-js.mjs silently bailed out unless NODE_ENV=production was
# set, which made every release ship a stale src/public/_built/ bundle and
# every web-side fix invisible in production. The fail-loud check below
# guarantees we never deploy a stale bundle again.
rm -rf src/public/_built
npm run build
if [ ! -f src/public/_built/calendar-app.js ]; then
  echo "[release] ERROR: src/public/_built/calendar-app.js was not generated."
  echo "[release] This means the minify step bailed out — production would serve a stale bundle."
  exit 1
fi
# Surface the bundle's mtime so the release log shows it's fresh.
echo "[release] minified bundle:"
ls -lh src/public/_built/calendar-app.js

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

# Strip macOS metadata files (.DS_Store + any stray AppleDouble ._* on disk)
find "$STAGE" -name ".DS_Store" -delete
find "$STAGE" -name "._*" -delete

# 包不带 node_modules（让服务器跑 npm ci --omit=dev 自己装生产依赖）
echo "[release] taring..."
# COPYFILE_DISABLE=1 阻止 macOS 的 tar 夹带 AppleDouble（._*）元数据 —— ~/Desktop
# 在 iCloud 下、文件带扩展属性，否则包顶层会多出 ._<name>，让服务端「顶层单目录」
# 体检误判为两个目录而拒绝。签名在此之后进行，覆盖的就是这份干净的 tarball。
COPYFILE_DISABLE=1 tar -czf "${OUT_DIR}/${NAME}.tar.gz" -C "$OUT_DIR" "$NAME"
rm -rf "$STAGE"

TARBALL="${OUT_DIR}/${NAME}.tar.gz"

# ---- 签名（离线/手动更新的安全基石）----
# 用 ~/.bywave-update 下的 ed25519 私钥对 tarball 原始字节做分离签名，产出
# <tarball>.sig（base64）。服务器上传更新时先验签，验不过一律拒绝——这是防
# 「有人上传篡改/伪造的更新包在服务器上跑任意代码」的唯一硬边界。
#
# 私钥永远只在本机（chmod 600，永不提交/上传）；公钥在 deploy/update-signing-pub.pem
# 随仓库发布并内嵌进服务器。首次运行会自动生成密钥对；之后幂等复用。
echo "[release] ensuring signing key exists..."
# gen-update-key.mjs：确保私钥存在（不存在则生成）并把公钥同步进仓库；
# stdout 打印公钥 PEM 供人工核对，stderr 打印路径信息。
if ! PUBKEY_PEM=$(node scripts/gen-update-key.mjs 2>/dev/null); then
  echo "[release] ERROR: 无法生成/读取签名私钥 (~/.bywave-update/update-ed25519-private.pem)。"
  echo "[release] 拒绝产出未签名的 release —— 未签名的包服务器会直接拒收。"
  exit 1
fi

PRIV_KEY="$HOME/.bywave-update/update-ed25519-private.pem"
if [ ! -f "$PRIV_KEY" ]; then
  echo "[release] ERROR: 签名私钥不存在：$PRIV_KEY"
  echo "[release] 拒绝产出未签名的 release。"
  exit 1
fi

echo "[release] signing tarball (ed25519, detached)..."
# 用 node:crypto 对 tarball 原始字节签名，写 base64 到 <tarball>.sig。
# （openssl 的 ed25519 pkeyutl 各版本行为不一，用 node 保证与服务器验签逻辑一致。）
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
// 注意：node --input-type=module -e "..." -- a b c 下，process.argv 是
// [nodePath, a, b, c]（没有脚本路径这一项），所以只跳过第一个元素。
const [, tarball, privPath, sigOut] = process.argv;
const key = createPrivateKey(readFileSync(privPath, "utf8"));
const data = readFileSync(tarball);
const sig = cryptoSign(null, data, key); // ed25519：算法隐含在 key 类型里
writeFileSync(sigOut, sig.toString("base64") + "\n", "utf8");
' -- "$TARBALL" "$PRIV_KEY" "${TARBALL}.sig"

# sha256 供管理员肉眼核对（上传前后一致性）。
if command -v shasum >/dev/null 2>&1; then
  SHA256=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256=$(sha256sum "$TARBALL" | awk '{print $1}')
else
  SHA256="(no sha256 tool found)"
fi

echo
echo "[release] done -> ${TARBALL}"
ls -lh "$TARBALL"
echo "[release] signature -> ${TARBALL}.sig"
echo "[release] sha256    -> ${SHA256}"
echo "[release] pubkey (应与 deploy/update-signing-pub.pem 一致)："
echo "$PUBKEY_PEM" | sed 's/^/[release]   /'
echo "[release] signed ✓"
