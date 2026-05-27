// Desktop in-app update endpoint backing store. Mirrors the android_release
// shape but covers macOS (.dmg) + Windows (.msi) + Linux (.deb), each as a
// separate channel in the same manifest.
//
// Distribution policy: because the desktop client hardcodes
// `https://rl.lz-ss.com` as the default server URL (apps/desktop/.../
// SetupScreen.kt), the binaries are NOT published to GitHub/Gitee
// Releases — only self-hosted on rl.lz-ss.com. So unlike android_release.ts
// there is intentionally no `downloadUrl` (external URL) path; every
// release entry has a local `filename` and is served from
// data/desktop-binaries/<filename> via /downloads/desktop/<filename>.
//
// The manifest itself lives at apps/desktop/releases/latest.json (committed)
// with the standard data/ runtime override at data/app-desktop-manifest.json.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type DesktopPlatform = "mac" | "win" | "linux";

export interface DesktopReleaseAsset {
  /** Filename used in the local /downloads/desktop/<filename> URL. */
  filename: string;
  sha256: string;
  sizeBytes: number;
}

export interface DesktopRelease {
  versionCode: number;
  versionName: string;
  releasedAt: string;
  notes: string;
  mandatory: boolean;
  /** Per-platform assets. Any platform missing here is treated as "not yet
   *  released for that OS" by the download page + in-app updater. */
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
    // Normalize each asset; drop entries with missing filename.
    const assets: DesktopRelease["assets"] = {};
    for (const platform of ["mac", "win", "linux"] as const) {
      const a = raw.assets[platform] as Partial<DesktopReleaseAsset> | undefined;
      if (!a || typeof a.filename !== "string" || !a.filename) continue;
      assets[platform] = {
        filename: a.filename,
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

/** Absolute path to a binary file, or null if the filename escapes BINARY_DIR.
 *  Defense-in-depth against a manifest edited to point at /etc/passwd. */
export function binaryPathFor(filename: string): string | null {
  const resolved = path.resolve(BINARY_DIR, filename);
  if (!resolved.startsWith(BINARY_DIR + path.sep) && resolved !== BINARY_DIR) return null;
  return resolved;
}

export { BINARY_DIR };
