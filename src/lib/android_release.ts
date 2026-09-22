// Android in-app update endpoint backing store.
//
// The Android APP polls /api/app/android/latest on resume (6h throttle).
// We answer with the latest published release manifest. Two delivery
// modes are supported, picked per release via the manifest:
//
// 1. **GitHub Releases (recommended)** — `downloadUrl` is an absolute
//    URL (e.g. github.com/.../releases/download/...). Server returns
//    that URL verbatim. APK never touches our disk. This is how we
//    actually publish — `gh release create` handles upload, the
//    JSON is committed to git, every server deploy picks it up via
//    git pull.
//
// 2. **Server-hosted (fallback)** — `downloadUrl` absent. Server
//    constructs ${origin}/downloads/android/<filename> and serves
//    the APK from data/android-apks/<filename>. Useful for self-
//    hosted users who don't want their APP relying on GitHub.
//
// The manifest itself is committed to the repo at
// apps/android/releases/latest.json — so server-side reads are just
// a fs read after every `git pull`. The legacy data/ override path
// is still honored (mtime-cached) so an admin can override locally
// without a code change.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface AndroidRelease {
  versionCode: number;
  versionName: string;
  /** Filename used in the local /downloads/android/<filename> URL when
   *  downloadUrl is absent. Optional when downloadUrl is set. */
  filename: string;
  /** Absolute URL to the APK — typically a GitHub Releases asset URL.
   *  When set, /api/app/android/latest returns this directly and the
   *  server doesn't need a local APK copy. */
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  releasedAt: string;
  notes: string;
  mandatory: boolean;
  /** APPs with versionCode < this MUST update (even if mandatory=false on the
   *  latest release). Useful for retroactively flagging an old version as
   *  having a critical bug. */
  minSupportedVersionCode: number;
}

const COMMITTED_MANIFEST_PATH = path.join(process.cwd(), "apps", "android", "releases", "latest.json");
const RUNTIME_MANIFEST_PATH = path.join(process.cwd(), "data", "app-android-manifest.json");
const APK_DIR = path.join(process.cwd(), "data", "android-apks");

interface CacheEntry { mtime: number; release: AndroidRelease | null }
const fileCache = new Map<string, CacheEntry>();

/**
 * 校验 + 规范化一份安卓更新清单。**读取侧和后台上传共用这一份。**
 *
 * 为什么必须共用:后台如果自己写一套「看起来差不多」的校验,就会出现
 * 「页面说保存成功、而 /api/app/android/latest 直接 404」—— 因为真正决定
 * 成败的是这里,而这里对解析失败和形状不符一律静默 return null。
 * 站长看到的是一次成功的保存和一个不工作的接口,中间没有任何提示。
 *
 * 返回 null = 这份清单不可用,别落盘。
 */
export function parseAndroidManifest(raw: unknown, fallbackReleasedAt: string): AndroidRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AndroidRelease>;
  if (typeof r.versionCode !== "number" || !Number.isFinite(r.versionCode)) return null;
  if (typeof r.versionName !== "string" || !r.versionName) return null;
  const release: AndroidRelease = {
    versionCode: r.versionCode,
    versionName: r.versionName,
    filename: String(r.filename || ""),
    downloadUrl: String(r.downloadUrl || ""),
    sha256: String(r.sha256 || "").toLowerCase(),
    sizeBytes: Number(r.sizeBytes || 0),
    releasedAt: String(r.releasedAt || fallbackReleasedAt),
    notes: String(r.notes || ""),
    mandatory: r.mandatory === true,
    minSupportedVersionCode: Number(r.minSupportedVersionCode || 1),
  };
  // 两种投递方式一个都没有 —— App 无处可下。
  if (!release.downloadUrl && !release.filename) return null;
  return release;
}

/** Try to read + parse a manifest from a path. Returns null on missing
 *  file, parse error, or schema mismatch. mtime-cached so a single page
 *  hitting both /api/app/android/latest AND /download doesn't double-read. */
async function readManifestAt(p: string): Promise<AndroidRelease | null> {
  try {
    const st = await stat(p);
    const cached = fileCache.get(p);
    if (cached && cached.mtime === st.mtimeMs) return cached.release;
    const text = await readFile(p, "utf8");
    const release = parseAndroidManifest(JSON.parse(text), new Date(st.mtimeMs).toISOString());
    fileCache.set(p, { mtime: st.mtimeMs, release });
    return release;
  } catch {
    return null;
  }
}

/** Get the active release. Runtime data/ override wins over the
 *  committed manifest — handy for staging a hotfix without a code
 *  push. Returns null when nothing is published. */
export async function getLatestRelease(): Promise<AndroidRelease | null> {
  const runtime = await readManifestAt(RUNTIME_MANIFEST_PATH);
  if (runtime) return runtime;
  return readManifestAt(COMMITTED_MANIFEST_PATH);
}

/** 这台服务器上有没有这个 APK —— 真的 stat 一次,0 字节不算。
 *  理由同 desktop_release.ts 的 hasLocalBinary。 */
export async function hasLocalApk(filename: string | undefined | null): Promise<boolean> {
  if (!filename || !isServableApkName(filename)) return false;
  const abs = apkPathFor(filename);
  if (!abs) return false;
  const { stat } = await import("node:fs/promises");
  return stat(abs).then((st) => st.isFile() && st.size > 0).catch(() => false);
}

/** APK 该给什么下载地址 —— 全站唯一口径。来龙去脉见 desktop_release.ts
 *  的 resolveAssetUrls。返回 [主地址, 备选地址]。 */
export async function resolveApkUrls(
  origin: string,
  rel: { downloadUrl?: string; filename?: string } | null | undefined,
): Promise<[string, string]> {
  if (!rel) return ["", ""];
  const local = await hasLocalApk(rel.filename)
    ? `${origin}/downloads/android/${encodeURIComponent(rel.filename!)}`
    : "";
  if (local) return [local, rel.downloadUrl || ""];
  return [rel.downloadUrl || "", ""];
}

/** 这个 APK 文件名发得出去吗。理由同 desktop_release.ts 的 isServableBinaryName:
 *  三处需要同一份判据,各写一份必然漂移,而漂移的表现是
 *  「上传成功、落盘成功、下载页有按钮、点下去 400」。 */
export function isServableApkName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (Buffer.byteLength(name, "utf8") > 120) return false;
  return /^[\w.\-]+\.apk$/i.test(name);
}

/** Absolute path to the APK file that backs a given filename. Returns
 *  null if the filename escapes the APK_DIR (defense-in-depth against
 *  someone editing the manifest to point at /etc/passwd). */
export function apkPathFor(filename: string): string | null {
  const resolved = path.resolve(APK_DIR, filename);
  if (!resolved.startsWith(APK_DIR + path.sep) && resolved !== APK_DIR) return null;
  return resolved;
}

export { APK_DIR };
