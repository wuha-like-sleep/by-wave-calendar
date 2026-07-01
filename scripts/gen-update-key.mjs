#!/usr/bin/env node
// 生成 / 读取 用于「离线手动更新」的 ed25519 签名密钥对。
//
// 设计要点（务必读完再改）：
//   - 私钥只存在打包者本机：~/.bywave-update/update-ed25519-private.pem (chmod 600)，
//     永不进仓库、永不上传服务器。它是「谁能签发更新包」的唯一凭证。
//   - 公钥是安全的，可以随包发布：写到仓库内 deploy/update-signing-pub.pem，
//     服务器在 self_update.ts 里 import 它来验签。
//   - 幂等：私钥已存在就直接读出来用，不会覆盖（避免把旧包的验签基准弄丢）。
//
// 用法：
//   node scripts/gen-update-key.mjs            # 确保密钥对存在，打印公钥
//   node scripts/gen-update-key.mjs --print    # 同上，只是更明确
//
// release.sh 在签名前会调用本脚本（确保密钥存在）。

import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY_DIR = path.join(homedir(), ".bywave-update");
const PRIV_PATH = path.join(KEY_DIR, "update-ed25519-private.pem");

// 仓库内公钥落点 —— 与 self_update.ts 的 PUBLIC_KEY_PATH 必须一致。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PUB_PATH = path.join(REPO_ROOT, "deploy", "update-signing-pub.pem");

/**
 * 确保私钥存在（不存在则生成），返回 { privateKeyPem, publicKeyPem }。
 * 私钥写盘时 chmod 600。公钥从私钥派生（始终与私钥配对）。
 */
export function ensureKeyPair() {
  mkdirSync(KEY_DIR, { recursive: true });

  let privateKeyPem;
  if (existsSync(PRIV_PATH)) {
    privateKeyPem = readFileSync(PRIV_PATH, "utf8");
  } else {
    const { privateKey } = generateKeyPairSync("ed25519");
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileSync(PRIV_PATH, privateKeyPem, { mode: 0o600 });
    try { chmodSync(PRIV_PATH, 0o600); } catch { /* best effort on non-POSIX */ }
  }

  // 公钥始终从当前私钥派生，保证 deploy/update-signing-pub.pem 与签名私钥配对。
  const publicKeyPem = createPublicKey({ key: privateKeyPem, format: "pem" })
    .export({ type: "spki", format: "pem" })
    .toString();

  return { privateKeyPem, publicKeyPem, privPath: PRIV_PATH, pubPath: PUB_PATH };
}

/**
 * 把派生出的公钥写进仓库（若与现有内容不同）。返回是否发生写入。
 * 第一次运行会创建 deploy/update-signing-pub.pem；之后只在密钥轮换时变化。
 */
export function syncPublicKeyToRepo(publicKeyPem) {
  const existing = existsSync(PUB_PATH) ? readFileSync(PUB_PATH, "utf8") : null;
  if (existing !== publicKeyPem) {
    writeFileSync(PUB_PATH, publicKeyPem, "utf8");
    return true;
  }
  return false;
}

// 作为脚本直接运行时：确保密钥、同步公钥、打印公钥供人工核对。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { publicKeyPem, privPath, pubPath } = ensureKeyPair();
  const wrote = syncPublicKeyToRepo(publicKeyPem);
  process.stderr.write(`[gen-update-key] 私钥: ${privPath} (chmod 600，本机限定，永不提交)\n`);
  process.stderr.write(`[gen-update-key] 公钥: ${pubPath}${wrote ? " (已更新)" : " (无变化)"}\n`);
  process.stderr.write("[gen-update-key] 公钥内容（应与 deploy/update-signing-pub.pem 一致）：\n");
  // 公钥打到 stdout，方便 `node scripts/gen-update-key.mjs > /tmp/pub.pem` 之类核对。
  process.stdout.write(publicKeyPem);
}
