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

/** Try to read + parse a manifest from a path. Returns null on missing
 *  file, parse error, or schema mismatch. mtime-cached so a single page
 *  hitting both /api/app/android/latest AND /download doesn't double-read. */
async function readManifestAt(p: string): Promise<AndroidRelease | null> {
  try {
    const st = await stat(p);
    const cached = fileCache.get(p);
    if (cached && cached.mtime === st.mtimeMs) return cached.release;
    const text = await readFile(p, "utf8");
    const raw = JSON.parse(text) as Partial<AndroidRelease>;
    if (
      typeof raw.versionCode !== "number" ||
      typeof raw.versionName !== "string"
    ) {
      fileCache.set(p, { mtime: st.mtimeMs, release: null });
      return null;
    }
    const release: AndroidRelease = {
      versionCode: raw.versionCode,
      versionName: raw.versionName,
      filename: String(raw.filename || ""),
      downloadUrl: String(raw.downloadUrl || ""),
      sha256: String(raw.sha256 || "").toLowerCase(),
      sizeBytes: Number(raw.sizeBytes || 0),
      releasedAt: String(raw.releasedAt || new Date(st.mtimeMs).toISOString()),
      notes: String(raw.notes || ""),
      mandatory: raw.mandatory === true,
      minSupportedVersionCode: Number(raw.minSupportedVersionCode || 1),
    };
    // Reject manifests that have neither hosting mode — there's nowhere
    // for the APP to download from.
    if (!release.downloadUrl && !release.filename) {
      fileCache.set(p, { mtime: st.mtimeMs, release: null });
      return null;
    }
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

/** Absolute path to the APK file that backs a given filename. Returns
 *  null if the filename escapes the APK_DIR (defense-in-depth against
 *  someone editing the manifest to point at /etc/passwd). */
export function apkPathFor(filename: string): string | null {
  const resolved = path.resolve(APK_DIR, filename);
  if (!resolved.startsWith(APK_DIR + path.sep) && resolved !== APK_DIR) return null;
  return resolved;
}

export { APK_DIR };
