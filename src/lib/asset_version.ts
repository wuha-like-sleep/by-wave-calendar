import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * 静态资源版本号：从「内容」算，不再用启动时间戳。
 *
 * 以前 ASSET_VERSION 是 String(Date.now()) —— 每次重启都变，于是所有带
 * ?v=<版本> 的资源 URL 全部失效、Service Worker 的缓存桶整桶作废，哪怕这次
 * 部署一个字节都没改过静态资源。7 天的 maxAge 形同虚设，弱网用户每次发版
 * 都要把整套 CSS/JS 重新拉一遍。
 *
 * 现在版本号 = src/public 下全部可服务文件的内容哈希（sha256 前 16 位）：
 * 内容没变 → 版本不变，重启、重复构建都不失效；任一资源变了 → 版本变，
 * SW 换新桶、version-check 轮询到新版本照常刷新，语义和以前完全一致。
 *
 * 两条取值路径，结果必须一致（scripts/asset-version.mjs 是同一算法的脚本版）：
 *   1. 构建时 scripts/asset-version.mjs 把哈希写进项目根的 asset-version.txt，
 *      服务启动时直接读戳文件；
 *   2. 戳文件不在（没跑过 build:assets 就直接起服务）时，启动时现算一遍兜底。
 */

// 戳文件名（项目根目录，已进 .gitignore —— 它是构建产物，不是源码）。
export const ASSET_VERSION_STAMP = "asset-version.txt";

// src/public 下不是构建产物的目录：用户上传的文件随时在变，
// 不能因为有人传了张图就把全站的壳缓存作废。
const EXCLUDED_DIRS = new Set(["uploads"]);

function listAssetFiles(publicDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(path.relative(publicDir, full));
      }
    }
  };
  walk(publicDir);
  // 排序保证与文件系统枚举顺序无关：同一份内容在任何机器上算出同一个哈希。
  files.sort();
  return files;
}

/** 对 publicDir 下全部可服务文件的内容算哈希，返回 16 位十六进制串。 */
export function computeAssetVersion(publicDir: string): string {
  const hash = createHash("sha256");
  for (const rel of listAssetFiles(publicDir)) {
    hash.update(rel.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(path.join(publicDir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** 服务启动时取版本号：优先读构建戳，戳不在就现算。 */
export function loadAssetVersion(projectRoot: string): string {
  try {
    const v = readFileSync(path.join(projectRoot, ASSET_VERSION_STAMP), "utf8").trim();
    if (/^[0-9a-f]{16}$/.test(v)) return v;
  } catch {
    // 没有戳文件就走现算兜底，不要因为少跑了一步构建就起不来。
  }
  return computeAssetVersion(path.join(projectRoot, "src", "public"));
}

/**
 * 带 ?v=<内容哈希> 的静态资源可以「永久缓存」：URL 里的 v 就是全部资源
 * 内容的哈希（见上面），任何一个文件变了，所有带 v 的 URL 都跟着变，
 * 所以旧 URL 上的内容永远不会变——immutable 是这条语义的准确表达。
 * 以前全局只有 7 天 maxAge：过期之后浏览器对每个资源各发一次条件请求，
 * 日历页 15 个资源就是 15 次往返换回 15 个 304，弱网下肉眼可见地慢。
 *
 * 只对 /static/ 下、且 query 里带非空 v 参数的 URL 返回长缓存：
 *   · 没带 v 的（vendor 直引、favicon 之外的零星引用）保持注册时的 7 天，
 *     免得某个没走版本戳的引用把旧内容钉死一年；
 *   · /static/uploads/ 是管理员上传内容，URL 不带版本语义，哪怕误带了
 *     v 参数也绝不给长缓存（哈希计算本来就排除了 uploads 目录）。
 * 返回 null 表示「不接管，用 fastifyStatic 自己的 Cache-Control」。
 */
export const VERSIONED_STATIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function cacheControlForVersionedStatic(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://static.local");
  } catch {
    return null;
  }
  if (!url.pathname.startsWith("/static/")) return null;
  if (url.pathname.startsWith("/static/uploads/")) return null;
  const v = url.searchParams.get("v");
  if (!v) return null;
  return VERSIONED_STATIC_CACHE_CONTROL;
}
