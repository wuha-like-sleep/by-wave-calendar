// Desktop in-app update endpoint backing store. Mirrors android_release.ts
// shape but covers macOS (.dmg) + Windows (.msi) + Linux (.deb), each as a
// separate asset in the same manifest.
//
// Two delivery modes per asset (same as android):
//
// 1. **GitHub Releases (recommended)** — `downloadUrl` is an absolute
//    URL. Server returns that URL verbatim, binary never touches our disk.
//    This is the canonical path: `gh release create` handles upload,
//    latest.json is committed to git, every server deploy picks it up.
//
// 2. **Server-hosted (fallback)** — `downloadUrl` absent. Server constructs
//    ${origin}/downloads/desktop/<filename> and serves from
//    data/desktop-binaries/<filename>. Useful for self-hosters who don't
//    want their users relying on GitHub.
//
// Manifest committed at apps/desktop/releases/latest.json. The legacy
// data/ override at data/app-desktop-manifest.json is honored (mtime-cached)
// for hotfix staging without a code change.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type DesktopPlatform = "mac" | "win" | "linux";

export interface DesktopReleaseAsset {
  /** Filename used in the local /downloads/desktop/<filename> URL when
   *  downloadUrl is absent. Optional when downloadUrl is set. */
  filename: string;
  /** Absolute URL — typically a GitHub Releases asset URL. When set,
   *  the API returns this directly; no local binary copy needed. */
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
}

export interface DesktopRelease {
  versionCode: number;
  versionName: string;
  releasedAt: string;
  notes: string;
  mandatory: boolean;
  /** Per-platform assets. Any platform missing → "not yet released for
   *  that OS" branch in the download page + in-app updater. */
  assets: Partial<Record<DesktopPlatform, DesktopReleaseAsset>>;
}

const COMMITTED_MANIFEST_PATH = path.join(process.cwd(), "apps", "desktop", "releases", "latest.json");
const RUNTIME_MANIFEST_PATH = path.join(process.cwd(), "data", "app-desktop-manifest.json");
const BINARY_DIR = path.join(process.cwd(), "data", "desktop-binaries");

interface CacheEntry { mtime: number; release: DesktopRelease | null }
const fileCache = new Map<string, CacheEntry>();

/**
 * 校验 + 规范化一份桌面端更新清单。**读取侧和后台上传共用这一份。**
 * 理由同 android_release.ts 的 parseAndroidManifest:后台自己写一套
 * 「看起来差不多」的校验,就会出现「页面说保存成功、接口却 404」。
 *
 * 返回 null = 这份清单不可用,别落盘。
 */
export function parseDesktopManifest(raw: unknown, fallbackReleasedAt: string): DesktopRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DesktopRelease>;
  if (typeof r.versionCode !== "number" || !Number.isFinite(r.versionCode)) return null;
  if (typeof r.versionName !== "string" || !r.versionName) return null;
  if (!r.assets || typeof r.assets !== "object") return null;
  const assets: DesktopRelease["assets"] = {};
  for (const platform of ["mac", "win", "linux"] as const) {
    const a = r.assets[platform] as Partial<DesktopReleaseAsset> | undefined;
    if (!a) continue;
    const filename = String(a.filename || "");
    const downloadUrl = String(a.downloadUrl || "");
    // 两种投递方式一个都没有 —— 没地方可下。
    if (!filename && !downloadUrl) continue;
    assets[platform] = {
      filename, downloadUrl,
      sha256: String(a.sha256 || "").toLowerCase(),
      sizeBytes: Number(a.sizeBytes || 0),
    };
  }
  if (Object.keys(assets).length === 0) return null;
  return {
    versionCode: r.versionCode,
    versionName: r.versionName,
    releasedAt: String(r.releasedAt || fallbackReleasedAt),
    notes: String(r.notes || ""),
    mandatory: r.mandatory === true,
    assets,
  };
}

async function readManifestAt(p: string): Promise<DesktopRelease | null> {
  try {
    const st = await stat(p);
    const cached = fileCache.get(p);
    if (cached && cached.mtime === st.mtimeMs) return cached.release;
    const text = await readFile(p, "utf8");
    const release = parseDesktopManifest(JSON.parse(text), new Date(st.mtimeMs).toISOString());
    fileCache.set(p, { mtime: st.mtimeMs, release });
    return release;
  } catch {
    return null;
  }
}

