// Android in-app update endpoint backing store.
//
// The Android APP polls /api/app/android/latest on resume (6h throttle).
// We answer with the latest published release manifest. The manifest is
// stored as a JSON file at <projectRoot>/data/app-android-manifest.json,
// gitignored, so the deploy admin can drop in a new APK + bump the JSON
// without touching code. Format:
//
//   {
//     "versionCode": 8,
//     "versionName": "0.8.0",
//     "filename": "bywave-calendar-0.8.0.apk",
//     "sha256": "<lowercase hex sha256 of the APK>",
//     "sizeBytes": 15400000,
//     "releasedAt": "2026-05-25T00:00:00Z",
//     "notes": "v0.8 — APP 内自动更新...",
//     "mandatory": false,
//     "minSupportedVersionCode": 1
//   }
//
// Files live at <projectRoot>/data/android-apks/<filename>. The server
// serves them via Fastify static at /downloads/android/<filename>.
//
// We deliberately keep this file the single source of truth — the
// /download web page also reads from it via getLatestRelease() so the
// version shown there can't drift from what the APP gets.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface AndroidRelease {
  versionCode: number;
  versionName: string;
  filename: string;
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

const MANIFEST_PATH = path.join(process.cwd(), "data", "app-android-manifest.json");
const APK_DIR = path.join(process.cwd(), "data", "android-apks");

let cached: { mtime: number; release: AndroidRelease | null } | null = null;

/** Read the manifest from disk, with a small mtime-based cache so we don't
 *  hit fs every request. Returns null if the manifest is missing or
 *  unparseable — meaning "no release published yet". */
export async function getLatestRelease(): Promise<AndroidRelease | null> {
  try {
    const st = await stat(MANIFEST_PATH);
    if (cached && cached.mtime === st.mtimeMs) return cached.release;
    const text = await readFile(MANIFEST_PATH, "utf8");
    const raw = JSON.parse(text) as Partial<AndroidRelease>;
    // Defensive: only treat well-formed manifests as published.
    if (
      typeof raw.versionCode !== "number" ||
      typeof raw.versionName !== "string" ||
      typeof raw.filename !== "string"
    ) {
      cached = { mtime: st.mtimeMs, release: null };
      return null;
    }
    const release: AndroidRelease = {
      versionCode: raw.versionCode,
      versionName: raw.versionName,
      filename: raw.filename,
      sha256: String(raw.sha256 || "").toLowerCase(),
      sizeBytes: Number(raw.sizeBytes || 0),
      releasedAt: String(raw.releasedAt || new Date(st.mtimeMs).toISOString()),
      notes: String(raw.notes || ""),
      mandatory: raw.mandatory === true,
      minSupportedVersionCode: Number(raw.minSupportedVersionCode || 1),
    };
    cached = { mtime: st.mtimeMs, release };
    return release;
  } catch {
    // No manifest, no published release. Fine — endpoint returns 404.
    return null;
  }
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
