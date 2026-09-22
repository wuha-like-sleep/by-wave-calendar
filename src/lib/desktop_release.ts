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

/** Absolute path to a local binary, or null if the filename escapes
 *  BINARY_DIR. Defense-in-depth against a manifest pointing at /etc/passwd. */
export function binaryPathFor(filename: string): string | null {
  const resolved = path.resolve(BINARY_DIR, filename);
  if (!resolved.startsWith(BINARY_DIR + path.sep) && resolved !== BINARY_DIR) return null;
  return resolved;
}

export { BINARY_DIR };