export async function getLatestRelease(): Promise<DesktopRelease | null> {
  const runtime = await readManifestAt(RUNTIME_MANIFEST_PATH);
  if (runtime) return runtime;
  return readManifestAt(COMMITTED_MANIFEST_PATH);
}

/**
 * 这台服务器上到底有没有这个安装包 —— **真的 stat 一次**。
 *
 * 不能靠「清单里有 filename」推断:清单是上游给的,filename 一定有,
 * 而文件在不在这台服务器上完全是另一回事。推断的话用户点了会撞 404。
 * 0 字节也不算 —— 那是上传半途留下的壳。
 */
export async function hasLocalBinary(filename: string | undefined | null): Promise<boolean> {
  if (!filename || !isServableBinaryName(filename)) return false;
  const abs = binaryPathFor(filename);
  if (!abs) return false;
  const { stat } = await import("node:fs/promises");
  return stat(abs).then((st) => st.isFile() && st.size > 0).catch(() => false);
}

/**
 * 一个资产该给什么下载地址 —— **全站唯一的口径**。
 *
 * 以前这件事有两份实现,而且口径相反:
 *   · /download 网页会 stat 本地文件,本地有就本站优先;
 *   · /api/app/desktop/latest 写的是 `downloadUrl || 本站URL`,清单里只要有
 *     downloadUrl 就永远用它,从不看本地。
 * 后果:站长把安装包传到服务器上之后,**网页发本站,而 App 的自动更新仍然把
 * 所有在跑的客户端送去 GitHub 拉 109MB** —— 而已装机的老用户恰恰是最需要
 * 本站发包的那一半。
 *
 * 返回 [主地址, 备选地址]。备选只在「本站有文件且上游也给了地址」时非空。
 */
export async function resolveAssetUrls(
  origin: string,
  a: { downloadUrl?: string; filename?: string } | undefined,
): Promise<[string, string]> {
  if (!a) return ["", ""];
  const local = await hasLocalBinary(a.filename)
    ? `${origin}/downloads/desktop/${encodeURIComponent(a.filename!)}`
    : "";
  if (local) return [local, a.downloadUrl || ""];
  return [a.downloadUrl || "", ""];
}

/**
 * 这个文件名**发得出去吗**。
 *
 * 三处需要同一份判据:发文件的路由、后台上传、以及将来任何列目录的地方。
 * 以前它只是 server.ts 里一条行内正则,后台上传再写一遍就必然漂移 ——
 * 漂移的后果很具体:带空格 / 中文 / 括号的名字**上传成功、落盘成功、
 * 下载页也给出按钮**(它只 stat 不校验名字),用户点下去拿到 400。
 * 站长看到「传成功了」,用户看到「下不了」,中间没有任何提示。
 *
 * 注意 \w 在没有 u 标志时就是 [A-Za-z0-9_] —— 中文和空格都不在内,
 * 这是故意的:这个名字要出现在 URL 里。
 */
export function isServableBinaryName(name: string): boolean {
  if (typeof name !== "string") return false;
  // 长度上限:文件名要进 URL、进 Content-Disposition,还要在各种文件系统上落地。
  if (Buffer.byteLength(name, "utf8") > 120) return false;
  return /^[\w.\-]+\.(dmg|msi|deb)$/i.test(name);
}

/** 按扩展名给 Content-Type。和 isServableBinaryName 的白名单绑在一起维护 ——
 *  放宽扩展名却忘了这里,安装包会落到 application/octet-stream,
 *  而那个类型正好命中 @fastify/compress 的默认可压缩正则。 */
export function contentTypeForBinary(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "dmg" ? "application/x-apple-diskimage"
    : ext === "msi" ? "application/x-msi"
    : ext === "deb" ? "application/vnd.debian.binary-package"
    : "application/octet-stream";
}

/** Absolute path to a local binary, or null if the filename escapes
 *  BINARY_DIR. Defense-in-depth against a manifest pointing at /etc/passwd. */
export function binaryPathFor(filename: string): string | null {
  const resolved = path.resolve(BINARY_DIR, filename);
  if (!resolved.startsWith(BINARY_DIR + path.sep) && resolved !== BINARY_DIR) return null;
  return resolved;
}

export { BINARY_DIR };
