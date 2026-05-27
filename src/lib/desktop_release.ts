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

async function readManifestAt(p: string): Promise<DesktopRelease | null> {
  try {
    const st = await stat(p);
    const cached = fileCache.get(p);
    if (cached && cached.mtime === st.mtimeMs) return cached.release;
    const text = await readFile(p, "utf8");
    const raw = JSON.parse(text) as Partial<DesktopRelease>;
    if (
      typeof raw.versionCode !== "number" ||
      typeof raw.versionName !== "string" ||
      !raw.assets || typeof raw.assets !== "object"
    ) {
      fileCache.set(p, { mtime: st.mtimeMs, release: null });
      return null;
    }
    const assets: DesktopRelease["assets"] = {};
    for (const platform of ["mac", "win", "linux"] as const) {
      const a = raw.assets[platform] as Partial<DesktopReleaseAsset> | undefined;
      if (!a) continue;
      const filename = String(a.filename || "");
      const downloadUrl = String(a.downloadUrl || "");
      // Reject entries with neither hosting mode — nowhere to fetch from.
      if (!filename && !downloadUrl) continue;
      assets[platform] = {
        filename,
        downloadUrl,
        sha256: String(a.sha256 || "").toLowerCase(),
        sizeBytes: Number(a.sizeBytes || 0),
      };
    }
    if (Object.keys(assets).length === 0) {
      fileCache.set(p, { mtime: st.mtimeMs, release: null });
      return null;
    }
    const release: DesktopRelease = {
      versionCode: raw.versionCode,
      versionName: raw.versionName,
      releasedAt: String(raw.releasedAt || new Date(st.mtimeMs).toISOString()),
      notes: String(raw.notes || ""),
      mandatory: raw.mandatory === true,
      assets,
    };
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
